import { contextOrderOfRow, type ContextOrderRow, dedupOrderEntries } from '../../rows'
import type { ContextOrderPersistence, ContextSetTargetKind } from '../../types'
import type { PgDriverCtx } from './context'

/** Namespaces the two-arg per-scope reorder lock so it can never alias the single-arg SETUP_LOCK_KEY. */
const CONTEXT_ORDER_LOCK_NS = 0x6374_4f72 // 'ctOr'

/** Keys the per-scope advisory lock; a hash collision merely serializes two unrelated scopes, never a correctness issue. */
const hash32 = (s: string): number => {
  let h = 0

  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  }

  return h
}

export const createContextOrderFacet = (ctx: PgDriverCtx): ContextOrderPersistence => ({
  orderForTarget: async (targetKind: ContextSetTargetKind, targetId: string) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      'SELECT target_kind, target_id, target_space, entry_kind, entry_ref, rank FROM context_order WHERE target_kind = $1 AND target_id = $2 ORDER BY rank ASC',
      [targetKind, targetId],
    )
    return (res.rows as ContextOrderRow[]).map(contextOrderOfRow)
  },
  // Advisory xact lock serializes concurrent reorders of the SAME scope: without it two racing
  // DELETE-then-INSERT txns miss each other's committed rows (READ COMMITTED) → PK unique_violation.
  setOrder: async (targetKind, targetId, targetSpace, entries) => {
    await ctx.ensureInit()
    const rows = dedupOrderEntries(entries)
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
        CONTEXT_ORDER_LOCK_NS,
        hash32(`${targetKind}:${targetId}`),
      ])
      await client.query('DELETE FROM context_order WHERE target_kind = $1 AND target_id = $2', [
        targetKind,
        targetId,
      ])
      for (let rank = 0; rank < rows.length; rank++) {
        const e = rows[rank]
        await client.query(
          'INSERT INTO context_order (target_kind, target_id, target_space, entry_kind, entry_ref, rank) VALUES ($1, $2, $3, $4, $5, $6)',
          [targetKind, targetId, targetSpace, e.entryKind, e.entryRef, rank],
        )
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  },
})
