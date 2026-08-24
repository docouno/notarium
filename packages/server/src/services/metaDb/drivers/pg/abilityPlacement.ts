import { abilitySpaceOfLocator } from '../../abilityAddress'
import type { AbilityPlacementPersistence, OwnedRolePlacementMove } from '../../types'
import type { PgDriverCtx } from './context'
import {
  lockAbilityPreferencePackages,
  lockContextOrderScopes,
  lockScopePinTargets,
} from './lockOrder'

const ROLE_TARGET = 'role'

export const createAbilityPlacementFacet = (ctx: PgDriverCtx): AbilityPlacementPersistence => ({
  resolveMovedOwnedRoleLocator: async (fromLocator) => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      `SELECT to_locator, registry_note_id, manifest_note_id
         FROM ability_placement_trail
        WHERE from_locator = $1`,
      [fromLocator],
    )
    const row = result.rows[0] as
      | {
          to_locator: string
          registry_note_id: string | null
          manifest_note_id: string | null
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
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      // The statements are ordered by the level of the table they TARGET —
      // L2b attachments, L2d pins, L2e advisory, L2f order, L4p preferences — and the
      // one unlevelled table (`agent_sessions`) comes last. See `lockOrder`: a
      // transaction that derives the order for itself deadlocks against one that
      // derived it differently.
      //
      // Each pair is delete-then-update, and the delete is not defensive noise: every
      // one of these tables is keyed by the target/locator this move rewrites onto, so
      // a leftover row at the destination (a promotion undone by hand and redone)
      // would fail the UPDATE on the primary key and abort a move that is otherwise
      // legitimate. The destination belongs to the package being moved either way.
      await client.query(
        'DELETE FROM context_set_attachments WHERE target_kind = $1 AND target_id = $2',
        [ROLE_TARGET, move.toTargetId],
      )
      await client.query(
        'UPDATE context_set_attachments SET target_id = $1 WHERE target_kind = $2 AND target_id = $3',
        [move.toTargetId, ROLE_TARGET, move.fromTargetId],
      )

      // The pins are re-addressed by RANGE, so this is the same shape as L4p below:
      // the other writer of this table — a user pinning a note to this very role —
      // inserts a row keyed by a note this transaction cannot name, and under READ
      // COMMITTED the two pass through each other unless both name the TARGET. Both
      // targets, because a pin may arrive at either address while the move runs, and
      // sorted inside the helper so two mirrored moves cannot deadlock.
      await lockScopePinTargets(client, [
        { targetKind: ROLE_TARGET, targetId: move.fromTargetId },
        { targetKind: ROLE_TARGET, targetId: move.toTargetId },
      ])
      await client.query(
        'DELETE FROM context_scope_pins WHERE target_kind = $1 AND target_id = $2',
        [ROLE_TARGET, move.toTargetId],
      )
      await client.query(
        'UPDATE context_scope_pins SET target_id = $1 WHERE target_kind = $2 AND target_id = $3',
        [move.toTargetId, ROLE_TARGET, move.fromTargetId],
      )

      // The order overlay is rewritten by primary key on both sides, so it needs the
      // per-scope advisory of BOTH scopes — the level L2f cannot be entered without.
      await lockContextOrderScopes(client, [
        { targetKind: ROLE_TARGET, targetId: move.fromTargetId },
        { targetKind: ROLE_TARGET, targetId: move.toTargetId },
      ])
      await client.query('DELETE FROM context_order WHERE target_kind = $1 AND target_id = $2', [
        ROLE_TARGET,
        move.toTargetId,
      ])
      await client.query(
        'UPDATE context_order SET target_id = $1 WHERE target_kind = $2 AND target_id = $3',
        [move.toTargetId, ROLE_TARGET, move.fromTargetId],
      )

      // The owner's sparse `disabled` bit is keyed by the WHOLE locator, placement
      // included, so it follows the address like the pointers above. Its lifecycle
      // keys (Space, registry note) are untouched by a move inside one Space. The move
      // carries no owner and rewrites the key for ALL of them at once, so it can name
      // no prefix of the `(owner, locator)` primary key — `ability_preferences_locator`
      // (migration 0015) is the index that keeps it from scanning every override in
      // the installation.
      //
      // …and being a RANGE is exactly why L4p is entered first, with BOTH locators. The
      // other writer of this table inserts a row keyed by the same locator and an owner
      // this transaction cannot name; under READ COMMITTED that insert is invisible to
      // the UPDATE below and unlockable by it, so the two are serialized on the locator
      // or not at all — and "not at all" is an owner's explicit disable turning itself
      // back on. Sorted inside the helper, so two mirrored moves cannot deadlock.
      await lockAbilityPreferencePackages(client, [move.fromLocator, move.toLocator])
      await client.query('DELETE FROM ability_preferences WHERE locator = $1', [move.toLocator])
      await client.query('UPDATE ability_preferences SET locator = $1 WHERE locator = $2', [
        move.toLocator,
        move.fromLocator,
      ])
      // The hop itself, for the writers whose address is one statement older than this
      // transaction. Carrying the rows is only half of an address change: an override
      // written at the address just left would sit where nothing reads it, and the
      // role its owner switched off would read as enabled at the address it now has.
      // Order matters and is the same three statements in both dialects:
      //
      //   1. the destination stops forwarding — it is occupied now, and the row that
      //      pointed OUT of it belongs to the placement this package just undid;
      //   2. whatever pointed AT the source now points at the destination, so the
      //      trail stays one hop deep and no reader ever walks a chain;
      //   3. the source itself starts forwarding.
      //
      // (1) before (2) is what keeps a promotion undone by hand from writing a row
      // that forwards an address to itself.
      const space = abilitySpaceOfLocator(move.fromLocator)

      if (space !== null) {
        await client.query('DELETE FROM ability_placement_trail WHERE from_locator = $1', [
          move.toLocator,
        ])
        await client.query(
          `UPDATE ability_placement_trail
              SET to_locator = $1, registry_note_id = $2, manifest_note_id = $3
            WHERE to_locator = $4`,
          [move.toLocator, move.registryNoteId, move.manifestNoteId, move.fromLocator],
        )
        await client.query(
          `INSERT INTO ability_placement_trail
             (from_locator, to_locator, space_id, registry_note_id, manifest_note_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (from_locator) DO UPDATE SET
             to_locator = excluded.to_locator,
             registry_note_id = excluded.registry_note_id,
             manifest_note_id = excluded.manifest_note_id`,
          [move.fromLocator, move.toLocator, space, move.registryNoteId, move.manifestNoteId],
        )
      }

      // Exact resume is fail-closed by design, so an episode left on the old locator
      // would silently drop back to base mode instead of following its role.
      await client.query('UPDATE agent_sessions SET role_locator = $1 WHERE role_locator = $2', [
        move.toLocator,
        move.fromLocator,
      ])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
})
