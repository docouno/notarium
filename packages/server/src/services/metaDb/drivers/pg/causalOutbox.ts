import { CAUSAL_BARRIER_KIND, type CausalOutboxPersistence } from '@notarium/core'

import { causalOutboxOfRow, type CausalOutboxRow } from '../../causalRows'
import { lockCausalBarriers } from './causalBarriers'
import type { PgDriverCtx } from './context'

export const createCausalOutboxFacet = (ctx: PgDriverCtx): CausalOutboxPersistence => ({
  init: () => ctx.ensureInit(),
  append: async (input) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await lockCausalBarriers(
        client,
        [
          {
            kind: CAUSAL_BARRIER_KIND.spaceLifecycle,
            space: input.space,
            key: input.space,
          },
          {
            kind: CAUSAL_BARRIER_KIND.outbox,
            space: input.space,
            key: `${input.kind}:${input.resourceId}`,
          },
        ],
        (kind) => (kind === CAUSAL_BARRIER_KIND.spaceLifecycle ? 'shared' : 'exclusive'),
      )
      const result = await client.query(
        `INSERT INTO causal_outbox
          (space, generation, kind, operation_id, resource_id, created_at, acknowledged_at)
         VALUES ($1, $2, $3, $4, $5, $6, NULL)
         RETURNING *`,
        [
          input.space,
          input.generation,
          input.kind,
          input.operationId,
          input.resourceId,
          input.createdAt,
        ],
      )
      await client.query('COMMIT')
      return causalOutboxOfRow(result.rows[0] as CausalOutboxRow)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
  pending: async (subscriberId, limit) => {
    if (!subscriberId || subscriberId.length > 200) {
      throw new Error('causal outbox subscriber id must be a bounded non-empty string')
    }
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error('causal outbox limit must be a non-negative integer')
    }
    await ctx.ensureInit()
    const result = await ctx.required.query(
      `SELECT events.* FROM causal_outbox AS events
         LEFT JOIN causal_outbox_deliveries AS deliveries
           ON deliveries.subscriber_id = $1 AND deliveries.event_id = events.id
        WHERE deliveries.event_id IS NULL
        ORDER BY events.id LIMIT $2`,
      [subscriberId, limit],
    )
    return (result.rows as CausalOutboxRow[]).map(causalOutboxOfRow)
  },
  acknowledge: async (subscriberId, ids, at) => {
    if (!subscriberId || subscriberId.length > 200) {
      throw new Error('causal outbox subscriber id must be a bounded non-empty string')
    }
    if (!ids.length) {
      return
    }
    await ctx.ensureInit()
    await ctx.required.query(
      `INSERT INTO causal_outbox_deliveries (subscriber_id, event_id, acknowledged_at)
       SELECT $1, id, $3 FROM causal_outbox WHERE id = ANY($2::bigint[])
       ON CONFLICT (subscriber_id, event_id) DO NOTHING`,
      [subscriberId, [...new Set(ids)], at],
    )
  },
})
