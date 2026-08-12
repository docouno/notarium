import { scopePinOfRow, type ScopePinRow } from '../../rows'
import type { ContextSetTargetKind, ScopePinRecord, ScopePinsPersistence } from '../../types'
import type { PgDriverCtx } from './context'
import { enterIdentityTierForReferences } from './liveIdentity'

export const createScopePinsFacet = (ctx: PgDriverCtx): ScopePinsPersistence => ({
  addPin: async (r: ScopePinRecord) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      const identity = await enterIdentityTierForReferences(client, [r.noteId])
      const noteId = identity.canonical(r.noteSpace, r.noteId)

      await client.query(
        `INSERT INTO context_scope_pins (target_kind, target_id, target_space, note_space, note_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (target_kind, target_id, note_id) DO UPDATE SET
             target_space = EXCLUDED.target_space,
             note_space = EXCLUDED.note_space,
             created_at = EXCLUDED.created_at`,
        [r.targetKind, r.targetId, r.targetSpace, r.noteSpace, noteId, r.createdAt],
      )
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  },
  removePin: async (targetKind: ContextSetTargetKind, targetId: string, noteId: string) => {
    await ctx.ensureInit()
    await ctx.required.query(
      'DELETE FROM context_scope_pins WHERE target_kind = $1 AND target_id = $2 AND note_id = $3',
      [targetKind, targetId, noteId],
    )
  },
  pinsForTarget: async (targetKind: ContextSetTargetKind, targetId: string) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      'SELECT target_kind, target_id, target_space, note_space, note_id, created_at FROM context_scope_pins WHERE target_kind = $1 AND target_id = $2 ORDER BY created_at ASC',
      [targetKind, targetId],
    )
    return (res.rows as ScopePinRow[]).map(scopePinOfRow)
  },
})
