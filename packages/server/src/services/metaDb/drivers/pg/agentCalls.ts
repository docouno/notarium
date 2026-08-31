import type pg from 'pg'
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
import type { PgDriverCtx } from './context'

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
  duration_ms: number | string | null
  outcome: AgentCallRecord['outcome']
  reason_code: string | null
  input_bytes: number | string
  output_bytes: number | string | null
  input_shape: AgentTraceJson
  issue_summary: AgentTraceJson | null
  target_summary: AgentTraceJson | null
  result_summary: AgentTraceJson | null
  fingerprint: string
  projection_version: number
  redacted: boolean
  truncated: boolean
  detail_capture_failed: boolean
}

const COLUMNS =
  'id, owner, principal, agent, transport, request_id, session_id, session_name, session_attach, tool, effect, domain, started_at, finished_at, duration_ms, outcome, reason_code, input_bytes, output_bytes, input_shape, issue_summary, target_summary, result_summary, fingerprint, projection_version, redacted, truncated, detail_capture_failed'

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
  inputShape: row.input_shape,
  issueSummary: row.issue_summary,
  targetSummary: row.target_summary,
  resultSummary: row.result_summary,
  fingerprint: row.fingerprint,
  projectionVersion: row.projection_version,
  redacted: row.redacted,
  truncated: row.truncated,
  detailCaptureFailed: row.detail_capture_failed,
})

const configOf = (row: {
  detailed_enabled: boolean
  compact_retention_days: AgentTelemetryConfig['compactRetentionDays']
  detailed_retention_days: AgentTelemetryConfig['detailedRetentionDays']
  version: number | string
  updated_at: string
}): AgentTelemetryConfig => ({
  detailedEnabled: row.detailed_enabled,
  compactRetentionDays: row.compact_retention_days,
  detailedRetentionDays: row.detailed_retention_days,
  versionToken: `v${String(row.version)}`,
  updatedAt: row.updated_at,
})

const lockSession = async (
  client: pg.PoolClient,
  owner: string,
  sessionId: string,
): Promise<void> => {
  // eslint-disable-next-line no-restricted-syntax -- session diagnostics use one dedicated owner/session guard outside the note hierarchy
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
    `agent-session-diagnostics:${owner}`,
    sessionId,
  ])
}

const cleanupSession = async (
  client: pg.PoolClient,
  owner: string,
  sessionId: string,
  reason: 'retention' | 'human-delete',
  batchSize: number,
): Promise<{ complete: boolean; processed: number }> => {
  const details = await client.query(
    `DELETE FROM agent_call_details WHERE agent_call_id IN (
       SELECT id FROM agent_calls WHERE owner = $1 AND session_id = $2 LIMIT $3
     )`,
    [owner, sessionId, batchSize],
  )
  const retrievals = await client.query(
    `DELETE FROM agent_retrievals WHERE id IN (
       SELECT id FROM agent_retrievals
        WHERE owner = $1 AND session_id = $2
          AND ($3 = 'human-delete' OR agent_call_id IS NOT NULL)
        ORDER BY id LIMIT $4
     )`,
    [owner, sessionId, reason, batchSize],
  )
  const calls = await client.query(
    `DELETE FROM agent_calls WHERE id IN (
       SELECT id FROM agent_calls WHERE owner = $1 AND session_id = $2 ORDER BY id LIMIT $3
     )`,
    [owner, sessionId, batchSize],
  )
  const remaining = await client.query(
    `SELECT
       EXISTS(SELECT 1 FROM agent_calls WHERE owner = $1 AND session_id = $2) AS calls_left,
       EXISTS(
         SELECT 1 FROM agent_retrievals
          WHERE owner = $1 AND session_id = $2
            AND ($3 = 'human-delete' OR agent_call_id IS NOT NULL)
       ) AS retrievals_left`,
    [owner, sessionId, reason],
  )
  const row = remaining.rows[0] as { calls_left: boolean; retrievals_left: boolean }
  const complete = !row.calls_left && !row.retrievals_left
  const processed = (details.rowCount ?? 0) + (retrievals.rowCount ?? 0) + (calls.rowCount ?? 0)

  if (complete) {
    const updated = await client.query(
      `UPDATE agent_session_cleanup_markers SET cleanup_pending = false
        WHERE owner = $1 AND session_id = $2 AND reason = $3 AND cleanup_pending = true`,
      [owner, sessionId, reason],
    )
    return { complete: updated.rowCount === 1, processed }
  }

  return { complete: false, processed }
}

const expireSession = async (
  client: pg.PoolClient,
  input: {
    owner: string
    sessionId: string
    expiredBefore: string
    acceptedAt: string
    batchSize: number
  },
): Promise<'fresh' | 'dominated' | 'deleting' | 'complete'> => {
  const markerResult = await client.query(
    `SELECT reason FROM agent_session_cleanup_markers WHERE owner = $1 AND session_id = $2`,
    [input.owner, input.sessionId],
  )
  const marker = markerResult.rows[0] as { reason: 'retention' | 'human-delete' } | undefined

  if (marker?.reason === 'human-delete') {
    return 'dominated'
  }
  if (!marker) {
    const lifecycleResult = await client.query(
      `SELECT sessions.last_seen_at,
              EXISTS(
                SELECT 1 FROM agent_calls complete_start
                 WHERE complete_start.owner = sessions.owner
                   AND complete_start.session_id = sessions.id
                   AND complete_start.tool = 'start_session'
                   AND complete_start.outcome = 'success'
                   AND complete_start.result_summary->>'session.state' IN ('new', 'forked')
              ) AS complete_start
         FROM agent_sessions sessions WHERE sessions.owner = $1 AND sessions.id = $2`,
      [input.owner, input.sessionId],
    )
    const lifecycle = lifecycleResult.rows[0] as
      { last_seen_at: string; complete_start: boolean } | undefined

    if (!lifecycle || !lifecycle.complete_start || lifecycle.last_seen_at >= input.expiredBefore) {
      return 'fresh'
    }
    await client.query(
      `INSERT INTO agent_session_cleanup_markers
         (owner, session_id, reason, accepted_at, cleanup_pending)
       VALUES ($1, $2, 'retention', $3, true)`,
      [input.owner, input.sessionId, input.acceptedAt],
    )
    await client.query('DELETE FROM mcp_delta_session_cursors WHERE session_id = $1', [
      input.sessionId,
    ])
    await client.query('DELETE FROM agent_sessions WHERE owner = $1 AND id = $2', [
      input.owner,
      input.sessionId,
    ])
  }

  return (await cleanupSession(client, input.owner, input.sessionId, 'retention', input.batchSize))
    .complete
    ? 'complete'
    : 'deleting'
}

export const createAgentCallsFacet = (ctx: PgDriverCtx): AgentCallTracePersistence => ({
  admit: async (input: AgentCallAdmission) => {
    await ctx.ensureInit()
    await ctx.required.query(
      `INSERT INTO agent_calls
         (id, owner, principal, agent, transport, request_id, session_id, session_name,
          session_attach, tool, effect, domain, started_at, finished_at, duration_ms,
          outcome, reason_code, input_bytes, output_bytes, input_shape, issue_summary,
          target_summary, result_summary, fingerprint, projection_version, redacted,
          truncated, detail_capture_failed)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, NULL, $7, $8, $9, $10,
               NULL, NULL, NULL, NULL, $11, NULL, $12, NULL, $13, NULL, $14, $15,
               $16, $17, false)`,
      [
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
        input.redacted,
        input.truncated,
      ],
    )
  },

  projectInput: async (owner, id, targetSummary, redacted, truncated) => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      `UPDATE agent_calls SET target_summary = $1, redacted = $2, truncated = $3
        WHERE owner = $4 AND id = $5 AND outcome IS NULL`,
      [JSON.stringify(targetSummary), redacted, truncated, owner, id],
    )
    return result.rowCount === 1
  },

  bind: async (owner, id, session) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await lockSession(client, owner, session.id)
      const result = await client.query(
        `UPDATE agent_calls
          SET session_id = $1, session_name = $2, session_attach = $3
        WHERE owner = $4 AND id = $5
          AND NOT EXISTS (
            SELECT 1 FROM agent_session_cleanup_markers marker
             WHERE marker.owner = $4 AND marker.session_id = $1
          )`,
        [session.id, session.name, session.attach, owner, id],
      )
      await client.query('COMMIT')
      return result.rowCount === 1
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },

  discard: async (owner, id) => {
    await ctx.ensureInit()
    await ctx.required.query('DELETE FROM agent_calls WHERE owner = $1 AND id = $2', [owner, id])
  },

  finalize: async (owner: string, id: string, final: AgentCallFinal) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      const selected = await client.query(
        'SELECT session_id, tool FROM agent_calls WHERE owner = $1 AND id = $2',
        [owner, id],
      )
      const sessionId = selected.rows[0]?.session_id as string | null | undefined

      if (sessionId) {
        await lockSession(client, owner, sessionId)
      }
      const result = await client.query(
        `UPDATE agent_calls
          SET finished_at = $1, duration_ms = $2, outcome = $3, reason_code = $4,
              output_bytes = $5, issue_summary = $6, result_summary = $7, redacted = $8,
              truncated = $9, detail_capture_failed = $10, fingerprint = $11
        WHERE owner = $12 AND id = $13 AND outcome IS NULL
          AND (
            session_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM agent_session_cleanup_markers marker
               WHERE marker.owner = agent_calls.owner
                 AND marker.session_id = agent_calls.session_id
            )
          )`,
        [
          final.finishedAt,
          final.durationMs,
          final.outcome,
          final.reasonCode,
          final.outputBytes,
          final.issueSummary == null ? null : JSON.stringify(final.issueSummary),
          final.resultSummary == null ? null : JSON.stringify(final.resultSummary),
          final.redacted,
          final.truncated,
          final.detailCaptureFailed,
          final.fingerprint,
          owner,
          id,
        ],
      )
      const touchesLifecycle = !['use_skill', 'whoami', 'get_my_projects'].includes(
        String(selected.rows[0]?.tool ?? ''),
      )

      if (result.rowCount === 1 && sessionId && touchesLifecycle) {
        await client.query(
          `UPDATE agent_sessions SET last_seen_at = GREATEST(last_seen_at, $1)
            WHERE owner = $2 AND id = $3`,
          [final.finishedAt, owner, sessionId],
        )
      }
      await client.query('COMMIT')
      return result.rowCount === 1
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },

  appendDetail: async (input) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      const selected = await client.query(
        'SELECT session_id FROM agent_calls WHERE owner = $1 AND id = $2',
        [input.owner, input.id],
      )
      const sessionId = selected.rows[0]?.session_id as string | null | undefined

      if (sessionId) {
        await lockSession(client, input.owner, sessionId)
      }
      const result = await client.query(
        `INSERT INTO agent_call_details (agent_call_id, payload, created_at, expires_at)
       SELECT c.id, $1, $2, $3 FROM agent_calls c
        WHERE c.id = $4 AND c.owner = $5
          AND (
            c.session_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM agent_session_cleanup_markers marker
               WHERE marker.owner = c.owner AND marker.session_id = c.session_id
            )
          )
       ON CONFLICT(agent_call_id) DO UPDATE SET
         payload = EXCLUDED.payload,
         created_at = EXCLUDED.created_at,
         expires_at = EXCLUDED.expires_at`,
        [JSON.stringify(input.payload), input.createdAt, input.expiresAt, input.id, input.owner],
      )
      await client.query('COMMIT')
      return result.rowCount === 1
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },

  get: async (owner, id) => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      `SELECT ${COLUMNS} FROM agent_calls AS call
        WHERE owner = $1 AND id = $2
          AND NOT EXISTS (
            SELECT 1 FROM agent_session_cleanup_markers marker
             WHERE marker.owner = call.owner AND marker.session_id = call.session_id
          )`,
      [owner, id],
    )
    const row = result.rows[0] as AgentCallRow | undefined
    return row ? callOf(row) : null
  },

  getDetail: async (owner, id, now) => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      `SELECT detail.payload FROM agent_call_details detail
         JOIN agent_calls c ON c.id = detail.agent_call_id
        WHERE c.owner = $1 AND c.id = $2 AND detail.expires_at >= $3
          AND NOT EXISTS (
            SELECT 1 FROM agent_session_cleanup_markers marker
             WHERE marker.owner = c.owner AND marker.session_id = c.session_id
          )`,
      [owner, id, now],
    )
    return (result.rows[0]?.payload as AgentTraceJson | undefined) ?? null
  },

  links: async (owner, id) => {
    await ctx.ensureInit()
    const [retrievals, revisions] = await Promise.all([
      ctx.required.query(
        `SELECT retrieval.id, retrieval.agent_call_id, retrieval.owner, retrieval.principal,
                retrieval.agent, retrieval.session_id, retrieval.session_name,
                retrieval.session_attach, retrieval.tool, retrieval.query, retrieval.project,
                retrieval.class_filter, retrieval.result_count, retrieval.top_score,
                retrieval.hits, retrieval.created_at
           FROM agent_retrievals retrieval
           JOIN agent_calls c ON c.id = retrieval.agent_call_id
          WHERE retrieval.owner = $1 AND retrieval.agent_call_id = $2 AND c.owner = $1
            AND NOT EXISTS (
              SELECT 1 FROM agent_session_cleanup_markers marker
               WHERE marker.owner = c.owner AND marker.session_id = c.session_id
            )
           ORDER BY retrieval.created_at, retrieval.id`,
        [owner, id],
      ),
      ctx.required.query(
        `SELECT 'write' AS event_type, 0 AS source_rank,
                revision.id, revision.agent_call_id, revision.agent_owner AS owner,
                revision.principal, revision.agent_name AS agent,
                revision.session_id, revision.session_name, revision.session_attach,
                NULL::text AS tool, '' AS query, NULL::text AS project,
                NULL::text AS class_filter, 0 AS result_count,
                NULL::double precision AS top_score, NULL::text AS hits, revision.created_at,
                revision.note_id, revision.space, revision.kind AS revision_kind,
                revision.title AS revision_title, revision.class AS revision_class,
                revision.integrity AS revision_integrity
           FROM note_revisions revision
           JOIN agent_calls c ON c.id = revision.agent_call_id
          WHERE revision.agent_owner = $1 AND revision.agent_call_id = $2 AND c.owner = $1
            AND NOT EXISTS (
              SELECT 1 FROM agent_session_cleanup_markers marker
               WHERE marker.owner = c.owner AND marker.session_id = c.session_id
            )
           ORDER BY revision.created_at, revision.id`,
        [owner, id],
      ),
    ])
    return {
      retrievals: (retrievals.rows as RetrievalRow[]).map(retrievalOfRow),
      revisions: (revisions.rows as AuditEventRow[])
        .map(auditEventOfRow)
        .flatMap((event) => (event.type === 'write' ? [event] : [])),
    }
  },

  exportDetails: async (owner, ids, now) => {
    await ctx.ensureInit()
    if (ids.length === 0) {
      return {}
    }
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const visibleIds = (
        await client.query(
          `SELECT call.id FROM agent_calls call
            WHERE call.owner = $1 AND call.id = ANY($2::text[])
              AND NOT EXISTS (
                SELECT 1 FROM agent_session_cleanup_markers marker
                 WHERE marker.owner = call.owner AND marker.session_id = call.session_id
              )`,
          [owner, ids],
        )
      ).rows.map((row: { id: string }) => row.id)

      if (visibleIds.length === 0) {
        await client.query('COMMIT')
        return {}
      }
      const details = await client.query(
        `SELECT detail.agent_call_id, detail.payload
           FROM agent_call_details detail
          WHERE detail.agent_call_id = ANY($1::text[]) AND detail.expires_at >= $2`,
        [visibleIds, now],
      )
      const retrievals = await client.query(
        `SELECT retrieval.id, retrieval.agent_call_id, retrieval.owner, retrieval.principal,
                  retrieval.agent, retrieval.session_id, retrieval.session_name,
                  retrieval.session_attach, retrieval.tool, retrieval.query, retrieval.project,
                  retrieval.class_filter, retrieval.result_count, retrieval.top_score,
                  retrieval.hits, retrieval.created_at
             FROM agent_retrievals retrieval
          WHERE retrieval.owner = $1 AND retrieval.agent_call_id = ANY($2::text[])
          ORDER BY retrieval.created_at, retrieval.id`,
        [owner, visibleIds],
      )
      const revisions = await client.query(
        `SELECT 'write' AS event_type, 0 AS source_rank,
                  revision.id, revision.agent_call_id, revision.agent_owner AS owner,
                  revision.principal, revision.agent_name AS agent,
                  revision.session_id, revision.session_name, revision.session_attach,
                  NULL::text AS tool, '' AS query, NULL::text AS project,
                  NULL::text AS class_filter, 0 AS result_count,
                  NULL::double precision AS top_score, NULL::text AS hits, revision.created_at,
                  revision.note_id, revision.space, revision.kind AS revision_kind,
                  revision.title AS revision_title, revision.class AS revision_class,
                  revision.integrity AS revision_integrity
             FROM note_revisions revision
          WHERE revision.agent_owner = $1 AND revision.agent_call_id = ANY($2::text[])
          ORDER BY revision.created_at, revision.id`,
        [owner, visibleIds],
      )
      const result: Awaited<ReturnType<AgentCallTracePersistence['exportDetails']>> = {}
      const ensure = (id: string) =>
        (result[id] ??= { detailed: null, retrievals: [], revisions: [] })

      for (const row of details.rows as Array<{ agent_call_id: string; payload: AgentTraceJson }>) {
        ensure(row.agent_call_id).detailed = row.payload
      }
      for (const row of retrievals.rows as RetrievalRow[]) {
        ensure(row.agent_call_id!).retrievals.push(retrievalOfRow(row))
      }
      for (const row of revisions.rows as AuditEventRow[]) {
        const event = auditEventOfRow(row)

        if (event.type === 'write' && row.agent_call_id) {
          ensure(row.agent_call_id).revisions.push(event)
        }
      }
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },

  recurringProblems: async (owner, since, limit) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const marker = await client.query(
        'SELECT 1 FROM agent_session_cleanup_markers WHERE owner = $1 LIMIT 1',
        [owner],
      )
      const visibility =
        marker.rowCount === 0
          ? ''
          : `AND NOT EXISTS (
               SELECT 1 FROM agent_session_cleanup_markers marker
                WHERE marker.owner = agent_calls.owner
                  AND marker.session_id = agent_calls.session_id
             )`
      const detailVisibility =
        marker.rowCount === 0
          ? ''
          : `AND NOT EXISTS (
               SELECT 1 FROM agent_session_cleanup_markers marker
                WHERE marker.owner = call.owner
                  AND marker.session_id = call.session_id
             )`
      const rows = (
        await client.query(
          `SELECT fingerprint, tool, COUNT(*) AS count, MIN(started_at) AS first_at,
                  MAX(started_at) AS last_at
             FROM agent_calls
            WHERE owner = $1 AND outcome = 'invalid_arguments' AND started_at >= $2
              ${visibility}
            GROUP BY fingerprint, tool
            ORDER BY count DESC, last_at DESC LIMIT $3`,
          [owner, since, limit],
        )
      ).rows as Array<{
        fingerprint: string
        tool: string
        count: string | number
        first_at: string
        last_at: string
      }>
      const details =
        rows.length === 0
          ? []
          : (
              await client.query(
                `SELECT call.fingerprint, call.tool,
                        (array_agg(call.issue_summary ORDER BY call.started_at DESC, call.id DESC)
                           FILTER (WHERE call.issue_summary IS NOT NULL))[1] AS issues,
                        COUNT(DISTINCT COALESCE(call.agent, call.principal)) AS agents
                   FROM agent_calls AS call
                   JOIN unnest($1::text[], $2::text[]) AS wanted(fingerprint, tool)
                     ON wanted.fingerprint = call.fingerprint AND wanted.tool = call.tool
                  WHERE call.owner = $3 AND call.outcome = 'invalid_arguments'
                    AND call.started_at >= $4
                    ${detailVisibility}
                  GROUP BY call.fingerprint, call.tool`,
                [rows.map((row) => row.fingerprint), rows.map((row) => row.tool), owner, since],
              )
            ).rows
      const detailsByKey = new Map(
        (
          details as Array<{
            fingerprint: string
            tool: string
            issues: AgentTraceJson | null
            agents: string | number
          }>
        ).map((row) => [`${row.fingerprint}\0${row.tool}`, row]),
      )
      await client.query('COMMIT')
      return rows.map((row) => ({
        fingerprint: row.fingerprint,
        tool: row.tool,
        issues: detailsByKey.get(`${row.fingerprint}\0${row.tool}`)?.issues ?? null,
        count: Number(row.count),
        firstAt: row.first_at,
        lastAt: row.last_at,
        agents: Number(detailsByKey.get(`${row.fingerprint}\0${row.tool}`)?.agents ?? 0),
      }))
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },

  recoverInterrupted: async (before, finishedAt) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      const result = await client.query(
        `UPDATE agent_calls
            SET finished_at = $1::text,
                duration_ms = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ($1::timestamptz - started_at::timestamptz)) * 1000)),
                outcome = $2,
                reason_code = 'interrupted'
          WHERE outcome IS NULL AND started_at < $3
            AND NOT EXISTS (
              SELECT 1 FROM agent_session_cleanup_markers marker
               WHERE marker.owner = agent_calls.owner
                 AND marker.session_id = agent_calls.session_id
            )`,
        [finishedAt, AGENT_CALL_OUTCOME.internalError, before],
      )
      await client.query(
        `UPDATE agent_sessions SET last_seen_at = GREATEST(last_seen_at, $1)
          WHERE EXISTS (
            SELECT 1 FROM agent_calls recovered
             WHERE recovered.owner = agent_sessions.owner
               AND recovered.session_id = agent_sessions.id
               AND recovered.reason_code = 'interrupted'
               AND recovered.finished_at = $1
               AND recovered.tool NOT IN ('use_skill', 'whoami', 'get_my_projects')
          )`,
        [finishedAt],
      )
      await client.query('COMMIT')
      return result.rowCount ?? 0
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },

  config: async () => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      `SELECT detailed_enabled, compact_retention_days, detailed_retention_days, version, updated_at
         FROM agent_telemetry_config WHERE singleton = 1`,
    )
    return configOf(result.rows[0] as Parameters<typeof configOf>[0])
  },

  patchConfig: async (input) => {
    await ctx.ensureInit()
    const expected = /^v([1-9][0-9]*)$/.exec(input.expectedVersionToken)

    if (!expected) {
      return null
    }
    const result = await ctx.required.query(
      `UPDATE agent_telemetry_config
          SET detailed_enabled = COALESCE($1, detailed_enabled),
              compact_retention_days = COALESCE($2, compact_retention_days),
              detailed_retention_days = COALESCE($3, detailed_retention_days),
              version = version + 1,
              updated_at = $4
        WHERE singleton = 1 AND version = $5
          AND COALESCE($3, detailed_retention_days) <= COALESCE($2, compact_retention_days)
      RETURNING detailed_enabled, compact_retention_days, detailed_retention_days, version, updated_at`,
      [
        input.detailedEnabled ?? null,
        input.compactRetentionDays ?? null,
        input.detailedRetentionDays ?? null,
        input.updatedAt,
        Number(expected[1]),
      ],
    )
    const row = result.rows[0] as Parameters<typeof configOf>[0] | undefined
    return row ? configOf(row) : null
  },

  deleteSession: async (input) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await lockSession(client, input.owner, input.sessionId)
      const lifecycleResult = await client.query(
        'SELECT last_seen_at FROM agent_sessions WHERE owner = $1 AND id = $2',
        [input.owner, input.sessionId],
      )
      const markerResult = await client.query(
        `SELECT reason, cleanup_pending FROM agent_session_cleanup_markers
          WHERE owner = $1 AND session_id = $2`,
        [input.owner, input.sessionId],
      )
      const existsResult = await client.query(
        `SELECT 1 FROM agent_calls WHERE owner = $1 AND session_id = $2
           UNION ALL SELECT 1 FROM agent_retrievals WHERE owner = $1 AND session_id = $2
           UNION ALL SELECT 1 FROM note_revisions WHERE agent_owner = $1 AND session_id = $2
           LIMIT 1`,
        [input.owner, input.sessionId],
      )
      const lifecycle = lifecycleResult.rows[0] as { last_seen_at: string } | undefined
      const exists = lifecycle != null || markerResult.rowCount !== 0 || existsResult.rowCount !== 0

      if (!exists) {
        await client.query('COMMIT')
        return 'complete'
      }
      if (lifecycle && lifecycle.last_seen_at >= input.activeSince && !input.confirmActive) {
        await client.query('COMMIT')
        return 'active'
      }
      await client.query(
        `INSERT INTO agent_session_cleanup_markers
           (owner, session_id, reason, accepted_at, cleanup_pending)
         VALUES ($1, $2, 'human-delete', $3, true)
         ON CONFLICT(owner, session_id) DO UPDATE SET
           reason = 'human-delete',
           accepted_at = CASE
             WHEN agent_session_cleanup_markers.reason = 'retention'
             THEN EXCLUDED.accepted_at ELSE agent_session_cleanup_markers.accepted_at END,
           cleanup_pending = CASE
             WHEN agent_session_cleanup_markers.reason = 'retention'
             THEN true ELSE agent_session_cleanup_markers.cleanup_pending END`,
        [input.owner, input.sessionId, input.acceptedAt],
      )
      await client.query('DELETE FROM mcp_delta_session_cursors WHERE session_id = $1', [
        input.sessionId,
      ])
      await client.query('DELETE FROM agent_sessions WHERE owner = $1 AND id = $2', [
        input.owner,
        input.sessionId,
      ])
      const complete = await cleanupSession(
        client,
        input.owner,
        input.sessionId,
        'human-delete',
        input.batchSize,
      )
      await client.query('COMMIT')
      return complete.complete ? 'complete' : 'deleting'
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },

  expireSession: async (input) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await lockSession(client, input.owner, input.sessionId)
      const result = await expireSession(client, input)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },

  maintain: async ({ now, batchSize }) => {
    await ctx.ensureInit()
    const config = await ctx.required.query(
      'SELECT compact_retention_days FROM agent_telemetry_config WHERE singleton = 1',
    )
    const compactBefore = new Date(
      Date.parse(now) - Number(config.rows[0].compact_retention_days) * 86_400_000,
    ).toISOString()
    await Promise.all([
      ctx.required.query(
        `DELETE FROM agent_call_details WHERE agent_call_id IN (
           SELECT agent_call_id FROM agent_call_details
            WHERE expires_at < $1 ORDER BY expires_at LIMIT $2
         )`,
        [now, batchSize],
      ),
      ctx.required.query(
        `DELETE FROM agent_calls WHERE id IN (
           SELECT id FROM agent_calls
            WHERE session_id IS NULL AND COALESCE(finished_at, started_at) < $1
            ORDER BY started_at LIMIT $2
         )`,
        [compactBefore, batchSize],
      ),
    ])
    const candidates = await ctx.required.query(
      `SELECT sessions.owner, sessions.id AS session_id
         FROM agent_sessions sessions
        WHERE sessions.last_seen_at < $1
          AND EXISTS (
            SELECT 1 FROM agent_calls complete_start
             WHERE complete_start.owner = sessions.owner
               AND complete_start.session_id = sessions.id
               AND complete_start.tool = 'start_session'
               AND complete_start.outcome = 'success'
               AND complete_start.result_summary->>'session.state' IN ('new', 'forked')
          )
        ORDER BY sessions.last_seen_at LIMIT 1`,
      [compactBefore],
    )
    const owners = new Set<string>()

    for (const candidate of candidates.rows as Array<{ owner: string; session_id: string }>) {
      const client = await ctx.required.connect()

      try {
        await client.query('BEGIN')
        await lockSession(client, candidate.owner, candidate.session_id)
        const result = await expireSession(client, {
          owner: candidate.owner,
          sessionId: candidate.session_id,
          expiredBefore: compactBefore,
          acceptedAt: now,
          batchSize,
        })

        if (result === 'complete' || result === 'deleting') {
          owners.add(candidate.owner)
        }
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    }

    return [...owners]
  },

  resumeCleanup: async (batchSize) => {
    await ctx.ensureInit()
    const markers = await ctx.required.query(
      `SELECT owner, session_id, reason FROM agent_session_cleanup_markers
        WHERE cleanup_pending = true ORDER BY accepted_at LIMIT 1`,
    )
    const completed = new Set<string>()
    let processed = 0

    for (const marker of markers.rows as Array<{
      owner: string
      session_id: string
      reason: 'retention' | 'human-delete'
    }>) {
      const client = await ctx.required.connect()

      try {
        await client.query('BEGIN')
        await lockSession(client, marker.owner, marker.session_id)
        const currentResult = await client.query(
          `SELECT reason, cleanup_pending FROM agent_session_cleanup_markers
            WHERE owner = $1 AND session_id = $2`,
          [marker.owner, marker.session_id],
        )
        const current = currentResult.rows[0] as
          { reason: 'retention' | 'human-delete'; cleanup_pending: boolean } | undefined

        if (current?.cleanup_pending) {
          const batch = await cleanupSession(
            client,
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
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    }

    const pending = await ctx.required.query(
      'SELECT 1 FROM agent_session_cleanup_markers WHERE cleanup_pending = true LIMIT 1',
    )
    return { completedOwners: [...completed], processed, pending: pending.rowCount !== 0 }
  },
})
