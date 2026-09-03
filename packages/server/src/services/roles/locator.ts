import { type OwnedAbilityLocator, ROLE_SCOPE } from '@notarium/contract'

import type { RoleLocation, SkillHomeLocation } from './types'

/** A placement, as the ADDRESS a client will send back. The inverse direction of the
 *  locator seam, and it belongs to the service for the same reason the seam does:
 *  spelled out at each door instead, it became eight copies — three of them
 *  dereferencing `projectId!` — and the first shape change caught two of them. */
export const ownedRoleLocator = (
  location: RoleLocation,
  packageId: string,
): Extract<OwnedAbilityLocator, { kind: 'role' }> => ({
  source: 'owned',
  kind: 'role',
  packageId,
  location:
    location.scope === ROLE_SCOPE.project
      ? { scope: ROLE_SCOPE.project, spaceId: location.space, projectId: location.projectId! }
      : { scope: location.scope, spaceId: location.space },
})

/** The same, for a skill — which has no project placement to spell. */
export const ownedSkillLocator = (
  location: SkillHomeLocation,
  packageId: string,
): Extract<OwnedAbilityLocator, { kind: 'skill' }> => ({
  source: 'owned',
  kind: 'skill',
  packageId,
  location: { scope: location.scope, spaceId: location.space },
})
