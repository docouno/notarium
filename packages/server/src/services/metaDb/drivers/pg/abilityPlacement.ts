import {
  abilitySpaceOfLocator,
  classifyOwnedRolePlacementMove,
  ownedRolePlacementAddresses,
} from '../../abilityAddress'
import type { AbilityPlacementPersistence, OwnedRolePlacementMove } from '../../types'
import type { PgDriverCtx } from './context'
import {
  lockAbilityPreferencePackages,
  lockRoleContextOrderPackages,
  lockRoleContextTargets,
  lockRoleScopePinTargets,
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
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      const address = ownedRolePlacementAddresses(move.fromLocator, move.toLocator)
      const placement = await lockRoleContextTargets(client, [move.fromLocator, move.toLocator])
      const classification = classifyOwnedRolePlacementMove({
        ...move,
        fromTrail: placement.trails.get(move.fromLocator) ?? null,
        toTrail: placement.trails.get(move.toLocator) ?? null,
      })

      if (classification === 'replay') {
        await client.query('COMMIT')
        return 'replayed'
      }
      const fromTargetId = address.fromTarget.targetId
      const toTargetId = address.toTarget.targetId
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
        [ROLE_TARGET, toTargetId],
      )
      await client.query(
        'UPDATE context_set_attachments SET target_id = $1 WHERE target_kind = $2 AND target_id = $3',
        [toTargetId, ROLE_TARGET, fromTargetId],
      )

      // The pins are re-addressed by RANGE, so this is the same shape as L4p below:
      // the other writer of this table — a user pinning a note to this very role —
      // inserts a row keyed by a note this transaction cannot name, and under READ
      // COMMITTED the two pass through each other unless both name the TARGET. Both
      // targets, because a pin may arrive at either address while the move runs, and
      // sorted inside the helper so two mirrored moves cannot deadlock.
      await lockRoleScopePinTargets(client, [move.fromLocator, move.toLocator])
      await client.query(
        'DELETE FROM context_scope_pins WHERE target_kind = $1 AND target_id = $2',
        [ROLE_TARGET, toTargetId],
      )
      await client.query(
        'UPDATE context_scope_pins SET target_id = $1 WHERE target_kind = $2 AND target_id = $3',
        [toTargetId, ROLE_TARGET, fromTargetId],
      )

      // The order overlay is rewritten by primary key on both sides, so it needs the
      // per-scope advisory of BOTH scopes — the level L2f cannot be entered without.
      await lockRoleContextOrderPackages(client, [move.fromLocator, move.toLocator])
      await client.query('DELETE FROM context_order WHERE target_kind = $1 AND target_id = $2', [
        ROLE_TARGET,
        toTargetId,
      ])
      await client.query(
        'UPDATE context_order SET target_id = $1 WHERE target_kind = $2 AND target_id = $3',
        [toTargetId, ROLE_TARGET, fromTargetId],
      )

      // The owner's sparse `disabled` bit is keyed by the WHOLE locator, placement
      // included, so it follows the address like the pointers above. Its lifecycle
      // keys (Space, registry note) are untouched by a move inside one Space. The move
      // carries no owner and rewrites the key for ALL of them at once, so it can name
      // no prefix of the `(owner, locator)` primary key;
      // `ability_preferences_locator` keeps that range indexed.
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
      //   3. the source itself starts forwarding — but ONLY for a `record`.
      //
      // (1) before (2) is what keeps a promotion undone by hand from writing a row
      // that forwards an address to itself.
      //
      // A `cancel` stops after (2), and (1) is what makes it an erasure: this move
      // walks the package back along a hop its caller recorded, so that hop is the
      // destination's own forwarding and deleting it IS the undo. The alternative —
      // (3) writing the counter-hop — leaves a row only a further compensating step can
      // remove, and every trail row is read fail-closed; an interrupted compensation
      // then left the package tombstoned at the address it actually stands at.
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
        if (move.trail === 'record') {
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
      }

      // Exact resume is fail-closed by design, so an episode left on the old locator
      // would silently drop back to base mode instead of following its role.
      await client.query('UPDATE agent_sessions SET role_locator = $1 WHERE role_locator = $2', [
        move.toLocator,
        move.fromLocator,
      ])
      await client.query('COMMIT')
      return 'applied'
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
})
