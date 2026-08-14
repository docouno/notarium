import { auditEventOfRow, type AuditEventRow } from '../../rows'
import type { AgentSessionAuditPersistence, AgentSessionAuditSummary } from '../../types'
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

type RetainedSessionRow = {
  id: string
  name: string
  named: number
  parent_id: string | null
  created_at: string
  last_seen_at: string
  calls: number
}

type SessionAuditRow = {
  session_id: string | null
  session_name: string | null
  first_at: string | null
  last_at: string | null
  reads: number | null
  writes: number | null
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
      FROM note_revisions INDEXED BY idx_note_revisions_agent_session_created
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
  )`

type EventQuery = Parameters<AgentSessionAuditPersistence['events']>[0]
type EventSource = 'retrieval' | 'write'
type SqlParam = string | number | bigint | null

const eventSources = (q: EventQuery): EventSource[] => {
  if (q.type === 'retrieval' || q.tool || q.query) {
    return ['retrieval']
  }

  return q.type === 'write' ? ['write'] : ['retrieval', 'write']
}

const sourceFilters = (
  q: EventQuery,
  source: EventSource,
  includeCursor: boolean,
): { sql: string; params: SqlParam[] } => {
  const filters = [source === 'retrieval' ? 'owner = ?' : 'agent_owner = ?']
  const params: SqlParam[] = [q.owner]

  if (q.scope.kind === 'session') {
    filters.push('session_id = ?')
    params.push(q.scope.id)
  } else if (q.scope.kind === 'outside') {
    filters.push('session_id IS NULL')
  }
  if (q.agent) {
    filters.push(source === 'retrieval' ? 'agent = ?' : "integrity = 'trusted' AND agent_name = ?")
    params.push(q.agent)
  }
  if (source === 'retrieval') {
    if (q.tool) {
      filters.push('tool = ?')
      params.push(q.tool)
    }
    if (q.query) {
      filters.push("lower_u(query) LIKE ? ESCAPE '\\'")
      params.push(`%${q.query.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`)
    }
  }
  if (includeCursor && q.before) {
    if (source === q.before.source) {
      filters.push('(created_at < ? OR (created_at = ? AND id < ?))')
      params.push(q.before.at, q.before.at, BigInt(q.before.id))
    } else if (source === 'retrieval') {
      filters.push('created_at < ?')
      params.push(q.before.at)
    } else {
      filters.push('created_at <= ?')
      params.push(q.before.at)
    }
  }

  return { sql: filters.join(' AND '), params }
}

const sourceIndex = (q: EventQuery, source: EventSource): string => {
  if (source === 'retrieval') {
    if (q.scope.kind === 'all' && q.agent) {
      return 'idx_agent_retrievals_owner_agent_created'
    }
    if (q.scope.kind === 'outside') {
      return 'idx_agent_retrievals_owner_outside_created'
    }

    return q.scope.kind === 'all'
      ? 'idx_agent_retrievals_owner_created'
      : 'idx_agent_retrievals_owner_session_created'
  }

  if (q.scope.kind === 'all' && q.agent) {
    return 'idx_note_revisions_agent_owner_name_created'
  }
  if (q.scope.kind === 'outside') {
    return 'idx_note_revisions_agent_outside_created'
  }

  return q.scope.kind === 'all'
    ? 'idx_note_revisions_agent_created'
    : 'idx_note_revisions_agent_session_created'
}

const pageBranch = (q: EventQuery, source: EventSource): { sql: string; params: SqlParam[] } => {
  const where = sourceFilters(q, source, true)
  const from =
    source === 'retrieval'
      ? `agent_retrievals INDEXED BY ${sourceIndex(q, source)}`
      : `note_revisions INDEXED BY ${sourceIndex(q, source)}`
  const select =
    source === 'retrieval'
      ? `SELECT 'retrieval' AS event_type, 1 AS source_rank,
                id, owner, principal, agent, session_id, session_name, session_attach,
                tool, query, project, class_filter, result_count, top_score, hits, created_at,
                NULL AS note_id, NULL AS space, NULL AS revision_kind,
                NULL AS revision_title, NULL AS revision_class, NULL AS revision_integrity`
      : `SELECT 'write' AS event_type, 0 AS source_rank,
                id, agent_owner AS owner, principal, agent_name AS agent,
                session_id, session_name, session_attach,
                NULL AS tool, '' AS query, NULL AS project, NULL AS class_filter,
                0 AS result_count, NULL AS top_score, NULL AS hits, created_at,
                note_id, space, kind AS revision_kind, title AS revision_title,
                class AS revision_class, integrity AS revision_integrity`
  return {
    sql: `SELECT * FROM (
            ${select} FROM ${from} WHERE ${where.sql}
             ORDER BY created_at DESC, id DESC LIMIT ?
          )`,
    params: [...where.params, q.limit + 1],
  }
}

export const createSessionAuditFacet = (ctx: SqliteDriverCtx): AgentSessionAuditPersistence => ({
  overview: async ({ owner, activeSince, type, limit, before }) => {
    await ctx.ensureInit()
    const typeFilter =
      type === 'retrieval' ? 'WHERE reads > 0' : type === 'write' ? 'WHERE writes > 0' : ''
    const cursor = before
      ? 'WHERE (filtered.last_seen_at < ? OR (filtered.last_seen_at = ? AND filtered.id < ?))'
      : ''
    const params: Array<string | number> = [owner, owner, activeSince, owner, owner]

    if (before) {
      params.push(before.at, before.at, before.id)
    }
    params.push(limit + 1)
    const rows = ctx.required
      .prepare(
        `${SUMMARY_CTES},
         filtered AS (SELECT * FROM combined ${typeFilter}),
         stats AS (
           SELECT COUNT(*) AS total_rows, COALESCE(SUM(active), 0) AS active_rows FROM filtered
         )
         SELECT filtered.*, stats.total_rows, stats.active_rows
           FROM stats LEFT JOIN filtered ON ${cursor ? cursor.replace('WHERE ', '') : 'TRUE'}
          ORDER BY filtered.last_seen_at DESC, filtered.id DESC LIMIT ?`,
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
    const outsideSummary = outside.last_seen_at
      ? {
          reads: Number(outside.reads ?? 0),
          writes: Number(outside.writes ?? 0),
          lastSeenAt: outside.last_seen_at,
        }
      : null
    const outsideMatches =
      outsideSummary != null &&
      (type === 'retrieval'
        ? outsideSummary.reads > 0
        : type === 'write'
          ? outsideSummary.writes > 0
          : true)
    return {
      items: pageRows.slice(0, limit).map(summaryOf),
      total: Number(rows[0]?.total_rows ?? 0),
      active: Number(rows[0]?.active_rows ?? 0),
      outside: outsideMatches ? outsideSummary : null,
      hasMore: pageRows.length > limit,
    }
  },

  find: async (owner, sessionId, activeSince) => {
    await ctx.ensureInit()
    const retained = ctx.required
      .prepare(
        `SELECT id, name, named, parent_id, created_at, last_seen_at, calls
           FROM agent_sessions WHERE owner = ? AND id = ? LIMIT 1`,
      )
      .get(owner, sessionId) as RetainedSessionRow | undefined
    const audit = ctx.required
      .prepare(
        `SELECT MIN(session_id) AS session_id,
                MAX(session_name) AS session_name,
                MIN(created_at) AS first_at,
                MAX(created_at) AS last_at,
                SUM(reads) AS reads,
                SUM(writes) AS writes
           FROM (
             SELECT session_id, session_name, created_at, 1 AS reads, 0 AS writes
               FROM agent_retrievals INDEXED BY idx_agent_retrievals_owner_session_created
              WHERE owner = ? AND session_id = ?
             UNION ALL
             SELECT session_id, session_name, created_at, 0 AS reads, 1 AS writes
               FROM note_revisions INDEXED BY idx_note_revisions_agent_session_created
              WHERE agent_owner = ? AND session_id = ?
           )`,
      )
      .get(owner, sessionId, owner, sessionId) as SessionAuditRow

    if (!retained && !audit.session_id) {
      return null
    }
    const lastSeenAt = retained
      ? audit.last_at && audit.last_at > retained.last_seen_at
        ? audit.last_at
        : retained.last_seen_at
      : audit.last_at!
    return {
      id: sessionId,
      name: retained?.name ?? audit.session_name ?? 'Archived session',
      named: retained ? retained.named === 1 : null,
      parentId: retained?.parent_id ?? null,
      createdAt: retained?.created_at ?? audit.first_at!,
      lastSeenAt,
      calls: retained ? Number(retained.calls) : null,
      reads: Number(audit.reads ?? 0),
      writes: Number(audit.writes ?? 0),
      retained: retained != null,
      active: retained != null && retained.last_seen_at >= activeSince,
    }
  },

  events: async (q) => {
    await ctx.ensureInit()
    const sources = eventSources(q)
    const branches = sources.map((source) => pageBranch(q, source))
    const params = branches.flatMap((branch) => branch.params)
    params.push(q.limit + 1)
    const rows = ctx.required
      .prepare(
        `WITH events AS (${branches.map((branch) => branch.sql).join(' UNION ALL ')})
         SELECT * FROM events
          ORDER BY created_at DESC, source_rank DESC, id DESC LIMIT ?`,
      )
      .all(...params) as AuditEventRow[]
    let total: number | null = null

    if (q.scope.kind === 'session') {
      total = sources.reduce((sum, source) => {
        const where = sourceFilters(q, source, false)
        const table = source === 'retrieval' ? 'agent_retrievals' : 'note_revisions'
        const count = ctx.required
          .prepare(
            `SELECT COUNT(*) AS n FROM ${table} INDEXED BY ${sourceIndex(q, source)}
              WHERE ${where.sql}`,
          )
          .get(...where.params) as { n: number }
        return sum + Number(count.n)
      }, 0)
    }

    return {
      items: rows.slice(0, q.limit).map(auditEventOfRow),
      total,
      hasMore: rows.length > q.limit,
    }
  },

  agentFacet: async (owner) => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare(
        `SELECT agent, COUNT(*) AS count FROM (
           SELECT agent FROM agent_retrievals
            WHERE owner = ? AND agent IS NOT NULL AND agent != ''
           UNION ALL
           SELECT agent_name AS agent FROM note_revisions
            WHERE agent_owner = ? AND integrity = 'trusted'
              AND agent_name IS NOT NULL AND agent_name != ''
         ) GROUP BY agent ORDER BY count DESC, agent ASC`,
      )
      .all(owner, owner) as Array<{ agent: string; count: number }>
    return rows.map((row) => ({ agent: row.agent, count: Number(row.count) }))
  },
})
