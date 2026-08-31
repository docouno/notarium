import { auditEventOfRow, type AuditEventRow } from '../../rows'
import type {
  AgentCallRecord,
  AgentSessionAuditEvent,
  AgentSessionAuditPersistence,
  AgentSessionAuditSummary,
  AgentTraceJson,
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
  complete: number
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
  calls: number | null
  complete: number | null
  reads: number | null
  writes: number | null
}

type CallEventRow = {
  event_type: 'call'
  source_rank: 2
  id: string
  owner: string
  principal: string
  agent: string | null
  transport: AgentCallRecord['transport']
  request_id: string | null
  session_id: string | null
  session_name: string | null
  session_attach: AgentCallRecord['sessionAttach']
  tool: string
  effect: AgentCallRecord['effect']
  domain: string
  started_at: string
  finished_at: string
  duration_ms: number
  outcome: NonNullable<AgentCallRecord['outcome']>
  reason_code: string | null
  input_bytes: number
  output_bytes: number | null
  input_shape: string
  issue_summary: string | null
  target_summary: string | null
  result_summary: string | null
  fingerprint: string
  projection_version: number
  redacted: number
  truncated: number
  detail_capture_failed: number
}

const parseJson = (value: string | null): AgentTraceJson | null =>
  value == null ? null : (JSON.parse(value) as AgentTraceJson)

const callOf = (row: CallEventRow): AgentCallRecord => ({
  id: row.id,
  owner: row.owner,
  principal: row.principal,
  agent: row.agent,
  transport: row.transport,
  requestId: row.request_id,
  sessionId: row.session_id,
  sessionName: row.session_name,
  sessionAttach: row.session_attach,
  tool: row.tool,
  effect: row.effect,
  domain: row.domain,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  durationMs: Number(row.duration_ms),
  outcome: row.outcome,
  reasonCode: row.reason_code,
  inputBytes: Number(row.input_bytes),
  outputBytes: row.output_bytes == null ? null : Number(row.output_bytes),
  inputShape: parseJson(row.input_shape)!,
  issueSummary: parseJson(row.issue_summary),
  targetSummary: parseJson(row.target_summary),
  resultSummary: parseJson(row.result_summary),
  fingerprint: row.fingerprint,
  projectionVersion: row.projection_version,
  redacted: row.redacted === 1,
  truncated: row.truncated === 1,
  detailCaptureFailed: row.detail_capture_failed === 1,
})

const summaryOf = (row: SummaryRow): AgentSessionAuditSummary => ({
  id: row.id,
  name: row.name,
  named: row.named == null ? null : row.named === 1,
  parentId: row.parent_id,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  calls: row.calls == null ? null : Number(row.calls),
  reads: Number(row.reads),
  writes: Number(row.writes),
  retained: row.retained === 1,
  active: row.active === 1,
  complete: row.complete === 1,
})

const SUMMARY_CTES = `
  WITH cleanup_state AS (
    SELECT NOT EXISTS (
      SELECT 1 FROM agent_session_cleanup_markers WHERE owner = ?
    ) AS owner_clear
  ),
  audit_events AS (
    SELECT session_id, session_name, started_at AS created_at,
           1 AS calls,
           0 AS complete,
           CASE WHEN effect = 'read' THEN 1 ELSE 0 END AS reads,
           CASE WHEN effect = 'mutation' THEN 1 ELSE 0 END AS writes
      FROM agent_calls
     WHERE owner = ? AND session_id IS NOT NULL AND outcome IS NOT NULL
       AND (
         (SELECT owner_clear FROM cleanup_state) OR NOT EXISTS (
           SELECT 1 FROM agent_session_cleanup_markers marker
            WHERE marker.owner = agent_calls.owner AND marker.session_id = agent_calls.session_id
         )
       )
    UNION ALL
    SELECT session_id, session_name, created_at, 0 AS calls, 0 AS complete, 1 AS reads, 0 AS writes
     FROM agent_retrievals
     WHERE owner = ? AND session_id IS NOT NULL AND agent_call_id IS NULL
       AND (
         (SELECT owner_clear FROM cleanup_state) OR NOT EXISTS (
           SELECT 1 FROM agent_session_cleanup_markers marker
            WHERE marker.owner = agent_retrievals.owner
              AND marker.session_id = agent_retrievals.session_id
              AND marker.reason = 'human-delete'
         )
       )
    UNION ALL
    SELECT session_id, session_name, created_at, 0 AS calls, 0 AS complete, 0 AS reads, 1 AS writes
     FROM note_revisions INDEXED BY idx_note_revisions_agent_session_created
     WHERE agent_owner = ? AND session_id IS NOT NULL AND agent_call_id IS NULL
       AND (
         (SELECT owner_clear FROM cleanup_state) OR NOT EXISTS (
           SELECT 1 FROM agent_session_cleanup_markers marker
            WHERE marker.owner = note_revisions.agent_owner
              AND marker.session_id = note_revisions.session_id
              AND marker.reason = 'human-delete'
         )
       )
  ),
  audit AS (
    SELECT events.session_id,
           MAX(events.session_name) AS session_name,
           MIN(events.created_at) AS first_at,
           MAX(events.created_at) AS last_at,
           SUM(events.calls) AS calls,
           CASE WHEN EXISTS (
             SELECT 1 FROM agent_calls complete_start
              WHERE complete_start.owner = ?
                AND complete_start.session_id = events.session_id
                AND complete_start.tool = 'start_session'
                AND complete_start.outcome = 'success'
                AND json_extract(complete_start.result_summary, '$."session.state"')
                    IN ('new', 'forked')
           ) THEN 1 ELSE 0 END AS complete,
           SUM(events.reads) AS reads,
           SUM(events.writes) AS writes
      FROM audit_events events GROUP BY events.session_id
  ),
  combined AS (
    SELECT sessions.id,
           sessions.name,
           sessions.named,
           sessions.parent_id,
           sessions.created_at,
           MAX(sessions.last_seen_at, COALESCE(audit.last_at, sessions.last_seen_at)) AS last_seen_at,
           CASE WHEN COALESCE(audit.complete, 0) = 1 THEN audit.calls ELSE sessions.calls END AS calls,
           COALESCE(audit.complete, 0) AS complete,
           COALESCE(audit.reads, 0) AS reads,
           COALESCE(audit.writes, 0) AS writes,
           1 AS retained,
           CASE WHEN sessions.last_seen_at >= ? THEN 1 ELSE 0 END AS active
      FROM agent_sessions AS sessions
      LEFT JOIN audit ON audit.session_id = sessions.id
     WHERE sessions.owner = ?
       AND NOT EXISTS (
         SELECT 1 FROM agent_session_cleanup_markers marker
          WHERE marker.owner = sessions.owner AND marker.session_id = sessions.id
       )
    UNION ALL
    SELECT audit.session_id AS id,
           COALESCE(audit.session_name, 'Archived session') AS name,
           NULL AS named,
           NULL AS parent_id,
           audit.first_at AS created_at,
           audit.last_at AS last_seen_at,
           CASE WHEN audit.calls > 0 THEN audit.calls ELSE NULL END AS calls,
           audit.complete,
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
type EventSource = 'call' | 'retrieval' | 'write'
type SqlParam = string | number | bigint | null

const SOURCE_RANK: Record<EventSource, number> = { call: 2, retrieval: 1, write: 0 }

const eventSources = (query: EventQuery): EventSource[] => {
  if (query.outcome) {
    return ['call']
  }
  if (query.query) {
    return ['call', 'retrieval']
  }
  if (query.tool) {
    return [
      'call',
      ...(['search', 'recall', 'get_note'].includes(query.tool) && query.type !== 'write'
        ? ['retrieval' as const]
        : []),
    ]
  }
  if (query.type === 'retrieval') {
    return ['call', 'retrieval']
  }
  if (query.type === 'write') {
    return ['call', 'write']
  }

  return ['call', 'retrieval', 'write']
}

const sourceOwnerColumn = (source: EventSource): string =>
  source === 'write' ? 'agent_owner' : 'owner'

const sourceTimeColumn = (source: EventSource): string =>
  source === 'call' ? 'started_at' : 'created_at'

const sourceFilters = (
  query: EventQuery,
  source: EventSource,
  includeCursor: boolean,
): { sql: string; params: SqlParam[] } => {
  const ownerColumn = sourceOwnerColumn(source)
  const timeColumn = sourceTimeColumn(source)
  const filters = [`${ownerColumn} = ?`]
  const params: SqlParam[] = [query.owner]

  if (source === 'call') {
    filters.push('outcome IS NOT NULL')
    if (query.scope.kind === 'session') {
      filters.push(`NOT EXISTS (
        SELECT 1 FROM agent_session_cleanup_markers marker
         WHERE marker.owner = ? AND marker.session_id = ?
      )`)
      params.push(query.owner, query.scope.id)
    } else if (query.scope.kind === 'all') {
      filters.push(`(
        NOT EXISTS (SELECT 1 FROM agent_session_cleanup_markers WHERE owner = ?)
        OR session_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM agent_session_cleanup_markers marker
           WHERE marker.owner = agent_calls.owner AND marker.session_id = agent_calls.session_id
        )
      )`)
      params.push(query.owner)
    }
  } else {
    const table = source === 'write' ? 'note_revisions' : 'agent_retrievals'
    filters.push('agent_call_id IS NULL')
    if (query.scope.kind === 'session') {
      filters.push(`NOT EXISTS (
        SELECT 1 FROM agent_session_cleanup_markers marker
         WHERE marker.owner = ? AND marker.session_id = ? AND marker.reason = 'human-delete'
      )`)
      params.push(query.owner, query.scope.id)
    } else if (query.scope.kind === 'all') {
      filters.push(`(
        NOT EXISTS (SELECT 1 FROM agent_session_cleanup_markers WHERE owner = ?)
        OR session_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM agent_session_cleanup_markers marker
           WHERE marker.owner = ${ownerColumn} AND marker.session_id = ${table}.session_id
             AND marker.reason = 'human-delete'
        )
      )`)
      params.push(query.owner)
    }
  }
  if (query.scope.kind === 'session') {
    filters.push('session_id = ?')
    params.push(query.scope.id)
  } else if (query.scope.kind === 'outside') {
    filters.push('session_id IS NULL')
  }
  if (query.agent) {
    filters.push(source === 'write' ? "integrity = 'trusted' AND agent_name = ?" : 'agent = ?')
    params.push(query.agent)
  }
  if (query.type === 'retrieval' && source === 'call') {
    filters.push("effect = 'read'")
  }
  if (query.type === 'write' && source === 'call') {
    filters.push("effect = 'mutation'")
  }
  if (query.tool) {
    if (source === 'write') {
      filters.push('0')
    } else {
      filters.push('tool = ?')
      params.push(query.tool)
    }
  }
  if (query.query) {
    if (source === 'call') {
      filters.push("tool IN ('search', 'recall', 'get_note')")
    }
    filters.push(
      source === 'call'
        ? "lower_u(COALESCE(json_extract(target_summary, '$.query'), json_extract(target_summary, '$.ref'))) LIKE ? ESCAPE '\\'"
        : "lower_u(query) LIKE ? ESCAPE '\\'",
    )
    params.push(`%${query.query.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`)
  }
  if (source === 'call' && query.outcome) {
    if (query.outcome === 'errors') {
      filters.push("outcome <> 'success'")
    } else {
      filters.push('outcome = ?')
      params.push(query.outcome)
    }
  }
  if (includeCursor && query.before) {
    if (source === query.before.source) {
      filters.push(`(${timeColumn}, id) < (?, ?)`)
      params.push(query.before.at, source === 'call' ? query.before.id : BigInt(query.before.id))
    } else if (SOURCE_RANK[source] > SOURCE_RANK[query.before.source]) {
      filters.push(`${timeColumn} < ?`)
      params.push(query.before.at)
    } else {
      filters.push(`${timeColumn} <= ?`)
      params.push(query.before.at)
    }
  }

  return { sql: filters.join(' AND '), params }
}

const sourceTable = (source: EventSource): string =>
  source === 'call' ? 'agent_calls' : source === 'retrieval' ? 'agent_retrievals' : 'note_revisions'

const page = (
  ctx: SqliteDriverCtx,
  query: EventQuery,
  source: EventSource,
): Array<CallEventRow | AuditEventRow> => {
  const where = sourceFilters(query, source, true)
  const timeColumn = sourceTimeColumn(source)
  const select =
    source === 'call'
      ? `SELECT 'call' AS event_type, 2 AS source_rank, *`
      : source === 'retrieval'
        ? `SELECT 'retrieval' AS event_type, 1 AS source_rank,
                  id, owner, principal, agent, session_id, session_name, session_attach, agent_call_id,
                  tool, query, project, class_filter, result_count, top_score, hits, created_at,
                  NULL AS note_id, NULL AS space, NULL AS revision_kind,
                  NULL AS revision_title, NULL AS revision_class, NULL AS revision_integrity`
        : `SELECT 'write' AS event_type, 0 AS source_rank,
                  id, agent_call_id, agent_owner AS owner, principal, agent_name AS agent,
                  session_id, session_name, session_attach,
                  NULL AS tool, '' AS query, NULL AS project, NULL AS class_filter,
                  0 AS result_count, NULL AS top_score, NULL AS hits, created_at,
                  note_id, space, kind AS revision_kind, title AS revision_title,
                  class AS revision_class, integrity AS revision_integrity`
  return ctx.required
    .prepare(
      `${select} FROM ${sourceTable(source)} WHERE ${where.sql}
        ORDER BY ${timeColumn} DESC, id DESC LIMIT ?`,
    )
    .all(...where.params, query.limit + 1) as Array<CallEventRow | AuditEventRow>
}

const eventOf = (row: CallEventRow | AuditEventRow): AgentSessionAuditEvent =>
  row.event_type === 'call' ? { type: 'call', record: callOf(row) } : auditEventOfRow(row)

const eventAt = (event: AgentSessionAuditEvent): string =>
  event.type === 'call'
    ? event.record.startedAt
    : event.type === 'retrieval'
      ? event.record.createdAt
      : event.at

const eventId = (event: AgentSessionAuditEvent): string =>
  event.type === 'call' ? event.record.id : event.type === 'retrieval' ? event.record.id : event.id

export const createSessionAuditFacet = (ctx: SqliteDriverCtx): AgentSessionAuditPersistence => ({
  overview: async ({ owner, activeSince, type, limit, before }) => {
    await ctx.ensureInit()
    const typeFilter =
      type === 'retrieval' ? 'WHERE reads > 0' : type === 'write' ? 'WHERE writes > 0' : ''
    const cursor = before
      ? 'WHERE (filtered.last_seen_at < ? OR (filtered.last_seen_at = ? AND filtered.id < ?))'
      : ''
    const params: Array<string | number> = [
      owner,
      owner,
      owner,
      owner,
      owner,
      activeSince,
      owner,
      owner,
    ]

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
             SELECT CASE WHEN effect = 'read' THEN 1 ELSE 0 END AS reads,
                    CASE WHEN effect = 'mutation' THEN 1 ELSE 0 END AS writes,
                    started_at AS created_at
               FROM agent_calls WHERE owner = ? AND session_id IS NULL AND outcome IS NOT NULL
             UNION ALL
             SELECT 1, 0, created_at FROM agent_retrievals
              WHERE owner = ? AND session_id IS NULL AND agent_call_id IS NULL
             UNION ALL
             SELECT 0, 1, created_at FROM note_revisions
              WHERE agent_owner = ? AND session_id IS NULL AND agent_call_id IS NULL
           )`,
      )
      .get(owner, owner, owner) as {
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
           FROM agent_sessions WHERE owner = ? AND id = ?
             AND NOT EXISTS (
               SELECT 1 FROM agent_session_cleanup_markers marker
                WHERE marker.owner = agent_sessions.owner AND marker.session_id = agent_sessions.id
             ) LIMIT 1`,
      )
      .get(owner, sessionId) as RetainedSessionRow | undefined
    const audit = ctx.required
      .prepare(
        `SELECT MIN(session_id) AS session_id,
                MAX(session_name) AS session_name,
                MIN(created_at) AS first_at,
                MAX(created_at) AS last_at,
                SUM(calls) AS calls,
                MAX(complete) AS complete,
                SUM(reads) AS reads,
                SUM(writes) AS writes
           FROM (
             SELECT session_id, session_name, started_at AS created_at, 1 AS calls,
                    CASE WHEN tool = 'start_session' AND outcome = 'success' AND projection_version >= 1
                               AND json_extract(result_summary, '$."session.state"') IN ('new', 'forked')
                         THEN 1 ELSE 0 END AS complete,
                    CASE WHEN effect = 'read' THEN 1 ELSE 0 END AS reads,
                    CASE WHEN effect = 'mutation' THEN 1 ELSE 0 END AS writes
               FROM agent_calls WHERE owner = ? AND session_id = ? AND outcome IS NOT NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM agent_session_cleanup_markers marker
                    WHERE marker.owner = agent_calls.owner AND marker.session_id = agent_calls.session_id
                 )
             UNION ALL
             SELECT session_id, session_name, created_at, 0, 0, 1, 0
               FROM agent_retrievals WHERE owner = ? AND session_id = ? AND agent_call_id IS NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM agent_session_cleanup_markers marker
                    WHERE marker.owner = agent_retrievals.owner
                      AND marker.session_id = agent_retrievals.session_id
                      AND marker.reason = 'human-delete'
                 )
             UNION ALL
             SELECT session_id, session_name, created_at, 0, 0, 0, 1
               FROM note_revisions WHERE agent_owner = ? AND session_id = ? AND agent_call_id IS NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM agent_session_cleanup_markers marker
                    WHERE marker.owner = note_revisions.agent_owner
                      AND marker.session_id = note_revisions.session_id
                      AND marker.reason = 'human-delete'
                 )
           )`,
      )
      .get(owner, sessionId, owner, sessionId, owner, sessionId) as SessionAuditRow

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
      calls:
        Number(audit.complete ?? 0) === 1
          ? Number(audit.calls ?? 0)
          : retained
            ? Number(retained.calls)
            : Number(audit.calls ?? 0) || null,
      reads: Number(audit.reads ?? 0),
      writes: Number(audit.writes ?? 0),
      retained: retained != null,
      active: retained != null && retained.last_seen_at >= activeSince,
      complete: Number(audit.complete ?? 0) === 1,
    }
  },

  events: async (query) => {
    await ctx.ensureInit()
    const sources = eventSources(query)
    const items = sources
      .flatMap((source) => page(ctx, query, source).map(eventOf))
      .sort((left, right) => {
        const byTime = eventAt(right).localeCompare(eventAt(left))

        if (byTime) {
          return byTime
        }
        const bySource = SOURCE_RANK[right.type] - SOURCE_RANK[left.type]
        return bySource || eventId(right).localeCompare(eventId(left))
      })
    let total: number | null = null

    if (query.scope.kind === 'session' && query.withTotal !== false) {
      total = sources.reduce((sum, source) => {
        const where = sourceFilters(query, source, false)
        const count = ctx.required
          .prepare(`SELECT COUNT(*) AS n FROM ${sourceTable(source)} WHERE ${where.sql}`)
          .get(...where.params) as { n: number }
        return sum + Number(count.n)
      }, 0)
    }

    return {
      items: items.slice(0, query.limit),
      total,
      hasMore: items.length > query.limit,
    }
  },

  agentFacet: async (owner) => {
    await ctx.ensureInit()
    ctx.required.exec('BEGIN')

    try {
      const hasMarkers = Boolean(
        ctx.required
          .prepare('SELECT 1 FROM agent_session_cleanup_markers WHERE owner = ? LIMIT 1')
          .get(owner),
      )
      const callVisibility = hasMarkers
        ? `AND (session_id IS NULL OR NOT EXISTS (
             SELECT 1 FROM agent_session_cleanup_markers marker
              WHERE marker.owner = agent_calls.owner
                AND marker.session_id = agent_calls.session_id
           ))`
        : ''
      const legacyVisibility = (table: 'agent_retrievals' | 'note_revisions') =>
        hasMarkers
          ? `AND (session_id IS NULL OR NOT EXISTS (
               SELECT 1 FROM agent_session_cleanup_markers marker
                WHERE marker.owner = ${table === 'note_revisions' ? `${table}.agent_owner` : `${table}.owner`}
                  AND marker.session_id = ${table}.session_id
                  AND marker.reason = 'human-delete'
             ))`
          : ''
      const rows = ctx.required
        .prepare(
          `WITH agent_counts AS (
             SELECT agent, COUNT(*) AS count FROM agent_calls
              WHERE owner = ? AND outcome IS NOT NULL AND agent IS NOT NULL AND agent != ''
                ${callVisibility}
              GROUP BY agent
             UNION ALL
             SELECT agent, COUNT(*) FROM agent_retrievals
              WHERE owner = ? AND agent_call_id IS NULL AND agent IS NOT NULL AND agent != ''
                ${legacyVisibility('agent_retrievals')}
              GROUP BY agent
             UNION ALL
             SELECT agent_name AS agent, COUNT(*) FROM note_revisions
              WHERE agent_owner = ? AND agent_call_id IS NULL AND integrity = 'trusted'
                AND agent_name IS NOT NULL AND agent_name != ''
                ${legacyVisibility('note_revisions')}
              GROUP BY agent_name
           )
           SELECT agent, SUM(count) AS count FROM agent_counts
            GROUP BY agent ORDER BY count DESC, agent ASC`,
        )
        .all(owner, owner, owner) as Array<{ agent: string; count: number }>
      ctx.required.exec('COMMIT')
      return rows.map((row) => ({ agent: row.agent, count: Number(row.count) }))
    } catch (error) {
      if (ctx.required.isTransaction) {
        ctx.required.exec('ROLLBACK')
      }
      throw error
    }
  },
})
