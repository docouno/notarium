import { CONTEXT_KIND } from '@notarium/contract'
import { isGeneratedNoteId } from '@notarium/core'

import type { Principal } from '../authz'
import type {
  ContextOrderPersistence,
  ContextSetsPersistence,
  ScopePinsPersistence,
} from '../metaDb'
import type { SpaceManager } from '../spaces'
import {
  type StoreAccess,
  weighScopeContextSets,
  weighScopeOrder,
  weighScopePins,
} from '../storeAccess'
import type { ResolvedOwnedRole, RoleLocation } from './types'

export type RoleContextTarget = {
  id: string
  space: string
  name: string
  location: RoleLocation
}

export type ParsedRoleContextTarget = {
  scope: RoleLocation['scope']
  ownerId: string
  packageId: string
}

const roleOwnerId = (location: RoleLocation): string => {
  if (location.scope === 'project') {
    if (!location.projectId) {
      throw new Error('project role location requires projectId')
    }

    return location.projectId
  }

  return location.space
}

/** The ONE spelling of a role context target id. Placement is part of the address —
 * which is exactly why promoting a project version to the Space base has to MOVE the
 * rows keyed by it instead of assuming they follow the package. */
export const roleContextTargetIdOf = (location: RoleLocation, packageId: string): string =>
  `${location.scope}:${encodeURIComponent(roleOwnerId(location))}:${packageId}`

/** Stable identity of one owned Agent Role placement. Scope + stable space/project id
 * + immutable package id survives role-name, handle and project-path changes while
 * keeping same-name Personal/Space/Project forks independent. */
export const roleContextTargetOf = (
  resolved: Pick<ResolvedOwnedRole, 'location' | 'packageId'> & { role: { name: string } },
): RoleContextTarget => ({
  id: roleContextTargetIdOf(resolved.location, resolved.packageId),
  space: resolved.location.space,
  name: resolved.role.name,
  location: resolved.location,
})

/** Best-effort decoder for management labels. Persistence treats target ids as opaque;
 * malformed/stale values stay safely undescribed instead of selecting another role. */
export const parseRoleContextTarget = (id: string): ParsedRoleContextTarget | null => {
  const [scope, ownerRaw, packageId, ...tail] = id.split(':')

  if (
    tail.length > 0 ||
    !['personal', 'space', 'project'].includes(scope) ||
    !ownerRaw ||
    !packageId
  ) {
    return null
  }

  try {
    const ownerId = decodeURIComponent(ownerRaw)
    return ownerId && isGeneratedNoteId(packageId)
      ? { scope: scope as RoleLocation['scope'], ownerId, packageId }
      : null
  } catch {
    return null
  }
}

type RoleContextDeps = {
  store: StoreAccess
  spaces: SpaceManager
  contextSets?: ContextSetsPersistence
  scopePins?: ScopePinsPersistence
  contextOrder?: ContextOrderPersistence
}

/** Resolve the three reusable context facets for the exact placement selected by the
 * role resolver. Missing meta-DB facets honestly degrade to an empty preset. */
export const weighRoleContext = async (
  deps: RoleContextDeps,
  principal: Principal,
  resolved: ResolvedOwnedRole,
) => {
  const target = roleContextTargetOf(resolved)
  const selector = { kind: CONTEXT_KIND.role, id: target.id } as const
  const [pins, sets, order] = await Promise.all([
    weighScopePins(deps, principal, selector),
    weighScopeContextSets(deps, principal, selector),
    weighScopeOrder(deps, selector),
  ])

  return { target, pins, sets, order }
}
