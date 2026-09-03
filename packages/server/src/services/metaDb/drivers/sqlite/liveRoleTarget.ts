import type { DatabaseSync } from 'node:sqlite'
import { serializeAbilityLocator } from '@notarium/core'

import {
  type LiveRoleContextTarget,
  ownedRoleLocatorOfContextTarget,
  resolveLiveRoleContextTarget,
  type RoleContextTargetAddress,
} from '../../abilityAddress'

export const resolveLiveRoleTargetForWrite = (
  db: DatabaseSync,
  target: RoleContextTargetAddress,
): LiveRoleContextTarget => {
  const locator = ownedRoleLocatorOfContextTarget(target)

  if (!locator) {
    throw new Error('invalid Owned Role context target projection')
  }
  const row = db
    .prepare(
      `SELECT to_locator, registry_note_id, manifest_note_id
         FROM ability_placement_trail
        WHERE from_locator = ?`,
    )
    .get(serializeAbilityLocator(locator)) as
    | {
        to_locator: string
        registry_note_id: string
        manifest_note_id: string
      }
    | undefined

  return resolveLiveRoleContextTarget(
    target,
    row
      ? {
          toLocator: row.to_locator,
          registryNoteId: row.registry_note_id,
          manifestNoteId: row.manifest_note_id,
        }
      : null,
  )
}
