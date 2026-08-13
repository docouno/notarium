import type { CausalOutboxPersistence } from '@notarium/core'

import { causalOutboxOfRow, type CausalOutboxRow } from '../../causalRows'
import type { SqliteDriverCtx } from './context'

export const createCausalOutboxFacet = (ctx: SqliteDriverCtx): CausalOutboxPersistence => ({
  init: () => ctx.ensureInit(),
  append: async (input) => {
    await ctx.ensureInit()
    const result = ctx.required
      .prepare(
        `INSERT INTO causal_outbox
          (space, generation, kind, operation_id, resource_id, created_at, acknowledged_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        input.space,
        input.generation,
        input.kind,
        input.operationId,
        input.resourceId,
        input.createdAt,
      )
    return causalOutboxOfRow(
      ctx.required
        .prepare('SELECT * FROM causal_outbox WHERE id = ?')
        .get(result.lastInsertRowid) as CausalOutboxRow,
    )
  },
  pending: async (subscriberId, limit) => {
    if (!subscriberId || subscriberId.length > 200) {
      throw new Error('causal outbox subscriber id must be a bounded non-empty string')
    }
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error('causal outbox limit must be a non-negative integer')
    }
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare(
        `SELECT events.* FROM causal_outbox AS events
           LEFT JOIN causal_outbox_deliveries AS deliveries
             ON deliveries.subscriber_id = ? AND deliveries.event_id = events.id
          WHERE deliveries.event_id IS NULL
          ORDER BY events.id LIMIT ?`,
      )
      .all(subscriberId, limit) as CausalOutboxRow[]
    return rows.map(causalOutboxOfRow)
  },
  acknowledge: async (subscriberId, ids, at) => {
    if (!subscriberId || subscriberId.length > 200) {
      throw new Error('causal outbox subscriber id must be a bounded non-empty string')
    }
    if (!ids.length) {
      return
    }
    await ctx.ensureInit()
    const db = ctx.required
    const statement = db.prepare(
      `INSERT OR IGNORE INTO causal_outbox_deliveries
         (subscriber_id, event_id, acknowledged_at)
       SELECT ?, id, ? FROM causal_outbox WHERE id = ?`,
    )
    db.exec('BEGIN')
    try {
      for (const id of new Set(ids)) {
        statement.run(subscriberId, at, Number(id))
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },
})
