import { AGENT_CALL_OUTCOME } from '@notarium/contract'

import { auditEventOfRow, type AuditEventRow, retrievalOfRow, type RetrievalRow } from '../../rows'
import type {
  AgentCallAdmission,
  AgentCallFinal,
  AgentCallRecord,
  AgentCallTracePersistence,
  AgentTelemetryConfig,
  AgentTraceJson,
} from '../../types'
import type { SqliteDriverCtx } from './context'

type AgentCallRow = {
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
  finished_at: string | null
  duration_ms: number | bigint | null
  outcome: AgentCallRecord['outcome']
  reason_code: string | null
  input_bytes: number | bigint
  output_bytes: number | bigint | null
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

const COLUMNS =
  'id, owner, principal, agent, transport, request_id, session_id, session_name, session_attach, tool, effect, domain, started_at, finished_at, duration_ms, outcome, reason_code, input_bytes, output_bytes, input_shape, issue_summary, target_summary, result_summary, fingerprint, projection_version, redacted, truncated, detail_capture_failed'

const parseJson = (value: string | null): AgentTraceJson | null =>
  value == null ? null : (JSON.parse(value) as AgentTraceJson)

const callOf = (row: AgentCallRow): AgentCallRecord => ({
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
  durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
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

const configOf = (row: {
  detailed_enabled: number
  compact_retention_days: AgentTelemetryConfig['compactRetentionDays']
  detailed_retention_days: AgentTelemetryConfig['detailedRetentionDays']
  version: number | bigint
  updated_at: string
}): AgentTelemetryConfig => ({
  detailedEnabled: row.detailed_enabled === 1,
  compactRetentionDays: row.compact_retention_days,
  detailedRetentionDays: row.detailed_retention_days,
  versionToken: `v${String(row.version)}`,
  updatedAt: row.updated_at,
})

const configRow = (ctx: SqliteDriverCtx): AgentTelemetryConfig =>
  configOf(
    ctx.required
      .prepare(
        `SELECT detailed_enabled, compact_retention_days, detailed_retention_days, version, updated_at
           FROM agent_telemetry_config WHERE singleton = 1`,
      )
      .get() as Parameters<typeof configOf>[0],
  )

const cleanupSession = (
  ctx: SqliteDriverCtx,
  owner: string,
  sessionId: string,
  reason: 'retention' | 'human-delete',
  batchSize: number,
): { complete: boolean; processed: number } => {
  const details = ctx.required
    .prepare(
      `DELETE FROM agent_call_details WHERE agent_call_id IN (
         SELECT id FROM agent_calls INDEXED BY idx_agent_calls_owner_session_started
          WHERE owner = ? AND session_id = ?
          ORDER BY started_at, id LIMIT ?
       )`,
    )
    .run(owner, sessionId, batchSize)
  const retrievals = ctx.required
    .prepare(
      `DELETE FROM agent_retrievals WHERE id IN (
         SELECT id FROM agent_retrievals
          INDEXED BY idx_agent_retrievals_owner_session_created
          WHERE owner = ? AND session_id = ?
            AND (? = 'human-delete' OR agent_call_id IS NOT NULL)
          ORDER BY created_at, id LIMIT ?
       )`,
    )
    .run(owner, sessionId, reason, batchSize)
  const calls = ctx.required
    .prepare(
      `DELETE FROM agent_calls WHERE id IN (
         SELECT id FROM agent_calls INDEXED BY idx_agent_calls_owner_session_started
          WHERE owner = ? AND session_id = ?
          ORDER BY started_at, id LIMIT ?
       )`,
    )
    .run(owner, sessionId, batchSize)
  const remaining = ctx.required
    .prepare(
      `SELECT
         EXISTS(SELECT 1 FROM agent_calls WHERE owner = ? AND session_id = ?) AS calls_left,
         EXISTS(
           SELECT 1 FROM agent_retrievals
            WHERE owner = ? AND session_id = ?
              AND (? = 'human-delete' OR agent_call_id IS NOT NULL)
         ) AS retrievals_left`,
    )
    .get(owner, sessionId, owner, sessionId, reason) as {
    calls_left: number
    retrievals_left: number
  }
  const complete = remaining.calls_left === 0 && remaining.retrievals_left === 0
  const processed = Number(details.changes) + Number(retrievals.changes) + Number(calls.changes)

  if (complete) {
    const updated = ctx.required
      .prepare(
        `UPDATE agent_session_cleanup_markers SET cleanup_pending = 0
          WHERE owner = ? AND session_id = ? AND reason = ? AND cleanup_pending = 1`,
      )
      .run(owner, sessionId, reason)
    return { complete: updated.changes === 1, processed }
  }

  return { complete: false, processed }
}

const expireSession = (
  ctx: SqliteDriverCtx,
  input: {
    owner: string
    sessionId: string
    expiredBefore: string
    acceptedAt: string
    batchSize: number
  },
): 'fresh' | 'dominated' | 'deleting' | 'complete' => {
  const marker = ctx.required
    .prepare('SELECT reason FROM agent_session_cleanup_markers WHERE owner = ? AND session_id = ?')
    .get(input.owner, input.sessionId) as { reason: 'retention' | 'human-delete' } | undefined

  if (marker?.reason === 'human-delete') {
    return 'dominated'
  }
  if (!marker) {
    const lifecycle = ctx.required
      .prepare(
        `SELECT sessions.last_seen_at,
                EXISTS(
                  SELECT 1 FROM agent_calls complete_start
                   INDEXED BY idx_agent_calls_complete_start
                   WHERE complete_start.owner = sessions.owner
                     AND complete_start.session_id = sessions.id
                     AND complete_start.tool = 'start_session'
                     AND complete_start.outcome = 'success'
                     AND json_extract(complete_start.result_summary, '$."session.state"')
                         IN ('new', 'forked')
                ) AS complete_start
           FROM agent_sessions sessions WHERE sessions.owner = ? AND sessions.id = ?`,
      )
      .get(input.owner, input.sessionId) as
      | {
          last_seen_at: string
          complete_start: number
        }
      | undefined

    if (
      !lifecycle ||
      lifecycle.complete_start !== 1 ||
      lifecycle.last_seen_at >= input.expiredBefore
    ) {
      return 'fresh'
    }
    ctx.required
      .prepare(
        `INSERT INTO agent_session_cleanup_markers
           (owner, session_id, reason, accepted_at, cleanup_pending)
         VALUES (?, ?, 'retention', ?, 1)`,
      )
      .run(input.owner, input.sessionId, input.acceptedAt)
    ctx.required
      .prepare('DELETE FROM mcp_delta_session_cursors WHERE session_id = ?')
      .run(input.sessionId)
    ctx.required
      .prepare('DELETE FROM agent_sessions WHERE owner = ? AND id = ?')
      .run(input.owner, input.sessionId)
  }

  return cleanupSession(ctx, input.owner, input.sessionId, 'retention', input.batchSize).complete
    ? 'complete'
    : 'deleting'
}

export const createAgentCallsFacet = (ctx: SqliteDriverCtx): AgentCallTracePersistence => ({
  admit: async (input: AgentCallAdmission) => {
    await ctx.ensureInit()
    ctx.required
      .prepare(
        `INSERT INTO agent_calls
           (id, owner, principal, agent, transport, request_id, session_id, session_name,
            session_attach, tool, effect, domain, started_at, finished_at, duration_ms,
            outcome, reason_code, input_bytes, output_bytes, input_shape, issue_summary,
            target_summary, result_summary, fingerprint, projection_version, redacted,
            truncated, detail_capture_failed)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, NULL, NULL, NULL,
                 NULL, ?, NULL, ?, NULL, ?, NULL, ?, ?, ?, ?, 0)`,
      )
      .run(
        input.id,
        input.owner,
        input.principal,
        input.agent,
        input.transport,
        input.requestId,
        input.tool,
        input.effect,
        input.domain,
        input.startedAt,
        input.inputBytes,
        JSON.stringify(input.inputShape),
        input.targetSummary == null ? null : JSON.stringify(input.targetSummary),
        input.fingerprint,
        input.projectionVersion,
        input.redacted ? 1 : 0,
        input.truncated ? 1 : 0,
      )
  },

  projectInput: async (owner, id, targetSummary, redacted, truncated) => {
    await ctx.ensureInit()
    const result = ctx.required
      .prepare(
        'UPDATE agent_calls SET target_summary = ?, redacted = ?, truncated = ? WHERE owner = ? AND id = ? AND outcome IS NULL',
      )
      .run(JSON.stringify(targetSummary), redacted ? 1 : 0, truncated ? 1 : 0, owner, id)
    return result.changes === 1
  },

  bind: async (owner, id, session) => {
    await ctx.ensureInit()
    const result = ctx.required
      .prepare(
        `UPDATE agent_calls
            SET session_id = ?, session_name = ?, session_attach = ?
          WHERE owner = ? AND id = ?
            AND NOT EXISTS (
              SELECT 1 FROM agent_session_cleanup_markers marker
               WHERE marker.owner = ? AND marker.session_id = ?
            )`,
      )
      .run(session.id, session.name, session.attach, owner, id, owner, session.id)
    return result.changes === 1
  },

  discard: async (owner, id) => {
    await ctx.ensureInit()
    ctx.required.prepare('DELETE FROM agent_calls WHERE owner = ? AND id = ?').run(owner, id)
  },

  finalize: async (owner: string, id: string, final: AgentCallFinal) => {
    await ctx.ensureInit()
    const result = ctx.required
      .prepare(
        `UPDATE agent_calls
            SET finished_at = ?, duration_ms = ?, outcome = ?, reason_code = ?,
                output_bytes = ?, issue_summary = ?, result_summary = ?, redacted = ?,
                truncated = ?, detail_capture_failed = ?, fingerprint = ?
          WHERE owner = ? AND id = ? AND outcome IS NULL
            AND (
              session_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM agent_session_cleanup_markers marker
                 WHERE marker.owner = agent_calls.owner
                   AND marker.session_id = agent_calls.session_id
              )
            )`,
      )
      .run(
        final.finishedAt,
        final.durationMs,
        final.outcome,
        final.reasonCode,
        final.outputBytes,
        final.issueSummary == null ? null : JSON.stringify(final.issueSummary),
        final.resultSummary == null ? null : JSON.stringify(final.resultSummary),
        final.redacted ? 1 : 0,
        final.truncated ? 1 : 0,
        final.detailCaptureFailed ? 1 : 0,
        final.fingerprint,
        owner,
        id,
      )

    if (result.changes === 1) {
      ctx.required
        .prepare(
          `UPDATE agent_sessions SET last_seen_at = MAX(last_seen_at, ?)
            WHERE owner = ? AND id = (
              SELECT session_id FROM agent_calls WHERE owner = ? AND id = ?
                AND tool NOT IN ('use_skill', 'whoami', 'get_my_projects')
            )`,
        )
        .run(final.finishedAt, owner, owner, id)
    }

    return result.changes === 1
  },

  appendDetail: async (input) => {
    await ctx.ensureInit()
    const result = ctx.required
      .prepare(
        `INSERT INTO agent_call_details (agent_call_id, payload, created_at, expires_at)
         SELECT c.id, ?, ?, ? FROM agent_calls c
          WHERE c.id = ? AND c.owner = ?
            AND (
              c.session_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM agent_session_cleanup_markers marker
                 WHERE marker.owner = c.owner AND marker.session_id = c.session_id
              )
            )
         ON CONFLICT(agent_call_id) DO UPDATE SET
           payload = excluded.payload,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at`,
      )
      .run(JSON.stringify(input.payload), input.createdAt, input.expiresAt, input.id, input.owner)
    return result.changes === 1
  },

  get: async (owner, id) => {
    await ctx.ensureInit()
    const row = ctx.required
      .prepare(
        `SELECT ${COLUMNS} FROM agent_calls AS call
          WHERE owner = ? AND id = ?
            AND NOT EXISTS (
              SELECT 1 FROM agent_session_cleanup_markers marker
               WHERE marker.owner = call.owner AND marker.session_id = call.session_id
            )`,
      )
      .get(owner, id) as AgentCallRow | undefined
    return row ? callOf(row) : null
  },

  getDetail: async (owner, id, now) => {
    await ctx.ensureInit()
    const row = ctx.required
      .prepare(
        `SELECT detail.payload FROM agent_call_details detail
           JOIN agent_calls c ON c.id = detail.agent_call_id
          WHERE c.owner = ? AND c.id = ? AND detail.expires_at >= ?
            AND NOT EXISTS (
              SELECT 1 FROM agent_session_cleanup_markers marker
               WHERE marker.owner = c.owner AND marker.session_id = c.session_id
            )`,
      )
      .get(owner, id, now) as { payload: string } | undefined
    return row ? parseJson(row.payload) : null
  },

  links: async (owner, id) => {
    await ctx.ensureInit()
    const retrievals = ctx.required
      .prepare(
        `SELECT retrieval.id, retrieval.agent_call_id, retrieval.owner, retrieval.principal,
                retrieval.agent, retrieval.session_id, retrieval.session_name,
                retrieval.session_attach, retrieval.tool, retrieval.query, retrieval.project,
                retrieval.class_filter, retrieval.result_count, retrieval.top_score,
                retrieval.hits, retrieval.created_at
           FROM agent_retrievals retrieval INDEXED BY idx_agent_retrievals_agent_call
           JOIN agent_calls c ON c.id = retrieval.agent_call_id
          WHERE retrieval.owner = ? AND retrieval.agent_call_id = ? AND c.owner = ?
            AND NOT EXISTS (
              SELECT 1 FROM agent_session_cleanup_markers marker
               WHERE marker.owner = c.owner AND marker.session_id = c.session_id
            )
           ORDER BY retrieval.created_at, retrieval.id`,
      )
      .all(owner, id, owner) as RetrievalRow[]
    const revisions = ctx.required
      .prepare(
        `SELECT 'write' AS event_type, 0 AS source_rank,
                revision.id, revision.agent_call_id, revision.agent_owner AS owner,
                revision.principal, revision.agent_name AS agent,
                revision.session_id, revision.session_name, revision.session_attach,
                NULL AS tool, '' AS query, NULL AS project, NULL AS class_filter,
                0 AS result_count, NULL AS top_score, NULL AS hits, revision.created_at,
                revision.note_id, revision.space, revision.kind AS revision_kind,
                revision.title AS revision_title, revision.class AS revision_class,
                revision.integrity AS revision_integrity
           FROM note_revisions revision INDEXED BY idx_note_revisions_agent_call
           JOIN agent_calls c ON c.id = revision.agent_call_id
          WHERE revision.agent_owner = ? AND revision.agent_call_id = ? AND c.owner = ?
            AND NOT EXISTS (
              SELECT 1 FROM agent_session_cleanup_markers marker
               WHERE marker.owner = c.owner AND marker.session_id = c.session_id
            )
           ORDER BY revision.created_at, revision.id`,
      )
      .all(owner, id, owner) as AuditEventRow[]
    return {
      retrievals: retrievals.map(retrievalOfRow),
      revisions: revisions
        .map(auditEventOfRow)
        .flatMap((event) => (event.type === 'write' ? [event] : [])),
    }
  },

  exportDetails: async (owner, ids, now) => {
    await ctx.ensureInit()
    if (ids.length === 0) {
      return {}
    }
    ctx.required.exec('BEGIN')

    try {
      const encodedIds = JSON.stringify(ids)
      const selectedIds = 'SELECT value FROM json_each(?)'
      const visibleIds = (
        ctx.required
          .prepare(
            `SELECT call.id FROM json_each(?) requested
              CROSS JOIN agent_calls call
              WHERE call.id = requested.value AND call.owner = ?
                AND NOT EXISTS (
                  SELECT 1 FROM agent_session_cleanup_markers marker
                   WHERE marker.owner = call.owner AND marker.session_id = call.session_id
                )`,
          )
          .all(encodedIds, owner) as Array<{ id: string }>
      ).map((row) => row.id)

      if (visibleIds.length === 0) {
        ctx.required.exec('COMMIT')
        return {}
      }
      const encodedVisibleIds = JSON.stringify(visibleIds)
      const details = ctx.required
        .prepare(
          `SELECT detail.agent_call_id, detail.payload
             FROM agent_call_details detail
            WHERE detail.agent_call_id IN (${selectedIds}) AND detail.expires_at >= ?`,
        )
        .all(encodedVisibleIds, now) as Array<{ agent_call_id: string; payload: string }>
      const retrievals = ctx.required
        .prepare(
          `SELECT retrieval.id, retrieval.agent_call_id, retrieval.owner, retrieval.principal,
                  retrieval.agent, retrieval.session_id, retrieval.session_name,
                  retrieval.session_attach, retrieval.tool, retrieval.query, retrieval.project,
                  retrieval.class_filter, retrieval.result_count, retrieval.top_score,
                  retrieval.hits, retrieval.created_at
             FROM agent_retrievals retrieval INDEXED BY idx_agent_retrievals_agent_call
            WHERE retrieval.owner = ? AND retrieval.agent_call_id IN (${selectedIds})
            ORDER BY retrieval.created_at, retrieval.id`,
        )
        .all(owner, encodedVisibleIds) as RetrievalRow[]
      const revisions = ctx.required
        .prepare(
          `SELECT 'write' AS event_type, 0 AS source_rank,
                  revision.id, revision.agent_call_id, revision.agent_owner AS owner,
                  revision.principal, revision.agent_name AS agent,
                  revision.session_id, revision.session_name, revision.session_attach,
                  NULL AS tool, '' AS query, NULL AS project, NULL AS class_filter,
                  0 AS result_count, NULL AS top_score, NULL AS hits, revision.created_at,
                  revision.note_id, revision.space, revision.kind AS revision_kind,
                  revision.title AS revision_title, revision.class AS revision_class,
                  revision.integrity AS revision_integrity
             FROM note_revisions revision INDEXED BY idx_note_revisions_agent_call
            WHERE revision.agent_owner = ? AND revision.agent_call_id IN (${selectedIds})
            ORDER BY revision.created_at, revision.id`,
        )
        .all(owner, encodedVisibleIds) as AuditEventRow[]
      const result: Awaited<ReturnType<AgentCallTracePersistence['exportDetails']>> = {}
      const ensure = (id: string) =>
        (result[id] ??= { detailed: null, retrievals: [], revisions: [] })

      for (const row of details) {
        ensure(row.agent_call_id).detailed = parseJson(row.payload)
      }
      for (const row of retrievals) {
        ensure(row.agent_call_id!).retrievals.push(retrievalOfRow(row))
      }
      for (const row of revisions) {
        const event = auditEventOfRow(row)

        if (event.type === 'write' && row.agent_call_id) {
          ensure(row.agent_call_id).revisions.push(event)
        }
      }
      ctx.required.exec('COMMIT')
      return result
    } catch (error) {
      if (ctx.required.isTransaction) {
        ctx.required.exec('ROLLBACK')
      }
      throw error
    }
  },

  recurringProblems: async (owner, since, limit) => {
    await ctx.ensureInit()
    ctx.required.exec('BEGIN')

    try {
      const hasMarkers = Boolean(
        ctx.required
          .prepare('SELECT 1 FROM agent_session_cleanup_markers WHERE owner = ? LIMIT 1')
          .get(owner),
      )
      const visibility = hasMarkers
        ? `AND NOT EXISTS (
             SELECT 1 FROM agent_session_cleanup_markers marker
              WHERE marker.owner = agent_calls.owner
                AND marker.session_id = agent_calls.session_id
           )`
        : ''
      const rows = ctx.required
        .prepare(
          `SELECT fingerprint, tool, COUNT(*) AS count, MIN(started_at) AS first_at,
                  MAX(started_at) AS last_at,
                  COUNT(DISTINCT COALESCE(agent, principal)) AS agents
             FROM agent_calls INDEXED BY idx_agent_calls_owner_fingerprint_started
            WHERE owner = ? AND outcome = 'invalid_arguments' AND started_at >= ?
              ${visibility}
            GROUP BY fingerprint, tool
            ORDER BY count DESC, last_at DESC LIMIT ?`,
        )
        .all(owner, since, limit) as Array<{
        fingerprint: string
        tool: string
        count: number
        first_at: string
        last_at: string
        agents: number
      }>
      const issue = ctx.required.prepare(
        `SELECT issue_summary FROM agent_calls INDEXED BY idx_agent_calls_owner_fingerprint_started
          WHERE owner = ? AND outcome = 'invalid_arguments' AND started_at >= ?
            AND fingerprint = ? AND tool = ? ${visibility}
          ORDER BY started_at DESC, id DESC LIMIT 1`,
      )
      const problems = rows.map((row) => ({
        fingerprint: row.fingerprint,
        tool: row.tool,
        issues: parseJson(
          (
            issue.get(owner, since, row.fingerprint, row.tool) as
              { issue_summary: string | null } | undefined
          )?.issue_summary ?? null,
        ),
        count: Number(row.count),
        firstAt: row.first_at,
        lastAt: row.last_at,
        agents: Number(row.agents),
      }))
      ctx.required.exec('COMMIT')
      return problems
    } catch (error) {
      if (ctx.required.isTransaction) {
        ctx.required.exec('ROLLBACK')
      }
      throw error
    }
  },

  recoverInterrupted: async (before, finishedAt) => {
    await ctx.ensureInit()
    ctx.required.exec('BEGIN IMMEDIATE')
    try {
      const result = ctx.required
        .prepare(
          `UPDATE agent_calls
              SET finished_at = ?, duration_ms = MAX(0, CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER)),
                  outcome = ?, reason_code = 'interrupted'
            WHERE outcome IS NULL AND started_at < ?
              AND NOT EXISTS (
                SELECT 1 FROM agent_session_cleanup_markers marker
                 WHERE marker.owner = agent_calls.owner
                   AND marker.session_id = agent_calls.session_id
              )`,
        )
        .run(finishedAt, finishedAt, AGENT_CALL_OUTCOME.internalError, before)
      ctx.required
        .prepare(
          `UPDATE agent_sessions SET last_seen_at = MAX(last_seen_at, ?)
            WHERE EXISTS (
              SELECT 1 FROM agent_calls recovered
               WHERE recovered.owner = agent_sessions.owner
                 AND recovered.session_id = agent_sessions.id
                 AND recovered.reason_code = 'interrupted'
                 AND recovered.finished_at = ?
                 AND recovered.tool NOT IN ('use_skill', 'whoami', 'get_my_projects')
            )`,
        )
        .run(finishedAt, finishedAt)
      ctx.required.exec('COMMIT')
      return Number(result.changes)
    } catch (error) {
      if (ctx.required.isTransaction) {
        ctx.required.exec('ROLLBACK')
      }
      throw error
    }
  },

  config: async () => {
    await ctx.ensureInit()
    return configRow(ctx)
  },

  patchConfig: async (input) => {
    await ctx.ensureInit()
    const expected = /^v([1-9][0-9]*)$/.exec(input.expectedVersionToken)

    if (!expected) {
      return null
    }
    const result = ctx.required
      .prepare(
        `UPDATE agent_telemetry_config
            SET detailed_enabled = COALESCE(?, detailed_enabled),
                compact_retention_days = COALESCE(?, compact_retention_days),
                detailed_retention_days = COALESCE(?, detailed_retention_days),
                version = version + 1,
                updated_at = ?
          WHERE singleton = 1 AND version = ?
            AND COALESCE(?, detailed_retention_days) <= COALESCE(?, compact_retention_days)
        RETURNING detailed_enabled, compact_retention_days, detailed_retention_days, version, updated_at`,
      )
      .get(
        input.detailedEnabled == null ? null : input.detailedEnabled ? 1 : 0,
        input.compactRetentionDays ?? null,
        input.detailedRetentionDays ?? null,
        input.updatedAt,
        Number(expected[1]),
        input.detailedRetentionDays ?? null,
        input.compactRetentionDays ?? null,
      ) as Parameters<typeof configOf>[0] | undefined
    return result ? configOf(result) : null
  },

  deleteSession: async (input) => {
    await ctx.ensureInit()
    ctx.required.exec('BEGIN IMMEDIATE')

    try {
      const lifecycle = ctx.required
        .prepare('SELECT last_seen_at FROM agent_sessions WHERE owner = ? AND id = ?')
        .get(input.owner, input.sessionId) as { last_seen_at: string } | undefined
      const marker = ctx.required
        .prepare(
          'SELECT reason, cleanup_pending FROM agent_session_cleanup_markers WHERE owner = ? AND session_id = ?',
        )
        .get(input.owner, input.sessionId) as
        { reason: 'retention' | 'human-delete'; cleanup_pending: number } | undefined
      const exists =
        lifecycle != null ||
        marker != null ||
        Boolean(
          ctx.required
            .prepare(
              `SELECT 1 FROM agent_calls WHERE owner = ? AND session_id = ?
               UNION ALL SELECT 1 FROM agent_retrievals WHERE owner = ? AND session_id = ?
               UNION ALL SELECT 1 FROM note_revisions WHERE agent_owner = ? AND session_id = ?
               LIMIT 1`,
            )
            .get(
              input.owner,
              input.sessionId,
              input.owner,
              input.sessionId,
              input.owner,
              input.sessionId,
            ),
        )

      if (!exists) {
        ctx.required.exec('COMMIT')
        return 'complete'
      }
      if (lifecycle && lifecycle.last_seen_at >= input.activeSince && !input.confirmActive) {
        ctx.required.exec('COMMIT')
        return 'active'
      }
      ctx.required
        .prepare(
          `INSERT INTO agent_session_cleanup_markers
             (owner, session_id, reason, accepted_at, cleanup_pending)
           VALUES (?, ?, 'human-delete', ?, 1)
           ON CONFLICT(owner, session_id) DO UPDATE SET
             reason = 'human-delete',
             accepted_at = CASE
               WHEN agent_session_cleanup_markers.reason = 'retention'
               THEN excluded.accepted_at ELSE agent_session_cleanup_markers.accepted_at END,
             cleanup_pending = CASE
               WHEN agent_session_cleanup_markers.reason = 'retention'
               THEN 1 ELSE agent_session_cleanup_markers.cleanup_pending END`,
        )
        .run(input.owner, input.sessionId, input.acceptedAt)
      ctx.required
        .prepare('DELETE FROM mcp_delta_session_cursors WHERE session_id = ?')
        .run(input.sessionId)
      ctx.required
        .prepare('DELETE FROM agent_sessions WHERE owner = ? AND id = ?')
        .run(input.owner, input.sessionId)
      const complete = cleanupSession(
        ctx,
        input.owner,
        input.sessionId,
        'human-delete',
        input.batchSize,
      )
      ctx.required.exec('COMMIT')
      return complete.complete ? 'complete' : 'deleting'
    } catch (error) {
      if (ctx.required.isTransaction) {
        ctx.required.exec('ROLLBACK')
      }
      throw error
    }
  },

  expireSession: async (input) => {
    await ctx.ensureInit()
    ctx.required.exec('BEGIN IMMEDIATE')
    try {
      const result = expireSession(ctx, input)
      ctx.required.exec('COMMIT')
      return result
    } catch (error) {
      if (ctx.required.isTransaction) {
        ctx.required.exec('ROLLBACK')
      }
      throw error
    }
  },

  maintain: async ({ now, batchSize }) => {
    await ctx.ensureInit()
    ctx.required.exec('BEGIN IMMEDIATE')
    try {
      const config = configRow(ctx)
      const compactBefore = new Date(
        Date.parse(now) - config.compactRetentionDays * 86_400_000,
      ).toISOString()
      ctx.required
        .prepare(
          `DELETE FROM agent_call_details WHERE agent_call_id IN (
             SELECT agent_call_id FROM agent_call_details
              WHERE expires_at < ? ORDER BY expires_at LIMIT ?
           )`,
        )
        .run(now, batchSize)
      ctx.required
        .prepare(
          `DELETE FROM agent_calls WHERE id IN (
             SELECT id FROM agent_calls INDEXED BY idx_agent_calls_outside_expiry
              WHERE session_id IS NULL AND COALESCE(finished_at, started_at) < ?
              ORDER BY COALESCE(finished_at, started_at), id LIMIT ?
           )`,
        )
        .run(compactBefore, batchSize)
      const candidates = ctx.required
        .prepare(
          `SELECT sessions.owner, sessions.id AS session_id
             FROM agent_sessions sessions
            WHERE sessions.last_seen_at < ?
              AND EXISTS (
                SELECT 1 FROM agent_calls complete_start
                 INDEXED BY idx_agent_calls_complete_start
                 WHERE complete_start.owner = sessions.owner
                   AND complete_start.session_id = sessions.id
                   AND complete_start.tool = 'start_session'
                   AND complete_start.outcome = 'success'
                   AND json_extract(complete_start.result_summary, '$."session.state"')
                       IN ('new', 'forked')
              )
            ORDER BY sessions.last_seen_at LIMIT 1`,
        )
        .all(compactBefore) as Array<{ owner: string; session_id: string }>
      const owners = new Set<string>()

      for (const candidate of candidates) {
        const result = expireSession(ctx, {
          owner: candidate.owner,
          sessionId: candidate.session_id,
          expiredBefore: compactBefore,
          acceptedAt: now,
          batchSize,
        })

        if (result === 'complete' || result === 'deleting') {
          owners.add(candidate.owner)
        }
      }
      ctx.required.exec('COMMIT')
      return [...owners]
    } catch (error) {
      if (ctx.required.isTransaction) {
        ctx.required.exec('ROLLBACK')
      }
      throw error
    }
  },

  resumeCleanup: async (batchSize) => {
    await ctx.ensureInit()
    const markers = ctx.required
      .prepare(
        `SELECT owner, session_id, reason FROM agent_session_cleanup_markers
          WHERE cleanup_pending = 1 ORDER BY accepted_at LIMIT 1`,
      )
      .all() as Array<{
      owner: string
      session_id: string
      reason: 'retention' | 'human-delete'
    }>
    const completed = new Set<string>()
    let processed = 0

    for (const marker of markers) {
      ctx.required.exec('BEGIN IMMEDIATE')
      try {
        const current = ctx.required
          .prepare(
            `SELECT reason, cleanup_pending FROM agent_session_cleanup_markers
              WHERE owner = ? AND session_id = ?`,
          )
          .get(marker.owner, marker.session_id) as
          { reason: 'retention' | 'human-delete'; cleanup_pending: number } | undefined

        if (current?.cleanup_pending === 1) {
          const batch = cleanupSession(
            ctx,
            marker.owner,
            marker.session_id,
            current.reason,
            batchSize,
          )
          processed += batch.processed

          if (batch.complete) {
            completed.add(marker.owner)
          }
        }
        ctx.required.exec('COMMIT')
      } catch (error) {
        if (ctx.required.isTransaction) {
          ctx.required.exec('ROLLBACK')
        }
        throw error
      }
    }

    const pending = Boolean(
      ctx.required
        .prepare('SELECT 1 FROM agent_session_cleanup_markers WHERE cleanup_pending = 1 LIMIT 1')
        .get(),
    )
    return { completedOwners: [...completed], processed, pending }
  },
})
