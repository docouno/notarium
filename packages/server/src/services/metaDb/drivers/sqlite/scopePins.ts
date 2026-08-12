import { scopePinOfRow, type ScopePinRow } from '../../rows'
import type { ContextSetTargetKind, ScopePinRecord, ScopePinsPersistence } from '../../types'
import type { SqliteDriverCtx } from './context'
import { resolveLiveIdentityForWrite } from './liveIdentity'

export const createScopePinsFacet = (ctx: SqliteDriverCtx): ScopePinsPersistence => ({
  addPin: async (r: ScopePinRecord) => {
    await ctx.ensureInit()
    const db = ctx.required

    db.exec('BEGIN IMMEDIATE')
    try {
      const noteId = resolveLiveIdentityForWrite(db, r.noteSpace, r.noteId)

      db.prepare(
        `INSERT INTO context_scope_pins (target_kind, target_id, target_space, note_space, note_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(target_kind, target_id, note_id) DO UPDATE SET
             target_space = excluded.target_space,
             note_space = excluded.note_space,
             created_at = excluded.created_at`,
      ).run(r.targetKind, r.targetId, r.targetSpace, r.noteSpace, noteId, r.createdAt)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  },
  removePin: async (targetKind: ContextSetTargetKind, targetId: string, noteId: string) => {
    await ctx.ensureInit()
    ctx.required
      .prepare(
        'DELETE FROM context_scope_pins WHERE target_kind = ? AND target_id = ? AND note_id = ?',
      )
      .run(targetKind, targetId, noteId)
  },
  pinsForTarget: async (targetKind: ContextSetTargetKind, targetId: string) => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare(
        'SELECT target_kind, target_id, target_space, note_space, note_id, created_at FROM context_scope_pins WHERE target_kind = ? AND target_id = ? ORDER BY created_at ASC',
      )
      .all(targetKind, targetId) as ScopePinRow[]
    return rows.map(scopePinOfRow)
  },
})
