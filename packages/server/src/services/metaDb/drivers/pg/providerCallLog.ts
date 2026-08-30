import type { PoolClient } from 'pg'

import { PROVIDER_CALL_OUTCOME, PROVIDER_DELIVERY_STATE } from '@notarium/contract'

import { providerCallLicensesAnotherAttempt } from '../../providerCallLog'
import { providerCallLogOfRow, type ProviderCallLogRow } from '../../rows'
import type {
  ProviderCallIntentInput,
  ProviderCallLogPersistence,
  ProviderCallSettleInput,
} from '../../types'
import type { PgDriverCtx } from './context'
import { lockProviderCallLogEntry } from './lockOrder'

const latestAttempt = async (
  client: Pick<PoolClient, 'query'>,
  jobId: string,
  jobCallKey: string,
): Promise<ProviderCallLogRow | undefined> => {
  const result = await client.query(
    `SELECT * FROM provider_call_log
      WHERE job_id = $1 AND job_call_key = $2
      ORDER BY attempt_no DESC LIMIT 1`,
    [jobId, jobCallKey],
  )

  return result.rows[0] as ProviderCallLogRow | undefined
}

export const createProviderCallLogFacet = (ctx: PgDriverCtx): ProviderCallLogPersistence => ({
  intent: async (input: ProviderCallIntentInput) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await lockProviderCallLogEntry(client, { id: input.id, job: input.job })
      const previous = input.job
        ? await latestAttempt(client, input.job.jobId, input.job.jobCallKey)
        : undefined

      if (previous) {
        const record = providerCallLogOfRow(previous)

        if (!providerCallLicensesAnotherAttempt(record)) {
          await client.query('COMMIT')
          return { status: 'blocked' as const, record }
        }
      }
      const stored = await client.query(
        `INSERT INTO provider_call_log
           (id, owner, principal, agent, resource_id, credential_id, host, spaces,
            job_id, job_call_key, attempt_no, delivery_state, retry_safe, outcome,
            token_usage, created_at, settled_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         RETURNING *`,
        [
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
          input.job ? Number(previous?.attempt_no ?? 0) + 1 : null,
          // The intent is written before the transport may send, so the honest reading
          // of a process that dies right here is "it might have gone out".
          PROVIDER_DELIVERY_STATE.mayHaveSent,
          false,
          PROVIDER_CALL_OUTCOME.inFlight,
          null,
          input.createdAt,
          null,
        ],
      )
      await client.query('COMMIT')
      return {
        status: 'recorded' as const,
        record: providerCallLogOfRow(stored.rows[0] as ProviderCallLogRow),
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
  settle: async (input: ProviderCallSettleInput) => {
    await ctx.ensureInit()
    const stored = await ctx.required.query(
      `UPDATE provider_call_log
          SET delivery_state = $2, retry_safe = $3, outcome = $4, token_usage = $5, settled_at = $6
        WHERE id = $1 AND outcome = $7
      RETURNING *`,
      [
        input.id,
        input.deliveryState,
        input.retrySafe,
        input.outcome,
        input.usage ? JSON.stringify(input.usage) : null,
        input.settledAt,
        PROVIDER_CALL_OUTCOME.inFlight,
      ],
    )
    const row = stored.rows[0] as ProviderCallLogRow | undefined

    if (row) {
      return providerCallLogOfRow(row)
    }
    const current = await ctx.required.query('SELECT * FROM provider_call_log WHERE id = $1', [
      input.id,
    ])
    const existing = current.rows[0] as ProviderCallLogRow | undefined

    return existing ? providerCallLogOfRow(existing) : null
  },
  get: async (id: string) => {
    await ctx.ensureInit()
    const result = await ctx.required.query('SELECT * FROM provider_call_log WHERE id = $1', [id])
    const row = result.rows[0] as ProviderCallLogRow | undefined

    return row ? providerCallLogOfRow(row) : null
  },
  latestForJobCall: async (jobId: string, jobCallKey: string) => {
    await ctx.ensureInit()
    const row = await latestAttempt(ctx.required, jobId, jobCallKey)
    return row ? providerCallLogOfRow(row) : null
  },
  pruneTerminalBefore: async (before: string, limit = 1_000) => {
    await ctx.ensureInit()
    const bounded = Math.max(1, Math.min(limit, 1_000))
    const result = await ctx.required.query(
      `WITH removable AS (
         SELECT entry.id
           FROM provider_call_log AS entry
           LEFT JOIN jobs AS job ON job.id = entry.job_id
          WHERE entry.outcome <> $1 AND entry.settled_at IS NOT NULL
            AND entry.settled_at < $2
            AND (
              entry.job_id IS NULL OR job.id IS NULL
              OR job.status NOT IN ('pending', 'running')
            )
          ORDER BY entry.settled_at, entry.id
          LIMIT $3
       )
       DELETE FROM provider_call_log AS entry USING removable
        WHERE entry.id = removable.id
       RETURNING entry.id`,
      [PROVIDER_CALL_OUTCOME.inFlight, before, bounded],
    )

    return result.rowCount ?? 0
  },
  listForOwner: async (owner: string) => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      'SELECT * FROM provider_call_log WHERE owner = $1 ORDER BY created_at, id',
      [owner],
    )

    return (result.rows as ProviderCallLogRow[]).map(providerCallLogOfRow)
  },
})
