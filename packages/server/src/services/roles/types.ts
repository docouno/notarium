import { ROLE_SCOPE } from '@notarium/contract'

import type { ProjectRecord } from '../metaDb'

export { ROLE_SCOPE }

export type RoleScope = (typeof ROLE_SCOPE)[keyof typeof ROLE_SCOPE]
export type InstalledRoleScope = Exclude<RoleScope, 'catalog'>

export type RoleSummary = {
  name: string
  description: string
  scope: RoleScope
  origin?: string
  originRevision?: string
}
export type EffectiveRoleSummary = Omit<RoleSummary, 'scope'> & { scope: InstalledRoleScope }

export type RoleLocation = {
  scope: InstalledRoleScope
  /** Stable space id, never the mutable wire slug. */
  space: string
  /** Required only for a project placement. */
  projectId?: string
}

export type EffectiveRoleContext = {
  personalSpace: string | null
  project?: ProjectRecord
}

export type LoadedRole = {
  role: RoleSummary & { instructions: string }
  skills: Array<{ name: string; description: string; instructions: string }>
  truncated: boolean
}
export type LoadedEffectiveRole = Omit<LoadedRole, 'role'> & {
  role: EffectiveRoleSummary & { instructions: string }
}

export type RoleInventoryEntry = RoleSummary & {
  space: string
  projectId?: string
}

export type BoundedRoleList<T> = { roles: T[]; truncated: boolean }

export type RolesService = {
  listCatalog(): Promise<RoleSummary[]>
  hasCatalog(name: string): Promise<boolean>
  listAt(location: RoleLocation): Promise<BoundedRoleList<RoleInventoryEntry>>
  listEffective(context: EffectiveRoleContext): Promise<BoundedRoleList<EffectiveRoleSummary>>
  loadCatalog(name: string, budgetTokens: number): Promise<LoadedRole | null>
  loadAt(location: RoleLocation, name: string, budgetTokens: number): Promise<LoadedRole | null>
  loadEffective(
    context: EffectiveRoleContext,
    name: string,
    budgetTokens: number,
  ): Promise<LoadedEffectiveRole | null>
  addFromCatalog(name: string, location: RoleLocation): Promise<RoleInventoryEntry>
}
