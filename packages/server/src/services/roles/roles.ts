import { Buffer } from 'node:buffer'

import {
  CatalogRoleNotFoundError,
  RoleAlreadyExistsError,
  RoleDependencyConflictError,
} from './errors'
import {
  InvalidSkillPackageError,
  type RoleLibrary,
  type SkillPackage,
  validateSkillPackage,
} from './library'
import { packageRevision, parseSkillFile, withBuiltinProvenance } from './skillFile'
import {
  type EffectiveRoleContext,
  type LoadedEffectiveRole,
  type LoadedRole,
  ROLE_SCOPE,
  type RoleInventoryEntry,
  type RoleLocation,
  type RolesService,
  type RoleSummary,
} from './types'

type ParsedPackage = { pkg: SkillPackage; skill: ReturnType<typeof parseSkillFile> }

const packagesEqual = (left: SkillPackage, right: SkillPackage): boolean => {
  if (left.name !== right.name || left.files.size !== right.files.size) {
    return false
  }

  for (const [name, bytes] of left.files) {
    const other = right.files.get(name)

    if (!other || !Buffer.from(bytes).equals(Buffer.from(other))) {
      return false
    }
  }

  return true
}

const parsePackage = (pkg: SkillPackage): ParsedPackage => {
  const file = pkg.files.get('SKILL.md')

  if (!file) {
    throw new Error(`${pkg.name}/SKILL.md is missing`)
  }

  return { pkg, skill: parseSkillFile(Buffer.from(file).toString('utf8'), pkg.name) }
}

const forkCatalogPackage = (parsed: ParsedPackage): SkillPackage => {
  const revision = packageRevision(parsed.pkg.files)
  const files = new Map(parsed.pkg.files)
  const skillFile = withBuiltinProvenance(
    Buffer.from(parsed.pkg.files.get('SKILL.md')!).toString('utf8'),
    parsed.skill.name,
    revision,
  )

  // Provenance is part of the stored fork, so its rewritten manifest must obey
  // the exact same parser/byte bounds before the template is advertised.
  parseSkillFile(skillFile, parsed.skill.name)
  files.set('SKILL.md', Buffer.from(skillFile))
  const fork = { name: parsed.skill.name, files }
  validateSkillPackage(fork)
  return fork
}

const summaryOf = (parsed: ParsedPackage, scope: RoleSummary['scope']): RoleSummary => {
  const origin = parsed.skill.metadata['notarium.origin']
  const originRevision = parsed.skill.metadata['notarium.originRevision']
  // Provenance is a paired, narrow declaration. Arbitrary writable metadata
  // never reaches REST/MCP or earns the built-in UI treatment.
  const builtinOrigin =
    origin === `builtin:${parsed.skill.name}` && /^sha256:[a-f0-9]{64}$/.test(originRevision ?? '')

  return {
    name: parsed.skill.name,
    description: parsed.skill.description,
    scope,
    ...(builtinOrigin ? { origin, originRevision } : {}),
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
        `[roles] ignoring invalid ${location.scope} package ${pkg.name}:`,
        (err as Error).message,
      )
    }
  }

  return { packages: parsed, truncated: listing.truncated }
}

const locationsFor = (context: EffectiveRoleContext): RoleLocation[] => {
  const locations: RoleLocation[] = []

  if (context.personalSpace) {
    locations.push({ scope: ROLE_SCOPE.personal, space: context.personalSpace })
  }
  if (context.project && context.project.space !== context.personalSpace) {
    locations.push({ scope: ROLE_SCOPE.space, space: context.project.space })
  }
  if (context.project) {
    locations.push({
      scope: ROLE_SCOPE.project,
      space: context.project.space,
      projectId: context.project.id,
    })
  }

  return locations
}

const tokenChars = (tokens: number): number => Math.max(0, tokens) * 4
const ROLE_BUNDLE_OVERHEAD_CHARS = 96
const SKILL_BUNDLE_OVERHEAD_CHARS = 64

const loadParsedRole = async (
  parsed: ParsedPackage,
  scope: RoleSummary['scope'],
  dependency: (name: string) => Promise<ParsedPackage | undefined>,
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

  for (const skillName of parsed.skill.linkedSkills) {
    if (remaining <= SKILL_BUNDLE_OVERHEAD_CHARS + skillName.length) {
      truncated = true
      break
    }
    const linked = (await dependency(skillName))?.skill

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

export const createRolesService = ({
  catalog,
  library,
}: {
  catalog: () => Promise<SkillPackage[]>
  library: RoleLibrary
}): RolesService => {
  let catalogPromise: Promise<ParsedPackage[]> | undefined
  const catalogPackages = (): Promise<ParsedPackage[]> =>
    (catalogPromise ??= catalog().then((packages) =>
      packages.map((pkg) => {
        validateSkillPackage(pkg)
        const parsed = parsePackage(pkg)
        forkCatalogPackage(parsed)
        return parsed
      }),
    ))

  const effectivePackages = async (
    context: EffectiveRoleContext,
  ): Promise<{
    packages: Map<string, { parsed: ParsedPackage; location: RoleLocation }>
    truncated: boolean
  }> => {
    const effective = new Map<string, { parsed: ParsedPackage; location: RoleLocation }>()
    let truncated = false

    // Ordered general → specific. A same-name package in a narrower scope wins.
    for (const location of locationsFor(context)) {
      const listing = await parsedAt(library, location)
      truncated ||= listing.truncated
      for (const parsed of listing.packages) {
        effective.set(parsed.skill.name, { parsed, location })
      }
    }

    return { packages: effective, truncated }
  }

  const directOwnedPackage = async (
    locations: readonly RoleLocation[],
    name: string,
  ): Promise<{ parsed: ParsedPackage; location: RoleLocation } | null> => {
    // Exact activation is not constrained by the bounded discovery window.
    // Search narrowest → broadest, mirroring effectivePackages precedence.
    for (const location of [...locations].reverse()) {
      const pkg = await library.getSkill(location, name)

      if (!pkg) {
        continue
      }
      try {
        return { parsed: parsePackage(pkg), location }
      } catch (err) {
        console.warn(
          `[roles] ignoring invalid ${location.scope} package ${name}:`,
          (err as Error).message,
        )
      }
    }

    return null
  }

  return {
    listCatalog: async () =>
      (await catalogPackages())
        .filter(({ skill }) => skill.role)
        .map((parsed) => summaryOf(parsed, ROLE_SCOPE.catalog))
        .sort((left, right) => left.name.localeCompare(right.name)),

    hasCatalog: async (name) =>
      (await catalogPackages()).some(({ skill }) => skill.role && skill.name === name),

    listAt: async (location) => {
      const listing = await parsedAt(library, location)
      return {
        roles: listing.packages
          .filter(({ skill }) => skill.role)
          .map((parsed): RoleInventoryEntry => ({
            ...summaryOf(parsed, location.scope),
            space: location.space,
            ...(location.projectId ? { projectId: location.projectId } : {}),
          }))
          .sort((left, right) => left.name.localeCompare(right.name)),
        truncated: listing.truncated,
      }
    },

    listEffective: async (context) => {
      const listing = await effectivePackages(context)
      return {
        roles: [...listing.packages.values()]
          .filter(({ parsed }) => parsed.skill.role)
          .map(({ parsed, location }) => ({
            ...summaryOf(parsed, location.scope),
            scope: location.scope,
          }))
          .sort((left, right) => left.name.localeCompare(right.name)),
        truncated: listing.truncated,
      }
    },

    loadCatalog: async (name, budgetTokens) => {
      const packages = await catalogPackages()
      const role = packages.find(({ skill }) => skill.role && skill.name === name)

      return role
        ? loadParsedRole(
            role,
            ROLE_SCOPE.catalog,
            async (skillName) => packages.find(({ skill }) => skill.name === skillName),
            budgetTokens,
          )
        : null
    },

    loadAt: async (location, name, budgetTokens) => {
      const rolePackage = await library.getSkill(location, name)

      if (!rolePackage) {
        return null
      }
      let role

      try {
        role = parsePackage(rolePackage)
      } catch (err) {
        console.warn(
          `[roles] ignoring invalid ${location.scope} package ${name}:`,
          (err as Error).message,
        )
        return null
      }
      if (!role.skill.role) {
        return null
      }

      return loadParsedRole(
        role,
        location.scope,
        async (skillName) => {
          const dependency = await library.getSkill(location, skillName)

          try {
            return dependency ? parsePackage(dependency) : undefined
          } catch (err) {
            console.warn(
              `[roles] ignoring invalid linked package ${skillName}:`,
              (err as Error).message,
            )
            return undefined
          }
        },
        budgetTokens,
      )
    },

    loadEffective: async (context, name, budgetTokens) => {
      const locations = locationsFor(context)
      const hit = await directOwnedPackage(locations, name)

      if (!hit?.parsed.skill.role) {
        return null
      }

      return (await loadParsedRole(
        hit.parsed,
        hit.location.scope,
        async (skillName) => {
          const dependencyHit = await directOwnedPackage(locations, skillName)
          return dependencyHit?.parsed
        },
        budgetTokens,
      )) as LoadedEffectiveRole
    },

    addFromCatalog: async (name, location) => {
      const packages = await catalogPackages()
      const role = packages.find(({ skill }) => skill.role && skill.name === name)

      if (!role) {
        throw new CatalogRoleNotFoundError(`no such catalog role: ${name}`)
      }
      if (await library.exists(location, name)) {
        throw new RoleAlreadyExistsError(`role "${name}" already exists in ${location.scope}`)
      }
      const dependencies = role.skill.linkedSkills.map((skillName) => {
        const dependency = packages.find(({ skill }) => !skill.role && skill.name === skillName)

        if (!dependency) {
          throw new Error(`catalog role "${name}" links missing skill "${skillName}"`)
        }

        return dependency
      })

      const installable = [...dependencies, role].map((parsed) => {
        return { parsed, pkg: forkCatalogPackage(parsed) }
      })

      // Add is a fork of one coherent catalog bundle. Reusing an exact dependency
      // left by an interrupted/concurrent install is safe; silently binding the new
      // role to different owned bytes is not.
      const assertCompatibleDependency = async (parsed: ParsedPackage, pkg: SkillPackage) => {
        let existing: SkillPackage | null

        try {
          existing = await library.get(location, parsed.skill.name)
        } catch (err) {
          if (err instanceof InvalidSkillPackageError) {
            throw new RoleDependencyConflictError(
              `linked skill "${parsed.skill.name}" already exists with invalid content in ${location.scope}`,
            )
          }
          throw err
        }

        if (!existing || !packagesEqual(existing, pkg)) {
          throw new RoleDependencyConflictError(
            `linked skill "${parsed.skill.name}" already exists with different content in ${location.scope}`,
          )
        }
      }

      for (const { parsed, pkg } of installable.slice(0, -1)) {
        if (await library.exists(location, parsed.skill.name)) {
          await assertCompatibleDependency(parsed, pkg)
        }
      }

      for (const { parsed, pkg } of installable) {
        const added = await library.putIfAbsent(location, pkg)

        if (!added && parsed.skill.role) {
          throw new RoleAlreadyExistsError(`role "${name}" already exists in ${location.scope}`)
        }
        if (!added) {
          await assertCompatibleDependency(parsed, pkg)
        }
      }

      const installed = await library.get(location, name)

      if (!installed) {
        throw new Error(`role "${name}" was not installed`)
      }

      return {
        ...summaryOf(parsePackage(installed), location.scope),
        space: location.space,
        ...(location.projectId ? { projectId: location.projectId } : {}),
      }
    },
  }
}
