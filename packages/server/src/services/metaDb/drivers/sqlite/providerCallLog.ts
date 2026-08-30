import { PROVIDER_CALL_OUTCOME, PROVIDER_DELIVERY_STATE } from '@notarium/contract'

import { providerCallLicensesAnotherAttempt } from '../../providerCallLog'
import { providerCallLogOfRow, type ProviderCallLogRow } from '../../rows'
import type {
  ProviderCallIntentInput,
  ProviderCallLogPersistence,
  ProviderCallSettleInput,
} from '../../types'
import type { SqliteDriverCtx } from './context'

const COLUMNS = `id, owner, principal, agent, resource_id, credential_id, host, spaces,
                 job_id, job_call_key, attempt_no, delivery_state, retry_safe, outcome,
                 token_usage, created_at, settled_at`

const latestAttempt = (
  ctx: SqliteDriverCtx,
  jobId: string,
  jobCallKey: string,
): ProviderCallLogRow | undefined =>
  ctx.required
    .prepare(
      `SELECT ${COLUMNS} FROM provider_call_log
        WHERE job_id = ? AND job_call_key = ?
        ORDER BY attempt_no DESC LIMIT 1`,
    )
    .get(jobId, jobCallKey) as ProviderCallLogRow | undefined

export const createProviderCallLogFacet = (ctx: SqliteDriverCtx): ProviderCallLogPersistence => ({
  intent: async (input: ProviderCallIntentInput) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN IMMEDIATE')
    try {
      const previous = input.job
        ? latestAttempt(ctx, input.job.jobId, input.job.jobCallKey)
        : undefined

      if (previous) {
        const record = providerCallLogOfRow(previous)

        if (!providerCallLicensesAnotherAttempt(record)) {
          db.exec('COMMIT')
          return { status: 'blocked' as const, record }
        }
      }
      const attemptNo = input.job ? Number(previous?.attempt_no ?? 0) + 1 : null
      const stored = db
        .prepare(
          `INSERT INTO provider_call_log
             (${COLUMNS})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING ${COLUMNS}`,
        )
        .get(
          input.id,
          input.owner,
          input.principal,
          input.agent,
          input.resourceId,
          input.credentialId,
          input.host,
          JSON.stringify([...input.spaces]),
          input.job?.jobId ?? null,
          input.job?.jobCallKey ?? null,
          attemptNo,
          // The intent is written before the transport may send, so the honest reading
          // of a process that dies right here is "it might have gone out".
          PROVIDER_DELIVERY_STATE.mayHaveSent,
          0,
          PROVIDER_CALL_OUTCOME.inFlight,
          null,
          input.createdAt,
          null,
        ) as ProviderCallLogRow
      db.exec('COMMIT')
      return { status: 'recorded' as const, record: providerCallLogOfRow(stored) }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },
  settle: async (input: ProviderCallSettleInput) => {
    await ctx.ensureInit()
    const stored = ctx.required
      .prepare(
        `UPDATE provider_call_log
            SET delivery_state = ?, retry_safe = ?, outcome = ?, token_usage = ?, settled_at = ?
          WHERE id = ? AND outcome = ?
        RETURNING ${COLUMNS}`,
      )
      .get(
        input.deliveryState,
        input.retrySafe ? 1 : 0,
        input.outcome,
        input.usage ? JSON.stringify(input.usage) : null,
        input.settledAt,
        input.id,
        PROVIDER_CALL_OUTCOME.inFlight,
      ) as ProviderCallLogRow | undefined

    if (stored) {
      return providerCallLogOfRow(stored)
    }
    const current = ctx.required
      .prepare(`SELECT ${COLUMNS} FROM provider_call_log WHERE id = ?`)
      .get(input.id) as ProviderCallLogRow | undefined

    return current ? providerCallLogOfRow(current) : null
  },
  get: async (id: string) => {
    await ctx.ensureInit()
    const row = ctx.required
      .prepare(`SELECT ${COLUMNS} FROM provider_call_log WHERE id = ?`)
      .get(id) as ProviderCallLogRow | undefined

    return row ? providerCallLogOfRow(row) : null
  },
  latestForJobCall: async (jobId: string, jobCallKey: string) => {
    await ctx.ensureInit()
    const row = latestAttempt(ctx, jobId, jobCallKey)
    return row ? providerCallLogOfRow(row) : null
  },
  pruneTerminalBefore: async (before: string, limit = 1_000) => {
    await ctx.ensureInit()
    const bounded = Math.max(1, Math.min(limit, 1_000))
    const removed = ctx.required
      .prepare(
        `DELETE FROM provider_call_log
          WHERE id IN (
            SELECT entry.id
              FROM provider_call_log AS entry
              LEFT JOIN jobs AS job ON job.id = entry.job_id
             WHERE entry.outcome <> ? AND entry.settled_at IS NOT NULL
               AND entry.settled_at < ?
               AND (
                 entry.job_id IS NULL OR job.id IS NULL
                 OR job.status NOT IN ('pending', 'running')
               )
             ORDER BY entry.settled_at, entry.id
             LIMIT ?
          )
        RETURNING id`,
      )
      .all(PROVIDER_CALL_OUTCOME.inFlight, before, bounded)

    return removed.length
  },
  listForOwner: async (owner: string) => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare(
        `SELECT ${COLUMNS} FROM provider_call_log
          WHERE owner = ? ORDER BY created_at, id`,
      )
      .all(owner) as ProviderCallLogRow[]

    return rows.map(providerCallLogOfRow)
  },
})
