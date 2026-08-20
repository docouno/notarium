import { Buffer } from 'node:buffer'

import {
  ABILITY_ATTACHMENT_HEALTH,
  ABILITY_AVAILABILITY_MODE,
  ABILITY_KIND,
  type AbilityAttachmentHealth,
  type AbilityAttachmentState,
  type AbilityHealth,
  type AgentAbilitySummary,
  type AuthoredAttachment,
  type CatalogAbilityLocator,
  type OwnedAbilityLocator,
  type SystemAbilityLocator,
} from '@notarium/contract'
import {
  freshNoteId,
  frontmatterScalar,
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
  SkillAlreadyExistsError,
} from './errors'
import {
  InvalidSkillPackageError,
  type RoleLibrary,
  type SkillPackage,
  validateSkillPackage,
} from './library'
import {
  authoredSkillFile,
  bundledAbilityIdentityOf,
  hasCatalogProvenance,
  packageRevision,
  parseSkillFile,
  unwritableSkillLinks,
  withCatalogProvenance,
  withFreshNoteId,
  withSkillLinks,
} from './skillFile'
import {
  type ActiveRoleLocator,
  type AddressedPlacement,
  type AddressedProjectPlacement,
  type AddressedRoleStatus,
  type EffectiveRoleContext,
  type EffectiveRoleSummary,
  type LoadedRole,
  type LoadedSkill,
  type OwnedAbilityInventoryEntry,
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

  return {
    pkg,
    skill: parseSkillFile(Buffer.from(file).toString('utf8'), pkg.directoryName),
  }
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

/** What a package says about itself, with no placement in it. Split out because a
 *  System role has these facts and no scope at all. */
const roleFactsOf = (parsed: ParsedPackage): Omit<RoleSummary, 'scope'> => {
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
    ...roleFactsOf(parsed),
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
const ROLE_BUNDLE_OVERHEAD_CHARS = 96
const SKILL_BUNDLE_OVERHEAD_CHARS = 64

const loadParsedSkill = (
  parsed: ParsedPackage,
  scope: RoleSummary['scope'],
  budgetTokens: number,
): LoadedSkill => {
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
  const fixed = SKILL_BUNDLE_OVERHEAD_CHARS + summary.name.length + summary.scope.length

  if (fixed > remaining) {
    truncated = true
    remaining = 0
  } else {
    remaining -= fixed
  }

  return {
    skill: {
      ...summary,
      description: take(summary.description),
      instructions: take(parsed.skill.instructions),
    },
    truncated,
  }
}

const loadParsedRole = async (
  parsed: ParsedPackage,
  scope: RoleSummary['scope'],
  dependency: (link: SkillLink) => Promise<ParsedPackage | undefined>,
  budgetTokens: number,
): Promise<LoadedRole> => {
  let remaining = tokenChars(budgetTokens)
  let truncated = false

  const charge = (characters: number): boolean => {
    if (characters > remaining) {
      truncated = true
      remaining = 0
      return false
    }
    remaining -= characters
    return true
  }

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
  charge(
    ROLE_BUNDLE_OVERHEAD_CHARS +
      summary.name.length +
      summary.scope.length +
      (summary.origin?.length ?? 0) +
      (summary.originRevision?.length ?? 0),
  )
  const description = take(summary.description)
  const roleInstructions = take(parsed.skill.instructions)
  const skills: LoadedRole['skills'] = []

  for (const link of parsed.skill.linkedSkills) {
    const label = link.kind === 'name' ? link.name : link.kind === 'locator' ? link.label : link.raw

    if (remaining <= SKILL_BUNDLE_OVERHEAD_CHARS + label.length) {
      truncated = true
      break
    }
    const linked = (await dependency(link))?.skill

    if (!linked || linked.role) {
      continue
    }
    if (!charge(SKILL_BUNDLE_OVERHEAD_CHARS + linked.name.length) || !remaining) {
      truncated = true
      break
    }
    const linkedDescription = take(linked.description)
    skills.push({
      name: linked.name,
      title: linked.title,
      description: linkedDescription,
      instructions: take(linked.instructions),
    })
  }

  return {
    role: { ...summary, description, instructions: roleInstructions },
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
  abilityAvailability,
  abilityPreferences,
  abilityPlacement,
}: {
  catalog: () => Promise<SkillPackage[]>
  library: RoleLibrary
  /** REQUIRED to pass: every composition root states which persistence it built on.
   *  `inMemoryAbilityPersistence()` spells the answer for a host that has none. */
  abilityAvailability: AbilityAvailabilityPersistence
  abilityPreferences: AbilityPreferencesPersistence
  abilityPlacement: AbilityPlacementPersistence
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
    role: { source: 'owned', ...roleFactsOf(parsed), scope: location.scope },
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

  /** The System counterpart of `activeOwnedRoleAt`. A System package has no placement
   *  and no reach, so the owner's preference row is the whole gate. */
  const activeSystemRole = async (parsed: ParsedPackage, principal: Principal): Promise<boolean> =>
    parsed.skill.role &&
    (await abilityPreferences.isEnabled(preferenceOwner(principal), systemRoleLocator(parsed)))

  const effectiveRoleEntries = async (
    context: EffectiveRoleContext,
    principal: Principal,
  ): Promise<{
    entries: Map<string, EffectiveRoleEntry>
    truncated: boolean
  }> => {
    const effective = new Map<string, EffectiveRoleEntry>()
    const owner = preferenceOwner(principal)
    let truncated = false

    // System is the broadest source there is, so it is seeded first and any Owned
    // placement of the same name overrides it — `Owned Project > Space > Personal > System`.
    for (const parsed of await systemPackages()) {
      if (await activeSystemRole(parsed, principal)) {
        effective.set(parsed.skill.name, { source: 'system', parsed })
      }
    }

    // Ordered general → specific. A same-name package in a narrower scope wins.
    for (const location of readableLocationsFor(context, principal)) {
      const listing = await parsedAt(library, location)
      truncated ||= listing.truncated
      const roles = listing.packages.filter((parsed) => parsed.skill.role)

      if (!roles.length) {
        continue
      }
      // One question per LOCATION, not per package: this runs on every discovery and
      // on every MCP activation, over a window of up to MAX_LIBRARY_PACKAGES.
      const reach = await reachAt(location)
      const candidates = roles.filter((parsed) =>
        coversProject(location, reach?.get(parsed.pkg.directoryName), context.project?.id),
      )
      const locators = candidates.map((parsed) =>
        ownedRoleLocator(location, parsed.pkg.directoryName),
      )
      const disabled = await abilityPreferences.disabled(owner, locators)

      for (const [index, parsed] of candidates.entries()) {
        if (!disabled.has(serializeAbilityLocator(locators[index]!))) {
          effective.set(parsed.skill.name, { source: 'owned', parsed, location })
        }
      }
    }

    return { entries: effective, truncated }
  }

  /** What makes an Owned package answerable AS A ROLE at a placement the caller can
   * already reach: it is a role at all, the Space reach covers the project being asked
   * about, and the owner has not turned it off. One producer, because the two entries
   * that need it — activation BY NAME and resume BY EXACT PACKAGE — each answered it
   * separately and stopped agreeing: resume never asked reach at all, so a role the
   * owner had narrowed away from a project still resumed there. */
  const activeOwnedRoleAt = async (
    location: AddressedPlacement,
    parsed: ParsedPackage,
    principal: Principal,
    projectId: string | undefined,
  ): Promise<boolean> =>
    parsed.skill.role &&
    (await availableAt(location, parsed.pkg.directoryName, projectId)) &&
    (await abilityPreferences.isEnabled(
      preferenceOwner(principal),
      ownedRoleLocator(location, parsed.pkg.directoryName),
    ))

  const directEnabledOwnedRole = async (
    locations: readonly AddressedPlacement[],
    principal: Principal,
    name: string,
    projectId?: string,
  ): Promise<{ parsed: ParsedPackage; location: AddressedPlacement } | null> => {
    // Exact activation is not constrained by the bounded discovery window.
    // Search narrowest → broadest, mirroring effectivePackages precedence.
    for (const location of [...locations].reverse()) {
      const pkg = await library.getSkill(location, name)

      if (!pkg) {
        continue
      }
      try {
        const parsed = parsePackage(pkg)

        if (await activeOwnedRoleAt(location, parsed, principal, projectId)) {
          return { parsed, location }
        }
      } catch (err) {
        console.warn(
          `[roles] ignoring invalid ${location.scope} package ${name}:`,
          (err as Error).message,
        )
      }
    }

    return null
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
    const owned = await directEnabledOwnedRole(locations, principal, name, projectId)

    if (owned) {
      return { source: 'owned', parsed: owned.parsed, location: owned.location }
    }
    const system = (await systemPackages()).find(({ skill }) => skill.role && skill.name === name)

    return system && (await activeSystemRole(system, principal))
      ? { source: 'system', parsed: system }
      : null
  }

  const effectiveSummaryOf = (entry: EffectiveRoleEntry): EffectiveRoleSummary =>
    entry.source === 'system'
      ? { source: 'system', ...roleFactsOf(entry.parsed) }
      : { source: 'owned', ...roleFactsOf(entry.parsed), scope: entry.location.scope }

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

  const healthForRole = async (
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
  ): Promise<AbilityHealth> => {
    const owner = preferenceOwner(principal)
    const attachments: AbilityAttachmentState[] = []

    for (const link of parsed.skill.linkedSkills) {
      if (link.kind === 'invalid' || link.kind === 'name') {
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

      if (locator && can(principal, 'space:read', { space: dependencyLocation!.space })) {
        const dependency = await exactOwnedPackage(dependencyLocation!, link.packageId)

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
    }

    return {
      healthy: attachments.every(({ health }) => health === ABILITY_ATTACHMENT_HEALTH.healthy),
      attachments,
    }
  }

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

  const publishOwnedPackage = async (
    location: RoleHomeLocation,
    pkg: SkillPackage,
    conflict: () => Error,
  ): Promise<string> => {
    try {
      if (!(await library.putIfAbsent(location, pkg))) {
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

  /** Does this saved binding still ADDRESS an effective role in THIS context — is the
   *  placement still reachable from here, does the package still exist, is it still
   *  enabled and still in reach? One producer because the REST surface answered it by
   *  hand and disagreed with resume: it judged reach by SPACE alone, so a role the
   *  owner had narrowed away from the project was still drawn as active there while
   *  `start_session` refused to raise it.
   *
   *  Soundness is the OTHER half and lives in `entryHealth`; resume applies both, so
   *  any surface reporting a binding as live must apply both too. */
  const savedRoleEntry = async (
    context: EffectiveRoleContext,
    principal: Principal,
    locator: ActiveRoleLocator,
  ): Promise<EffectiveRoleEntry | null> => {
    if (locator.source === 'system') {
      const parsed = await systemPackageById(locator.packageId)

      return parsed && (await activeSystemRole(parsed, principal))
        ? { source: 'system', parsed }
        : null
    }
    const placement = ownedPlacementOf(locator, context.personalSpace)
    // A binding is only still a binding where the CURRENT context reaches it. The
    // chain is the one list of placements this context can see, so asking it here
    // is the same question resolution asks — not a fifth hand-written copy of it.
    const location = locationsFor(context).find(
      (entry) =>
        placement != null &&
        entry.scope === placement.scope &&
        entry.space === placement.space &&
        entry.projectId === placement.projectId,
    )

    if (!location || !can(principal, 'space:read', { space: location.space })) {
      return null
    }
    const role = await exactOwnedPackage(location, locator.packageId)

    return role && (await activeOwnedRoleAt(location, role, principal, context.project?.id))
      ? { source: 'owned', parsed: role, location }
      : null
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
          role: { source: 'system', ...roleFactsOf(entry.parsed) },
          packageId,
          locator,
        }
      : {
          source: 'owned',
          role: { source: 'owned', ...roleFactsOf(entry.parsed), scope: entry.location.scope },
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
    locations: readonly AddressedPlacement[],
    budgetTokens: number,
  ) => {
    const health = await entryHealth(entry, context, principal)

    if (!health.healthy) {
      return null
    }
    const loaded = await loadParsedRole(
      entry.parsed,
      // A System package is not placed; the scope here only labels the summary that
      // `loadParsedRole` builds, and the caller replaces it with the source union.
      entry.source === 'system' ? ROLE_SCOPE.catalog : entry.location.scope,
      async (link) =>
        link.kind === 'locator' && link.source === 'system'
          ? ((await systemPackageById(link.packageId)) ?? undefined)
          : entry.source === 'system'
            ? undefined
            : linkedAt(link, locations, context.personalSpace, context.project?.id),
      budgetTokens,
    )

    return { loaded, health }
  }

  return {
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
          : loadParsedSkill(parsed, ROLE_SCOPE.catalog, budgetTokens)
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
          : loadParsedSkill(parsed, ROLE_SCOPE.catalog, budgetTokens)
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

      if (!location) {
        return null
      }
      const parsed = await exactOwnedPackage(location, locator.packageId)

      if (!parsed || parsed.skill.role !== (locator.kind === 'role')) {
        return null
      }
      const enabled = await abilityPreferences.isEnabled(owner, locator)
      const noteIds = await library.readableNoteIds(location, [locator.packageId])
      const noteId = noteIds.get(locator.packageId)

      if (!noteId) {
        return null
      }
      const loaded = parsed.skill.role
        ? await loadParsedRole(
            parsed,
            location.scope,
            async (link) =>
              link.kind === 'locator' && link.source === 'system'
                ? ((await systemPackageById(link.packageId)) ?? undefined)
                : // Scoped to THIS role's own placement, the way activation scopes it.
                  // Handed the reader's readable chain instead, a personal dependency
                  // would be looked up in the READER's personal library — so what a
                  // shared role appears to be made of would depend on who opened it.
                  linkedAt(
                    link,
                    [homeOf(location, context.personalSpace)],
                    context.personalSpace,
                    location.projectId ?? context.project?.id,
                  ),
            budgetTokens,
          )
        : loadParsedSkill(parsed, location.scope, budgetTokens)
      const item = 'role' in loaded ? loaded.role : loaded.skill
      const reach = await abilityAvailability.get(location.space, locator.packageId)
      return {
        locator,
        source: 'owned' as const,
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
    },

    setEnabled: async (context, principal, locator, enabled) => {
      const owner = preferenceOwner(principal)

      if (locator.source === 'system') {
        const parsed = await systemPackageById(locator.packageId)

        if (!parsed || parsed.skill.role !== (locator.kind === 'role')) {
          throw new AbilityUnavailableError('no such System ability')
        }
        await abilityPreferences.setEnabled(owner, { locator }, enabled, new Date().toISOString())
        return
      }
      const location = exactLocationIn(context, principal, locator)

      if (!location) {
        throw new AbilityUnavailableError('Owned ability is unavailable to this principal')
      }
      const parsed = await exactOwnedPackage(location, locator.packageId)

      if (!parsed || parsed.skill.role !== (locator.kind === 'role')) {
        throw new AbilityUnavailableError('no such Owned ability')
      }
      const noteIds = await library.readableNoteIds(location, [locator.packageId])
      const registryNoteId = noteIds.get(locator.packageId)

      if (!registryNoteId) {
        // The same package the DETAIL answers 404 for. A bare Error here made one door
        // call it a server fault and the other call it absent.
        throw new AbilityUnavailableError('Owned ability has no readable registry identity')
      }
      await abilityPreferences.setEnabled(
        owner,
        { locator, registryNoteId },
        enabled,
        new Date().toISOString(),
      )
    },

    setAbilityAvailability: async (context, principal, locator, availability) => {
      const location = ownedPlacementOf(locator, context.personalSpace)

      if (
        location?.scope !== ROLE_SCOPE.space ||
        !can(principal, 'space:write', { space: location.space })
      ) {
        throw new AbilityUnavailableError(
          'Owned ability availability is unavailable to this principal',
        )
      }
      const parsed = await exactOwnedPackage(location, locator.packageId)

      if (!parsed || parsed.skill.role !== (locator.kind === 'role')) {
        throw new AbilityUnavailableError('no such Owned ability')
      }
      const registryNoteId = await projectedNoteId(location, locator.packageId)

      await abilityAvailability.set(location.space, locator.packageId, availability, registryNoteId)
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
        const pkg = await library.getSkill(location, parsed.skill.name)

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
      const pkg = await library.getSkill(base, parsed.skill.name)

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

    createRoleVersion: async (principal, locator, personalSpace, projectId) => {
      const base = ownedPlacementOf(locator, personalSpace)

      if (
        !base ||
        base.scope !== ROLE_SCOPE.space ||
        !can(principal, 'space:write', { space: base.space })
      ) {
        throw new AbilityUnavailableError('a project version needs a writable Space base')
      }
      const parsed = await exactOwnedPackage(base, locator.packageId)

      if (!parsed?.skill.role) {
        throw new AbilityUnavailableError('no such Owned Role')
      }
      const location = {
        scope: ROLE_SCOPE.project,
        space: base.space,
        projectId,
      } as const
      const name = parsed.skill.name
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
        const source = await library.getByDirectory(base, locator.packageId)

        if (!source) {
          throw new AbilityUnavailableError('no such Owned Role')
        }
        const noteId = freshNoteId()
        const files = new Map(source.files)
        files.set(
          'SKILL.md',
          Buffer.from(
            withFreshNoteId(Buffer.from(source.files.get('SKILL.md')!).toString('utf8'), noteId),
          ),
        )
        const pkg = { directoryName: noteId, files }
        validateSkillPackage(pkg)
        const registryNoteId = await publishOwnedPackage(
          location,
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

    moveRolePlacement: async (principal, locator, personalSpace) => {
      const placed = ownedPlacementOf(locator, personalSpace)
      const from = placed && projectPlacement(placed)
      const to = from && spaceRootOf(from.space, personalSpace)

      if (!from || !to || !can(principal, 'space:write', { space: from.space })) {
        // The one move leads to a Space root, so every role that has no such root
        // above it has nowhere to go: a base is already there, and Personal IS the
        // root — a different SPACE, which the engine cannot move a note across.
        throw new AbilityUnavailableError('this role cannot change where it belongs')
      }
      const space = from.space
      const parsed = await exactOwnedPackage(from, locator.packageId)

      if (!parsed?.skill.role) {
        throw new AbilityUnavailableError('no such Owned Role')
      }
      const name = parsed.skill.name
      const release = await acquireAddFence(to, name)

      try {
        // Checked BEFORE anything moves. A base and its version legally share a name
        // precisely because they sit in different placements, so a move into an
        // occupied name is the ordinary case, not an edge — and neither silently
        // merging nor overwriting is an answer the user could have meant.
        if (await library.exists(to, name)) {
          throw new RoleAlreadyExistsError(`role "${name}" already exists in ${to.scope}`)
        }
        // Reach is part of what moves, so it is part of what must come back. Absence
        // of a row READS as all-projects for a role, which means a half-undone move
        // would not leave the reach untouched — it would widen it to the whole Space.
        const reachBefore = await abilityAvailability.get(space, locator.packageId)
        // The package address survives the move and so does the identity behind it,
        // but identity is projected from a PATH — so it is only readable while the
        // package is still at that path. Read here, one line above the move.
        const movedNoteId = await projectedNoteId(from, locator.packageId)

        const moved = ownedRoleLocator(to, locator.packageId)
        // Reach belongs to a Space home and only to it. Coming up from a project the
        // role keeps exactly the reach it had — the one project it served — because a
        // move must not widen what a role applies to.
        const availability: AbilityAvailability = {
          mode: ABILITY_AVAILABILITY_MODE.selectedProjects,
          projectIds: [from.projectId],
        }
        // Written BEFORE the package is readable at its new home, the same order
        // publication already keeps: for a role the ABSENCE of a row reads as
        // all-projects, so moving first opens a window — however short — in which a
        // role narrowed to one project answers in every project of its Space. Early is
        // harmless: the package is still a project placement, which reaches its own
        // project by construction and never consults this row.
        await abilityAvailability.set(space, locator.packageId, availability, movedNoteId)
        let published = false

        try {
          published = await library.movePackage(from, to, locator.packageId)

          if (!published) {
            throw new RoleAlreadyExistsError(`role "${name}" already exists in ${to.scope}`)
          }
          await abilityPlacement.moveOwnedRolePlacement({
            fromTargetId: roleContextTargetIdOf(from, locator.packageId),
            toTargetId: roleContextTargetIdOf(to, locator.packageId),
            fromLocator: serializeAbilityLocator(locator),
            toLocator: serializeAbilityLocator(moved),
          })
        } catch (error) {
          // The package already moved and its pointers did not. Put it back rather
          // than leave a role whose context, preference and episodes still name a
          // placement that no longer exists. Nothing to put back when the move itself
          // was refused — but the reach written ahead of it still has to come off.
          const undone = published
            ? await library.movePackage(to, from, locator.packageId).catch((err: Error) => {
                console.error(`[roles] failed to undo the move of ${name}:`, err.message)
                return false
              })
            : true

          // Reach describes where the package IS, so undoing it is meaningless unless
          // the package went back. A role left standing at the Space root with its
          // pre-move reach — for a project version, no row at all — would read as
          // all-projects, and a failed promotion would end up WIDENING the role.
          if (undone) {
            await (
              reachBefore
                ? abilityAvailability.set(space, locator.packageId, reachBefore, movedNoteId)
                : abilityAvailability.clear(space, locator.packageId)
            ).catch((err: Error) => {
              console.error(`[roles] failed to undo the reach of ${name}:`, err.message)
            })
          } else {
            console.error(
              `[roles] failed to undo the move of ${name}: destination refused the package`,
            )
          }
          throw error
        }
        const noteIds = await library.awaitReadableNoteIds(to, [locator.packageId])
        const noteId = noteIds.get(locator.packageId)

        if (!noteId) {
          throw new Error(`role "${name}" was moved without a readable note identity`)
        }

        return {
          locator: moved,
          availability,
          role: {
            ...summaryOf(parsed, to.scope),
            space,
            packageId: locator.packageId,
            noteId,
          },
        }
      } finally {
        release()
      }
    },

    serializeOwnedRoleAttachments: async (principal, locator, attachments, personalSpace) => {
      const location = ownedPlacementOf(locator, personalSpace)

      if (!location || !can(principal, 'space:write', { space: location.space })) {
        throw new AbilityUnavailableError('Owned Role is unavailable to this principal')
      }
      const current = await exactOwnedPackage(location, locator.packageId)

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

      const noteId = (await library.readableNoteIds(location, [current.pkg.directoryName])).get(
        current.pkg.directoryName,
      )

      if (!noteId) {
        throw new AbilityUnavailableError('Owned Role has no readable registry identity')
      }

      return { links, noteId }
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
            role: { source: 'system', ...roleFactsOf(hit.parsed) },
            packageId,
            locator,
          }
        : {
            source: 'owned',
            role: { source: 'owned', ...roleFactsOf(hit.parsed), scope: hit.location.scope },
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
      const entry = await savedRoleEntry(context, principal, locator)

      if (!entry) {
        return null
      }

      return (await entryHealth(entry, context, principal)).healthy ? resolvedRoleOf(entry) : null
    },

    loadSavedRole: async (context, principal, locator, budgetTokens) => {
      const entry = await savedRoleEntry(context, principal, locator)

      if (!entry) {
        return null
      }
      // A saved binding resolves its attachments where the ROLE lives, not along the
      // discovery chain; a System package has no such home and takes none.
      const outcome = await loadEffectiveEntry(
        entry,
        context,
        principal,
        entry.source === 'owned' ? [homeOf(entry.location, context.personalSpace)] : [],
        budgetTokens,
      )

      if (!outcome) {
        return null
      }
      const resolved = resolvedRoleOf(entry)
      const instructions = outcome.loaded.role.instructions

      return resolved.source === 'system'
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
    },

    loadEffective: async (context, principal, name, budgetTokens) => {
      const locations = readableLocationsFor(context, principal)
      const hit = await effectiveRoleNamed(locations, principal, name, context.project?.id)

      if (!hit) {
        return null
      }
      const outcome = await loadEffectiveEntry(hit, context, principal, locations, budgetTokens)

      if (!outcome) {
        return null
      }
      const { loaded } = outcome
      const packageId = hit.parsed.pkg.directoryName
      const locator = activeRoleLocatorOf(hit)
      const instructions = loaded.role.instructions

      return hit.source === 'system'
        ? {
            source: 'system',
            role: { source: 'system', ...roleFactsOf(hit.parsed), instructions },
            skills: loaded.skills,
            truncated: loaded.truncated,
            packageId,
            locator,
          }
        : {
            source: 'owned',
            role: {
              source: 'owned',
              ...roleFactsOf(hit.parsed),
              scope: hit.location.scope,
              instructions,
            },
            skills: loaded.skills,
            truncated: loaded.truncated,
            location: hit.location,
            packageId,
            locator,
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

        const installedDependencies: SkillPackage[] = []

        for (const parsed of dependencies) {
          const pkg = forkCatalogPackage(parsed)
          const existing = await compatibleDependency(parsed, pkg)

          if (existing) {
            installedDependencies.push(existing)
            continue
          }
          const added = await library.putIfAbsent(dependencyLocation, pkg)

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

        // A dependency that already existed is REUSED, so granting it reach widens a
        // skill the owner already had. Captured before the first grant, because if the
        // role then fails to publish the caller is told nothing happened — and a failed
        // Add must not widen what a skill applies to any more than a successful one may.
        const reachBeforeAdd = new Map<string, AbilityAvailability | null>()

        for (const dependency of installedDependencies) {
          reachBeforeAdd.set(
            dependency.directoryName,
            await abilityAvailability.get(location.space, dependency.directoryName),
          )
        }
        // Everything from here on is compensated: the reach comes back off — but only
        // while the ROLE has not landed. Once it has, that reach is the reach of a live
        // role's dependencies, and taking it back left the role published, effective,
        // and fail-closed forever with no retry available to it (Add answers 409).
        // The dependency PACKAGES are never undone — the library port has no removal —
        // so a failed Add can leave a freshly forked skill behind, inert until
        // something reaches it. That is the honest limit of what this port can undo.
        let rolePublished = false

        const undoDependencyReach = async () => {
          if (rolePublished) {
            return
          }
          for (const [directoryName, before] of reachBeforeAdd) {
            await (
              before
                ? abilityAvailability.set(location.space, directoryName, before, null)
                : abilityAvailability.clear(location.space, directoryName)
            ).catch((err: Error) => {
              console.error(
                `[roles] failed to undo the reach of linked skill ${directoryName}:`,
                err.message,
              )
            })
          }
        }

        try {
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
          const added = await library.putIfAbsent(location, rolePackage)

          if (!added) {
            throw new RoleAlreadyExistsError(`role "${name}" already exists in ${location.scope}`)
          }
          rolePublished = true

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
        } catch (error) {
          await undoDependencyReach()
          throw error
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
      const noteId = await publishOwnedPackage(
        location,
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
      const pkg = customPackage(name, description, instructions, false)
      const noteId = await publishOwnedPackage(
        location,
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
      // Enumerated, not addressed by a locator: the caller names a home it has already
      // been granted, so the question the seam asks does not arise here.
      const home = addressed(location)
      const attachments = options.attachments ?? []
      const links = attachments.map((attachment) => {
        if (attachment.kind === 'invalid') {
          throw new RoleDependencyConflictError('new invalid skill attachments are not allowed')
        }

        return serializedAttachmentAt(home, options.personalSpace ?? null, attachment)
      })
      const pkg = customPackage(name, description, instructions, true, links)

      if (links.length) {
        if (!options.principal) {
          throw new RoleDependencyConflictError('skill attachments require a principal')
        }
        const principal = options.principal

        for (const projectId of coveredProjectsOf(location, options.availability)) {
          const health = await healthForRole(
            parsePackage(pkg),
            'owned',
            principal,
            home,
            options.personalSpace ?? null,
            projectId,
          )

          if (health.attachments.some(({ health: verdict }) => blocksAttachmentWrite(verdict))) {
            throw new RoleDependencyConflictError('one or more skill attachments are unavailable')
          }
        }
      }
      const availability =
        location.scope === ROLE_SCOPE.space
          ? (options.availability ?? { mode: ABILITY_AVAILABILITY_MODE.allProjects })
          : undefined

      // Reach is written BEFORE the package is readable. For a role the absence of a
      // row reads as all-projects, so publishing first opens a window — as wide as the
      // projection barrier inside publish — in which a role narrowed to one project
      // answers in every project of its Space. A row for a package that never appears
      // is inert and dies with its Space; the reverse is not.
      if (availability) {
        await abilityAvailability.set(location.space, pkg.directoryName, availability, null)
      }
      const noteId = await publishOwnedPackage(
        location,
        pkg,
        () => new RoleAlreadyExistsError(`role "${name}" already exists in ${location.scope}`),
      )

      // The row was written before there WAS an identity to name; now there is. The
      // key is learned, never forgotten, so this second write only fills it in.
      if (availability) {
        await abilityAvailability.set(location.space, pkg.directoryName, availability, noteId)
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
