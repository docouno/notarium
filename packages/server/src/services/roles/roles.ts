import { Buffer } from 'node:buffer'

import {
  ABILITY_ATTACHMENT_HEALTH,
  ABILITY_AVAILABILITY_MODE,
  ABILITY_KIND,
  type AbilityAttachmentHealth,
  type AbilityAttachmentState,
  type AbilityHealth,
  type AbilityKind,
  type AgentAbilitySummary,
  type AuthoredAttachment,
  type CatalogAbilityLocator,
  type OwnedAbilityLocator,
  ROLE_ATTACHMENT_STATE,
  type SystemAbilityLocator,
} from '@notarium/contract'
import {
  encodeAbilityLocator,
  exactOwnerObservation,
  freshNoteId,
  frontmatterScalar,
  parseAbilityLocator,
  serializeAbilityLocator,
  serializeSkillLocator,
  type SkillLink,
} from '@notarium/core'
import { agentOwnerOf, can, type Principal } from '../authz'
import type {
  AbilityAvailability,
  AbilityAvailabilityPersistence,
  AbilityPlacementPersistence,
  AbilityPreferencesPersistence,
} from '../metaDb'
import { InMemoryAbilityAvailability } from './abilityAvailability'
import { createInMemoryAbilityPlacement } from './abilityPlacement'
import { InMemoryAbilityPreferences } from './abilityPreferences'
import { roleContextTargetIdOf } from './context'
import {
  AbilityUnavailableError,
  CatalogRoleNotFoundError,
  CatalogSkillNotFoundError,
  RoleAlreadyExistsError,
  RoleDependencyConflictError,
  RoleInstallUnavailableError,
  RolePlacementUnconfirmedError,
  SkillAlreadyExistsError,
  SkillTooLargeForActivationError,
} from './errors'
import {
  InvalidSkillPackageError,
  isRolePackageMoveRollbackError,
  type RoleLibrary,
  type RolePackagePublication,
  type RolePackagePublicationPolicy,
  type RolePackageSnapshot,
  type SkillPackage,
  validateSkillPackage,
} from './library'
import {
  authoredSkillFile,
  bundledAbilityIdentityOf,
  hasCatalogProvenance,
  isResolvableAbilityManifest,
  packageRevision,
  parseSkillFile,
  unwritableSkillLinks,
  withCatalogProvenance,
  withFreshNoteId,
  withSkillLinks,
} from './skillFile'
import {
  type AbilityDetail,
  type AbilityLoadOutcome,
  type AbilityRemediation,
  type AbilityResolutionCandidate,
  type ActiveRoleLocator,
  type AddressedPlacement,
  type AddressedProjectPlacement,
  type AddressedRoleStatus,
  type EffectiveRoleContext,
  type EffectiveRoleSummary,
  type LoadedEffectiveRole,
  type LoadedEffectiveSkill,
  type LoadedRole,
  type LoadedSkill,
  type OwnedAbilityInventoryEntry,
  type OwnedAbilitySnapshot,
  type OwnedAbilityTarget,
  type PublishedRoleInventoryEntry,
  type PublishedSkillInventoryEntry,
  type ResolvedEffectiveRole,
  type ResolvedOwnedRole,
  ROLE_INACTIVE,
  ROLE_SCOPE,
  type RoleHomeLocation,
  type RoleLocation,
  type RolesService,
  type RoleSummary,
  type SkillHomeLocation,
} from './types'

type ParsedPackage = { pkg: SkillPackage; skill: ReturnType<typeof parseSkillFile> }

const clonePackage = (pkg: SkillPackage): SkillPackage => ({
  directoryName: pkg.directoryName,
  files: new Map([...pkg.files].map(([path, bytes]) => [path, Uint8Array.from(bytes)])),
})

const availabilityStateOf = (
  availability: AbilityAvailability | null | undefined,
): AbilityAvailability =>
  availability?.mode === ABILITY_AVAILABILITY_MODE.allProjects
    ? { mode: ABILITY_AVAILABILITY_MODE.allProjects }
    : {
        mode: ABILITY_AVAILABILITY_MODE.selectedProjects,
        projectIds:
          availability?.mode === ABILITY_AVAILABILITY_MODE.selectedProjects
            ? availability.projectIds
            : [],
      }

/** One pair of tables serves both kinds, but an ABSENT row is not the same answer
 * for both. A Space Skill is a dependency a Role opts into, so absence reads as
 * "nothing selected" — unavailable until stated. A Space Role applied everywhere in
 * its Space before availability existed for roles at all, so absence reads as
 * all-projects: that default is what lets availability arrive with no data
 * migration behind it. canon: docs/meta-db.md */
const abilityAvailabilityOf = (
  availability: AbilityAvailability | null | undefined,
  kind: 'role' | 'skill',
): AbilityAvailability =>
  !availability && kind === 'role'
    ? { mode: ABILITY_AVAILABILITY_MODE.allProjects }
    : availabilityStateOf(availability)

const availabilityCovers = (availability: AbilityAvailability, projectId: string): boolean =>
  availability.mode === ABILITY_AVAILABILITY_MODE.allProjects ||
  availability.projectIds.includes(projectId)

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

/** Does this ability's reach cover that project — the whole rule, including the
 *  asymmetric default an absent row carries per KIND. Exported because the transport
 *  needs the same answer to label a library card, and a route that spelled the formula
 *  out was a copy that a change to the default would never reach. */
export const abilityReachesProject = (
  availability: AbilityAvailability | null | undefined,
  projectId: string,
  kind: 'role' | 'skill',
): boolean => availabilityCovers(abilityAvailabilityOf(availability, kind), projectId)

const packagesEqual = (left: SkillPackage, right: SkillPackage): boolean => {
  if (left.files.size !== right.files.size) {
    return false
  }

  for (const [name, bytes] of left.files) {
    const other = right.files.get(name)

    if (!other) {
      return false
    }
    if (name === 'SKILL.md') {
      if (
        authoredSkillFile(Buffer.from(bytes).toString('utf8')) !==
        authoredSkillFile(Buffer.from(other).toString('utf8'))
      ) {
        return false
      }
    } else if (!Buffer.from(bytes).equals(Buffer.from(other))) {
      return false
    }
  }

  return true
}

const sameCatalogLineage = (left: SkillPackage, right: ParsedPackage): boolean => {
  try {
    const parsed = parsePackage(left).skill
    const identity = bundledAbilityIdentityOf(right.skill, right.pkg.directoryName)

    return (
      identity.source === 'catalog' &&
      hasCatalogProvenance(parsed) &&
      parsed.metadata['notarium.origin'] === `catalog:${identity.packageId}` &&
      parsed.metadata['notarium.originRevision'] === packageRevision(right.pkg.files)
    )
  } catch {
    return false
  }
}

const parsePackage = (pkg: SkillPackage): ParsedPackage => {
  const file = pkg.files.get('SKILL.md')

  if (!file) {
    throw new Error(`${pkg.directoryName}/SKILL.md is missing`)
  }

  const skill = parseSkillFile(Buffer.from(file).toString('utf8'), pkg.directoryName)

  if (!isResolvableAbilityManifest(skill)) {
    throw new InvalidSkillPackageError(
      `Agent Skill package cannot attach skills: ${pkg.directoryName}`,
    )
  }

  return { pkg, skill }
}

const forkCatalogPackage = (
  parsed: ParsedPackage,
  linkedSkills?: readonly string[],
): SkillPackage => {
  const identity = bundledAbilityIdentityOf(parsed.skill, parsed.pkg.directoryName)

  if (identity.source !== 'catalog') {
    throw new Error(`system package "${parsed.skill.name}" cannot be forked`)
  }
  const noteId = freshNoteId()
  const revision = packageRevision(parsed.pkg.files)
  const files = new Map(parsed.pkg.files)
  let skillFile = withCatalogProvenance(
    Buffer.from(parsed.pkg.files.get('SKILL.md')!).toString('utf8'),
    identity.packageId,
    revision,
    noteId,
  )

  if (linkedSkills) {
    skillFile = withSkillLinks(skillFile, linkedSkills)
  }

  // Provenance is part of the stored fork, so its rewritten manifest must obey
  // the exact same parser/byte bounds before the template is advertised.
  parseSkillFile(skillFile, noteId)
  files.set('SKILL.md', Buffer.from(skillFile))
  const fork = { directoryName: noteId, files }
  validateSkillPackage(fork)
  return fork
}

const customPackage = (
  name: string,
  description: string,
  instructions: string,
  role: boolean,
  linkedSkills: readonly string[] = [],
): SkillPackage => {
  const noteId = freshNoteId()
  const metadata = role
    ? `metadata:\n  notarium.kind: role\n${
        linkedSkills.length
          ? `  notarium.skills: ${frontmatterScalar(linkedSkills.join(' '))}\n`
          : ''
      }`
    : ''
  const descriptionEntry = description.trim()
    ? `description: ${frontmatterScalar(description.trim())}\n`
    : ''
  const manifest = `---\nnotarium-id: ${noteId}\nname: ${frontmatterScalar(name)}\n${descriptionEntry}${metadata}---\n\n${instructions.trim()}\n`
  const pkg = {
    directoryName: noteId,
    files: new Map([['SKILL.md', Buffer.from(manifest)]]),
  }

  parseSkillFile(manifest, noteId)
  validateSkillPackage(pkg)
  return pkg
}

/** Which attachment verdicts refuse a WRITE. Five of the six describe the shared
 *  package — it is missing, it is the wrong kind, it is out of reach, its address does
 *  not parse. `disabled` describes the READER: an owner-scoped override that says
 *  nothing about the package. Letting it refuse a write made the composition of a
 *  SHARED role depend on who opened it — one member could save it and another, who had
 *  turned one of its skills off for themselves, could not. */
const blocksAttachmentWrite = (health: AbilityAttachmentHealth | undefined): boolean =>
  health !== ABILITY_ATTACHMENT_HEALTH.healthy && health !== ABILITY_ATTACHMENT_HEALTH.disabled

/** What a role or skill package says about itself, with no placement in it. */
const abilityFactsOf = (parsed: ParsedPackage): Omit<RoleSummary, 'scope'> => {
  const origin = parsed.skill.metadata['notarium.origin']
  const originRevision = parsed.skill.metadata['notarium.originRevision']
  // Provenance is a paired, narrow declaration. Arbitrary writable metadata
  // never reaches REST/MCP or earns Catalog ancestry treatment.
  const catalogOrigin = hasCatalogProvenance(parsed.skill)

  return {
    name: parsed.skill.name,
    title: parsed.skill.title,
    description: parsed.skill.description,
    ...(catalogOrigin ? { origin, originRevision } : {}),
  }
}

/** Generic in the scope so the caller's answer survives: an entry built at an
 * installed placement stays installed, instead of widening back to the union that
 * still carries `catalog` — which is a SOURCE, and not a place anything lives. */
const summaryOf = <S extends RoleSummary['scope']>(
  parsed: ParsedPackage,
  scope: S,
): Omit<RoleSummary, 'scope'> & { scope: S } => {
  return {
    ...abilityFactsOf(parsed),
    scope,
  }
}

const parsedAt = async (
  library: RoleLibrary,
  location: RoleLocation,
): Promise<{ packages: ParsedPackage[]; truncated: boolean }> => {
  const parsed: ParsedPackage[] = []
  const listing = await library.listManifests(location)

  for (const pkg of listing.packages) {
    try {
      parsed.push(parsePackage(pkg))
    } catch (err) {
      console.warn(
        `[roles] ignoring invalid ${location.scope} package ${pkg.directoryName}:`,
        (err as Error).message,
      )
    }
  }

  return { packages: parsed, truncated: listing.truncated }
}

/** A placement the service DERIVED, never one a caller spelled. Reading an owned
 * package demands it, so a method that wants to read one from a client locator cannot
 * skip the question of whether that locator addresses a real place.
 *
 * Minted in exactly three kinds of place, and nowhere else:
 *  - the effective chain (`locationsFor`) — the placements a CONTEXT reaches;
 *  - the locator seam (`ownedPlacementOf`) — the one answer for a client address;
 *  - the two entries a caller reaches by ENUMERATING a home it was already granted
 *    (`addFromCatalog`, `createCustomRole`), each marking the boundary out loud.
 * A placement derived from one already addressed inherits its answer instead of
 * asking a new one, so it goes through `homeOf` rather than a mint. */
const addressed = (location: RoleLocation): AddressedPlacement => location as AddressedPlacement

const locationsFor = (context: EffectiveRoleContext): AddressedPlacement[] => {
  const locations: AddressedPlacement[] = []

  if (context.personalSpace) {
    locations.push(addressed({ scope: ROLE_SCOPE.personal, space: context.personalSpace }))
  }
  if (context.project && context.project.space !== context.personalSpace) {
    locations.push(addressed({ scope: ROLE_SCOPE.space, space: context.project.space }))
  }
  if (context.project) {
    locations.push(
      addressed({
        scope: ROLE_SCOPE.project,
        space: context.project.space,
        projectId: context.project.id,
      }),
    )
  }

  return locations
}

/** The HOME a placement falls back to. A Space root is that home for every placement
 * in a shared space — but Personal IS the root of the caller's own space, and naming it
 * `space` there produces an address the locator seam refuses, which is how a role in a
 * project of a personal space ended up unable to hold any Owned skill at all.
 *
 * Two questions answer to it, because they are one question: where a role's
 * dependencies live, and which package a project version OVERRIDES. Asking the second
 * with `spaceRootOf` instead is how the same server came to say "this is a version of
 * that role" in its listing and "this has no base" in its detail. */
const homeOf = (
  location: AddressedPlacement,
  personalSpace: string | null,
): SkillHomeLocation & AddressedPlacement =>
  addressed(
    location.scope === ROLE_SCOPE.personal || location.space === personalSpace
      ? { scope: ROLE_SCOPE.personal, space: location.space }
      : { scope: ROLE_SCOPE.space, space: location.space },
  ) as SkillHomeLocation & AddressedPlacement

const tokenChars = (tokens: number): number => Math.max(0, tokens) * 4
const instructionTokens = (instructions: string): number => Math.ceil(instructions.length / 4)

const loadParsedSkill = (parsed: ParsedPackage, scope: RoleSummary['scope']): LoadedSkill => {
  const summary = summaryOf(parsed, scope)

  return {
    skill: {
      ...summary,
      instructions: parsed.skill.instructions,
    },
    truncated: false,
  }
}

const loadParsedRole = async (
  parsed: ParsedPackage,
  scope: RoleSummary['scope'],
  dependency: (
    link: SkillLink,
    index: number,
  ) => Promise<ParsedPackage | undefined> | ParsedPackage | undefined,
  budgetTokens: number,
  failOnChangedDependency = false,
): Promise<LoadedRole | null> => {
  let remaining = tokenChars(budgetTokens)
  let truncated = false

  const take = (text: string): string => {
    if (text.length <= remaining) {
      remaining -= text.length
      return text
    }
    truncated = true
    const slice = text.slice(0, Math.max(0, remaining)).trimEnd()
    remaining = 0
    return slice
  }
  const summary = summaryOf(parsed, scope)
  const roleInstructions = take(parsed.skill.instructions)
  const skills: LoadedRole['skills'] = []
  let omitRemaining = false

  for (const [index, link] of parsed.skill.linkedSkills.entries()) {
    const linked = (await dependency(link, index))?.skill

    if (!linked || linked.role) {
      if (failOnChangedDependency) {
        return null
      }
      continue
    }
    const facts = {
      name: linked.name,
      title: linked.title,
      description: linked.description,
    }

    if (omitRemaining || linked.instructions.length > remaining) {
      omitRemaining = true
      skills.push({ ...facts, state: ROLE_ATTACHMENT_STATE.omittedByBudget })
      continue
    }

    remaining -= linked.instructions.length
    skills.push({
      ...facts,
      state: ROLE_ATTACHMENT_STATE.loaded,
      instructions: linked.instructions,
    })
  }

  return {
    role: { ...summary, instructions: roleInstructions },
    skills,
    truncated,
  }
}

/** The three facets a host without a meta-DB genuinely does not have. Named so a
 * composition can ASK for them: a default would let a host that owns durable ones
 * inherit these by omission, and the difference is invisible until a restart. */
export const inMemoryAbilityPersistence = () => {
  const abilityPreferences = new InMemoryAbilityPreferences()

  return {
    abilityAvailability: new InMemoryAbilityAvailability(),
    abilityPreferences,
    // Composed OVER the twin beside it, not beside it: the placement adapter can only
    // carry what this host actually holds, and this host holds a preference table.
    abilityPlacement: createInMemoryAbilityPlacement({ abilityPreferences }),
  }
}

export const createRolesService = ({
  catalog,
  library,
  publication,
  abilityAvailability,
  abilityPreferences,
  abilityPlacement,
  projectHandleForId = async () => null,
}: {
  catalog: () => Promise<SkillPackage[]>
  library: RoleLibrary
  /** The write side, separately. Reading a library works on a deployment that
   *  cannot publish at all, so the two are not one dependency. */
  publication: RolePackagePublicationPolicy
  /** REQUIRED to pass: every composition root states which persistence it built on.
   *  `inMemoryAbilityPersistence()` spells the answer for a host that has none. */
  abilityAvailability: AbilityAvailabilityPersistence
  abilityPreferences: AbilityPreferencesPersistence
  abilityPlacement: AbilityPlacementPersistence
  /** Project ids are durable internals; remediation exposes only current handles.
   * Optional because a meta-DB-less host has no project registry to translate with. */
  projectHandleForId?: (projectId: string) => Promise<string | null>
}): RolesService => {
  let catalogPromise: Promise<ParsedPackage[]> | undefined
  const addFences = new Map<string, Promise<void>>()

  const acquireAddFence = async (location: RoleLocation, name: string): Promise<() => void> => {
    const key = `${location.scope}\0${location.space}\0${location.projectId ?? ''}\0${name}`
    const previous = addFences.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.catch(() => undefined).then(() => gate)

    addFences.set(key, tail)
    await previous.catch(() => undefined)

    return () => {
      release()
      if (addFences.get(key) === tail) {
        addFences.delete(key)
      }
    }
  }
  const catalogPackages = (): Promise<ParsedPackage[]> =>
    // A failure is not an answer, so it must not become the permanent one. The loader
    // this wraps already forgets its own failure; a memo that remembered ours would
    // make that reset unreachable and pin the process to its first bad read.
    (catalogPromise ??= parsedCatalog().catch((error: unknown) => {
      catalogPromise = undefined
      throw error
    }))

  const parsedCatalog = (): Promise<ParsedPackage[]> =>
    catalog().then((packages) => {
      const identities = new Set<string>()

      return packages.map((pkg) => {
        validateSkillPackage(pkg)
        const parsed = parsePackage(pkg)
        const identity = bundledAbilityIdentityOf(parsed.skill, parsed.pkg.directoryName)
        const kind = parsed.skill.role ? 'role' : 'skill'
        const key = `${identity.source}\0${kind}\0${identity.packageId}`

        if (identities.has(key)) {
          throw new Error(
            `duplicate bundled ability identity: ${identity.source}:${kind}:${identity.packageId}`,
          )
        }
        identities.add(key)
        return parsed
      })
    })

  /** Every reach recorded for a Space in one question. `undefined` outside a Space
   * home, where reach is not a property at all. */
  const reachAt = async (
    location: RoleLocation,
  ): Promise<Map<string, AbilityAvailability> | undefined> =>
    location.scope === ROLE_SCOPE.space
      ? new Map(
          (await abilityAvailability.listForSpace(location.space)).map((record) => [
            record.packageId,
            { ...record } as AbilityAvailability,
          ]),
        )
      : undefined

  /** The one answer to "is there a Catalog package with this name and this kind?".
   * Written five separate times before, so a change to what makes a package a Catalog
   * one — the identity's `source` — had five places to reach and could agree with
   * itself in four of them. */
  const catalogPackageOf = async (
    name: string,
    kind: (typeof ABILITY_KIND)[keyof typeof ABILITY_KIND],
  ): Promise<ParsedPackage | undefined> =>
    (await catalogPackages()).find(
      ({ skill, pkg }) =>
        skill.role === (kind === ABILITY_KIND.role) &&
        skill.name === name &&
        bundledAbilityIdentityOf(skill, pkg.directoryName).source === 'catalog',
    )

  /** The one availability gate of effective resolution. It applies to the Space link
   * of the chain and nowhere else: Personal is not project-scoped, and a project
   * version is created BY an explicit act for that project, so an override is
   * self-sufficient and never asks the base for permission.
   *
   * Availability is therefore only ever answerable inside a project context — the
   * chain has no Space link without one (`locationsFor`). Outside a project a Space
   * role is not a candidate at all. */
  const coversProject = (
    location: RoleLocation,
    availability: AbilityAvailability | undefined,
    projectId: string | undefined,
  ): boolean =>
    location.scope !== ROLE_SCOPE.space || !projectId
      ? true
      : abilityReachesProject(availability, projectId, 'role')

  /** Does a Space-homed SKILL's reach cover this project? The same formula
   *  `coversProject` applies to a role, with the skill's own default for an absent row.
   *  Written out by hand in the two places that needed it, which is how they came to
   *  disagree about the case with NO project — each caller still answers that for
   *  itself, but now visibly, instead of inside two copies of the formula. */
  const skillReaches = (
    availability: AbilityAvailability | null | undefined,
    projectId: string | undefined,
  ): boolean => {
    // A reach that says "everywhere" covers a caller with no project in hand too; a
    // selected list cannot, because there is nothing to match against.
    return projectId === undefined
      ? abilityAvailabilityOf(availability, 'skill').mode === ABILITY_AVAILABILITY_MODE.allProjects
      : abilityReachesProject(availability, projectId, 'skill')
  }

  const availableAt = async (
    location: RoleLocation,
    packageId: string,
    projectId: string | undefined,
  ): Promise<boolean> => {
    if (location.scope !== ROLE_SCOPE.space || !projectId) {
      return true
    }

    return coversProject(
      location,
      (await abilityAvailability.get(location.space, packageId)) ?? undefined,
      projectId,
    )
  }

  /** Does this address name an owned Role the principal may READ? The identity half of
   *  the two questions a locator can be asked, shared so they cannot disagree about
   *  what the address points at while disagreeing about what may be done with it. */
  const addressedOwnedRole = async (
    locator: Extract<OwnedAbilityLocator, { kind: 'role' }>,
    principal: Principal,
    personalSpace: string | null,
  ): Promise<{ location: AddressedPlacement; parsed: ParsedPackage } | null> => {
    const location = ownedPlacementOf(locator, personalSpace)

    if (!location || !can(principal, 'space:read', { space: location.space })) {
      return null
    }
    const parsed = await exactOwnedPackage(location, locator.packageId)

    return parsed?.skill.role ? { location, parsed } : null
  }

  const resolvedOwnedRoleOf = (
    location: AddressedPlacement,
    parsed: ParsedPackage,
  ): ResolvedOwnedRole => ({
    source: 'owned',
    role: { source: 'owned', ...abilityFactsOf(parsed), scope: location.scope },
    location,
    packageId: parsed.pkg.directoryName,
    locator: ownedRoleLocator(location, parsed.pkg.directoryName),
  })

  /** Every project context an owned role is answerable in. A role that covers a set
   * of projects has to satisfy its attachments in EVERY one of them: a skill that
   * reaches two of the three would leave the role fail-closed in the third, which is
   * a state authoring should refuse rather than publish. `undefined` is the context
   * of a role with no project narrowing — the answer stays "everywhere". */
  const coveredProjectsOf = (
    location: RoleLocation,
    availability?: AbilityAvailability,
  ): ReadonlyArray<string | undefined> =>
    location.scope === ROLE_SCOPE.project
      ? [location.projectId]
      : location.scope === ROLE_SCOPE.space &&
          availability?.mode === ABILITY_AVAILABILITY_MODE.selectedProjects &&
          availability.projectIds.length > 0
        ? availability.projectIds
        : // A reach narrowed to nothing is still a question with an answer, and it is
          // NOT "everything is fine". Iterating an empty list would skip validation
          // and health alike, so a role whose last project was deleted would report
          // itself healthy with no attachments while holding broken ones.
          [undefined]

  /** One effective role, and where it came from. The Owned arm carries a placement
   *  because it has one; the System arm does not, because a shipped package is not
   *  placed anywhere. Listing, activation and resume all read this shape, so a source
   *  one of them can reach and another cannot stops being expressible — which is the
   *  state a second, human-facing pair of producers had put the service in. */
  type EffectiveRoleEntry =
    | { source: 'system'; parsed: ParsedPackage }
    | { source: 'owned'; parsed: ParsedPackage; location: AddressedPlacement }

  type AbilityResolutionEntry = EffectiveRoleEntry & {
    kind: AbilityKind
    locator: ActiveRoleLocator
    enabled: boolean
    reachable: boolean
    effective: boolean
    /** False only for externally introduced same-name packages that lost this
     * placement's stable package-id tie-break. They remain authoring-addressable. */
    resolutionCandidate?: false
    health?: AbilityHealth
  }

  const resolutionKey = (kind: AbilityKind, name: string): string => `${kind}\0${name}`

  const activeSystemAbility = async (
    parsed: ParsedPackage,
    principal: Principal,
  ): Promise<boolean> =>
    abilityPreferences.isEnabled(
      preferenceOwner(principal),
      bundledAbilityLocator(parsed) as SystemAbilityLocator,
    )

  const abilityReachesContext = (
    parsed: ParsedPackage,
    location: AddressedPlacement,
    availability: AbilityAvailability | null | undefined,
    projectId: string | undefined,
  ): boolean =>
    parsed.skill.role
      ? coversProject(location, availability ?? undefined, projectId)
      : location.scope !== ROLE_SCOPE.space || skillReaches(availability, projectId)

  const selectAbilityWinners = (
    candidates: readonly AbilityResolutionEntry[],
  ): Map<string, AbilityResolutionEntry> => {
    const winners = new Map<string, AbilityResolutionEntry>()

    for (const candidate of candidates) {
      candidate.effective = false
      if (candidate.resolutionCandidate !== false && candidate.enabled && candidate.reachable) {
        winners.set(resolutionKey(candidate.kind, candidate.parsed.skill.name), candidate)
      }
    }

    for (const winner of winners.values()) {
      winner.effective = true
    }

    return winners
  }

  const abilityResolutionEntries = async (
    context: EffectiveRoleContext,
    principal: Principal,
  ): Promise<{
    candidates: AbilityResolutionEntry[]
    winners: Map<string, AbilityResolutionEntry>
    truncated: boolean
  }> => {
    const candidates: AbilityResolutionEntry[] = []
    const owner = preferenceOwner(principal)
    let truncated = false

    for (const parsed of await systemPackages()) {
      const kind = parsed.skill.role ? ABILITY_KIND.role : ABILITY_KIND.skill
      const locator = bundledAbilityLocator(parsed) as SystemAbilityLocator
      const enabled = await abilityPreferences.isEnabled(owner, locator)
      const entry: AbilityResolutionEntry = {
        source: 'system',
        parsed,
        kind,
        locator,
        enabled,
        reachable: true,
        effective: false,
      }

      candidates.push(entry)
    }

    for (const location of readableLocationsFor(context, principal)) {
      const listing = await parsedAt(library, location)
      const reach = await reachAt(location)
      const addressedPackages = listing.packages
        .map((parsed) => ({ parsed, locator: ownedAbilityLocator(location, parsed) }))
        .filter(
          (entry): entry is { parsed: ParsedPackage; locator: OwnedAbilityLocator } =>
            entry.locator != null,
        )
        .sort((left, right) =>
          left.parsed.pkg.directoryName.localeCompare(right.parsed.pkg.directoryName),
        )
      // External files can violate the product's same-name uniqueness invariant.
      // Exact RoleLibrary lookup canonically picks the smallest package id. Keep all
      // packages addressable for authoring, but let only that same stable package
      // participate in runtime resolution at this placement.
      const stablePackages = new Set<string>()
      const disabled = await abilityPreferences.disabled(
        owner,
        addressedPackages.map(({ locator }) => locator),
      )

      truncated ||= listing.truncated
      for (const { parsed, locator } of addressedPackages) {
        const kind = parsed.skill.role ? ABILITY_KIND.role : ABILITY_KIND.skill
        const stableKey = resolutionKey(kind, parsed.skill.name)
        const resolutionCandidate = !stablePackages.has(stableKey)

        stablePackages.add(stableKey)
        const enabled = !disabled.has(serializeAbilityLocator(locator))
        const availability = reach?.get(parsed.pkg.directoryName)
        const reachable = abilityReachesContext(parsed, location, availability, context.project?.id)
        const entry: AbilityResolutionEntry = {
          source: 'owned',
          parsed,
          location,
          kind,
          locator,
          enabled,
          reachable,
          effective: false,
          ...(resolutionCandidate ? {} : { resolutionCandidate: false as const }),
        }

        candidates.push(entry)
      }
    }

    const winners = selectAbilityWinners(candidates)

    for (const winner of winners.values()) {
      if (winner.kind === ABILITY_KIND.role) {
        winner.health = await entryHealth(winner, context, principal)
      }
    }

    return { candidates, winners, truncated }
  }

  const effectiveRoleEntries = async (
    context: EffectiveRoleContext,
    principal: Principal,
  ): Promise<{
    entries: Map<string, EffectiveRoleEntry>
    truncated: boolean
  }> => {
    const resolution = await abilityResolutionEntries(context, principal)
    const entries = new Map<string, EffectiveRoleEntry>()

    for (const winner of resolution.winners.values()) {
      if (winner.kind === ABILITY_KIND.role) {
        entries.set(
          winner.parsed.skill.name,
          winner.source === 'system'
            ? { source: 'system', parsed: winner.parsed }
            : { source: 'owned', parsed: winner.parsed, location: winner.location },
        )
      }
    }

    return { entries, truncated: resolution.truncated }
  }

  const exactAbilityEntriesNamed = async (
    locations: readonly AddressedPlacement[],
    principal: Principal,
    name: string,
    projectId?: string,
  ): Promise<AbilityResolutionEntry[]> => {
    const owner = preferenceOwner(principal)
    const candidates: AbilityResolutionEntry[] = []

    for (const parsed of await systemPackages()) {
      if (parsed.skill.name !== name) {
        continue
      }
      const kind = parsed.skill.role ? ABILITY_KIND.role : ABILITY_KIND.skill
      const locator = bundledAbilityLocator(parsed) as SystemAbilityLocator

      candidates.push({
        source: 'system',
        parsed,
        kind,
        locator,
        enabled: await abilityPreferences.isEnabled(owner, locator),
        reachable: true,
        effective: false,
      })
    }

    // Exact activation is not constrained by the bounded discovery window. Entries
    // stay broad → narrow so the shared selector applies the same precedence as list.
    for (const location of locations) {
      const packages = await library.getAbilitiesNamed(location, name)

      for (const [kind, pkg] of packages) {
        try {
          const parsed = parsePackage(pkg)
          const locator = ownedAbilityLocator(location, parsed)

          if (!locator) {
            continue
          }
          const availability =
            location.scope === ROLE_SCOPE.space
              ? await abilityAvailability.get(location.space, parsed.pkg.directoryName)
              : undefined
          candidates.push({
            source: 'owned',
            parsed,
            location,
            kind,
            locator,
            enabled: await abilityPreferences.isEnabled(owner, locator),
            reachable: abilityReachesContext(parsed, location, availability, projectId),
            effective: false,
          })
        } catch (err) {
          console.warn(
            `[roles] ignoring invalid ${location.scope} package ${name}:`,
            (err as Error).message,
          )
        }
      }
    }

    return candidates
  }

  const effectiveAbilityNamed = async (
    locations: readonly AddressedPlacement[],
    principal: Principal,
    kind: AbilityKind,
    name: string,
    projectId?: string,
  ): Promise<AbilityResolutionEntry | null> => {
    const candidates = await exactAbilityEntriesNamed(locations, principal, name, projectId)

    return selectAbilityWinners(candidates).get(resolutionKey(kind, name)) ?? null
  }

  type AbilityCandidateSelection =
    | { kind: 'active'; candidate: AbilityResolutionEntry }
    | { kind: 'inactive'; candidate: AbilityResolutionEntry }
    | { kind: 'wrong-kind'; actual: AbilityKind }
    | { kind: 'not-found' }

  /** Resolve one name without discarding the best readable inactive candidate. Active
   * same-kind fallback wins first; only when none exists does the narrowest inactive
   * candidate beat an active candidate of the other kind. */
  const selectAbilityForLoad = async (
    locations: readonly AddressedPlacement[],
    principal: Principal,
    kind: AbilityKind,
    name: string,
    projectId?: string,
  ): Promise<AbilityCandidateSelection> => {
    const candidates = await exactAbilityEntriesNamed(locations, principal, name, projectId)
    const winners = selectAbilityWinners(candidates)
    const active = winners.get(resolutionKey(kind, name))

    if (active) {
      return { kind: 'active', candidate: active }
    }
    // Candidates are broad → narrow. Keeping the last requested-kind candidate gives
    // the same precedence the winner selector applies by overwriting its map entry.
    const inactive = candidates.filter((candidate) => candidate.kind === kind).at(-1)

    if (inactive) {
      return { kind: 'inactive', candidate: inactive }
    }
    const other = kind === ABILITY_KIND.role ? ABILITY_KIND.skill : ABILITY_KIND.role

    return winners.has(resolutionKey(other, name))
      ? { kind: 'wrong-kind', actual: other }
      : { kind: 'not-found' }
  }

  const candidateAccess = (
    candidate: AbilityResolutionEntry,
    principal: Principal,
  ): 'writer' | 'reader' | 'system' =>
    candidate.source === 'system'
      ? 'system'
      : can(principal, 'space:write', { space: candidate.location.space })
        ? 'writer'
        : 'reader'

  const retryProjectHandles = async (candidate: AbilityResolutionEntry): Promise<string[]> => {
    if (candidate.source !== 'owned' || candidate.location.scope !== ROLE_SCOPE.space) {
      return []
    }
    const availability = await abilityAvailability.get(
      candidate.location.space,
      candidate.parsed.pkg.directoryName,
    )

    if (availability?.mode !== ABILITY_AVAILABILITY_MODE.selectedProjects) {
      return []
    }
    const handles = await Promise.all(
      availability.projectIds.map((projectId) => projectHandleForId(projectId)),
    )
    return [...new Set(handles.filter((handle): handle is string => handle != null))].sort()
  }

  const failedCandidate = async (
    candidate: AbilityResolutionEntry,
    context: EffectiveRoleContext,
    principal: Principal,
    reason: 'disabled' | 'out-of-reach' | 'unhealthy',
    health?: AbilityHealth,
  ): Promise<Extract<AbilityLoadOutcome, { ok: false }>> => {
    const ref = encodeAbilityLocator(candidate.locator)
    const access = candidateAccess(candidate, principal)
    let remediation: AbilityRemediation[]

    if (reason === 'disabled') {
      remediation =
        candidate.source === 'system'
          ? [{ kind: 'open-agents-ui', ref }]
          : access === 'writer'
            ? [{ kind: 'edit-ability', ref, patch: 'enabled' }]
            : [{ kind: 'contact-space-writer' }]
    } else if (reason === 'out-of-reach') {
      if (candidate.source === 'owned' && access === 'writer') {
        remediation = [{ kind: 'edit-ability', ref, patch: 'availability' }]
      } else {
        const projects = await retryProjectHandles(candidate)
        remediation = [
          ...(projects.length ? [{ kind: 'retry-project' as const, projects }] : []),
          { kind: 'contact-space-writer' as const },
        ]
      }
    } else {
      // Attachment health is already a typed diagnosis. Package composition is most
      // safely repaired on the Agents surface; the adapter adds reason-specific prose
      // without re-running access or resolution policy.
      remediation = [{ kind: 'open-agents-ui', ref }]
    }
    const facts = {
      ok: false as const,
      reason,
      ref,
      source: candidate.source,
      access,
      remediation,
    }

    if (reason === 'unhealthy') {
      if (!health) {
        throw new Error('unhealthy ability outcome requires attachment health')
      }

      return { ...facts, reason, health }
    }

    return reason === 'out-of-reach'
      ? {
          ...facts,
          reason,
          ...(context.project
            ? {
                project: (await projectHandleForId(context.project.id)) ?? context.project.slug,
              }
            : {}),
        }
      : { ...facts, reason }
  }

  const failedSelection = async (
    selection: Exclude<AbilityCandidateSelection, { kind: 'active' }>,
    context: EffectiveRoleContext,
    principal: Principal,
  ): Promise<Extract<AbilityLoadOutcome, { ok: false }>> => {
    if (selection.kind === 'inactive') {
      return failedCandidate(
        selection.candidate,
        context,
        principal,
        selection.candidate.enabled ? 'out-of-reach' : 'disabled',
      )
    }
    if (selection.kind === 'wrong-kind') {
      return {
        ok: false,
        reason: 'wrong-kind',
        actual: selection.actual,
        remediation: [{ kind: 'call-other-kind', actual: selection.actual }],
      }
    }

    return {
      ok: false,
      reason: 'not-found',
      remediation: [{ kind: 'list-abilities', view: 'runtime' }],
    }
  }

  /** A project OF a home the caller already reaches. Derived from an addressed home
   *  rather than spelled by hand: a placement literal here is exactly the bypass the
   *  brand exists to refuse, and the compiler said so the moment one was asked to
   *  answer an addressed question. */
  const projectIn = (home: AddressedPlacement, projectId: string): AddressedProjectPlacement =>
    addressed({
      scope: ROLE_SCOPE.project,
      space: home.space,
      projectId,
    }) as AddressedProjectPlacement

  /** The identity the projection gave a package here, or null when it has not caught
   *  up with it. The listing and the detail already refused a package without one; the
   *  base/version pair did not, so it handed out addresses this same service answers
   *  404 for. One producer, so "does this exist" cannot have two answers. */
  const projectedNoteId = async (
    location: AddressedPlacement,
    packageId: string,
  ): Promise<string | null> =>
    (await library.readableNoteIds(location, [packageId])).get(packageId) ?? null

  const exactOwnedPackage = async (
    location: AddressedPlacement,
    packageId: string,
  ): Promise<ParsedPackage | null> => {
    const pkg = await library.getSkillByDirectory(location, packageId)

    if (!pkg) {
      return null
    }
    try {
      return parsePackage(pkg)
    } catch (err) {
      console.warn(
        `[roles] ignoring invalid ${location.scope} package ${packageId}:`,
        (err as Error).message,
      )
      return null
    }
  }

  const systemPackages = async (): Promise<ParsedPackage[]> =>
    (await catalogPackages()).filter(
      ({ skill, pkg }) => bundledAbilityIdentityOf(skill, pkg.directoryName).source === 'system',
    )

  const systemPackageById = async (packageId: string): Promise<ParsedPackage | null> =>
    (await systemPackages()).find(
      ({ skill, pkg }) =>
        bundledAbilityIdentityOf(skill, pkg.directoryName).packageId === packageId,
    ) ?? null

  const systemRoleLocator = (parsed: ParsedPackage): SystemAbilityLocator => ({
    source: 'system',
    kind: 'role',
    packageId: bundledAbilityIdentityOf(parsed.skill, parsed.pkg.directoryName).packageId,
  })

  /** The one answer to "which role answers this NAME here, and from which source".
   *  Exact activation, so it is not bound by the discovery window: Owned narrowest →
   *  broadest first, then the shipped System package as the final fallback. Both
   *  `resolveEffective` and `loadEffective` ask it, which is what keeps activation and
   *  listing from drifting apart the way they already had for System. */
  const effectiveRoleNamed = async (
    locations: readonly AddressedPlacement[],
    principal: Principal,
    name: string,
    projectId?: string,
  ): Promise<EffectiveRoleEntry | null> => {
    const hit = await effectiveAbilityNamed(
      locations,
      principal,
      ABILITY_KIND.role,
      name,
      projectId,
    )

    return hit
      ? hit.source === 'system'
        ? { source: 'system', parsed: hit.parsed }
        : { source: 'owned', parsed: hit.parsed, location: hit.location }
      : null
  }

  const effectiveSummaryOf = (entry: EffectiveRoleEntry): EffectiveRoleSummary =>
    entry.source === 'system'
      ? { source: 'system', ...abilityFactsOf(entry.parsed) }
      : { source: 'owned', ...abilityFactsOf(entry.parsed), scope: entry.location.scope }

  const activeRoleLocatorOf = (entry: EffectiveRoleEntry): ActiveRoleLocator =>
    entry.source === 'system'
      ? systemRoleLocator(entry.parsed)
      : ownedRoleLocator(entry.location, entry.parsed.pkg.directoryName)

  const bundledAbilityLocator = (
    parsed: ParsedPackage,
  ): SystemAbilityLocator | CatalogAbilityLocator => {
    const identity = bundledAbilityIdentityOf(parsed.skill, parsed.pkg.directoryName)
    return {
      source: identity.source,
      kind: parsed.skill.role ? 'role' : 'skill',
      packageId: identity.packageId,
    }
  }

  /** The address of a package AT the placement it was found in — one producer per arm,
   *  neither of them written out here. The skill arm was, and that made this a second
   *  author of an address `ownedSkillLocator` already knows how to spell.
   *
   *  It is also why the scope test survives the merge rather than being a leftover: a
   *  skill has no project placement, and `ownedSkillLocator` says so in its PARAMETER —
   *  it takes a `SkillHomeLocation`, which cannot be a project one. So the test is that
   *  type at runtime, and dropping it does not simplify anything, it only forces a cast
   *  that would go back to naming a project-placed skill by the Space ROOT: an address
   *  pointing at a package that is somewhere else. No caller reaches it today — the one
   *  that pages skills builds its locations from Personal and Spaces — and a malformed
   *  package on disk is dropped from the listing rather than published at a made-up
   *  address. */
  const ownedAbilityLocator = (
    location: RoleLocation,
    parsed: ParsedPackage,
  ): OwnedAbilityLocator | null =>
    parsed.skill.role
      ? ownedRoleLocator(location, parsed.pkg.directoryName)
      : location.scope === ROLE_SCOPE.project
        ? null
        : ownedSkillLocator(
            { scope: location.scope, space: location.space },
            parsed.pkg.directoryName,
          )

  const preferenceOwner = (principal: Principal): string => {
    const owner = agentOwnerOf(principal)

    if (!owner) {
      throw new Error('ability preferences require an owner principal')
    }

    return owner
  }

  /** Where a Space's own packages live — a place only when that space is not the
   * caller's personal one, because Personal IS that space's root directory. Asked by
   * the locator seam below and by the one MOVE up, which needs a destination that
   * exists or none at all. NOT by the base/version relation: both directions of it go
   * through `homeOf`, because a Space root is only one of the homes a version can
   * override — asking here instead is what made this server call a personal pair "a
   * version of that role" in its listing and "no base" in its detail. */
  const spaceRootOf = (spaceId: string, personalSpace: string | null): AddressedPlacement | null =>
    spaceId === personalSpace ? null : addressed({ scope: ROLE_SCOPE.space, space: spaceId })

  /** The move up and the base/version relation are defined only for a role that
   * sits in a project, and only a project placement carries the id they ask it for. */
  const projectPlacement = (location: AddressedPlacement): AddressedProjectPlacement | null =>
    location.scope === ROLE_SCOPE.project && location.projectId != null
      ? (location as AddressedProjectPlacement)
      : null

  /** The one answer to "which placement does this locator address?". Personal and a
   * Space root are the SAME directory, so a locator that names the caller's personal
   * space as a Space — or any other space as personal — addresses a place that does
   * not exist. Accepting it would let a borrowed scope carry the writer rules of the
   * scope it borrowed. Resolution asks the project-context question on top of this
   * answer; addressing is this and only this.
   * canon: docs/note-model.md#roles-and-skills */
  const ownedPlacementOf = (
    locator: OwnedAbilityLocator,
    personalSpace: string | null,
  ): AddressedPlacement | null => {
    if (locator.location.scope === ROLE_SCOPE.personal) {
      return personalSpace === locator.location.spaceId
        ? addressed({ scope: ROLE_SCOPE.personal, space: locator.location.spaceId })
        : null
    }
    if (locator.location.scope === ROLE_SCOPE.space) {
      return spaceRootOf(locator.location.spaceId, personalSpace)
    }

    return addressed({
      scope: ROLE_SCOPE.project,
      space: locator.location.spaceId,
      projectId: locator.location.projectId,
    })
  }

  /** The WRITE side of the same question `healthForRole` reads: an attachment is
   *  eligible exactly where this role's dependencies live. Spelling the rule out here
   *  instead of asking `homeOf` made the two disagree for a role in a project of the
   *  caller's own space — the reader called such an attachment healthy and the writer
   *  refused the very list it had just handed back. */
  const serializedAttachmentAt = (
    location: AddressedPlacement,
    personalSpace: string | null,
    attachment: AuthoredAttachment,
  ): string => {
    if (attachment.kind === 'invalid') {
      return attachment.raw
    }
    const { locator, label } = attachment

    if (locator.source === 'system') {
      return serializeSkillLocator({ source: 'system', packageId: locator.packageId, label })
    }
    const home = homeOf(location, personalSpace)
    const eligible =
      locator.location.scope === home.scope && locator.location.spaceId === home.space

    if (!eligible) {
      throw new RoleDependencyConflictError('skill attachment is outside the Role placement')
    }

    return serializeSkillLocator({
      scope: locator.location.scope,
      packageId: locator.packageId,
      label,
    })
  }

  const readableLocationsFor = (
    context: EffectiveRoleContext,
    principal: Principal,
  ): AddressedPlacement[] =>
    locationsFor(context).filter(({ space }) => can(principal, 'space:read', { space }))

  /** Addressing plus the two questions resolution adds: may this principal read the
   * space at all, and is the project the one this request is actually in. */
  const exactLocationIn = (
    context: EffectiveRoleContext,
    principal: Principal,
    locator: OwnedAbilityLocator,
  ): AddressedPlacement | null => {
    if (!can(principal, 'space:read', { space: locator.location.spaceId })) {
      return null
    }
    const placement = ownedPlacementOf(locator, context.personalSpace)

    if (!placement || placement.scope !== ROLE_SCOPE.project) {
      return placement
    }

    const project = context.project

    return project && project.id === placement.projectId && project.space === placement.space
      ? placement
      : null
  }

  const linkedAt = async (
    link: SkillLink,
    locations: readonly AddressedPlacement[],
    personalSpace: string | null,
    projectId?: string,
  ): Promise<ParsedPackage | undefined> => {
    if (link.kind !== 'locator' || link.source !== 'owned') {
      console.warn('[roles] ignoring name-only link in owned role')
      return undefined
    }
    const location =
      locations.find(({ scope }) => scope === link.scope) ??
      (link.scope === ROLE_SCOPE.space
        ? locations
            .filter(({ scope }) => scope === ROLE_SCOPE.project)
            .map((entry) => homeOf(entry, personalSpace))[0]
        : undefined)

    if (!location) {
      console.warn(`[roles] ignoring unavailable ${link.scope} linked package ${link.packageId}`)
      return undefined
    }

    if (link.scope === ROLE_SCOPE.space && projectId) {
      const availability = await abilityAvailability.get(location.space, link.packageId)

      if (!skillReaches(availability, projectId)) {
        console.warn(`[roles] ignoring unavailable space linked package ${link.packageId}`)
        return undefined
      }
    }
    const parsed = await exactOwnedPackage(location, link.packageId)

    if (!parsed) {
      console.warn(`[roles] ignoring missing ${link.scope} linked package ${link.packageId}`)
    }

    return parsed ?? undefined
  }

  const roleActivationSnapshot = async (
    parsed: ParsedPackage,
    // Catalog composition is not expressed on the wire at all — a Catalog package is
    // read to be forked, and the fork is what gets a health verdict.
    source: 'system' | 'owned',
    principal: Principal,
    /** Addressed, because health READS the packages this role depends on: the home
     *  they are looked up in must be one the service derived, not one a caller named. */
    location: AddressedPlacement | undefined,
    personalSpace: string | null,
    projectId?: string,
  ): Promise<{ health: AbilityHealth; dependencies: Array<ParsedPackage | undefined> }> => {
    const owner = preferenceOwner(principal)
    const attachments: AbilityAttachmentState[] = []
    const dependencies: Array<ParsedPackage | undefined> = []

    for (const link of parsed.skill.linkedSkills) {
      if (link.kind === 'invalid' || link.kind === 'name') {
        dependencies.push(undefined)
        attachments.push({
          attachment: {
            kind: 'invalid',
            raw: link.kind === 'invalid' ? link.raw : `[[${link.name}]]`,
            reason: 'invalid-locator',
          },
          health: ABILITY_ATTACHMENT_HEALTH.invalidLocator,
        })
        continue
      }
      if (link.source === 'system') {
        const locator = {
          source: 'system',
          kind: 'skill',
          packageId: link.packageId,
        } as const
        const dependency = await systemPackageById(link.packageId)
        dependencies.push(dependency ?? undefined)
        const health = !dependency
          ? ABILITY_ATTACHMENT_HEALTH.missing
          : dependency.skill.role
            ? ABILITY_ATTACHMENT_HEALTH.wrongKind
            : (await abilityPreferences.isEnabled(owner, locator))
              ? ABILITY_ATTACHMENT_HEALTH.healthy
              : ABILITY_ATTACHMENT_HEALTH.disabled
        attachments.push({
          attachment: { kind: 'exact', locator, label: link.label },
          health,
        })
        continue
      }

      // Where this role's dependencies live, and only if the link agrees: a `personal`
      // token names the personal library and a `space` token the Space root, so a
      // token that names the other home is not resolvable from here at all.
      const home = location ? homeOf(location, personalSpace) : null
      const dependencyLocation = home?.scope === link.scope ? home : null
      // Minted, not spelled: this address is the key the private override is looked up
      // by, so a shape change that missed it would make the lookup MISS and read the
      // dependency as enabled — fail-open on a bit the owner set deliberately.
      const locator = dependencyLocation
        ? ownedSkillLocator(dependencyLocation, link.packageId)
        : null
      let health: AbilityAttachmentState['health'] = ABILITY_ATTACHMENT_HEALTH.unavailable
      let dependency: ParsedPackage | undefined

      if (locator && can(principal, 'space:read', { space: dependencyLocation!.space })) {
        dependency = (await exactOwnedPackage(dependencyLocation!, link.packageId)) ?? undefined

        if (!dependency) {
          health = ABILITY_ATTACHMENT_HEALTH.missing
        } else if (dependency.skill.role) {
          health = ABILITY_ATTACHMENT_HEALTH.wrongKind
        } else if (!(await abilityPreferences.isEnabled(owner, locator))) {
          health = ABILITY_ATTACHMENT_HEALTH.disabled
        } else if (dependencyLocation!.scope === ROLE_SCOPE.space) {
          const availability = await abilityAvailability.get(
            dependencyLocation!.space,
            link.packageId,
          )
          // Asked of the PROJECT this role is being resolved for, not of the role's
          // own placement. A Space role narrowed to A may legitimately depend on a
          // skill available in A, and the loader already includes that skill
          // (`linkedAt`) — judging it unavailable here would refuse activation for a
          // dependency the very same request loads.
          health = skillReaches(availability, projectId)
            ? ABILITY_ATTACHMENT_HEALTH.healthy
            : ABILITY_ATTACHMENT_HEALTH.unavailable
        } else {
          health = ABILITY_ATTACHMENT_HEALTH.healthy
        }
      }
      attachments.push(
        locator
          ? { attachment: { kind: 'exact', locator, label: link.label }, health }
          : {
              attachment: { kind: 'invalid', raw: link.raw, reason: 'invalid-locator' },
              health,
            },
      )
      dependencies.push(dependency)
    }

    return {
      health: {
        healthy: attachments.every(({ health }) => health === ABILITY_ATTACHMENT_HEALTH.healthy),
        attachments,
      },
      dependencies,
    }
  }

  const healthForRole = async (
    parsed: ParsedPackage,
    source: 'system' | 'owned',
    principal: Principal,
    location: AddressedPlacement | undefined,
    personalSpace: string | null,
    projectId?: string,
  ): Promise<AbilityHealth> =>
    (await roleActivationSnapshot(parsed, source, principal, location, personalSpace, projectId))
      .health

  /** A role's own page has no project context, but a role that covers a set of
   * projects has an answer in each of them — and a single "no project" verdict would
   * call a perfectly usable role broken. Judged in every project it covers and
   * reported at its worst: an attachment healthy in two of three still leaves the
   * role fail-closed in the third, and that is what the reader must see. */
  const roleHealthAcross = async (
    parsed: ParsedPackage,
    principal: Principal,
    location: AddressedPlacement,
    personalSpace: string | null,
    contextProjectId: string | undefined,
    availability: AbilityAvailability | null,
  ): Promise<AbilityHealth> => {
    const covered = contextProjectId
      ? [contextProjectId]
      : coveredProjectsOf(location, availability ?? undefined)
    let worst: AbilityHealth | null = null

    for (const projectId of covered) {
      const health = await healthForRole(
        parsed,
        'owned',
        principal,
        location,
        personalSpace,
        projectId,
      )

      worst = worst
        ? {
            healthy: worst.healthy && health.healthy,
            attachments: worst.attachments.map((state, index) =>
              state.health === ABILITY_ATTACHMENT_HEALTH.healthy
                ? (health.attachments[index] ?? state)
                : state,
            ),
          }
        : health
    }

    return worst ?? { healthy: true, attachments: [] }
  }

  /** The writer for one settled placement, or a typed refusal. Asked BEFORE any
   *  mutation the caller is about to make: composition either can publish here or
   *  cannot, and finding out afterwards is what left half-installed state behind. */
  const publisherAt = async (location: RoleHomeLocation): Promise<RolePackagePublication> => {
    const handle = publication.availableFor({ kind: 'location', location })
      ? await publication.publicationFor(location)
      : null

    if (!handle) {
      throw new RoleInstallUnavailableError(
        `role installation is unavailable for this ${location.scope} placement`,
      )
    }

    return handle
  }

  /** Every distinct placement one Add will write to, resolved once each and then
   *  held. Deduplicated by the canonical location, so a Personal role whose
   *  linked skills live in that same placement takes ONE handle, not two — and
   *  resolved together, so a Project role whose Space dependencies are
   *  publishable but whose own placement is not is refused before either. */
  const placementPublishers = async (
    ...locations: readonly RoleHomeLocation[]
  ): Promise<RolePackagePublication[]> => {
    const keyOf = (location: RoleHomeLocation): string =>
      `${location.scope}\0${location.space}\0${location.projectId ?? ''}`
    const resolved = new Map<string, RolePackagePublication>()

    for (const location of locations) {
      if (!resolved.has(keyOf(location))) {
        resolved.set(keyOf(location), await publisherAt(location))
      }
    }

    return locations.map((location) => resolved.get(keyOf(location))!)
  }

  const publishOwnedPackage = async (
    location: RoleHomeLocation,
    publisher: RolePackagePublication,
    pkg: SkillPackage,
    conflict: () => Error,
  ): Promise<string> => {
    try {
      if (!(await publisher.putIfAbsent(pkg))) {
        throw conflict()
      }
    } catch (error) {
      if ((error as { code?: string }).code === 'SKILL_NAME_CONFLICT') {
        throw conflict()
      }
      throw error
    }
    const readable = await library.awaitReadableNoteIds(location, [pkg.directoryName])
    const noteId = readable.get(pkg.directoryName)

    if (!noteId) {
      throw new Error(
        `package "${pkg.directoryName}" was published without a readable note identity`,
      )
    }

    return noteId
  }

  /** Exact saved bindings need the same candidate facts as by-name activation, but
   * they start from an address and must distinguish a package that is gone from one
   * that is merely inactive in the current context. */
  const savedRoleCandidate = async (
    context: EffectiveRoleContext,
    principal: Principal,
    locator: ActiveRoleLocator,
  ): Promise<AbilityResolutionEntry | Extract<AbilityLoadOutcome, { ok: false }>> => {
    if (locator.source === 'system') {
      const parsed = await systemPackageById(locator.packageId)

      if (!parsed) {
        return {
          ok: false,
          reason: 'gone',
          ref: encodeAbilityLocator(locator),
          remediation: [{ kind: 'list-abilities', view: 'runtime' }],
        }
      }
      if (!parsed.skill.role) {
        return {
          ok: false,
          reason: 'wrong-kind',
          actual: ABILITY_KIND.skill,
          remediation: [{ kind: 'call-other-kind', actual: ABILITY_KIND.skill }],
        }
      }
      const candidate: AbilityResolutionEntry = {
        source: 'system',
        parsed,
        kind: ABILITY_KIND.role,
        locator,
        enabled: await activeSystemAbility(parsed, principal),
        reachable: true,
        effective: false,
      }

      return candidate.enabled
        ? candidate
        : await failedCandidate(candidate, context, principal, 'disabled')
    }
    const placement = ownedPlacementOf(locator, context.personalSpace)

    if (!placement || !can(principal, 'space:read', { space: placement.space })) {
      return {
        ok: false,
        reason: 'gone',
        remediation: [{ kind: 'list-abilities', view: 'runtime' }],
      }
    }
    const parsed = await exactOwnedPackage(placement, locator.packageId)

    if (!parsed) {
      return {
        ok: false,
        reason: 'gone',
        ref: encodeAbilityLocator(locator),
        remediation: [{ kind: 'list-abilities', view: 'runtime' }],
      }
    }
    if (!parsed.skill.role) {
      return {
        ok: false,
        reason: 'wrong-kind',
        actual: ABILITY_KIND.skill,
        remediation: [{ kind: 'call-other-kind', actual: ABILITY_KIND.skill }],
      }
    }
    const currentReachesPlacement = locationsFor(context).some(
      (entry) =>
        entry.scope === placement.scope &&
        entry.space === placement.space &&
        entry.projectId === placement.projectId,
    )
    const availability =
      placement.scope === ROLE_SCOPE.space
        ? await abilityAvailability.get(placement.space, parsed.pkg.directoryName)
        : undefined
    const candidate: AbilityResolutionEntry = {
      source: 'owned',
      parsed,
      location: placement,
      kind: ABILITY_KIND.role,
      locator,
      enabled: await abilityPreferences.isEnabled(preferenceOwner(principal), locator),
      reachable:
        currentReachesPlacement &&
        abilityReachesContext(parsed, placement, availability, context.project?.id),
      effective: false,
    }

    if (!candidate.enabled) {
      return failedCandidate(candidate, context, principal, 'disabled')
    }

    return candidate.reachable
      ? candidate
      : await failedCandidate(candidate, context, principal, 'out-of-reach')
  }

  /** WHICH role this address names, and whether the agent actually loads it here.
   *  One producer for both, because they are one walk over the same package: splitting
   *  them into two doors let the identity question inherit the effectiveness answer —
   *  a member who had switched a shared role off for themselves was told the role did
   *  not exist, on the page that configures its SHARED context. Identity is a question
   *  about the space; effectiveness is a question about this reader, here, now. */
  const addressedRoleStatus = async (
    context: EffectiveRoleContext,
    principal: Principal,
    locator: Extract<OwnedAbilityLocator, { kind: 'role' }>,
  ): Promise<AddressedRoleStatus | null> => {
    const hit = await addressedOwnedRole(locator, principal, context.personalSpace)

    if (!hit) {
      return null
    }
    const role = resolvedOwnedRoleOf(hit.location, hit.parsed)
    const enabled = await abilityPreferences.isEnabled(
      preferenceOwner(principal),
      ownedRoleLocator(hit.location, locator.packageId),
    )

    if (!enabled) {
      return { role, active: false, inactive: ROLE_INACTIVE.disabled }
    }
    // Reach is TWO questions, and answering only the second called a role live that
    // this caller could never load. First: does the context reach that placement at
    // all — a Space or Project placement asked about from Personal is not in the chain,
    // and `availableAt` says nothing about it because narrowing is a Space-role rule.
    // Second: is the Space role narrowed away from this project. The preview door
    // dropped the first case by filtering on scope before it ever asked, so the two
    // doors disagreed and the web had to reconcile them itself.
    const reached = locationsFor(context).some(
      (candidate) =>
        candidate.scope === hit.location.scope &&
        candidate.space === hit.location.space &&
        (candidate.scope !== ROLE_SCOPE.project ||
          candidate.projectId === (hit.location as { projectId?: string }).projectId),
    )

    if (!reached || !(await availableAt(hit.location, locator.packageId, context.project?.id))) {
      return { role, active: false, inactive: ROLE_INACTIVE.outOfReach }
    }
    const health = await entryHealth(
      { source: 'owned', parsed: hit.parsed, location: hit.location },
      context,
      principal,
    )

    return health.healthy
      ? { role, active: true }
      : { role, active: false, inactive: ROLE_INACTIVE.unhealthy }
  }

  const resolvedRoleOf = (entry: EffectiveRoleEntry): ResolvedEffectiveRole => {
    const packageId = entry.parsed.pkg.directoryName
    const locator = activeRoleLocatorOf(entry)

    return entry.source === 'system'
      ? {
          source: 'system',
          role: { source: 'system', ...abilityFactsOf(entry.parsed) },
          packageId,
          locator,
        }
      : {
          source: 'owned',
          role: { source: 'owned', ...abilityFactsOf(entry.parsed), scope: entry.location.scope },
          location: entry.location,
          packageId,
          locator,
        }
  }

  /** Is this entry sound enough to raise HERE? Factored out because resume refuses an
   *  unhealthy role, and the surface that only asks "is this binding still live" was
   *  answering yes to a role resume would drop — so a page said a role was active
   *  while the agent had none. */
  const entryHealth = async (
    entry: EffectiveRoleEntry,
    context: EffectiveRoleContext,
    principal: Principal,
  ) =>
    entry.source === 'system'
      ? await healthForRole(entry.parsed, 'system', principal, undefined, null)
      : await healthForRole(
          entry.parsed,
          'owned',
          principal,
          entry.location,
          context.personalSpace,
          context.project?.id,
        )

  /** Load an effective role, whichever source it came from — health first, then the
   *  body and its attachments. One body, because this used to be TWO: a second,
   *  human-facing pair carried its own loader and its own System fallback, and only
   *  one of the two ever learned about System — so the behaviour was specified and
   *  proven against the pair no production caller ran. */
  const loadEffectiveEntry = async (
    entry: EffectiveRoleEntry,
    context: EffectiveRoleContext,
    principal: Principal,
    budgetTokens: number,
  ) => {
    const snapshot = await roleActivationSnapshot(
      entry.parsed,
      entry.source,
      principal,
      entry.source === 'owned' ? entry.location : undefined,
      context.personalSpace,
      context.project?.id,
    )

    if (!snapshot.health.healthy) {
      return { loaded: null, health: snapshot.health }
    }
    const loaded = await loadParsedRole(
      entry.parsed,
      // A System package is not placed; the scope here only labels the summary that
      // `loadParsedRole` builds, and the caller replaces it with the source union.
      entry.source === 'system' ? ROLE_SCOPE.catalog : entry.location.scope,
      (_link, index) => snapshot.dependencies[index],
      budgetTokens,
      true,
    )

    return { loaded, health: snapshot.health }
  }

  const prepareCustomRole = async (
    name: string,
    description: string,
    instructions: string,
    location: RoleHomeLocation,
    options: {
      principal: Principal
      attachments?: readonly AuthoredAttachment[]
      availability?: AbilityAvailability
      personalSpace?: string | null
    },
  ): Promise<SkillPackage> => {
    const home = addressed(location)
    const links = (options.attachments ?? []).map((attachment) => {
      if (attachment.kind === 'invalid') {
        throw new RoleDependencyConflictError('new invalid skill attachments are not allowed')
      }

      return serializedAttachmentAt(home, options.personalSpace ?? null, attachment)
    })
    const pkg = customPackage(name, description, instructions, true, links)

    for (const projectId of coveredProjectsOf(location, options.availability)) {
      const health = await healthForRole(
        parsePackage(pkg),
        'owned',
        options.principal,
        home,
        options.personalSpace ?? null,
        projectId,
      )
      const blocked = health.attachments.find(({ health: verdict }) =>
        blocksAttachmentWrite(verdict),
      )

      if (blocked) {
        const attachment =
          blocked.attachment.kind === 'exact'
            ? blocked.attachment.label
            : blocked.attachment.kind === 'invalid'
              ? blocked.attachment.raw
              : 'unknown attachment'
        const rule =
          blocked.health === ABILITY_ATTACHMENT_HEALTH.wrongKind
            ? 'an attachment must address a skill'
            : blocked.health === ABILITY_ATTACHMENT_HEALTH.unavailable
              ? 'an attachment must reach every project covered by the role'
              : blocked.health === ABILITY_ATTACHMENT_HEALTH.invalidLocator
                ? 'an attachment must have a valid locator'
                : 'an attachment must exist and be readable at the role home'

        throw new RoleDependencyConflictError(
          `skill attachment "${attachment}" is ${blocked.health} for project ${projectId}; ${rule}`,
          { attachment, verdict: blocked.health, rule, projectId },
        )
      }
    }

    return pkg
  }

  const describeOwnedParsed = async (
    context: EffectiveRoleContext,
    principal: Principal,
    locator: OwnedAbilityLocator,
    location: AddressedPlacement,
    parsed: ParsedPackage,
    noteId: string,
    budgetTokens: number,
  ): Promise<AbilityDetail | null> => {
    if (parsed.skill.role !== (locator.kind === ABILITY_KIND.role)) {
      return null
    }
    const exact = ownedAbilityLocator(location, parsed)

    if (!exact || serializeAbilityLocator(exact) !== serializeAbilityLocator(locator)) {
      return null
    }
    const enabled = await abilityPreferences.isEnabled(preferenceOwner(principal), locator)
    const loaded = parsed.skill.role
      ? await loadParsedRole(
          parsed,
          location.scope,
          async (link) =>
            link.kind === 'locator' && link.source === 'system'
              ? ((await systemPackageById(link.packageId)) ?? undefined)
              : linkedAt(
                  link,
                  [homeOf(location, context.personalSpace)],
                  context.personalSpace,
                  location.projectId ?? context.project?.id,
                ),
          budgetTokens,
        )
      : loadParsedSkill(parsed, location.scope)

    if (!loaded) {
      return null
    }
    const item = 'role' in loaded ? loaded.role : loaded.skill
    const reach = await abilityAvailability.get(location.space, locator.packageId)

    return {
      locator,
      source: 'owned',
      title: parsed.skill.title,
      name: item.name,
      description: item.description,
      instructions: item.instructions,
      enabled,
      noteId,
      origin: hasCatalogProvenance(parsed.skill) ? 'catalog' : 'custom',
      ...(hasCatalogProvenance(parsed.skill)
        ? { originRevision: parsed.skill.metadata['notarium.originRevision'] }
        : {}),
      ...(location.scope === ROLE_SCOPE.space
        ? {
            availability: abilityAvailabilityOf(reach, parsed.skill.role ? 'role' : 'skill'),
          }
        : {}),
      ...(parsed.skill.role
        ? {
            health: await roleHealthAcross(
              parsed,
              principal,
              location,
              context.personalSpace,
              context.project?.id,
              reach,
            ),
          }
        : {}),
      truncated: loaded.truncated,
    }
  }

  const describeOwnedSnapshot = async (
    context: EffectiveRoleContext,
    principal: Principal,
    snapshot: OwnedAbilitySnapshot,
    budgetTokens: number,
  ): Promise<AbilityDetail | null> => {
    const location = exactLocationIn(context, principal, snapshot.locator)

    if (!location) {
      return null
    }
    let parsed: ParsedPackage

    try {
      parsed = parsePackage(snapshot.pkg)
    } catch {
      return null
    }

    return describeOwnedParsed(
      context,
      principal,
      snapshot.locator,
      location,
      parsed,
      snapshot.registryNoteId,
      budgetTokens,
    )
  }

  const captureAt = async (
    location: AddressedPlacement,
    locator: OwnedAbilityLocator,
    expected?: Pick<OwnedAbilityTarget, 'registryNoteId' | 'manifestNoteId'>,
  ): Promise<OwnedAbilitySnapshot | null> => {
    const captured = await library.captureExactPackage(
      location,
      locator.packageId,
      expected?.registryNoteId,
    )

    if (!captured) {
      return null
    }
    let parsed: ParsedPackage

    try {
      parsed = parsePackage(captured.pkg)
    } catch {
      return null
    }
    const exact = ownedAbilityLocator(location, parsed)

    if (
      !exact ||
      serializeAbilityLocator(exact) !== serializeAbilityLocator(locator) ||
      (expected !== undefined &&
        (captured.registryNoteId !== expected.registryNoteId ||
          captured.manifestNoteId !== expected.manifestNoteId))
    ) {
      return null
    }

    return { ...captured, locator: exact }
  }

  type CurrentAuthority =
    | { state: 'current'; locator: OwnedAbilityLocator }
    | {
        state: 'moved'
        locator: OwnedAbilityLocator
        registryNoteId: string
        manifestNoteId: string
      }
    | { state: 'invalid' }

  const currentAuthority = async (locator: OwnedAbilityLocator): Promise<CurrentAuthority> => {
    const recorded = await abilityPlacement.resolveMovedOwnedRoleLocator(
      serializeAbilityLocator(locator),
    )

    if (!recorded) {
      return { state: 'current', locator }
    }
    const moved = parseAbilityLocator(recorded.toLocator)

    return moved?.source === 'owned' &&
      moved.kind === locator.kind &&
      moved.packageId === locator.packageId &&
      moved.location.spaceId === locator.location.spaceId
      ? {
          state: 'moved',
          locator: moved,
          registryNoteId: recorded.registryNoteId,
          manifestNoteId: recorded.manifestNoteId,
        }
      : { state: 'invalid' }
  }

  const sameAuthority = (left: CurrentAuthority, right: CurrentAuthority): boolean =>
    left.state === right.state &&
    left.state !== 'invalid' &&
    right.state !== 'invalid' &&
    serializeAbilityLocator(left.locator) === serializeAbilityLocator(right.locator) &&
    (left.state === 'current' ||
      (right.state === 'moved' &&
        left.registryNoteId === right.registryNoteId &&
        left.manifestNoteId === right.manifestNoteId))

  const captureCurrentOwnedTarget = async (
    locator: OwnedAbilityLocator,
    principal: Principal,
  ): Promise<OwnedAbilitySnapshot | null> => {
    if (!can(principal, 'space:read', { space: locator.location.spaceId })) {
      return null
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const selected = await currentAuthority(locator)

      if (selected.state === 'invalid') {
        return null
      }
      const location = addressed({
        scope: selected.locator.location.scope,
        space: selected.locator.location.spaceId,
        ...(selected.locator.location.scope === ROLE_SCOPE.project
          ? { projectId: selected.locator.location.projectId }
          : {}),
      })
      const captured = await captureAt(
        location,
        selected.locator,
        selected.state === 'moved'
          ? {
              registryNoteId: selected.registryNoteId,
              manifestNoteId: selected.manifestNoteId,
            }
          : undefined,
      )
      const checked = await currentAuthority(locator)

      if (sameAuthority(selected, checked)) {
        return captured
      }
    }

    return null
  }

  return {
    resolveOwnedPlacement: (location, personalSpace) => {
      if (location.scope === ROLE_SCOPE.personal) {
        return location.space === personalSpace ? addressed(location) : null
      }
      if (location.scope === ROLE_SCOPE.space) {
        return spaceRootOf(location.space, personalSpace)
      }

      return location.projectId ? addressed(location) : null
    },
    resolveOwnedAt: async (location, principal, kind, packageId) => {
      if (!can(principal, 'space:read', { space: location.space })) {
        return null
      }
      const at = addressed(location)
      const captured = await library.captureExactPackage(at, packageId)

      if (!captured || captured.kind !== kind) {
        return null
      }
      let parsed: ParsedPackage

      try {
        parsed = parsePackage(captured.pkg)
      } catch {
        return null
      }
      const locator = ownedAbilityLocator(at, parsed)

      return locator
    },
    captureOwnedAt: async (location, principal, kind, packageId, registryNoteId) => {
      if (!can(principal, 'space:read', { space: location.space })) {
        return null
      }
      const at = addressed(location)
      const captured = await library.captureExactPackage(at, packageId, registryNoteId)

      if (!captured || captured.kind !== kind) {
        return null
      }
      let parsed: ParsedPackage

      try {
        parsed = parsePackage(captured.pkg)
      } catch {
        return null
      }
      const locator = ownedAbilityLocator(at, parsed)

      return locator ? { ...captured, locator } : null
    },
    captureCurrentOwnedTarget,
    captureOwnedTarget: async (target, principal) => {
      const { locator } = target

      if (!can(principal, 'space:read', { space: locator.location.spaceId })) {
        return null
      }
      if (await abilityPlacement.resolveMovedOwnedRoleLocator(serializeAbilityLocator(locator))) {
        return null
      }
      const location = addressed({
        scope: locator.location.scope,
        space: locator.location.spaceId,
        ...(locator.location.scope === ROLE_SCOPE.project
          ? { projectId: locator.location.projectId }
          : {}),
      })

      return captureAt(location, locator, target)
    },
    withOwnedTargetMutation: async (target, principal, task) => {
      const { locator } = target

      if (!can(principal, 'space:read', { space: locator.location.spaceId })) {
        return null
      }
      if (await abilityPlacement.resolveMovedOwnedRoleLocator(serializeAbilityLocator(locator))) {
        return null
      }
      const location = addressed({
        scope: locator.location.scope,
        space: locator.location.spaceId,
        ...(locator.location.scope === ROLE_SCOPE.project
          ? { projectId: locator.location.projectId }
          : {}),
      })

      return library.withExactPackageMutation(
        location,
        locator.packageId,
        { kind: locator.kind, ...target },
        async (captured: RolePackageSnapshot) => {
          let parsed: ParsedPackage

          try {
            parsed = parsePackage(captured.pkg)
          } catch {
            return null
          }
          // The exact locator the manifest under the lease yields, and the task is run
          // against THAT rather than against the one the caller held. Comparing the two
          // would add nothing: the address is the selector this mutation was opened by
          // and `withExactPackageMutation` has already revalidated the kind against the
          // captured target under the same lease, so the only thing left for this line
          // to say is whether the manifest yields an owned address at all.
          const exact = ownedAbilityLocator(location, parsed)

          return exact ? task({ ...captured, locator: exact }) : null
        },
      )
    },
    readOwnedAbilityMetadataState: async (context, principal, snapshot) => {
      const { locator } = snapshot
      const location = exactLocationIn(context, principal, locator)

      if (!location) {
        return null
      }
      const [enabled, availability] = await Promise.all([
        abilityPreferences.isEnabled(preferenceOwner(principal), locator),
        location.scope === ROLE_SCOPE.space
          ? abilityAvailability.get(location.space, locator.packageId)
          : Promise.resolve(null),
      ])

      return {
        enabled,
        ...(location.scope === ROLE_SCOPE.space
          ? { availability: abilityAvailabilityOf(availability, locator.kind) }
          : {}),
      }
    },
    canAddSkillAt: (target) => publication.availableFor(target),
    canAddRoleAt: (target, personalSpace) => {
      if (!publication.availableFor(target)) {
        return false
      }
      if (target.kind === 'prospective-personal') {
        // A Personal role and its linked skills share one placement, so the
        // answer above already covered both.
        return true
      }

      return publication.availableFor({
        kind: 'location',
        location: homeOf(addressed(target.location), personalSpace),
      })
    },
    describeAbility: async (context, principal, locator, budgetTokens) => {
      if (locator.source === 'catalog') {
        const parsed = (await catalogPackages()).find(({ skill, pkg }) => {
          const identity = bundledAbilityIdentityOf(skill, pkg.directoryName)
          return identity.source === 'catalog' && identity.packageId === locator.packageId
        })

        if (!parsed || parsed.skill.role !== (locator.kind === 'role')) {
          return null
        }
        const loaded = parsed.skill.role
          ? await loadParsedRole(
              parsed,
              ROLE_SCOPE.catalog,
              async (link) =>
                link.kind === 'name' ? catalogPackageOf(link.name, ABILITY_KIND.skill) : undefined,
              budgetTokens,
            )
          : loadParsedSkill(parsed, ROLE_SCOPE.catalog)

        if (!loaded) {
          return null
        }
        const item = 'role' in loaded ? loaded.role : loaded.skill
        return {
          locator,
          source: 'catalog' as const,
          title: parsed.skill.title,
          name: item.name,
          description: item.description,
          instructions: item.instructions,
          truncated: loaded.truncated,
        }
      }
      const owner = preferenceOwner(principal)

      if (locator.source === 'system') {
        const parsed = await systemPackageById(locator.packageId)

        if (!parsed || parsed.skill.role !== (locator.kind === 'role')) {
          return null
        }
        const enabled = await abilityPreferences.isEnabled(owner, locator)
        const loaded = parsed.skill.role
          ? await loadParsedRole(
              parsed,
              ROLE_SCOPE.catalog,
              async (link) =>
                link.kind === 'locator' && link.source === 'system'
                  ? ((await systemPackageById(link.packageId)) ?? undefined)
                  : undefined,
              budgetTokens,
            )
          : loadParsedSkill(parsed, ROLE_SCOPE.catalog)

        if (!loaded) {
          return null
        }
        const item = 'role' in loaded ? loaded.role : loaded.skill
        return {
          locator,
          source: 'system' as const,
          title: parsed.skill.title,
          name: item.name,
          description: item.description,
          instructions: item.instructions,
          enabled,
          ...(parsed.skill.role
            ? { health: await healthForRole(parsed, 'system', principal, undefined, null) }
            : {}),
          truncated: loaded.truncated,
        }
      }

      const location = exactLocationIn(context, principal, locator)
      const snapshot = location ? await captureAt(location, locator) : null

      return snapshot ? describeOwnedSnapshot(context, principal, snapshot, budgetTokens) : null
    },

    describeOwnedAbility: describeOwnedSnapshot,

    setEnabled: async (context, principal, locator, enabled) => {
      const owner = preferenceOwner(principal)
      const target: OwnedAbilityTarget | null = 'locator' in locator ? locator : null
      const exactLocator: ActiveRoleLocator = target
        ? target.locator
        : (locator as Extract<ActiveRoleLocator, { source: 'system' }>)

      if (exactLocator.source === 'system') {
        const parsed = await systemPackageById(exactLocator.packageId)

        if (!parsed || parsed.skill.role !== (exactLocator.kind === 'role')) {
          throw new AbilityUnavailableError('no such System ability')
        }
        await abilityPreferences.setEnabled(
          owner,
          { locator: exactLocator },
          enabled,
          new Date().toISOString(),
        )
        return
      }
      const location = exactLocationIn(context, principal, exactLocator)

      if (!location) {
        throw new AbilityUnavailableError('Owned ability is unavailable to this principal')
      }
      if (!target) {
        throw new AbilityUnavailableError('Owned ability mutation needs a captured target')
      }
      await abilityPreferences.setEnabled(
        owner,
        { locator: exactLocator, registryNoteId: target.registryNoteId },
        enabled,
        new Date().toISOString(),
      )
    },

    setAbilityAvailability: async (context, principal, locator, availability) => {
      const target = locator
      const exactLocator = target.locator
      const location = ownedPlacementOf(exactLocator, context.personalSpace)

      if (
        location?.scope !== ROLE_SCOPE.space ||
        !can(principal, 'space:write', { space: location.space })
      ) {
        throw new AbilityUnavailableError(
          'Owned ability availability is unavailable to this principal',
        )
      }
      await abilityAvailability.set(
        location.space,
        exactLocator.packageId,
        availability,
        target.registryNoteId,
      )
    },

    listRoleVersions: async (principal, locator, personalSpace, projectIds) => {
      const base = ownedPlacementOf(locator, personalSpace)

      // Any HOME can be a base. Personal is one: a project of the caller's own space
      // falls back to it, which is exactly the pair the listing already collapses.
      if (
        !base ||
        base.scope === ROLE_SCOPE.project ||
        !can(principal, 'space:read', { space: base.space })
      ) {
        return []
      }
      const parsed = await exactOwnedPackage(base, locator.packageId)

      if (!parsed?.skill.role || !(await projectedNoteId(base, locator.packageId))) {
        return []
      }
      const versions: Array<{ projectId: string; locator: OwnedAbilityLocator }> = []

      // A version shares its base's NAME — that is what makes it the same role — so
      // this asks each project for that name rather than for a package address.
      for (const projectId of projectIds) {
        const location = projectIn(base, projectId)
        const pkg = (await library.getAbilitiesNamed(location, parsed.skill.name)).get(
          ABILITY_KIND.role,
        )

        if (!pkg) {
          continue
        }
        try {
          const version = parsePackage(pkg)

          if (version.skill.role && (await projectedNoteId(location, version.pkg.directoryName))) {
            versions.push({
              projectId,
              locator: ownedRoleLocator(location, version.pkg.directoryName),
            })
          }
        } catch (err) {
          console.warn(
            `[roles] ignoring invalid project version ${parsed.skill.name}:`,
            (err as Error).message,
          )
        }
      }

      return versions
    },

    findRoleBase: async (principal, locator, personalSpace) => {
      const placed = ownedPlacementOf(locator, personalSpace)
      const from = placed && projectPlacement(placed)

      if (!from || !can(principal, 'space:read', { space: from.space })) {
        return null
      }
      const parsed = await exactOwnedPackage(from, locator.packageId)
      const base = homeOf(from, personalSpace)

      if (!parsed?.skill.role) {
        return null
      }
      const pkg = (await library.getAbilitiesNamed(base, parsed.skill.name)).get(ABILITY_KIND.role)

      if (!pkg) {
        return null
      }
      try {
        const found = parsePackage(pkg)

        return found.skill.role && (await projectedNoteId(base, found.pkg.directoryName))
          ? ownedRoleLocator(base, found.pkg.directoryName)
          : null
      } catch {
        return null
      }
    },

    createRoleVersion: async (principal, sourceTarget, personalSpace, projectId) => {
      const locator = sourceTarget.locator
      const base = ownedPlacementOf(locator, personalSpace)

      if (
        !base ||
        base.scope !== ROLE_SCOPE.space ||
        !can(principal, 'space:write', { space: base.space })
      ) {
        throw new AbilityUnavailableError('a project version needs a writable Space base')
      }
      const capture = (snapshot: OwnedAbilitySnapshot) => {
        const pkg = clonePackage(snapshot.pkg)
        const manifest = pkg.files.get('SKILL.md')
        const owner = manifest ? exactOwnerObservation(manifest) : { kind: 'unproven' as const }
        let parsed: ParsedPackage

        try {
          parsed = parsePackage(pkg)
        } catch {
          return null
        }

        return parsed.skill.role &&
          serializeAbilityLocator(snapshot.locator) === serializeAbilityLocator(locator) &&
          snapshot.registryNoteId &&
          owner.kind === 'claimed' &&
          owner.id === snapshot.manifestNoteId
          ? { snapshot: { ...snapshot, pkg }, parsed }
          : null
      }
      const captured = capture(sourceTarget)

      if (!captured) {
        throw new AbilityUnavailableError('no such Owned Role')
      }
      const location = {
        scope: ROLE_SCOPE.project,
        space: base.space,
        projectId,
      } as const
      const name = captured.parsed.skill.name
      const release = await acquireAddFence(location, name)

      try {
        if (await library.exists(location, name)) {
          throw new RoleAlreadyExistsError(`role "${name}" already exists in ${location.scope}`)
        }
        // A fork of the base's BYTES, not a reconstruction from its parsed parts: the
        // authored H1 is the role's title and lives in the body, so rebuilding from
        // `instructions` would silently drop it. Only the note id is minted fresh —
        // two notes claiming one id is a collision, not a copy.
        //
        // The attachments therefore carry over verbatim too. A version is a fork of
        // one role, not new authoring, so the fail-closed gate `createCustomRole` puts
        // on freshly authored links does not apply: a Space skill the base links is
        // addressed identically from a project placement of the same Space, and if
        // that skill does not reach THIS project the version is simply unhealthy here
        // — a normal (role, project) state, visible as such. Granting the skill that
        // project instead would widen its reach behind the user's back.
        const noteId = freshNoteId()
        const files = new Map(captured.snapshot.pkg.files)
        files.set(
          'SKILL.md',
          Buffer.from(
            withFreshNoteId(
              Buffer.from(captured.snapshot.pkg.files.get('SKILL.md')!).toString('utf8'),
              noteId,
            ),
          ),
        )
        const pkg = { directoryName: noteId, files }
        validateSkillPackage(pkg)
        const registryNoteId = await publishOwnedPackage(
          location,
          await publisherAt(location),
          pkg,
          () => new RoleAlreadyExistsError(`role "${name}" already exists in ${location.scope}`),
        )

        return {
          ...summaryOf(parsePackage(pkg), location.scope),
          space: location.space,
          projectId,
          packageId: pkg.directoryName,
          noteId: registryNoteId,
        }
      } finally {
        release()
      }
    },

    moveRolePlacement: async (principal, requestedTarget, personalSpace) => {
      const locator = requestedTarget.locator
      const placed = ownedPlacementOf(locator, personalSpace)
      const from = placed && projectPlacement(placed)
      const to = from && spaceRootOf(from.space, personalSpace)

      if (!from || !to || !can(principal, 'space:write', { space: from.space })) {
        throw new AbilityUnavailableError('this role cannot change where it belongs')
      }
      const space = from.space
      const moved = ownedRoleLocator(to, locator.packageId)
      const availability: AbilityAvailability = {
        mode: ABILITY_AVAILABILITY_MODE.selectedProjects,
        projectIds: [from.projectId],
      }
      let reachBefore: AbilityAvailability | null = null

      /** `false` says the row is still the one this move wrote. Reach is the last
       *  effect an undo puts back and the only one whose residue is safe in both
       *  directions: a narrowing row left behind can make the role reach FEWER
       *  projects than it should, never more, and its owner rewrites it through the
       *  ordinary availability door as soon as the package is addressable again. */
      const restoreReach = async (): Promise<boolean> =>
        (reachBefore
          ? abilityAvailability.set(
              space,
              locator.packageId,
              reachBefore,
              requestedTarget.registryNoteId,
            )
          : abilityAvailability.clear(space, locator.packageId)
        )
          .then(() => true)
          .catch((error: Error) => {
            console.error('[roles] failed to undo role reach:', error.message)

            return false
          })

      /** The placement trail is the third durable effect of a move, and the only one
       *  the library knows nothing about: it is written by `finalize`, so a rollback
       *  the library drives (`lifecycle.rollback`) can only undo the reach.
       *
       *  Both directions are the same call with its ends swapped, so they share one
       *  body: an undo that could not finish has to be able to put the address back
       *  on the package it failed to bring home. They differ in ONE thing, and it is
       *  the thing that decides whether an interrupted undo is recoverable: the
       *  backward call CANCELS the hop rather than answering it with a counter-hop.
       *
       *  A counter-hop reads as an ordinary forwarding row, and every trail row
       *  tombstones the address it names whether or not the destination holds anything
       *  (`captureOwnedTarget` and `withOwnedTargetMutation` refuse on the row alone).
       *  So a compensating step is the only thing that could remove it — and that step
       *  is exactly the one an undo can be interrupted at. Left behind with the bytes
       *  still at the new home, it named the role from both spellings at once and no
       *  ordinary door reached it again. `cancel` needs no step after it. */
      const carryPlacementTrail = async (
        snapshot: RolePackageSnapshot,
        direction: 'forward' | 'back',
      ): Promise<boolean> => {
        const forward = direction === 'forward'

        return abilityPlacement
          .moveOwnedRolePlacement({
            fromTargetId: roleContextTargetIdOf(forward ? from : to, locator.packageId),
            toTargetId: roleContextTargetIdOf(forward ? to : from, locator.packageId),
            fromLocator: serializeAbilityLocator(forward ? locator : moved),
            toLocator: serializeAbilityLocator(forward ? moved : locator),
            registryNoteId: snapshot.registryNoteId,
            manifestNoteId: snapshot.manifestNoteId,
            trail: forward ? 'record' : 'cancel',
          })
          .then(() => true)
          .catch((error: Error) => {
            console.error('[roles] failed to carry role placement trail:', error.message)

            return false
          })
      }

      /** The physical half of the undo, and the only half the library owns. The reverse
       *  goes through the same `moveFrom` protocol as the forward one — so the same
       *  conditional directory move, the same destination name check, the same
       *  admissions — because a plain rename back would publish over whatever holds
       *  the source pathname now.
       *
       *  It is keyed on the dual identity this move COMMITTED, not on whatever the
       *  read model resolves at the new home now: an undo that accepted a different
       *  identity there would be carrying back a package it cannot prove is ours, and
       *  the whole reason it is running is that the identity at that address is not
       *  the committed one. Failing to prove it is the correct answer, not a gap.
       *
       *  `true` means the bytes are home again. */
      const reverseCommittedBytes = async (snapshot: RolePackageSnapshot): Promise<boolean> => {
        try {
          const reverted = await (
            await publisherAt(from)
          ).moveFrom(
            to,
            locator.packageId,
            {
              kind: snapshot.kind,
              registryNoteId: snapshot.registryNoteId,
              manifestNoteId: snapshot.manifestNoteId,
            },
            {
              beforeMove: async () => undefined,
              finalize: async () => undefined,
              rollback: async () => undefined,
            },
          )

          return reverted.status === 'moved'
        } catch (error) {
          if (isRolePackageMoveRollbackError(error)) {
            // `physicalMoveCommitted` is DIRECTIONAL: it says the transition this call
            // requested stayed at its own target — and the target of a reverse move is
            // the placement the package came from. So the bytes are home and only the
            // proof of it failed, which is exactly how the layer that raises the marker
            // reads its own reverse transition. Taking it for "still at the new home"
            // here is what left the reach row and the trail describing a placement the
            // package no longer occupies.
            console.error('[roles] role move undo landed without proof:', error.message)

            return true
          }
          console.error('[roles] failed to undo role move:', (error as Error).message)

          return false
        }
      }

      /** Undo a move whose physical transition is already committed. There is no
       *  transaction across a filesystem and a meta-DB, so the three effects come back
       *  in the order that leaves every FAILURE on a coherent state — "some of it" is
       *  the one outcome this operation may not leave behind. The trail — the ADDRESS
       *  — goes first, because nothing has moved yet and its refusal costs nothing;
       *  the bytes second, and if THEY refuse the address goes back onto them; the
       *  reach row last, so the row narrowing a Space-placed package outlives the
       *  package's stay there, the same order that keeps a promotion from widening.
       *
       *  `refused` means the package is still at its new home, whole — the "committed,
       *  undo impossible" outcome `rolePackageMoveRollbackError` already names for a
       *  failed finalize. `split` means a compensating step failed too and durable
       *  state is spread across both placements; reporting that as either of the other
       *  two would be a lie.
       *
       *  What `split` may NOT be is a dead end, and that is a property of the trail
       *  rather than of this order: the undo CANCELS the hop instead of writing a
       *  counter-hop, so the one step that can be interrupted here — putting the hop
       *  back after the bytes refused to come home — leaves both spellings unforwarded.
       *  The package then answers for itself at whichever placement it is standing at,
       *  which is the difference between state an owner can still rewrite and a role
       *  that is listed and unreachable through every door at once. */
      const undoCommittedMove = async (
        snapshot: RolePackageSnapshot,
      ): Promise<'undone' | 'refused' | 'split'> => {
        if (!(await carryPlacementTrail(snapshot, 'back'))) {
          return 'refused'
        }

        if (!(await reverseCommittedBytes(snapshot))) {
          return (await carryPlacementTrail(snapshot, 'forward')) ? 'refused' : 'split'
        }

        return (await restoreReach()) ? 'undone' : 'split'
      }
      let result

      try {
        result = await (
          await publisherAt(to)
        ).moveFrom(
          from,
          locator.packageId,
          {
            kind: locator.kind,
            registryNoteId: requestedTarget.registryNoteId,
            manifestNoteId: requestedTarget.manifestNoteId,
          },
          {
            beforeMove: async (snapshot) => {
              reachBefore = await abilityAvailability.get(space, locator.packageId)
              try {
                await abilityAvailability.set(
                  space,
                  locator.packageId,
                  availability,
                  snapshot.registryNoteId,
                )
              } catch (error) {
                await restoreReach()
                throw error
              }
            },
            finalize: async (snapshot) => {
              await abilityPlacement.moveOwnedRolePlacement({
                fromTargetId: roleContextTargetIdOf(from, locator.packageId),
                toTargetId: roleContextTargetIdOf(to, locator.packageId),
                fromLocator: serializeAbilityLocator(locator),
                toLocator: serializeAbilityLocator(moved),
                registryNoteId: snapshot.registryNoteId,
                manifestNoteId: snapshot.manifestNoteId,
                trail: 'record',
              })
            },
            rollback: async () => {
              await restoreReach()
            },
          },
        )
      } catch (error) {
        if (isRolePackageMoveRollbackError(error)) {
          console.error('[roles] failed to undo role move: source was reoccupied')
        }
        throw isRolePackageMoveRollbackError(error) ? error.cause : error
      }

      if (result.status === 'missing') {
        throw new AbilityUnavailableError('no such Owned Role')
      }
      let parsed: ParsedPackage

      try {
        parsed = parsePackage(result.snapshot.pkg)
      } catch {
        throw new AbilityUnavailableError('no such Owned Role')
      }
      const name = parsed.skill.name

      if (result.status === 'occupied') {
        throw new RoleAlreadyExistsError(`role "${name}" already exists in ${to.scope}`)
      }
      let noteIds: ReadonlyMap<string, string>

      try {
        noteIds = await library.awaitReadableNoteIds(to, [locator.packageId])
      } catch (error) {
        // The barrier itself refused to answer, and it runs AFTER the commit. Nothing
        // is undone: naming this "unavailable" would invite a retry that then races
        // the very package this call published — the outcome the Add path already
        // refuses to produce after ITS commit. What the caller must not lose is the
        // address, so the answer is typed and carries the new home, because that is
        // where the package now is and where the next read has to go.
        throw new RolePlacementUnconfirmedError(
          `role "${name}" moved to its ${to.scope}, but this deployment could not confirm it is readable there`,
          moved,
          error,
        )
      }
      const noteId = noteIds.get(locator.packageId)

      if (!noteId || noteId !== result.snapshot.registryNoteId) {
        // Fail-closed on a post-move projection mismatch. All three durable effects
        // have landed — the bytes at the new home, the reach row, the placement trail
        // — and the read model publishes an identity at that home which is NOT the one
        // this move committed. A partially committed move is not an outcome this
        // operation may leave behind, so every effect is undone before answering, and
        // the answer is a typed bounded failure rather than a bare 500.
        const failure = new RoleInstallUnavailableError(
          `role "${name}" could not be moved to its ${to.scope}`,
        )
        const undone = await undoCommittedMove(result.snapshot)

        // Same shape as the library-driven case above: the wire answer is the cause,
        // and the operator log is where the difference between a refused undo and a
        // half-landed one is recorded.
        if (undone === 'refused') {
          console.error('[roles] failed to undo role move: the new home could not be released')
        } else if (undone === 'split') {
          console.error(
            '[roles] failed to undo role move: durable state is split across placements',
          )
        }
        throw failure
      }

      return {
        locator: moved,
        target: {
          locator: moved,
          registryNoteId: result.snapshot.registryNoteId,
          manifestNoteId: result.snapshot.manifestNoteId,
        },
        availability,
        role: {
          ...summaryOf(parsed, to.scope),
          space,
          packageId: locator.packageId,
          noteId,
        },
      }
    },

    serializeOwnedRoleAttachments: async (principal, subject, attachments, personalSpace) => {
      const snapshot: OwnedAbilitySnapshot | null =
        'registryNoteId' in subject ? (subject as OwnedAbilitySnapshot) : null
      const locator = snapshot
        ? snapshot.locator
        : (subject as Extract<OwnedAbilityLocator, { kind: 'role' }>)
      const location = ownedPlacementOf(locator, personalSpace)

      if (!location || !can(principal, 'space:write', { space: location.space })) {
        throw new AbilityUnavailableError('Owned Role is unavailable to this principal')
      }
      let current: ParsedPackage | null

      try {
        current = snapshot
          ? parsePackage(snapshot.pkg)
          : await exactOwnedPackage(location, locator.packageId)
      } catch {
        current = null
      }

      if (!current?.skill.role) {
        throw new AbilityUnavailableError('no such Owned Role')
      }
      const remainingInvalid = new Map<string, number>()

      for (const link of current.skill.linkedSkills) {
        const raw =
          link.kind === 'invalid' ? link.raw : link.kind === 'name' ? `[[${link.name}]]` : null

        if (raw) {
          remainingInvalid.set(raw, (remainingInvalid.get(raw) ?? 0) + 1)
        }
      }
      for (const attachment of attachments) {
        if (attachment.kind !== 'invalid') {
          continue
        }
        const count = remainingInvalid.get(attachment.raw) ?? 0

        if (count <= 0) {
          throw new RoleDependencyConflictError('new invalid skill attachments are not allowed')
        }
        remainingInvalid.set(attachment.raw, count - 1)
      }
      const links = attachments.map((attachment) =>
        serializedAttachmentAt(location, personalSpace, attachment),
      )
      // Refused HERE, in the words of this domain, because the gate that would refuse it
      // three layers down knows nothing about attachments and answers a bare 400. The
      // read door deliberately carries every token the parser produces; writing is
      // narrower, and a package can therefore be readable and not re-writable. Saying so
      // — and naming the token — is the difference between "your package has a token this
      // format cannot store" and "invalid raw lines".
      const unwritable = unwritableSkillLinks(links)

      if (unwritable.length) {
        throw new RoleDependencyConflictError(
          `attachment cannot be written back to SKILL.md: ${unwritable.join(' ')}`,
        )
      }
      const currentRaw = Buffer.from(current.pkg.files.get('SKILL.md')!).toString('utf8')
      const candidateFile = withSkillLinks(currentRaw, links)
      const candidate = parsePackage({
        directoryName: current.pkg.directoryName,
        files: new Map(current.pkg.files).set('SKILL.md', Buffer.from(candidateFile)),
      })
      // Judged in every project this role covers, not just at its placement: a role
      // narrowed to two projects may depend on a skill that reaches those two, and
      // must not depend on one that misses either.
      const covered = coveredProjectsOf(
        location,
        (await abilityAvailability.get(location.space, locator.packageId)) ?? undefined,
      )

      for (const projectId of covered) {
        const health = await healthForRole(
          candidate,
          'owned',
          principal,
          location,
          personalSpace,
          projectId,
        )

        for (let index = 0; index < attachments.length; index++) {
          if (
            attachments[index]?.kind === 'exact' &&
            blocksAttachmentWrite(health.attachments[index]?.health)
          ) {
            throw new RoleDependencyConflictError(
              `skill attachment is ${health.attachments[index]?.health ?? 'invalid'}`,
            )
          }
        }
      }

      const noteId =
        snapshot?.registryNoteId ??
        (await library.readableNoteIds(location, [current.pkg.directoryName])).get(
          current.pkg.directoryName,
        )

      if (!noteId) {
        throw new AbilityUnavailableError('Owned Role has no readable registry identity')
      }

      return { links, noteId }
    },

    inspectAndRemoveOwned: async (target, personalSpace, options) => {
      const location = ownedPlacementOf(target.locator, personalSpace)

      if (!location) {
        return false
      }

      return library.inspectAndRemove(location, target.locator.packageId, {
        expected: {
          kind: target.locator.kind,
          registryNoteId: target.registryNoteId,
          manifestNoteId: target.manifestNoteId,
        },
        assertSafe: (pkg, members) => options.assertSafe(pkg.files, members),
        remove: options.remove,
      })
    },

    listBundledAbilities: async (principal) => {
      const owner = preferenceOwner(principal)
      const abilities: AgentAbilitySummary[] = []

      for (const parsed of await catalogPackages()) {
        const locator = bundledAbilityLocator(parsed)
        const base = {
          locator,
          title: parsed.skill.title,
          name: parsed.skill.name,
          description: parsed.skill.description,
        }

        abilities.push(
          locator.source === 'system'
            ? {
                ...base,
                locator,
                source: 'system',
                enabled: await abilityPreferences.isEnabled(owner, locator),
              }
            : { ...base, locator, source: 'catalog' },
        )
      }

      return abilities.sort(
        (left, right) =>
          left.name.localeCompare(right.name) ||
          left.locator.packageId.localeCompare(right.locator.packageId),
      )
    },

    listAbilityResolution: async (context, principal) => {
      const resolution = await abilityResolutionEntries(context, principal)
      const candidates: AbilityResolutionCandidate[] = resolution.candidates.map((entry) => {
        const facts = abilityFactsOf(entry.parsed)

        if (entry.source === 'system') {
          return entry.kind === ABILITY_KIND.role
            ? {
                ...facts,
                source: 'system',
                kind: 'role',
                locator: entry.locator as SystemAbilityLocator & { kind: 'role' },
                enabled: entry.enabled,
                effective: entry.effective,
                ...(entry.health ? { health: entry.health } : {}),
              }
            : {
                ...facts,
                source: 'system',
                kind: 'skill',
                locator: entry.locator as SystemAbilityLocator & { kind: 'skill' },
                enabled: entry.enabled,
                effective: entry.effective,
              }
        }

        return entry.kind === ABILITY_KIND.role
          ? {
              ...facts,
              source: 'owned',
              kind: 'role',
              locator: entry.locator as Extract<OwnedAbilityLocator, { kind: 'role' }>,
              location: entry.location,
              enabled: entry.enabled,
              effective: entry.effective,
              ...(entry.health ? { health: entry.health } : {}),
            }
          : {
              ...facts,
              source: 'owned',
              kind: 'skill',
              locator: entry.locator as Extract<OwnedAbilityLocator, { kind: 'skill' }>,
              location: entry.location as SkillHomeLocation,
              enabled: entry.enabled,
              effective: entry.effective,
            }
      })

      return { candidates, truncated: resolution.truncated }
    },

    listOwnedAbilitiesAt: async (location, principal, kind) => {
      if (!can(principal, 'space:read', { space: location.space })) {
        return { abilities: [], truncated: false }
      }
      const listing = await parsedAt(library, location)
      // A project library holds roles only, so asking it for skills is not an empty
      // answer by accident — it is the model saying there is nothing to hold.
      const packages = listing.packages.filter(
        ({ skill }) => skill.role === (kind === ABILITY_KIND.role),
      )
      const noteIds = await library.readableNoteIds(
        location,
        packages.map(({ pkg }) => pkg.directoryName),
      )
      const availability =
        location.scope === ROLE_SCOPE.space
          ? new Map(
              (await abilityAvailability.listForSpace(location.space)).map((record) => [
                record.packageId,
                record,
              ]),
            )
          : undefined
      const owner = preferenceOwner(principal)
      const withAddress = packages
        .filter((parsed) => noteIds.has(parsed.pkg.directoryName))
        .map((parsed) => ({ parsed, locator: ownedAbilityLocator(location, parsed) }))
        .filter(
          (entry): entry is { parsed: ParsedPackage; locator: OwnedAbilityLocator } =>
            entry.locator != null,
        )
      const listed = withAddress.map(({ parsed }) => parsed)
      const locators = withAddress.map(({ locator }) => locator)
      // One question for the whole page. Asked per package this is the listing's
      // dominant cost: a full discovery window is up to MAX_LIBRARY_PACKAGES rows.
      const disabled = await abilityPreferences.disabled(owner, locators)
      const abilities: OwnedAbilityInventoryEntry[] = []

      for (const [index, parsed] of listed.entries()) {
        const noteId = noteIds.get(parsed.pkg.directoryName)!
        const locator = locators[index]!
        const wireAvailability = abilityAvailabilityOf(
          availability?.get(parsed.pkg.directoryName),
          parsed.skill.role ? 'role' : 'skill',
        )
        const spaceHome = location.scope === ROLE_SCOPE.space
        abilities.push({
          ability: {
            locator,
            source: 'owned',
            title: parsed.skill.title,
            name: parsed.skill.name,
            description: parsed.skill.description,
            noteId,
            origin: hasCatalogProvenance(parsed.skill) ? 'catalog' : 'custom',
            ...(hasCatalogProvenance(parsed.skill)
              ? { originRevision: parsed.skill.metadata['notarium.originRevision'] }
              : {}),
            enabled: !disabled.has(serializeAbilityLocator(locator)),
            ...(spaceHome ? { availability: wireAvailability } : {}),
          },
          ...(spaceHome ? { availability: wireAvailability } : {}),
        })
      }

      return {
        abilities: abilities.sort(
          (left, right) =>
            left.ability.name.localeCompare(right.ability.name) ||
            left.ability.locator.packageId.localeCompare(right.ability.locator.packageId),
        ),
        truncated: listing.truncated || noteIds.size < packages.length,
      }
    },

    hasSystemAbility: async (kind, name) =>
      (await systemPackages()).some(
        ({ skill }) => skill.name === name && skill.role === (kind === ABILITY_KIND.role),
      ),
    hasOwnedAbilityAt: (location, name, options) => library.exists(location, name, options),
    prepareCustomSkill: (name, description, instructions) =>
      customPackage(name, description, instructions, false),
    prepareCustomRole,
    manifestPath: (location, packageId) => library.manifestPath(location, packageId),
    withCreateAdmission: (location, packageId, task, options) =>
      library.withCreateAdmission(location, packageId, task, options),

    hasCatalog: async (name) => (await catalogPackageOf(name, ABILITY_KIND.role)) != null,

    hasCatalogSkill: async (name) => (await catalogPackageOf(name, ABILITY_KIND.skill)) != null,

    listEffective: async (context, principal) => {
      const listing = await effectiveRoleEntries(context, principal)
      const roles = [...listing.entries.values()].map(effectiveSummaryOf)

      return {
        roles: roles.sort((left, right) => left.name.localeCompare(right.name)),
        truncated: listing.truncated,
      }
    },

    resolveEffective: async (context, principal, name) => {
      const hit = await effectiveRoleNamed(
        readableLocationsFor(context, principal),
        principal,
        name,
        context.project?.id,
      )

      if (!hit) {
        return null
      }
      const packageId = hit.parsed.pkg.directoryName
      const locator = activeRoleLocatorOf(hit)

      return hit.source === 'system'
        ? {
            source: 'system',
            role: { source: 'system', ...abilityFactsOf(hit.parsed) },
            packageId,
            locator,
          }
        : {
            source: 'owned',
            role: { source: 'owned', ...abilityFactsOf(hit.parsed), scope: hit.location.scope },
            location: hit.location,
            packageId,
            locator,
          }
    },

    addressedRoleAt: async (locator, principal, personalSpace) => {
      const hit = await addressedOwnedRole(locator, principal, personalSpace)

      return hit ? resolvedOwnedRoleOf(hit.location, hit.parsed) : null
    },

    addressedRoleStatus,

    effectiveRoleAt: async (context, principal, locator) => {
      const status = await addressedRoleStatus(context, principal, locator)

      return status?.active ? status.role : null
    },

    resolveSavedRole: async (context, principal, locator) => {
      const candidate = await savedRoleCandidate(context, principal, locator)

      if ('ok' in candidate) {
        return null
      }

      return (await entryHealth(candidate, context, principal)).healthy
        ? resolvedRoleOf(candidate)
        : null
    },

    loadSavedRole: async (context, principal, locator, budgetTokens) => {
      const candidate = await savedRoleCandidate(context, principal, locator)

      if ('ok' in candidate) {
        return candidate
      }
      const outcome = await loadEffectiveEntry(candidate, context, principal, budgetTokens)

      if (!outcome.loaded) {
        return failedCandidate(candidate, context, principal, 'unhealthy', outcome.health)
      }
      const resolved = resolvedRoleOf(candidate)
      const instructions = outcome.loaded.role.instructions

      const loaded: LoadedEffectiveRole =
        resolved.source === 'system'
          ? {
              source: 'system',
              role: { ...resolved.role, instructions },
              skills: outcome.loaded.skills,
              truncated: outcome.loaded.truncated,
              packageId: resolved.packageId,
              locator: resolved.locator,
            }
          : {
              source: 'owned',
              role: { ...resolved.role, instructions },
              skills: outcome.loaded.skills,
              truncated: outcome.loaded.truncated,
              location: resolved.location,
              packageId: resolved.packageId,
              locator: resolved.locator,
            }

      return { ok: true, loaded, health: outcome.health }
    },

    loadEffective: async (context, principal, name, budgetTokens) => {
      const locations = readableLocationsFor(context, principal)
      const selection = await selectAbilityForLoad(
        locations,
        principal,
        ABILITY_KIND.role,
        name,
        context.project?.id,
      )

      if (selection.kind !== 'active') {
        return failedSelection(selection, context, principal)
      }
      const hit = selection.candidate
      const outcome = await loadEffectiveEntry(hit, context, principal, budgetTokens)

      if (!outcome.loaded) {
        return failedCandidate(hit, context, principal, 'unhealthy', outcome.health)
      }
      const { loaded } = outcome
      const packageId = hit.parsed.pkg.directoryName
      const locator = activeRoleLocatorOf(hit)
      const instructions = loaded.role.instructions

      const resolved: LoadedEffectiveRole =
        hit.source === 'system'
          ? {
              source: 'system',
              role: { source: 'system', ...abilityFactsOf(hit.parsed), instructions },
              skills: loaded.skills,
              truncated: loaded.truncated,
              packageId,
              locator,
            }
          : {
              source: 'owned',
              role: {
                source: 'owned',
                ...abilityFactsOf(hit.parsed),
                scope: hit.location.scope,
                instructions,
              },
              skills: loaded.skills,
              truncated: loaded.truncated,
              location: hit.location,
              packageId,
              locator,
            }

      return { ok: true, loaded: resolved, health: outcome.health }
    },

    loadEffectiveSkill: async (context, principal, name, budgetTokens) => {
      const selection = await selectAbilityForLoad(
        readableLocationsFor(context, principal),
        principal,
        ABILITY_KIND.skill,
        name,
        context.project?.id,
      )

      if (selection.kind !== 'active') {
        return failedSelection(selection, context, principal)
      }
      const hit = selection.candidate
      const requiredTokens = instructionTokens(hit.parsed.skill.instructions)

      if (requiredTokens > budgetTokens) {
        throw new SkillTooLargeForActivationError(requiredTokens, budgetTokens)
      }
      const facts = {
        kind: ABILITY_KIND.skill,
        name: hit.parsed.skill.name,
        title: hit.parsed.skill.title,
        description: hit.parsed.skill.description,
      } as const

      const loaded: LoadedEffectiveSkill | null =
        hit.source === 'system'
          ? {
              packageId: hit.locator.packageId,
              locator: hit.locator,
              skill: {
                ...facts,
                source: 'system',
                instructions: hit.parsed.skill.instructions,
              },
            }
          : hit.location.scope === ROLE_SCOPE.project
            ? null
            : {
                packageId: hit.locator.packageId,
                locator: hit.locator,
                skill: {
                  ...facts,
                  source: 'owned',
                  scope: hit.location.scope,
                  instructions: hit.parsed.skill.instructions,
                },
              }

      return loaded
        ? { ok: true, loaded }
        : {
            ok: false,
            reason: 'not-found',
            remediation: [{ kind: 'list-abilities', view: 'runtime' }],
          }
    },

    addFromCatalog: async (name, location, personalSpace) => {
      const release = await acquireAddFence(location, name)

      try {
        const role = await catalogPackageOf(name, ABILITY_KIND.role)

        if (!role) {
          throw new CatalogRoleNotFoundError(`no such catalog role: ${name}`)
        }
        if (await library.exists(location, name)) {
          throw new RoleAlreadyExistsError(`role "${name}" already exists in ${location.scope}`)
        }
        const dependencies = await Promise.all(
          role.skill.linkedSkills.map(async (link) => {
            if (link.kind !== 'name') {
              throw new Error(`catalog role "${name}" contains an owned skill locator`)
            }
            const dependency = await catalogPackageOf(link.name, ABILITY_KIND.skill)

            if (!dependency) {
              throw new Error(`catalog role "${name}" links missing skill "${link.name}"`)
            }

            return dependency
          }),
        )

        // Add is a fork of one coherent catalog bundle. A matching owned lineage is
        // reused even after the owner renames/edits it; a same-name unrelated package
        // remains a conflict instead of silently changing the role dependency.
        const dependencyLocation = homeOf(addressed(location), personalSpace)

        const compatibleDependency = async (
          parsed: ParsedPackage,
          pkg: SkillPackage,
        ): Promise<SkillPackage | null> => {
          let existing: SkillPackage | null

          try {
            existing = await library.get(dependencyLocation, parsed.skill.name)
          } catch (err) {
            if (err instanceof InvalidSkillPackageError) {
              throw new RoleDependencyConflictError(
                `linked skill "${parsed.skill.name}" already exists with invalid content in ${dependencyLocation.scope}`,
              )
            }
            throw err
          }

          const matchingPackages: ParsedPackage[] = []

          for (const candidate of (await parsedAt(library, dependencyLocation)).packages) {
            if (!candidate.skill.role && sameCatalogLineage(candidate.pkg, parsed)) {
              matchingPackages.push(candidate)
            }
          }
          if (matchingPackages.length > 1) {
            throw new RoleDependencyConflictError(
              `linked skill "${parsed.skill.name}" has multiple owned catalog forks in ${dependencyLocation.scope}`,
            )
          }
          if (matchingPackages[0]) {
            existing = await library.getByDirectory(
              dependencyLocation,
              matchingPackages[0].pkg.directoryName,
            )
          }

          if (!existing) {
            return null
          }

          if (!packagesEqual(existing, pkg) && !sameCatalogLineage(existing, parsed)) {
            throw new RoleDependencyConflictError(
              `linked skill "${parsed.skill.name}" already exists with different content in ${dependencyLocation.scope}`,
            )
          }

          return existing
        }

        // Conflicts first, all of them, and they still answer 409: a dependency
        // that already exists with other content is the user's problem to resolve,
        // not a capability the host is missing.
        const planned = []

        for (const parsed of dependencies) {
          const pkg = forkCatalogPackage(parsed)

          planned.push({ parsed, pkg, existing: await compatibleDependency(parsed, pkg) })
        }
        // Only then the placements — and both of them, before the first write.
        // Resolving them later, one at a time, is how a Project Add published its
        // Space dependencies and only then discovered it could not publish the role.
        const [dependencyPublisher, rolePublisher] = await placementPublishers(
          dependencyLocation,
          location,
        )
        const installedDependencies: SkillPackage[] = []

        for (const { parsed, pkg, existing } of planned) {
          if (existing) {
            installedDependencies.push(existing)
            continue
          }
          let added: boolean

          try {
            added = await dependencyPublisher.putIfAbsent(pkg)
          } catch (error) {
            if ((error as { code?: string }).code !== 'SKILL_NAME_CONFLICT') {
              throw error
            }
            // The authority caught a placement-wide name race. Treat it like its
            // direct-FS `false` twin so an identical catalog fork may still be
            // reused; `compatibleDependency` turns every other occupant into the
            // stable dependency conflict this operation owns.
            added = false
          }

          const raced = added ? null : await compatibleDependency(parsed, pkg)

          if (!added && !raced) {
            throw new RoleDependencyConflictError(
              `linked skill "${parsed.skill.name}" could not be installed in ${dependencyLocation.scope}`,
            )
          }
          installedDependencies.push(added ? pkg : raced!)
        }

        // The dependencies are on disk; their identities are what the projection made
        // of them. Asked once for the whole set, on the side they were installed.
        const dependencyNoteIds = await library.readableNoteIds(
          dependencyLocation,
          installedDependencies.map((dependency) => dependency.directoryName),
        )

        // Grants are part of dependency-first partial persistence. A later role
        // failure leaves completed packages and grants in place, so a retry or a
        // concurrent Add can reuse them without erasing another successful Add.
        for (const dependency of installedDependencies) {
          const registryNoteId = dependencyNoteIds.get(dependency.directoryName) ?? null

          if (location.scope === ROLE_SCOPE.project && location.projectId) {
            await abilityAvailability.grantProject(
              location.space,
              dependency.directoryName,
              location.projectId,
              registryNoteId,
            )
          } else if (dependencyLocation.scope === ROLE_SCOPE.space) {
            await abilityAvailability.set(
              location.space,
              dependency.directoryName,
              { mode: ABILITY_AVAILABILITY_MODE.allProjects },
              registryNoteId,
            )
          }
        }

        const rolePackage = forkCatalogPackage(
          role,
          installedDependencies.map((dependency, index) =>
            serializeSkillLocator({
              scope: dependencyLocation.scope,
              packageId: dependency.directoryName,
              label: dependencies[index]!.skill.name,
            }),
          ),
        )
        let added: boolean

        try {
          added = await rolePublisher.putIfAbsent(rolePackage)
        } catch (error) {
          if ((error as { code?: string }).code !== 'SKILL_NAME_CONFLICT') {
            throw error
          }
          throw new RoleAlreadyExistsError(`role "${name}" already exists in ${location.scope}`)
        }

        if (!added) {
          throw new RoleAlreadyExistsError(`role "${name}" already exists in ${location.scope}`)
        }

        const installed = await library.get(location, name)

        if (!installed) {
          throw new Error(`role "${name}" was not installed`)
        }
        const [, readableRoles] = await Promise.all([
          library.awaitReadableNoteIds(
            dependencyLocation,
            installedDependencies.map((dependency) => dependency.directoryName),
          ),
          library.awaitReadableNoteIds(location, [installed.directoryName]),
        ])
        const noteId = readableRoles.get(installed.directoryName)

        if (!noteId) {
          throw new Error(`role "${name}" was published without a readable note identity`)
        }
        // A Space home starts where a Space role has always acted: everywhere in its
        // Space. Narrowing is an explicit act, not the shape a role arrives in.
        const availability =
          location.scope === ROLE_SCOPE.space
            ? { mode: ABILITY_AVAILABILITY_MODE.allProjects }
            : undefined

        if (availability) {
          await abilityAvailability.set(
            location.space,
            rolePackage.directoryName,
            availability,
            noteId,
          )
        }

        return {
          ...summaryOf(parsePackage(installed), location.scope),
          space: location.space,
          ...(location.projectId ? { projectId: location.projectId } : {}),
          ...(availability ? { availability } : {}),
          packageId: rolePackage.directoryName,
          noteId,
        }
      } finally {
        release()
      }
    },

    addSkillFromCatalog: async (name, location, availability) => {
      const skill = await catalogPackageOf(name, ABILITY_KIND.skill)

      if (!skill) {
        throw new CatalogSkillNotFoundError(`no such catalog skill: ${name}`)
      }
      const pkg = forkCatalogPackage(skill)

      if (await library.exists(location, name)) {
        throw new SkillAlreadyExistsError(`skill "${name}" already exists in ${location.scope}`)
      }
      const noteId = await publishOwnedPackage(
        location,
        await publisherAt(location),
        pkg,
        () => new SkillAlreadyExistsError(`skill "${name}" already exists in ${location.scope}`),
      )
      const resolvedAvailability =
        location.scope === ROLE_SCOPE.space
          ? (availability ?? { mode: ABILITY_AVAILABILITY_MODE.allProjects })
          : undefined

      if (resolvedAvailability) {
        await abilityAvailability.set(
          location.space,
          pkg.directoryName,
          resolvedAvailability,
          noteId,
        )
      }
      const installed = await library.getByDirectory(location, pkg.directoryName)

      if (!installed) {
        throw new Error(`skill "${name}" was not installed`)
      }

      return {
        ...summaryOf(parsePackage(installed), location.scope),
        scope: location.scope,
        space: location.space,
        ...(resolvedAvailability ? { availability: resolvedAvailability } : {}),
        packageId: pkg.directoryName,
        noteId,
      }
    },

    createCustomSkill: async (
      name,
      description,
      instructions,
      location,
      availability,
    ): Promise<PublishedSkillInventoryEntry> => {
      let pkg = customPackage(name, description, instructions, false)

      if (await library.exists(location, name)) {
        throw new SkillAlreadyExistsError(`skill "${name}" already exists in ${location.scope}`)
      }
      const resolvedAvailability =
        location.scope === ROLE_SCOPE.space
          ? (availability ?? { mode: ABILITY_AVAILABILITY_MODE.allProjects })
          : undefined
      let reserved = false

      if (resolvedAvailability) {
        for (;;) {
          reserved = await abilityAvailability.reserve(
            location.space,
            pkg.directoryName,
            resolvedAvailability,
          )
          if (reserved) {
            break
          }
          pkg = customPackage(name, description, instructions, false)
        }
      }
      let noteId: string

      try {
        noteId = await publishOwnedPackage(
          location,
          await publisherAt(location),
          pkg,
          () => new SkillAlreadyExistsError(`skill "${name}" already exists in ${location.scope}`),
        )
      } catch (error) {
        if (reserved) {
          await abilityAvailability.cancel(location.space, pkg.directoryName)
        }
        throw error
      }

      if (resolvedAvailability) {
        if (!(await abilityAvailability.finalize(location.space, pkg.directoryName, noteId))) {
          throw new Error('ability availability reservation could not be finalized')
        }
      }

      return {
        name,
        title: parsePackage(pkg).skill.title,
        description,
        scope: location.scope,
        space: location.space,
        ...(resolvedAvailability ? { availability: resolvedAvailability } : {}),
        packageId: pkg.directoryName,
        noteId,
      }
    },

    createCustomRole: async (
      name,
      description,
      instructions,
      location,
      options = {},
    ): Promise<PublishedRoleInventoryEntry> => {
      if (!options.principal && options.attachments?.length) {
        throw new RoleDependencyConflictError('skill attachments require a principal')
      }
      const makePackage = () =>
        options.principal
          ? prepareCustomRole(name, description, instructions, location, {
              principal: options.principal,
              ...(options.attachments ? { attachments: options.attachments } : {}),
              ...(options.availability ? { availability: options.availability } : {}),
              ...(options.personalSpace !== undefined
                ? { personalSpace: options.personalSpace }
                : {}),
            })
          : Promise.resolve(customPackage(name, description, instructions, true))
      let pkg = await makePackage()
      const availability =
        location.scope === ROLE_SCOPE.space
          ? (options.availability ?? { mode: ABILITY_AVAILABILITY_MODE.allProjects })
          : undefined
      const reservation = location.scope === ROLE_SCOPE.space ? options.availability : undefined

      if (await library.exists(location, name)) {
        throw new RoleAlreadyExistsError(`role "${name}" already exists in ${location.scope}`)
      }
      // Resolve the writer before reach becomes durable. An incomplete authority
      // view is a composition refusal and must leave no orphan availability row.
      const publisher = await publisherAt(location)

      // Explicit reach is reserved before publication. An unstated Space Role keeps
      // its historical absent-row=all-projects default and needs no policy row.
      let reserved = false

      if (reservation) {
        for (;;) {
          reserved = await abilityAvailability.reserve(
            location.space,
            pkg.directoryName,
            reservation,
          )
          if (reserved) {
            break
          }
          pkg = await makePackage()
        }
      }
      let noteId: string

      try {
        noteId = await publishOwnedPackage(
          location,
          publisher,
          pkg,
          () => new RoleAlreadyExistsError(`role "${name}" already exists in ${location.scope}`),
        )
      } catch (error) {
        if (reserved) {
          await abilityAvailability.cancel(location.space, pkg.directoryName)
        }
        throw error
      }

      // The reservation knew only the package id; publication supplies the actual
      // registry note id, which claim arbitration may make different.
      if (reservation) {
        if (!(await abilityAvailability.finalize(location.space, pkg.directoryName, noteId))) {
          throw new Error('ability availability reservation could not be finalized')
        }
      }

      return {
        name,
        title: parsePackage(pkg).skill.title,
        description,
        scope: location.scope,
        space: location.space,
        ...(location.projectId ? { projectId: location.projectId } : {}),
        ...(availability ? { availability } : {}),
        packageId: pkg.directoryName,
        noteId,
      }
    },
  }
}
