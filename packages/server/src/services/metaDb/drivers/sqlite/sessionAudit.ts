import { AGENT_SESSION_ATTACH, type RevisionKind } from '@notarium/core'

import { retrievalOfRow, type RetrievalRow } from '../../rows'
import type {
  AgentSessionAuditEvent,
  AgentSessionAuditPersistence,
  AgentSessionAuditSummary,
} from '../../types'
import type { SqliteDriverCtx } from './context'

type SummaryRow = {
  id: string
  name: string
  named: number | null
  parent_id: string | null
  created_at: string
  last_seen_at: string
  calls: number | null
  reads: number
  writes: number
  retained: number
  active: number
  total_rows: number
  active_rows: number
}

const summaryOf = (r: SummaryRow): AgentSessionAuditSummary => ({
  id: r.id,
  name: r.name,
  named: r.named == null ? null : r.named === 1,
  parentId: r.parent_id,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
  calls: r.calls == null ? null : Number(r.calls),
  reads: Number(r.reads),
  writes: Number(r.writes),
  retained: r.retained === 1,
  active: r.active === 1,
})

const SUMMARY_CTES = `
  WITH audit_events AS (
    SELECT session_id, session_name, created_at, 1 AS reads, 0 AS writes
      FROM agent_retrievals
     WHERE owner = ? AND session_id IS NOT NULL
    UNION ALL
    SELECT session_id, session_name, created_at, 0 AS reads, 1 AS writes
      FROM note_revisions
     WHERE agent_owner = ? AND session_id IS NOT NULL
  ),
  audit AS (
    SELECT session_id,
           MAX(session_name) AS session_name,
           MIN(created_at) AS first_at,
           MAX(created_at) AS last_at,
           SUM(reads) AS reads,
           SUM(writes) AS writes
      FROM audit_events GROUP BY session_id
  ),
  combined AS (
    SELECT sessions.id,
           sessions.name,
           sessions.named,
           sessions.parent_id,
           sessions.created_at,
           MAX(sessions.last_seen_at, COALESCE(audit.last_at, sessions.last_seen_at)) AS last_seen_at,
           sessions.calls,
           COALESCE(audit.reads, 0) AS reads,
           COALESCE(audit.writes, 0) AS writes,
           1 AS retained,
           CASE WHEN sessions.last_seen_at >= ? THEN 1 ELSE 0 END AS active
      FROM agent_sessions AS sessions
      LEFT JOIN audit ON audit.session_id = sessions.id
     WHERE sessions.owner = ?
    UNION ALL
    SELECT audit.session_id AS id,
           COALESCE(audit.session_name, 'Archived session') AS name,
           NULL AS named,
           NULL AS parent_id,
           audit.first_at AS created_at,
           audit.last_at AS last_seen_at,
           NULL AS calls,
           audit.reads,
           audit.writes,
           0 AS retained,
           0 AS active
      FROM audit
     WHERE NOT EXISTS (
       SELECT 1 FROM agent_sessions
        WHERE owner = ? AND id = audit.session_id
     )
  ),
  stats AS (
    SELECT COUNT(*) AS total_rows, COALESCE(SUM(active), 0) AS active_rows FROM combined
  )`

type EventRow = RetrievalRow & {
  event_type: 'retrieval' | 'write'
  source_rank: number
  note_id: string | null
  space: string | null
  revision_kind: string | null
  revision_title: string | null
  revision_class: string | null
}

const eventOf = (r: EventRow): AgentSessionAuditEvent => {
  if (r.event_type === 'retrieval') {
    return { type: 'retrieval', record: retrievalOfRow(r) }
  }

  return {
    type: 'write',
    id: String(r.id),
    at: r.created_at,
    principal: r.principal,
    agent: r.agent,
    sessionAttach:
      r.session_attach === AGENT_SESSION_ATTACH.declared ||
      r.session_attach === AGENT_SESSION_ATTACH.inferred
        ? r.session_attach
        : null,
    noteId: r.note_id ?? '',
    space: r.space ?? '',
    title: r.revision_title ?? '',
    class: r.revision_class,
    revisionKind: r.revision_kind as RevisionKind,
  }
}

const EVENTS_CTE = `
  WITH events AS (
    SELECT 'retrieval' AS event_type, 1 AS source_rank,
           id, owner, principal, agent, session_id, session_name, session_attach,
           tool, query, project, class_filter, result_count, top_score, hits, created_at,
           NULL AS note_id, NULL AS space, NULL AS revision_kind,
           NULL AS revision_title, NULL AS revision_class
      FROM agent_retrievals
     WHERE owner = ? AND ((? IS NULL AND session_id IS NULL) OR session_id = ?)
    UNION ALL
    SELECT 'write' AS event_type, 0 AS source_rank,
           id, agent_owner AS owner, principal, agent_name AS agent,
           session_id, session_name, session_attach,
           NULL AS tool, '' AS query, NULL AS project, NULL AS class_filter,
           0 AS result_count, NULL AS top_score, NULL AS hits, created_at,
           note_id, space, kind AS revision_kind, title AS revision_title, class AS revision_class
      FROM note_revisions
     WHERE agent_owner = ? AND ((? IS NULL AND session_id IS NULL) OR session_id = ?)
  )`

export const createSessionAuditFacet = (ctx: SqliteDriverCtx): AgentSessionAuditPersistence => ({
  overview: async ({ owner, activeSince, limit, before }) => {
    await ctx.ensureInit()
    const cursor = before
      ? 'WHERE (combined.last_seen_at < ? OR (combined.last_seen_at = ? AND combined.id < ?))'
      : ''
    const params: Array<string | number> = [owner, owner, activeSince, owner, owner]

    if (before) {
      params.push(before.at, before.at, before.id)
    }
    params.push(limit + 1)
    const rows = ctx.required
      .prepare(
        `${SUMMARY_CTES}
         SELECT combined.*, stats.total_rows, stats.active_rows
           FROM stats LEFT JOIN combined ON ${cursor ? cursor.replace('WHERE ', '') : 'TRUE'}
          ORDER BY combined.last_seen_at DESC, combined.id DESC LIMIT ?`,
      )
      .all(...params) as SummaryRow[]
    const pageRows = rows.filter((row) => row.id != null)
    const outside = ctx.required
      .prepare(
        `SELECT SUM(reads) AS reads, SUM(writes) AS writes, MAX(created_at) AS last_seen_at
           FROM (
             SELECT 1 AS reads, 0 AS writes, created_at FROM agent_retrievals
              WHERE owner = ? AND session_id IS NULL
             UNION ALL
             SELECT 0 AS reads, 1 AS writes, created_at FROM note_revisions
              WHERE agent_owner = ? AND session_id IS NULL
           )`,
      )
      .get(owner, owner) as {
      reads: number | null
      writes: number | null
      last_seen_at: string | null
    }
    return {
      items: pageRows.slice(0, limit).map(summaryOf),
      total: Number(rows[0]?.total_rows ?? 0),
      active: Number(rows[0]?.active_rows ?? 0),
      outside: outside.last_seen_at
        ? {
            reads: Number(outside.reads ?? 0),
            writes: Number(outside.writes ?? 0),
            lastSeenAt: outside.last_seen_at,
          }
        : null,
      hasMore: pageRows.length > limit,
    }
  },

  find: async (owner, sessionId, activeSince) => {
    await ctx.ensureInit()
    const row = ctx.required
      .prepare(
        `${SUMMARY_CTES}
         SELECT combined.*, stats.total_rows, stats.active_rows
           FROM combined CROSS JOIN stats WHERE combined.id = ? LIMIT 1`,
      )
      .get(owner, owner, activeSince, owner, owner, sessionId) as SummaryRow | undefined
    return row ? summaryOf(row) : null
  },

  events: async ({ owner, sessionId, type, limit, before }) => {
    await ctx.ensureInit()
    const filters: string[] = []
    const params: Array<string | number | bigint | null> = [
      owner,
      sessionId,
      sessionId,
      owner,
      sessionId,
      sessionId,
    ]

    if (type) {
      filters.push('event_type = ?')
      params.push(type)
    }
    const countWhere = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
    const count = ctx.required
      .prepare(`${EVENTS_CTE} SELECT COUNT(*) AS n FROM events ${countWhere}`)
      .get(...params) as { n: number }

    if (before) {
      filters.push(
        '(created_at < ? OR (created_at = ? AND (source_rank < ? OR (source_rank = ? AND id < ?))))',
      )
      const rank = before.source === 'retrieval' ? 1 : 0
      params.push(before.at, before.at, rank, rank, BigInt(before.id))
    }
    const rowWhere = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
    params.push(limit + 1)
    const rows = ctx.required
      .prepare(
        `${EVENTS_CTE} SELECT * FROM events ${rowWhere}
          ORDER BY created_at DESC, source_rank DESC, id DESC LIMIT ?`,
      )
      .all(...params) as EventRow[]
    return {
      items: rows.slice(0, limit).map(eventOf),
      total: Number(count.n),
      hasMore: rows.length > limit,
    }
  },
})
