import {
  ownedRoleLocator,
  type RoleLocation,
  type RolesService,
  SYSTEM_PRINCIPAL,
} from '@notarium/server'

import type { AppliedAgentRole } from './applyAgentRoles'
import type { AgentRoleMoveDecl, AgentRoleTargetDecl } from './types'

const samePlacement = (left: RoleLocation, right: RoleLocation): boolean =>
  left.scope === right.scope && left.space === right.space && left.projectId === right.projectId

export const applyAgentRoleMoves = async (input: {
  declarations: readonly AgentRoleMoveDecl[]
  roles: RolesService
  publishedRoles: readonly AppliedAgentRole[]
  resolvePlacement(target: AgentRoleTargetDecl): Promise<RoleLocation>
  personalSpaceFor(location: RoleLocation): string | null
}): Promise<
  Array<{
    name: string
    from: ReturnType<typeof ownedRoleLocator>
    to: ReturnType<typeof ownedRoleLocator>
  }>
> => {
  const applied = []

  for (const declaration of input.declarations) {
    const from = await input.resolvePlacement(declaration.from)
    const to = await input.resolvePlacement(declaration.to)

    if (from.scope !== 'project' || to.scope !== 'space' || from.space !== to.space) {
      throw new Error(`agent role move ${declaration.name} is not one project→Space move`)
    }
    const published = input.publishedRoles.find(
      (candidate) =>
        candidate.declaration.name === declaration.name && samePlacement(candidate.location, from),
    )

    if (!published) {
      throw new Error(`agent role move references unpublished role ${declaration.name}`)
    }
    const fromLocator = ownedRoleLocator(from, published.packageId)
    const captured = await input.roles.captureCurrentOwnedTarget(fromLocator, SYSTEM_PRINCIPAL)

    if (!captured || captured.locator.kind !== 'role') {
      throw new Error(`agent role move cannot capture ${declaration.name}`)
    }
    const moved = await input.roles.moveRolePlacement(
      SYSTEM_PRINCIPAL,
      { ...captured, locator: captured.locator },
      input.personalSpaceFor(from),
    )
    applied.push({ name: declaration.name, from: fromLocator, to: moved.locator })
  }

  return applied
}
