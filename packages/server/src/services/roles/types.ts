import {
  type AbilityHealth,
  type AbilityKind,
  type AgentAbilitySummary,
  type AuthoredAttachment,
  type CatalogAbilityLocator,
  type OwnedAbilityLocator,
  ROLE_SCOPE,
  type SystemAbilityLocator,
} from '@notarium/contract'

import type { Principal } from '../authz'
import type { AbilityAvailability, ProjectRecord } from '../metaDb'

export { ROLE_SCOPE }

export type RoleScope = (typeof ROLE_SCOPE)[keyof typeof ROLE_SCOPE]
export type InstalledRoleScope = Exclude<RoleScope, 'catalog'>
export type SkillHomeScope = Extract<InstalledRoleScope, 'personal' | 'space'>

export type RoleSummary = {
  name: string
  title: string
  description: string
  scope: RoleScope
  origin?: string
  originRevision?: string
}
/** A role that ANSWERS in this context. Placement is a fact about Owned roles only:
 *  a System role ships with the host and has none. A union on `source` rather than an
 *  optional `scope`, because the shape that demanded a placement could not express a
 *  System role at all — which is how the resolver came to have no System link while
 *  the docs, the taxonomy and the library all said it did. */
export type EffectiveRoleSummary =
  | (Omit<RoleSummary, 'scope'> & { source: 'system' })
  | (Omit<RoleSummary, 'scope'> & { source: 'owned'; scope: InstalledRoleScope })

/** The Owned arm on its own, for the surfaces that genuinely address a placement. */
export type EffectiveOwnedRoleSummary = Extract<EffectiveRoleSummary, { source: 'owned' }>

export type RoleLocation = {
  scope: InstalledRoleScope
  /** Stable space id, never the mutable wire slug. */
  space: string
  /** Required only for a project placement. */
  projectId?: string
}

declare const ADDRESSED_PLACEMENT: unique symbol

/** A `RoleLocation` the service derived rather than one a caller spelled. The brand
 * is unforgeable outside the module that mints it, which is what makes "did this
 * address survive the seam?" a question the compiler asks instead of a convention. */
export type AddressedPlacement = RoleLocation & { readonly [ADDRESSED_PLACEMENT]: true }

/** An addressed placement that is a project one, and therefore actually carries the
 * project id `RoleLocation` leaves optional for every other scope. */
export type AddressedProjectPlacement = AddressedPlacement & { projectId: string }

export type SkillHomeLocation = RoleLocation & { scope: SkillHomeScope; projectId?: never }
export type RoleHomeLocation = RoleLocation

/** Where a package is about to go, in the two shapes a caller can actually name.
 *  A Personal Add starts before its space exists, so its target cannot be a
 *  location yet — and answering it by minting one would be the mutation the
 *  preflight it feeds exists to avoid. */
export type RolePublicationTarget =
  { kind: 'prospective-personal' } | { kind: 'location'; location: RoleLocation }

export type EffectiveRoleContext = {
  personalSpace: string | null
  project?: ProjectRecord
}

export type ActiveRoleLocator = SystemAbilityLocator | OwnedAbilityLocator

export type AbilityDetail = {
  locator: ActiveRoleLocator | CatalogAbilityLocator
  source: 'system' | 'catalog' | 'owned'
  title: string
  name: string
  description: string
  instructions: string
  enabled?: boolean
  noteId?: string
  origin?: 'custom' | 'catalog'
  originRevision?: string
  availability?: AbilityAvailability
  health?: AbilityHealth
  truncated: boolean
}

export type LoadedRole = {
  role: RoleSummary & { instructions: string }
  skills: Array<{ name: string; title: string; description: string; instructions: string }>
  truncated: boolean
}
/** Same split as `ResolvedEffectiveRole`: what was loaded, and — for an Owned role
 *  only — the exact placement whose package won `Project > Space > Personal > System`. */
export type LoadedEffectiveRole = Omit<LoadedRole, 'role'> & {
  packageId: string
  /** The address itself. Carried rather than rebuilt: every consumer that derived it
   *  from a placement was a second producer of the locator, and a System role has no
   *  placement to derive one from. */
  locator: ActiveRoleLocator
} & (
    | {
        source: 'system'
        role: Extract<EffectiveRoleSummary, { source: 'system' }> & { instructions: string }
      }
    | {
        source: 'owned'
        role: EffectiveOwnedRoleSummary & { instructions: string }
        location: RoleLocation
      }
  )

/** Where the resolver landed. `location` lives on the Owned arm only: asking a System
 *  package where it is placed has no answer, and an optional field would have let every
 *  reader invent one. */
export type ResolvedOwnedRole = Extract<ResolvedEffectiveRole, { source: 'owned' }>

/** Why the agent does not load a role the caller addressed. Mirrors the wire enum; the
 *  three reasons are deliberately distinguishable because the surface tells the human
 *  which one it is, and "not effective" alone was the message that gave an agent a role
 *  in `list_roles` it could not activate. */
export const ROLE_INACTIVE = {
  disabled: 'disabled',
  outOfReach: 'out-of-reach',
  unhealthy: 'unhealthy',
} as const

export type RoleInactiveReason = (typeof ROLE_INACTIVE)[keyof typeof ROLE_INACTIVE]

/** The addressed role plus whether it is live HERE. One shape, because a surface that
 *  gets the role without the verdict starts guessing, and a surface that gets the
 *  verdict without the role cannot name what it refused. */
export type AddressedRoleStatus =
  | { role: ResolvedOwnedRole; active: true }
  | { role: ResolvedOwnedRole; active: false; inactive: RoleInactiveReason }

export type ResolvedEffectiveRole = { packageId: string; locator: ActiveRoleLocator } & (
  | { source: 'system'; role: Extract<EffectiveRoleSummary, { source: 'system' }> }
  | {
      source: 'owned'
      role: EffectiveOwnedRoleSummary
      location: RoleLocation
    }
)

/** A role that LIVES somewhere. `catalog` is a source, not a placement, so an entry
 *  that has a space cannot carry it — the narrowing is here rather than at each
 *  reader, which is what let a published entry be typed as possibly-Catalog. */
export type RoleInventoryEntry = Omit<RoleSummary, 'scope'> & {
  scope: InstalledRoleScope
  space: string
  projectId?: string
  /** Present for a Space home only — the reach a project version does not have. */
  availability?: AbilityAvailability
  noteId: string
}

export type PublishedRoleInventoryEntry = RoleInventoryEntry & { packageId: string }

/** Where a role may be asked to belong. One space only: cross-space is a move
 *  between two note stores, which the engine has no operation for. */

/** The result of a move: the role's new address plus the reach it landed with. Both
 *  are answers the caller cannot derive — the locator because placement is part of
 *  it, the availability because coming up from a project deliberately keeps the one
 *  project the role served rather than inheriting the Space-wide default. Absent at
 *  a project home, which reaches its own project by construction. */
export type MovedRole = {
  locator: Extract<OwnedAbilityLocator, { kind: 'role' }>
  availability?: AbilityAvailability
  role: RoleSummary & { space: string; packageId: string; noteId: string }
}

export type SkillInventoryEntry = {
  name: string
  title: string
  description: string
  scope: SkillHomeScope
  space: string
  availability?: AbilityAvailability
  noteId: string
  origin?: string
  originRevision?: string
}
export type PublishedSkillInventoryEntry = SkillInventoryEntry & { packageId: string }

export type OwnedAbilityInventoryEntry = {
  ability: Extract<AgentAbilitySummary, { source: 'owned' }>
  /** Internal filter metadata; the public identity and placement live in locator. */
  availability?: AbilityAvailability
}

export type BoundedAbilityList = {
  abilities: OwnedAbilityInventoryEntry[]
  truncated: boolean
}

export type BoundedRoleList<T> = { roles: T[]; truncated: boolean }
export type LoadedSkill = {
  skill: RoleSummary & { instructions: string }
  truncated: boolean
}

export type RolesService = {
  listBundledAbilities(principal: Principal): Promise<AgentAbilitySummary[]>
  /** `kind` is REQUIRED to pass: no caller has ever wanted both, and every one of
   *  them already knows which it is asking for. A default would let a new caller
   *  inherit the other kind — and spend the page budget on entries it then drops. */
  listOwnedAbilitiesAt(
    location: RoleLocation,
    principal: Principal,
    kind: AbilityKind,
  ): Promise<BoundedAbilityList>
  hasCatalog(name: string): Promise<boolean>
  hasCatalogSkill(name: string): Promise<boolean>
  describeAbility(
    context: EffectiveRoleContext,
    principal: Principal,
    locator: ActiveRoleLocator | CatalogAbilityLocator,
    budgetTokens: number,
  ): Promise<AbilityDetail | null>
  setEnabled(
    context: EffectiveRoleContext,
    principal: Principal,
    locator: ActiveRoleLocator,
    enabled: boolean,
  ): Promise<void>
  /** Where a Space-homed ability is effective. Both kinds answer it — the reach of a
   * Role is what makes "needed in two projects out of five" a setting instead of a
   * second copy. Personal has no projects to select from and a project version has no
   * reach beyond its own project, so only a Space home accepts this. */
  setAbilityAvailability(
    context: EffectiveRoleContext,
    principal: Principal,
    locator: OwnedAbilityLocator,
    availability: AbilityAvailability,
  ): Promise<void>
  /** Which of the named projects hold a version of this Space base. Asked with the
   * project set by the caller, because placement is the caller's world: the library
   * knows what a package is, not which projects a Space has. */
  listRoleVersions(
    principal: Principal,
    locator: Extract<OwnedAbilityLocator, { kind: 'role' }>,
    personalSpace: string | null,
    projectIds: readonly string[],
  ): Promise<Array<{ projectId: string; locator: OwnedAbilityLocator }>>
  /** The Space base this project version overrides, if there is one. A version with
   * no base is a legitimate state, and the difference is not cosmetic: it decides
   * whether the body a reader opens is an override of another one it can reach. */
  findRoleBase(
    principal: Principal,
    locator: Extract<OwnedAbilityLocator, { kind: 'role' }>,
    personalSpace: string | null,
  ): Promise<OwnedAbilityLocator | null>
  /** Fork a Space base into a project version of the SAME role: same name, the base's
   * body and attachments as a starting point, its own package address. */
  createRoleVersion(
    principal: Principal,
    locator: Extract<OwnedAbilityLocator, { kind: 'role' }>,
    personalSpace: string | null,
    projectId: string,
  ): Promise<PublishedRoleInventoryEntry>
  /** Lift a project version up to be its Space's base. The package address survives,
   * and every durable pointer keyed by the placement moves with it. Refused before
   * anything moves when the base name is taken, when the role is Personal (a
   * different Space), and when the role is already a base. */
  moveRolePlacement(
    principal: Principal,
    locator: Extract<OwnedAbilityLocator, { kind: 'role' }>,
    personalSpace: string | null,
  ): Promise<MovedRole>
  /** Validate and serialize a complete replacement of an Owned Role's authored
   * attachment list. Invalid raw tokens may only be carried forward from the
   * current package; new invalid tokens and unhealthy exact locators fail closed. */
  serializeOwnedRoleAttachments(
    principal: Principal,
    locator: Extract<OwnedAbilityLocator, { kind: 'role' }>,
    attachments: readonly AuthoredAttachment[],
    personalSpace: string | null,
  ): Promise<{ links: string[]; noteId: string }>
  listEffective(
    context: EffectiveRoleContext,
    principal: Principal,
  ): Promise<BoundedRoleList<EffectiveRoleSummary>>
  resolveEffective(
    context: EffectiveRoleContext,
    principal: Principal,
    name: string,
  ): Promise<ResolvedEffectiveRole | null>
  /** WHICH ROLE this address names, for a caller who may read it. Addressed by locator,
   * never by a pre-built placement: personal and a Space root are one directory, so
   * only the service may decide which of the two a locator means. `personalSpace` is
   * the caller's own — null when they have none.
   *
   * Deliberately blind to the owner's Enable/Disable bit. That bit is a private
   * READING preference, and one answer served both questions until a member who had
   * turned a shared role off for themselves could no longer edit its shared context. */
  addressedRoleAt(
    locator: Extract<OwnedAbilityLocator, { kind: 'role' }>,
    principal: Principal,
    personalSpace: string | null,
  ): Promise<ResolvedOwnedRole | null>
  /** Is this role EFFECTIVE for this caller here — the question the agent-context
   * preview asks. Same address, plus the two gates that make a role answer: the
   * owner's preference and, inside a project, its reach. Without `projectId` reach is
   * not a question this surface has. */
  /** The addressed role AND whether the agent loads it here — the two answers the
   * context preview needs at once. Takes the CONTEXT because reach and health are both
   * questions about where the caller is standing. */
  addressedRoleStatus(
    context: EffectiveRoleContext,
    principal: Principal,
    locator: Extract<OwnedAbilityLocator, { kind: 'role' }>,
  ): Promise<AddressedRoleStatus | null>
  /** Just the live half of `addressedRoleStatus`, for callers that have no use for a
   * role they would not load. */
  effectiveRoleAt(
    context: EffectiveRoleContext,
    principal: Principal,
    locator: Extract<OwnedAbilityLocator, { kind: 'role' }>,
  ): Promise<ResolvedOwnedRole | null>
  /** Is this saved binding still effective here — the gate `loadSavedRole` applies,
   *  without loading the body. Exists because the REST surface answered it by hand. */
  resolveSavedRole(
    context: EffectiveRoleContext,
    principal: Principal,
    locator: ActiveRoleLocator,
  ): Promise<ResolvedEffectiveRole | null>
  /** Reload the exact role a saved session was bound to. Takes the CONTEXT, not a
   * placement: a binding survives only where the current context still reaches the
   * placement the locator addresses, and both halves of that — is this an address at
   * all, and is it one of ours — are the service's to answer, not the caller's. */
  loadSavedRole(
    context: EffectiveRoleContext,
    principal: Principal,
    locator: ActiveRoleLocator,
    budgetTokens: number,
  ): Promise<LoadedEffectiveRole | null>
  loadEffective(
    context: EffectiveRoleContext,
    principal: Principal,
    name: string,
    budgetTokens: number,
  ): Promise<LoadedEffectiveRole | null>
  /** `personalSpace` says which space is the CALLER's own, because where a role's
   *  dependencies live depends on it: Personal IS the root of that space, so a role
   *  placed in a project of it takes personal skills, not Space ones. `null` is a
   *  real answer — a host or principal with no personal space. */
  /** Can this deployment publish EVERY placement a role Add at that target would
   *  write to? A role is not one package: its linked skills go to the home its
   *  dependencies live in, and the role package to the target itself, so a host
   *  that can publish one and not the other must not offer the target at all.
   *
   *  Pure — no space is minted, no authority or store is built, no path is
   *  probed — so a read model may ask it for every target it lists, and an Add
   *  may ask it before the first byte of durable state exists. `personalSpace`
   *  is the caller's own space, because it decides where dependencies live.
   *
   *  True does not promise a particular pathname: presence answers for the
   *  deployment, and the commit itself can still refuse one target. That refusal
   *  is `RoleInstallUnavailableError`: its failing package was not published, while
   *  dependency packages and grants completed earlier in the Add remain reusable. */
  canAddRoleAt(target: RolePublicationTarget, personalSpace: string | null): boolean
  /** The same question for a skill, which is one package in one placement. */
  canAddSkillAt(target: RolePublicationTarget): boolean
  addFromCatalog(
    name: string,
    location: RoleLocation,
    personalSpace: string | null,
  ): Promise<PublishedRoleInventoryEntry>
  addSkillFromCatalog(
    name: string,
    location: SkillHomeLocation,
    availability?: AbilityAvailability,
  ): Promise<PublishedSkillInventoryEntry>
  createCustomSkill(
    name: string,
    description: string,
    instructions: string,
    location: SkillHomeLocation,
    availability?: AbilityAvailability,
  ): Promise<PublishedSkillInventoryEntry>
  createCustomRole(
    name: string,
    description: string,
    instructions: string,
    location: RoleHomeLocation,
    options?: {
      principal?: Principal
      attachments?: readonly AuthoredAttachment[]
      availability?: AbilityAvailability
      /** See `addFromCatalog`: the caller's own space decides where dependencies live. */
      personalSpace?: string | null
    },
  ): Promise<PublishedRoleInventoryEntry>
}
