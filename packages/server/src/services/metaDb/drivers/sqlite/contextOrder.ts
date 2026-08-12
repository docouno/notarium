import { referenceIdentityConflict } from '../../identityRefs'
import { contextOrderOfRow, type ContextOrderRow, dedupOrderEntries } from '../../rows'
import type { ContextOrderPersistence, ContextSetTargetKind } from '../../types'
import type { SqliteDriverCtx } from './context'
import { isRetiredIdentity, resolveLiveIdentityForWrite } from './liveIdentity'

export const createContextOrderFacet = (ctx: SqliteDriverCtx): ContextOrderPersistence => ({
  orderForTarget: async (targetKind: ContextSetTargetKind, targetId: string) => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare(
        'SELECT target_kind, target_id, target_space, entry_kind, entry_ref, rank FROM context_order WHERE target_kind = ? AND target_id = ? ORDER BY rank ASC',
      )
      .all(targetKind, targetId) as ContextOrderRow[]
    return rows.map(contextOrderOfRow)
  },
  // Atomic on the event loop: DELETE the scope's rows then INSERT the new sequence with no
  // await between, so a concurrent reorder can't interleave — the two calls run to completion
  // one after the other, a clean last-writer-wins with no torn ranks and no PK clash. (pg buys
  // the same serialization explicitly via a per-scope advisory lock, since its txns run on
  // separate pooled connections.)
  setOrder: async (targetKind, targetId, targetSpace, entries) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN IMMEDIATE')
    try {
      const membership = db.prepare(
        'SELECT note_space FROM context_scope_pins WHERE target_kind = ? AND target_id = ? AND note_id = ?',
      )
      const canonical = entries.map((e) => {
        if (e.entryKind !== 'pin') {
          return e
        }
        const pin = membership.get(targetKind, targetId, e.entryRef) as
          { note_space: string } | undefined

        if (pin) {
          return { ...e, entryRef: resolveLiveIdentityForWrite(db, pin.note_space, e.entryRef) }
        }
        if (isRetiredIdentity(db, e.entryRef)) {
          throw referenceIdentityConflict(e.entryRef)
        }

        // A stale non-member: it ranks nothing, exactly as before.
        return e
      })
      const rows = dedupOrderEntries(canonical)

      db.prepare('DELETE FROM context_order WHERE target_kind = ? AND target_id = ?').run(
        targetKind,
        targetId,
      )
      const ins = db.prepare(
        'INSERT INTO context_order (target_kind, target_id, target_space, entry_kind, entry_ref, rank) VALUES (?, ?, ?, ?, ?, ?)',
      )
      rows.forEach((e, rank) =>
        ins.run(targetKind, targetId, targetSpace, e.entryKind, e.entryRef, rank),
      )
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  },
})
