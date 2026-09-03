// What a durable ability ADDRESS is asked, outside the facet that stores it: which
// package does it name, and whose Space is that package in? Both are read out of the
// locator itself, because a locator is the only thing the writers of these tables share
// — a placement move carries no owner and no registry note, only two addresses.
//
// It lives here rather than in either driver for the same reason `abilityLifecycle`
// does: two dialects and a twin ask the same question, and a question re-derived per
// implementation is how they come to disagree.
// canon: docs/meta-db.md#source-of-truth

import type { OwnedAbilityLocator } from '@notarium/contract'
import { isAbilityLocator, parseAbilityLocator } from '@notarium/core'

type OwnedRoleLocator = Extract<OwnedAbilityLocator, { kind: 'role' }>

export type RoleContextTargetAddress = {
  targetId: string
  targetSpace: string
}

export type OwnedRolePlacementAddresses = {
  fromLocator: OwnedRoleLocator
  toLocator: OwnedRoleLocator
  fromTarget: RoleContextTargetAddress
  toTarget: RoleContextTargetAddress
}

export type OwnedRolePlacementTrailEvidence = {
  toLocator: string
  registryNoteId: string
  manifestNoteId: string
}

export type LiveRoleContextTarget = {
  locator: OwnedRoleLocator
  target: RoleContextTargetAddress
}

/** Compatible context-table projection of the canonical Owned Role locator. */
export const roleContextTargetOfLocator = (locator: OwnedRoleLocator): RoleContextTargetAddress => {
  const ownerId =
    locator.location.scope === 'project' ? locator.location.projectId : locator.location.spaceId

  return {
    targetId: `${locator.location.scope}:${encodeURIComponent(ownerId)}:${locator.packageId}`,
    targetSpace: locator.location.spaceId,
  }
}

/** Reverse the published context-table projection without consulting package inventory. */
export const ownedRoleLocatorOfContextTarget = (
  target: RoleContextTargetAddress,
): OwnedRoleLocator | null => {
  const [scope, encodedOwner, packageId, ...tail] = target.targetId.split(':')

  if (
    tail.length > 0 ||
    !encodedOwner ||
    !packageId ||
    !target.targetSpace ||
    (scope !== 'personal' && scope !== 'space' && scope !== 'project')
  ) {
    return null
  }

  try {
    const ownerId = decodeURIComponent(encodedOwner)

    if (!ownerId || encodeURIComponent(ownerId) !== encodedOwner) {
      return null
    }
    const location =
      scope === 'project'
        ? { scope, spaceId: target.targetSpace, projectId: ownerId }
        : { scope, spaceId: ownerId }
    const candidate = { source: 'owned', kind: 'role', packageId, location }

    if (
      !isAbilityLocator(candidate) ||
      candidate.source !== 'owned' ||
      candidate.kind !== 'role' ||
      (scope !== 'project' && ownerId !== target.targetSpace)
    ) {
      return null
    }

    return roleContextTargetOfLocator(candidate).targetId === target.targetId ? candidate : null
  } catch {
    return null
  }
}

export const ownedRolePlacementAddresses = (
  fromLocator: string,
  toLocator: string,
): OwnedRolePlacementAddresses => {
  const from = parseAbilityLocator(fromLocator)
  const to = parseAbilityLocator(toLocator)

  if (
    from?.source !== 'owned' ||
    from.kind !== 'role' ||
    to?.source !== 'owned' ||
    to.kind !== 'role' ||
    from.packageId !== to.packageId ||
    from.location.spaceId !== to.location.spaceId ||
    fromLocator === toLocator
  ) {
    throw new Error('invalid Owned Role placement move')
  }

  return {
    fromLocator: from,
    toLocator: to,
    fromTarget: roleContextTargetOfLocator(from),
    toTarget: roleContextTargetOfLocator(to),
  }
}

const exactTrail = (
  row: OwnedRolePlacementTrailEvidence,
  toLocator: string,
  registryNoteId: string,
  manifestNoteId: string,
): boolean =>
  row.toLocator === toLocator &&
  row.registryNoteId === registryNoteId &&
  row.manifestNoteId === manifestNoteId

export const classifyOwnedRolePlacementMove = (input: {
  fromLocator: string
  toLocator: string
  registryNoteId: string
  manifestNoteId: string
  trail: 'record' | 'cancel'
  fromTrail: OwnedRolePlacementTrailEvidence | null
  toTrail: OwnedRolePlacementTrailEvidence | null
}): 'apply' | 'replay' => {
  if (input.trail === 'record') {
    if (!input.fromTrail) {
      return 'apply'
    }
    if (exactTrail(input.fromTrail, input.toLocator, input.registryNoteId, input.manifestNoteId)) {
      return 'replay'
    }
  } else {
    if (
      input.toTrail &&
      exactTrail(input.toTrail, input.fromLocator, input.registryNoteId, input.manifestNoteId)
    ) {
      return 'apply'
    }
    if (!input.toTrail && !input.fromTrail) {
      return 'replay'
    }
  }

  throw new Error('Owned Role placement trail conflicts with the requested move')
}

export const resolveLiveRoleContextTarget = (
  target: RoleContextTargetAddress,
  trail: OwnedRolePlacementTrailEvidence | null,
): LiveRoleContextTarget => {
  const captured = ownedRoleLocatorOfContextTarget(target)

  if (!captured) {
    throw new Error('invalid Owned Role context target projection')
  }
  if (!trail) {
    return { locator: captured, target }
  }
  const moved = parseAbilityLocator(trail.toLocator)

  if (
    moved?.source !== 'owned' ||
    moved.kind !== 'role' ||
    moved.packageId !== captured.packageId ||
    moved.location.spaceId !== captured.location.spaceId
  ) {
    throw new Error('invalid Owned Role placement trail destination')
  }

  return { locator: moved, target: roleContextTargetOfLocator(moved) }
}

/** The PACKAGE an address names — everything about the locator except where the
 *  package currently stands.
 *
 *  It is the key the L4p advisory is taken on, and the placement is left out on
 *  purpose: a move changes the placement, so a key that included it would put the two
 *  writers of a moving package on two different stripes at the exact moment they have
 *  to meet — the move on both spellings, an owner's `setEnabled` on whichever one its
 *  caller still holds. The package is the one thing both name in either order.
 *
 *  A locator this host cannot parse is its own key: an address nothing can read is an
 *  address nothing can move, so serializing it as itself serializes it with itself. */
export const abilityPackageOfLocator = (locator: string): string => {
  const parsed = parseAbilityLocator(locator)

  if (!parsed) {
    return locator
  }

  return parsed.source === 'owned'
    ? `owned:${parsed.kind}:${parsed.location.spaceId}:${parsed.packageId}`
    : `${parsed.source}:${parsed.kind}:${parsed.packageId}`
}

/** The Space an OWNED address belongs to, and null for anything else — a System
 *  package has no Space to be purged with, and neither has an address this host cannot
 *  read. The lifecycle key of a row keyed by an address, in other words: the sweeps of
 *  these tables are by Space, and a row nobody can attribute to one cannot be swept. */
export const abilitySpaceOfLocator = (locator: string): string | null => {
  const parsed = parseAbilityLocator(locator)

  return parsed?.source === 'owned' ? parsed.location.spaceId : null
}
