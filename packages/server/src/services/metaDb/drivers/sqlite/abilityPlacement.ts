import { abilitySpaceOfLocator } from '../../abilityAddress'
import type { AbilityPlacementPersistence, OwnedRolePlacementMove } from '../../types'
import type { SqliteDriverCtx } from './context'

const ROLE_TARGET = 'role'

export const createAbilityPlacementFacet = (ctx: SqliteDriverCtx): AbilityPlacementPersistence => ({
  resolveMovedOwnedRoleLocator: async (fromLocator) => {
    await ctx.ensureInit()
    const row = ctx.required
      .prepare(
        `SELECT to_locator, registry_note_id, manifest_note_id
           FROM ability_placement_trail
          WHERE from_locator = ?`,
      )
      .get(fromLocator) as
      | {
          to_locator: string
          registry_note_id: string
          manifest_note_id: string
        }
      | undefined

    return row
      ? {
          toLocator: row.to_locator,
          registryNoteId: row.registry_note_id,
          manifestNoteId: row.manifest_note_id,
        }
      : null
  },
  moveOwnedRolePlacement: async (move: OwnedRolePlacementMove) => {
    await ctx.ensureInit()
    const db = ctx.required

    db.exec('BEGIN IMMEDIATE')
    try {
      // Each pair is delete-then-update, and the delete is not defensive noise: every
      // one of these tables is keyed by the target/locator this move rewrites onto, so
      // a leftover row at the destination (a promotion undone by hand and redone)
      // would fail the UPDATE on the primary key and abort a move that is otherwise
      // legitimate. The destination belongs to the package being moved either way.
      db.prepare('DELETE FROM context_set_attachments WHERE target_kind = ? AND target_id = ?').run(
        ROLE_TARGET,
        move.toTargetId,
      )
      db.prepare(
        'UPDATE context_set_attachments SET target_id = ? WHERE target_kind = ? AND target_id = ?',
      ).run(move.toTargetId, ROLE_TARGET, move.fromTargetId)

      db.prepare('DELETE FROM context_scope_pins WHERE target_kind = ? AND target_id = ?').run(
        ROLE_TARGET,
        move.toTargetId,
      )
      db.prepare(
        'UPDATE context_scope_pins SET target_id = ? WHERE target_kind = ? AND target_id = ?',
      ).run(move.toTargetId, ROLE_TARGET, move.fromTargetId)

      db.prepare('DELETE FROM context_order WHERE target_kind = ? AND target_id = ?').run(
        ROLE_TARGET,
        move.toTargetId,
      )
      db.prepare(
        'UPDATE context_order SET target_id = ? WHERE target_kind = ? AND target_id = ?',
      ).run(move.toTargetId, ROLE_TARGET, move.fromTargetId)

      // The owner's sparse `disabled` bit is keyed by the WHOLE locator, placement
      // included, so it follows the address like the pointers above. Its lifecycle
      // keys (Space, registry note) are untouched by a move inside one Space. The move
      // carries no owner and rewrites the key for ALL of them at once, so it can name
      // no prefix of the `(owner, locator)` primary key;
      // `ability_preferences_locator` keeps that range indexed.
      db.prepare('DELETE FROM ability_preferences WHERE locator = ?').run(move.toLocator)
      db.prepare('UPDATE ability_preferences SET locator = ? WHERE locator = ?').run(
        move.toLocator,
        move.fromLocator,
      )
      // The hop itself, in the same statements and the same order as the PostgreSQL
      // twin: clear the destination's own forwarding first (it is occupied now), then
      // re-point whatever pointed at the source, then — only for a `record` — make the
      // source forward. Carrying the rows is half an address change; without this, an
      // override written at the address just left sits where nothing reads it and the
      // role its owner switched off reads as enabled at the address it now has.
      //
      // The first two statements are the whole of a `cancel`, and that is not an
      // omission: this move is walking the package back along a hop its caller
      // recorded, so the destination delete IS the removal of that hop, and the source
      // must end up forwarding NOWHERE. Writing a counter-hop instead would leave a row
      // that only a further compensating step could remove — and a trail row is read
      // fail-closed, so an interrupted compensation left the package unreachable from
      // both of its spellings at once.
      const space = abilitySpaceOfLocator(move.fromLocator)

      if (space !== null) {
        db.prepare('DELETE FROM ability_placement_trail WHERE from_locator = ?').run(move.toLocator)
        db.prepare(
          `UPDATE ability_placement_trail
             SET to_locator = ?, registry_note_id = ?, manifest_note_id = ?
           WHERE to_locator = ?`,
        ).run(move.toLocator, move.registryNoteId, move.manifestNoteId, move.fromLocator)
        if (move.trail === 'record') {
          db.prepare(
            `INSERT INTO ability_placement_trail
               (from_locator, to_locator, space_id, registry_note_id, manifest_note_id)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (from_locator) DO UPDATE SET
               to_locator = excluded.to_locator,
               registry_note_id = excluded.registry_note_id,
               manifest_note_id = excluded.manifest_note_id`,
          ).run(move.fromLocator, move.toLocator, space, move.registryNoteId, move.manifestNoteId)
        }
      }

      // Exact resume is fail-closed by design, so an episode left on the old locator
      // would silently drop back to base mode instead of following its role.
      db.prepare('UPDATE agent_sessions SET role_locator = ? WHERE role_locator = ?').run(
        move.toLocator,
        move.fromLocator,
      )
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },
})
