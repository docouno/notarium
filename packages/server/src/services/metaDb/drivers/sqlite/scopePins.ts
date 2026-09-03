import { scopePinOfRow, type ScopePinRow } from '../../rows'
import type { ContextSetTargetKind, ScopePinRecord, ScopePinsPersistence } from '../../types'
import type { SqliteDriverCtx } from './context'
import { resolveLiveIdentityForWrite } from './liveIdentity'
import { resolveLiveRoleTargetForWrite } from './liveRoleTarget'

const ROLE_TARGET = 'role'

export const createScopePinsFacet = (ctx: SqliteDriverCtx): ScopePinsPersistence => ({
  addPin: async (r: ScopePinRecord) => {
    await ctx.ensureInit()
    const db = ctx.required

    db.exec('BEGIN IMMEDIATE')
    try {
      const noteId = resolveLiveIdentityForWrite(db, r.noteSpace, r.noteId)
      const live =
        r.targetKind === ROLE_TARGET
          ? resolveLiveRoleTargetForWrite(db, {
              targetId: r.targetId,
              targetSpace: r.targetSpace,
            }).target
          : { targetId: r.targetId, targetSpace: r.targetSpace }

      db.prepare(
        `INSERT INTO context_scope_pins (target_kind, target_id, target_space, note_space, note_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(target_kind, target_id, note_id) DO UPDATE SET
             target_space = excluded.target_space,
             note_space = excluded.note_space,
             created_at = excluded.created_at`,
      ).run(r.targetKind, live.targetId, live.targetSpace, r.noteSpace, noteId, r.createdAt)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  },
  removePin: async (
    targetKind: ContextSetTargetKind,
    targetId: string,
    targetSpace: string,
    noteId: string,
  ) => {
    await ctx.ensureInit()
    if (targetKind !== ROLE_TARGET) {
      ctx.required
        .prepare(
          'DELETE FROM context_scope_pins WHERE target_kind = ? AND target_id = ? AND note_id = ?',
        )
        .run(targetKind, targetId, noteId)
      return
    }
    ctx.required.exec('BEGIN IMMEDIATE')
    try {
      const live = resolveLiveRoleTargetForWrite(ctx.required, { targetId, targetSpace })
      ctx.required
        .prepare(
          'DELETE FROM context_scope_pins WHERE target_kind = ? AND target_id = ? AND note_id = ?',
        )
        .run(targetKind, live.target.targetId, noteId)
      ctx.required.exec('COMMIT')
    } catch (error) {
      ctx.required.exec('ROLLBACK')
      throw error
    }
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
