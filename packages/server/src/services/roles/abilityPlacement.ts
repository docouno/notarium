import type { AbilityPlacementPersistence, OwnedRolePlacementMove } from '../metaDb'
import type { InMemoryAbilityPreferences } from './abilityPreferences'

/** Non-durable adapter for tests and explicitly meta-DB-less hosts. Placement is part
 *  of an owned Role's ADDRESS, so every table keyed by that address has to move with
 *  the package or start naming a placement that no longer exists.
 *
 *  Of the five such tables — context sets, scope pins, the order overlay, the owner's
 *  preference, the durable episode — a host composed without a meta-DB has four. The
 *  fifth it DOES have: `inMemoryAbilityPersistence()` hands it a preference twin, so
 *  a no-op here silently re-enabled a role the owner had turned off, because the row
 *  kept naming the pre-move locator and an absent row reads as enabled. What this
 *  adapter carries is exactly what the host it is composed with holds — no more, and
 *  no less. */
export const createInMemoryAbilityPlacement = (facets: {
  abilityPreferences: InMemoryAbilityPreferences
}): AbilityPlacementPersistence => ({
  moveOwnedRolePlacement: async (move: OwnedRolePlacementMove) => {
    facets.abilityPreferences.moveLocator(move.fromLocator, move.toLocator)
  },
})
