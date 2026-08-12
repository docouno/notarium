import { auditEventOfRow, type AuditEventRow } from '../../rows'
import type { AgentSessionAuditPersistence, AgentSessionAuditSummary } from '../../types'
import type { PgDriverCtx } from './context'

type SummaryRow = {
  id: string
  name: string
  named: boolean | null
  parent_id: string | null
  created_at: string
  last_seen_at: string
  calls: string | number | null
  reads: string | number
  writes: string | number
  retained: boolean
  active: boolean
  total_rows: string | number
  active_rows: string | number
}

const summaryOf = (r: SummaryRow): AgentSessionAuditSummary => ({
  id: r.id,
  name: r.name,
  named: r.named,
  parentId: r.parent_id,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
  calls: r.calls == null ? null : Number(r.calls),
  reads: Number(r.reads),
  writes: Number(r.writes),
  retained: r.retained,
  active: r.active,
})

const SUMMARY_CTES = `
  WITH audit_events AS (
    SELECT session_id, session_name, created_at, 1 AS reads, 0 AS writes
      FROM agent_retrievals
     WHERE owner = $1 AND session_id IS NOT NULL
    UNION ALL
    SELECT session_id, session_name, created_at, 0 AS reads, 1 AS writes
      FROM note_revisions
     WHERE agent_owner = $1 AND session_id IS NOT NULL
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
           GREATEST(sessions.last_seen_at, COALESCE(audit.last_at, sessions.last_seen_at)) AS last_seen_at,
           sessions.calls,
           COALESCE(audit.reads, 0) AS reads,
           COALESCE(audit.writes, 0) AS writes,
           true AS retained,
           sessions.last_seen_at >= $2 AS active
      FROM agent_sessions AS sessions
      LEFT JOIN audit ON audit.session_id = sessions.id
     WHERE sessions.owner = $1
    UNION ALL
    SELECT audit.session_id AS id,
           COALESCE(audit.session_name, 'Archived session') AS name,
           NULL::boolean AS named,
           NULL::text AS parent_id,
           audit.first_at AS created_at,
           audit.last_at AS last_seen_at,
           NULL::bigint AS calls,
           audit.reads,
           audit.writes,
           false AS retained,
           false AS active
      FROM audit
     WHERE NOT EXISTS (
       SELECT 1 FROM agent_sessions
        WHERE owner = $1 AND id = audit.session_id
     )
  ),
  stats AS (
    SELECT COUNT(*) AS total_rows,
           COALESCE(SUM(CASE WHEN active THEN 1 ELSE 0 END), 0) AS active_rows
      FROM combined
  )`

const EVENTS_CTE = `
  WITH events AS (
    SELECT 'retrieval' AS event_type, 1 AS source_rank,
           id, owner, principal, agent, session_id, session_name, session_attach,
           tool, query, project, class_filter, result_count, top_score, hits, created_at,
           NULL::text AS note_id, NULL::text AS space, NULL::text AS revision_kind,
           NULL::text AS revision_title, NULL::text AS revision_class,
           NULL::text AS revision_integrity
      FROM agent_retrievals
     WHERE owner = $1 AND session_id IS NOT DISTINCT FROM $2
    UNION ALL
    SELECT 'write' AS event_type, 0 AS source_rank,
           id, agent_owner AS owner, principal, agent_name AS agent,
           session_id, session_name, session_attach,
           NULL::text AS tool, '' AS query, NULL::text AS project, NULL::text AS class_filter,
           0 AS result_count, NULL::double precision AS top_score, NULL::text AS hits, created_at,
           note_id, space, kind AS revision_kind, title AS revision_title, class AS revision_class,
           integrity AS revision_integrity
      FROM note_revisions
     WHERE agent_owner = $1 AND session_id IS NOT DISTINCT FROM $2
  )`

export const createSessionAuditFacet = (ctx: PgDriverCtx): AgentSessionAuditPersistence => ({
  overview: async ({ owner, activeSince, limit, before }) => {
    await ctx.ensureInit()
    const params: unknown[] = [owner, activeSince]
    let cursor = ''

    if (before) {
      params.push(before.at, before.id)
      cursor =
        'WHERE (combined.last_seen_at < $3 OR (combined.last_seen_at = $3 AND combined.id < $4))'
    }
    params.push(limit + 1)
    const limitParam = `$${params.length}`
    const [result, outsideResult] = await Promise.all([
      ctx.required.query(
        `${SUMMARY_CTES}
         SELECT combined.*, stats.total_rows, stats.active_rows
           FROM stats LEFT JOIN combined ON ${cursor ? cursor.replace('WHERE ', '') : 'TRUE'}
          ORDER BY combined.last_seen_at DESC, combined.id DESC LIMIT ${limitParam}`,
        params,
      ),
      ctx.required.query(
        `SELECT SUM(reads) AS reads, SUM(writes) AS writes, MAX(created_at) AS last_seen_at
           FROM (
             SELECT 1 AS reads, 0 AS writes, created_at FROM agent_retrievals
              WHERE owner = $1 AND session_id IS NULL
             UNION ALL
             SELECT 0 AS reads, 1 AS writes, created_at FROM note_revisions
              WHERE agent_owner = $1 AND session_id IS NULL
           ) AS outside_events`,
        [owner],
      ),
    ])
    const rowsWithStats = result.rows as SummaryRow[]
    const rows = rowsWithStats.filter((row) => row.id != null)
    const outside = outsideResult.rows[0] as {
      reads: string | number | null
      writes: string | number | null
      last_seen_at: string | null
    }
    return {
      items: rows.slice(0, limit).map(summaryOf),
      total: Number(rowsWithStats[0]?.total_rows ?? 0),
      active: Number(rowsWithStats[0]?.active_rows ?? 0),
      outside: outside.last_seen_at
        ? {
            reads: Number(outside.reads ?? 0),
            writes: Number(outside.writes ?? 0),
            lastSeenAt: outside.last_seen_at,
          }
        : null,
      hasMore: rows.length > limit,
    }
  },

  find: async (owner, sessionId, activeSince) => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      `${SUMMARY_CTES}
       SELECT combined.*, stats.total_rows, stats.active_rows
         FROM combined CROSS JOIN stats WHERE combined.id = $3 LIMIT 1`,
      [owner, activeSince, sessionId],
    )
    const row = result.rows[0] as SummaryRow | undefined
    return row ? summaryOf(row) : null
  },

  events: async ({ owner, sessionId, type, limit, before }) => {
    await ctx.ensureInit()
    const countParams: unknown[] = [owner, sessionId]
    let countWhere = ''

    if (type) {
      countParams.push(type)
      countWhere = `WHERE event_type = $${countParams.length}`
    }
    const rowParams = [...countParams]
    const filters = countWhere ? [countWhere.replace('WHERE ', '')] : []

    if (before) {
      const rank = before.source === 'retrieval' ? 1 : 0
      rowParams.push(before.at)
      const at = `$${rowParams.length}`
      rowParams.push(rank)
      const source = `$${rowParams.length}`
      rowParams.push(before.id)
      const id = `$${rowParams.length}::bigint`
      filters.push(
        `(created_at < ${at} OR (created_at = ${at} AND (source_rank < ${source} OR (source_rank = ${source} AND id < ${id}))))`,
      )
    }
    rowParams.push(limit + 1)
    const rowWhere = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
    const [rowsResult, countResult] = await Promise.all([
      ctx.required.query(
        `${EVENTS_CTE} SELECT * FROM events ${rowWhere}
          ORDER BY created_at DESC, source_rank DESC, id DESC LIMIT $${rowParams.length}`,
        rowParams,
      ),
      ctx.required.query(
        `${EVENTS_CTE} SELECT COUNT(*) AS n FROM events ${countWhere}`,
        countParams,
      ),
    ])
    const rows = rowsResult.rows as AuditEventRow[]
    return {
      items: rows.slice(0, limit).map(auditEventOfRow),
      total: Number(countResult.rows[0].n),
      hasMore: rows.length > limit,
    }
  },
})
