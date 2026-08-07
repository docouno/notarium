import { CONTEXT_KIND } from '@notarium/contract'

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
import type { ResolvedEffectiveRole, RoleLocation } from './types'

export type RoleContextTarget = {
  id: string
  space: string
  name: string
  location: RoleLocation
}

export type ParsedRoleContextTarget = {
  scope: RoleLocation['scope']
  ownerId: string
  name: string
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

/** Stable identity of one owned Agent Skill placement. Scope + stable space/project id
 * + standard package name survives display-name, handle and project-path changes while
 * keeping same-name Personal/Space/Project forks independent. */
export const roleContextTargetOf = (
  resolved: Pick<ResolvedEffectiveRole, 'location'> & { role: { name: string } },
): RoleContextTarget => {
  const ownerId = roleOwnerId(resolved.location)

  return {
    id: `${resolved.location.scope}:${encodeURIComponent(ownerId)}:${encodeURIComponent(resolved.role.name)}`,
    space: resolved.location.space,
    name: resolved.role.name,
    location: resolved.location,
  }
}

/** Best-effort decoder for management labels. Persistence treats target ids as opaque;
 * malformed/stale values stay safely undescribed instead of selecting another role. */
export const parseRoleContextTarget = (id: string): ParsedRoleContextTarget | null => {
  const [scope, ownerRaw, nameRaw, ...tail] = id.split(':')

  if (
    tail.length > 0 ||
    !['personal', 'space', 'project'].includes(scope) ||
    !ownerRaw ||
    !nameRaw
  ) {
    return null
  }

  try {
    const ownerId = decodeURIComponent(ownerRaw)
    const name = decodeURIComponent(nameRaw)

    return ownerId && name ? { scope: scope as RoleLocation['scope'], ownerId, name } : null
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
  resolved: ResolvedEffectiveRole,
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
