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

type RetainedSessionRow = {
  id: string
  name: string
  named: boolean
  parent_id: string | null
  created_at: string
  last_seen_at: string
  calls: string | number
}

type SessionAuditRow = {
  session_id: string | null
  session_name: string | null
  first_at: string | null
  last_at: string | null
  reads: string | number | null
  writes: string | number | null
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
  )`

type EventQuery = Parameters<AgentSessionAuditPersistence['events']>[0]
type EventSource = 'retrieval' | 'write'

const eventSources = (q: EventQuery): EventSource[] => {
  if (q.type === 'retrieval' || q.tool || q.query) {
    return ['retrieval']
  }

  return q.type === 'write' ? ['write'] : ['retrieval', 'write']
}

const bind = (params: unknown[], value: unknown): string => {
  params.push(value)
  return `$${params.length}`
}

const sourceFilters = (
  q: EventQuery,
  source: EventSource,
  includeCursor: boolean,
  params: unknown[],
): string => {
  const owner = bind(params, q.owner)
  const filters = [source === 'retrieval' ? `owner = ${owner}` : `agent_owner = ${owner}`]

  if (q.scope.kind === 'session') {
    filters.push(`session_id = ${bind(params, q.scope.id)}`)
  } else if (q.scope.kind === 'outside') {
    filters.push('session_id IS NULL')
  }
  if (q.agent) {
    const agent = bind(params, q.agent)
    filters.push(
      source === 'retrieval'
        ? `agent = ${agent}`
        : `integrity = 'trusted' AND agent_name = ${agent}`,
    )
  }
  if (source === 'retrieval') {
    if (q.tool) {
      filters.push(`tool = ${bind(params, q.tool)}`)
    }
    if (q.query) {
      const pattern = `%${q.query.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`
      filters.push(`LOWER(query) LIKE ${bind(params, pattern)} ESCAPE '\\'`)
    }
  }
  if (includeCursor && q.before) {
    if (source === q.before.source) {
      const at = bind(params, q.before.at)
      const id = bind(params, q.before.id)
      filters.push(`(created_at < ${at} OR (created_at = ${at} AND id < ${id}::bigint))`)
    } else if (source === 'retrieval') {
      filters.push(`created_at < ${bind(params, q.before.at)}`)
    } else {
      filters.push(`created_at <= ${bind(params, q.before.at)}`)
    }
  }

  return filters.join(' AND ')
}

const pageBranch = (q: EventQuery, source: EventSource, params: unknown[]): string => {
  const where = sourceFilters(q, source, true, params)
  const limit = bind(params, q.limit + 1)
  const select =
    source === 'retrieval'
      ? `SELECT 'retrieval' AS event_type, 1 AS source_rank,
                id, owner, principal, agent, session_id, session_name, session_attach,
                tool, query, project, class_filter, result_count, top_score, hits, created_at,
                NULL::text AS note_id, NULL::text AS space, NULL::text AS revision_kind,
                NULL::text AS revision_title, NULL::text AS revision_class,
                NULL::text AS revision_integrity`
      : `SELECT 'write' AS event_type, 0 AS source_rank,
                id, agent_owner AS owner, principal, agent_name AS agent,
                session_id, session_name, session_attach,
                NULL::text AS tool, '' AS query, NULL::text AS project,
                NULL::text AS class_filter, 0 AS result_count,
                NULL::double precision AS top_score, NULL::text AS hits, created_at,
                note_id, space, kind AS revision_kind, title AS revision_title,
                class AS revision_class, integrity AS revision_integrity`
  const table = source === 'retrieval' ? 'agent_retrievals' : 'note_revisions'
  return `SELECT * FROM (
            ${select} FROM ${table} WHERE ${where}
             ORDER BY created_at DESC, id DESC LIMIT ${limit}
          ) AS ${source}_window`
}

export const createSessionAuditFacet = (ctx: PgDriverCtx): AgentSessionAuditPersistence => ({
  overview: async ({ owner, activeSince, type, limit, before }) => {
    await ctx.ensureInit()
    const params: unknown[] = [owner, activeSince]
    const typeFilter =
      type === 'retrieval' ? 'WHERE reads > 0' : type === 'write' ? 'WHERE writes > 0' : ''
    let cursor = ''

    if (before) {
      params.push(before.at, before.id)
      cursor =
        'WHERE (filtered.last_seen_at < $3 OR (filtered.last_seen_at = $3 AND filtered.id < $4))'
    }
    params.push(limit + 1)
    const limitParam = `$${params.length}`
    const [result, outsideResult] = await Promise.all([
      ctx.required.query(
        `${SUMMARY_CTES},
         filtered AS (SELECT * FROM combined ${typeFilter}),
         stats AS (
           SELECT COUNT(*) AS total_rows,
                  COALESCE(SUM(CASE WHEN active THEN 1 ELSE 0 END), 0) AS active_rows
             FROM filtered
         )
         SELECT filtered.*, stats.total_rows, stats.active_rows
           FROM stats LEFT JOIN filtered ON ${cursor ? cursor.replace('WHERE ', '') : 'TRUE'}
          ORDER BY filtered.last_seen_at DESC, filtered.id DESC LIMIT ${limitParam}`,
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
      items: rows.slice(0, limit).map(summaryOf),
      total: Number(rowsWithStats[0]?.total_rows ?? 0),
      active: Number(rowsWithStats[0]?.active_rows ?? 0),
      outside: outsideMatches ? outsideSummary : null,
      hasMore: rows.length > limit,
    }
  },

  find: async (owner, sessionId, activeSince) => {
    await ctx.ensureInit()
    const [retainedResult, auditResult] = await Promise.all([
      ctx.required.query(
        `SELECT id, name, named, parent_id, created_at, last_seen_at, calls
           FROM agent_sessions WHERE owner = $1 AND id = $2 LIMIT 1`,
        [owner, sessionId],
      ),
      ctx.required.query(
        `SELECT MIN(session_id) AS session_id,
                MAX(session_name) AS session_name,
                MIN(created_at) AS first_at,
                MAX(created_at) AS last_at,
                SUM(reads) AS reads,
                SUM(writes) AS writes
           FROM (
             SELECT session_id, session_name, created_at, 1 AS reads, 0 AS writes
               FROM agent_retrievals WHERE owner = $1 AND session_id = $2
             UNION ALL
             SELECT session_id, session_name, created_at, 0 AS reads, 1 AS writes
               FROM note_revisions WHERE agent_owner = $1 AND session_id = $2
           ) AS target_events`,
        [owner, sessionId],
      ),
    ])
    const retained = retainedResult.rows[0] as RetainedSessionRow | undefined
    const audit = auditResult.rows[0] as SessionAuditRow

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
      named: retained?.named ?? null,
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
    const rowParams: unknown[] = []
    const branches = sources.map((source) => pageBranch(q, source, rowParams))
    const outerLimit = bind(rowParams, q.limit + 1)
    const rowsResult = await ctx.required.query(
      `WITH events AS (${branches.join(' UNION ALL ')})
       SELECT * FROM events
        ORDER BY created_at DESC, source_rank DESC, id DESC LIMIT ${outerLimit}`,
      rowParams,
    )
    const rows = rowsResult.rows as AuditEventRow[]
    let total: number | null = null

    if (q.scope.kind === 'session') {
      const counts = await Promise.all(
        sources.map(async (source) => {
          const countParams: unknown[] = []
          const where = sourceFilters(q, source, false, countParams)
          const table = source === 'retrieval' ? 'agent_retrievals' : 'note_revisions'
          const result = await ctx.required.query(
            `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`,
            countParams,
          )
          return Number(result.rows[0].n)
        }),
      )
      total = counts.reduce((sum, count) => sum + count, 0)
    }

    return {
      items: rows.slice(0, q.limit).map(auditEventOfRow),
      total,
      hasMore: rows.length > q.limit,
    }
  },

  agentFacet: async (owner) => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      `SELECT agent, COUNT(*) AS count FROM (
         SELECT agent FROM agent_retrievals
          WHERE owner = $1 AND agent IS NOT NULL AND agent != ''
         UNION ALL
         SELECT agent_name AS agent FROM note_revisions
          WHERE agent_owner = $1 AND integrity = 'trusted'
            AND agent_name IS NOT NULL AND agent_name != ''
       ) AS attributed
       GROUP BY agent ORDER BY count DESC, agent ASC`,
      [owner],
    )
    return (result.rows as Array<{ agent: string; count: string | number }>).map((row) => ({
      agent: row.agent,
      count: Number(row.count),
    }))
  },
})
