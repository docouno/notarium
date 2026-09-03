import type { AbilityPlacementPersistence, OwnedRolePlacementMove } from '@notarium/server'
import { ownedRolePlacementAddresses } from '@notarium/server'
import type { InMemoryAbilityPreferences } from './abilityPreferences'
import type { InMemoryAgentSessions } from './agentSessions'
import type { InMemoryContextOrder } from './contextOrder'
import type { InMemoryContextSets } from './contextSets'
import type { InMemoryScopePins } from './scopePins'

/** In-memory twin of the ability-placement facet for the fake server. Placement is
 *  part of an owned Role's ADDRESS, so the five tables keyed by that address move
 *  with the package or start pointing at a placement that no longer exists. The
 *  shipped meta-DB-less adapter carries just the owner preference, because that is the
 *  one of the five tables such a host still holds; the fake keeps all five, so it owes
 *  the same rewrite the sqlite/pg drivers do in one transaction. */
export const createInMemoryAbilityPlacement = (facets: {
  contextSets: InMemoryContextSets
  scopePins: InMemoryScopePins
  contextOrder: InMemoryContextOrder
  abilityPreferences: InMemoryAbilityPreferences
  agentSessions: InMemoryAgentSessions
}): AbilityPlacementPersistence => {
  facets.contextSets.setRoleTargetResolver((target) =>
    facets.abilityPreferences.liveRoleTarget(target),
  )
  facets.scopePins.setRoleTargetResolver((target) =>
    facets.abilityPreferences.liveRoleTarget(target),
  )
  facets.contextOrder.setRoleTargetResolver((target) =>
    facets.abilityPreferences.liveRoleTarget(target),
  )
  facets.agentSessions.setRoleLocatorResolver((locator) =>
    facets.abilityPreferences.liveRoleLocator(locator),
  )

  return {
    resolveMovedOwnedRoleLocator: async (fromLocator) =>
      facets.abilityPreferences.movedPlacement(fromLocator),
    moveOwnedRolePlacement: async (move: OwnedRolePlacementMove) => {
      const address = ownedRolePlacementAddresses(move.fromLocator, move.toLocator)
      const result = facets.abilityPreferences.moveLocator(
        move.fromLocator,
        move.toLocator,
        move.registryNoteId,
        move.manifestNoteId,
        move.trail,
      )

      if (result === 'replayed') {
        return result
      }
      facets.contextSets.moveRoleTarget(address.fromTarget.targetId, address.toTarget.targetId)
      facets.scopePins.moveRoleTarget(address.fromTarget.targetId, address.toTarget.targetId)
      facets.contextOrder.moveRoleTarget(address.fromTarget.targetId, address.toTarget.targetId)
      facets.agentSessions.moveRoleLocator(move.fromLocator, move.toLocator)
      return result
    },
  }
}
