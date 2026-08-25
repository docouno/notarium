import {
  ABILITY_AVAILABILITY_MODE,
  ABILITY_KIND,
  type AgentAbilitySummary,
  type AgentPackageLibraryQuery,
  type OwnedAbilityLocation,
  type OwnedAbilityLocator,
  ROLE_SCOPE,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { decodeAbilityLocator, encodeAbilityLocator } from '@notarium/core'

import { AGENT_SESSION_IDLE_MS } from '../../../agentSessions'
import { AuthError } from '../../../auth'
import { can, type Principal } from '../../../authz'
import { projectSummaryOf } from '../../../mcp/helpers/projectAddressing'
import { abilityReachesProject } from '../../../roles'
import type { AbilityInventoryDeps, AbilityPersonalContext, HumanAbilityPage } from '../../types'
import {
  type PackageLibraryCandidate,
  PackageLibraryCursorError,
  pagePackageLibrary,
} from '../packageLibrary'
import type { AbilityPlacement } from '../placement'

const ROLE_INVENTORY_LOCATION_LIMIT = 128
const ROLE_PROJECT_SUMMARY_LIMIT = 128
const SKILL_INVENTORY_LOCATION_LIMIT = 128
const SKILL_PROJECT_SUMMARY_LIMIT = 128

type OwnedRoleSummary = Extract<AgentAbilitySummary, { source: 'owned' }>
type ProjectRoleLocator = Extract<OwnedAbilityLocator, { kind: 'role' }> & {
  location: Extract<OwnedAbilityLocation, { scope: 'project' }>
}
type OwnedRoleGroup = {
  base?: OwnedRoleSummary
  versions: Array<OwnedRoleSummary & { locator: ProjectRoleLocator }>
}

type ProjectSource = {
  id: string
  space: string
  project: ReturnType<typeof projectSummaryOf>
}

/** The one human-library projection for an Owned Role. Kept named because the
 * producer registry asserts that reach is asked here and nowhere else in the adapter. */
const ownedRoleCandidate = (
  item: OwnedRoleSummary,
  versions: OwnedRoleGroup['versions'],
  projectSources: readonly ProjectSource[],
): PackageLibraryCandidate<AgentAbilitySummary> => {
  const personalHome = item.locator.location.scope === ROLE_SCOPE.personal
  const availability = item.availability
  const versioned = versions.map((version) => version.locator.location.projectId)
  const own =
    item.locator.location.scope === ROLE_SCOPE.project ? [item.locator.location.projectId] : []
  const reach = personalHome
    ? projectSources.map(({ project }) => project.handle)
    : projectSources
        .filter(
          ({ id, space }) =>
            space === item.locator.location.spaceId &&
            (own.includes(id) ||
              versioned.includes(id) ||
              abilityReachesProject(availability, id, ABILITY_KIND.skill)),
        )
        .map(({ project }) => project.handle)

  return {
    item: {
      ...item,
      versions: versions.map((version) => ({
        projectId: version.locator.location.projectId,
        locator: version.locator,
      })),
    },
    name: item.name,
    description: item.description,
    source: 'owned',
    home: personalHome ? 'personal' : 'space',
    availability:
      personalHome || availability?.mode === ABILITY_AVAILABILITY_MODE.allProjects
        ? 'all'
        : 'selected',
    projects: reach,
    identity: encodeAbilityLocator(item.locator),
  }
}

export const createAbilityInventory = (
  { roles, spaces, projects, sessions }: AbilityInventoryDeps,
  placement: AbilityPlacement,
) => {
  const projectSourcesFor = async (scopedSpaces: string[]): Promise<ProjectSource[]> =>
    (await placement.contextProjectsFor(scopedSpaces))
      .map((project) => ({
        id: project.id,
        space: project.space,
        project: projectSummaryOf(project, spaces.slugOf(project.space) ?? project.space),
      }))
      .sort((left, right) => left.project.handle.localeCompare(right.project.handle))

  const readableSpacesFor = (principal: Principal): string[] =>
    spaces
      .list()
      .map((entry) => entry.id)
      .filter((space) => can(principal, 'space:read', { space }))

  const scopedSpacesFor = (principal: Principal, query: AgentPackageLibraryQuery): string[] => {
    const readable = readableSpacesFor(principal)

    if (query.spaceId && (!spaces.recOf(query.spaceId) || !readable.includes(query.spaceId))) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }

    return query.spaceId ? [query.spaceId] : readable
  }

  const listSkills = async (
    principal: Principal,
    query: AgentPackageLibraryQuery,
  ): Promise<HumanAbilityPage> => {
    const scopedSpaces = scopedSpacesFor(principal, query)
    const [personal, hostPersonal, projectSources, bundled] = await Promise.all([
      placement.personalSpaceFor(principal),
      placement.rawPersonalSpaceFor(principal),
      projectSourcesFor(scopedSpaces),
      roles.listBundledAbilities(principal),
    ])
    const projectHandleById = new Map(
      projectSources.map(({ id, project }) => [id, project.handle] as const),
    )
    const allLocations = [
      ...(personal ? [{ location: { scope: ROLE_SCOPE.personal, space: personal } as const }] : []),
      ...scopedSpaces
        .filter((space) => space !== personal)
        .map((space) => ({ location: { scope: ROLE_SCOPE.space, space } as const })),
    ]
    const candidates: PackageLibraryCandidate<AgentAbilitySummary>[] = bundled
      .filter(({ locator }) => locator.kind === ABILITY_KIND.skill)
      .map((ability) => ({
        item: ability,
        name: ability.name,
        description: ability.description,
        source: ability.source,
        projects: [],
        identity: encodeAbilityLocator(ability.locator),
      }))
    const writableProjects = projectSources.filter(
      ({ space }) =>
        (!query.spaceId || query.spaceId === space) && can(principal, 'space:write', { space }),
    )
    let truncated =
      allLocations.length > SKILL_INVENTORY_LOCATION_LIMIT ||
      writableProjects.length > SKILL_PROJECT_SUMMARY_LIMIT

    for (const source of allLocations.slice(0, SKILL_INVENTORY_LOCATION_LIMIT)) {
      const listing = await roles.listOwnedAbilitiesAt(
        source.location,
        principal,
        ABILITY_KIND.skill,
      )
      truncated ||= listing.truncated
      for (const { ability: skill, availability: storedAvailability } of listing.abilities) {
        if (skill.locator.location.scope === ROLE_SCOPE.personal) {
          candidates.push({
            item: skill,
            name: skill.name,
            description: skill.description,
            source: 'owned',
            home: 'personal',
            availability: 'all',
            projects: projectSources.map(({ project }) => project.handle),
            identity: encodeAbilityLocator(skill.locator),
          })
          continue
        }
        const availability =
          storedAvailability?.mode === ABILITY_AVAILABILITY_MODE.selectedProjects
            ? {
                mode: ABILITY_AVAILABILITY_MODE.selectedProjects,
                projects: storedAvailability.projectIds
                  .flatMap((id) => {
                    const handle = projectHandleById.get(id)
                    return handle ? [handle] : []
                  })
                  .sort(),
              }
            : { mode: ABILITY_AVAILABILITY_MODE.allProjects }
        candidates.push({
          item: skill,
          name: skill.name,
          description: skill.description,
          source: 'owned',
          home: 'space',
          availability:
            availability.mode === ABILITY_AVAILABILITY_MODE.selectedProjects ? 'selected' : 'all',
          projects:
            availability.mode === ABILITY_AVAILABILITY_MODE.selectedProjects
              ? availability.projects
              : projectSources
                  .filter((project) => project.space === skill.locator.location.spaceId)
                  .map(({ project }) => project.handle),
          identity: encodeAbilityLocator(skill.locator),
        })
      }
    }
    let page

    try {
      page = pagePackageLibrary({
        candidates,
        projects: projectSources.map(({ project }) => project),
        query,
      })
    } catch (error) {
      if (error instanceof PackageLibraryCursorError) {
        throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'bad cursor')
      }
      throw error
    }

    return {
      kind: 'skill',
      page: {
        ...page,
        projects: writableProjects
          .slice(0, SKILL_PROJECT_SUMMARY_LIMIT)
          .map(({ project }) => project),
        ...(truncated ? { truncated: true } : {}),
        installAvailability: {
          personal: placement.personalInstallAvailable(ABILITY_KIND.skill, hostPersonal),
          spaces: Object.fromEntries(
            scopedSpaces
              .filter((space) => space !== personal && can(principal, 'space:write', { space }))
              .map((space) => [
                spaces.slugOf(space) ?? space,
                roles.canAddSkillAt({
                  kind: 'location',
                  location: { scope: ROLE_SCOPE.space, space },
                }),
              ]),
          ),
        },
      },
    }
  }

  const listRoles = async (
    principal: Principal,
    query: AgentPackageLibraryQuery,
  ): Promise<HumanAbilityPage> => {
    const scopedSpaces = scopedSpacesFor(principal, query)
    const [personal, hostPersonal, projectSources, bundled] = await Promise.all([
      placement.personalSpaceFor(principal),
      placement.rawPersonalSpaceFor(principal),
      projectSourcesFor(scopedSpaces),
      roles.listBundledAbilities(principal),
    ])
    const summaries: ProjectSource['project'][] = []
    let writableProjectCount = 0

    for (const source of projectSources) {
      if (!can(principal, 'space:write', { space: source.space })) {
        continue
      }
      writableProjectCount++
      if (summaries.length < ROLE_PROJECT_SUMMARY_LIMIT) {
        summaries.push(source.project)
      }
    }
    const personalLocations = personal
      ? [{ location: { scope: ROLE_SCOPE.personal, space: personal } as const }]
      : []
    const spaceLocations = scopedSpaces
      .filter((space) => space !== personal)
      .map((space) => ({ location: { scope: ROLE_SCOPE.space, space } as const }))
    const projectLocations = projectSources.map((project) => ({
      location: {
        scope: ROLE_SCOPE.project,
        space: project.space,
        projectId: project.id,
      } as const,
    }))
    const locations = [...personalLocations, ...spaceLocations, ...projectLocations].slice(
      0,
      ROLE_INVENTORY_LOCATION_LIMIT,
    )
    const candidates: PackageLibraryCandidate<AgentAbilitySummary>[] = bundled
      .filter(({ locator }) => locator.kind === ABILITY_KIND.role)
      .map((ability) => ({
        item: ability,
        name: ability.name,
        description: ability.description,
        source: ability.source,
        projects: [],
        identity: encodeAbilityLocator(ability.locator),
      }))
    let inventoryTruncated =
      personalLocations.length + projectLocations.length + spaceLocations.length >
        ROLE_INVENTORY_LOCATION_LIMIT || writableProjectCount > ROLE_PROJECT_SUMMARY_LIMIT
    const groups = new Map<string, OwnedRoleGroup>()

    for (const source of locations) {
      const listing = await roles.listOwnedAbilitiesAt(
        source.location,
        principal,
        ABILITY_KIND.role,
      )
      inventoryTruncated ||= listing.truncated
      for (const { ability: role } of listing.abilities) {
        const key = `${role.locator.location.spaceId}\0${role.name}`
        const group = groups.get(key) ?? { versions: [] }

        if (role.locator.location.scope === ROLE_SCOPE.project) {
          group.versions.push(role as OwnedRoleSummary & { locator: ProjectRoleLocator })
        } else {
          group.base = role
        }
        groups.set(key, group)
      }
    }
    for (const group of groups.values()) {
      const versions = [...group.versions].sort((left, right) =>
        left.locator.location.projectId.localeCompare(right.locator.location.projectId),
      )

      if (group.base) {
        candidates.push(ownedRoleCandidate(group.base, versions, projectSources))
      } else {
        for (const version of versions) {
          candidates.push(ownedRoleCandidate(version, [], projectSources))
        }
      }
    }
    const owner = principal.username ?? (principal.system ? 'system' : null)
    const active =
      sessions && owner
        ? await sessions.listRecent(
            owner,
            new Date(Date.now() - AGENT_SESSION_IDLE_MS).toISOString(),
            2,
          )
        : []
    let activeRole: string | null = null

    if (active.length === 1) {
      const saved = active[0]

      if (saved.roleLocator?.kind === ABILITY_KIND.role) {
        const contextProject =
          saved.roleContextProjectId && projects
            ? await projects.getById(saved.roleContextProjectId)
            : null
        const resolved = await roles.resolveSavedRole(
          { personalSpace: personal, ...(contextProject ? { project: contextProject } : {}) },
          principal,
          saved.roleLocator,
        )

        activeRole = resolved?.role.name ?? null
      }
    }
    let page

    try {
      page = pagePackageLibrary({
        candidates,
        projects: projectSources.map(({ project }) => project),
        query,
      })
    } catch (error) {
      if (error instanceof PackageLibraryCursorError) {
        throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'bad cursor')
      }
      throw error
    }

    return {
      kind: 'role',
      page: {
        ...page,
        projects: summaries,
        activeRole,
        ...(inventoryTruncated ? { truncated: true } : {}),
        installAvailability: {
          personal: placement.personalInstallAvailable(ABILITY_KIND.role, hostPersonal),
          projects: Object.fromEntries(
            projectSources
              .filter(({ project }) => summaries.includes(project))
              .map(({ id, space, project }) => [
                project.handle,
                project.status === 'active' &&
                  roles.canAddRoleAt(
                    {
                      kind: 'location',
                      location: { scope: ROLE_SCOPE.project, space, projectId: id },
                    },
                    personal,
                  ),
              ]),
          ),
        },
      },
    }
  }

  const personalContext = async (
    principal: Principal,
    personalSpace: string,
    roleRef?: string,
  ): Promise<AbilityPersonalContext> => {
    const decoded = roleRef ? decodeAbilityLocator(roleRef) : null
    const locator =
      decoded?.source === 'owned' &&
      decoded.kind === ABILITY_KIND.role &&
      decoded.location.scope === ROLE_SCOPE.personal &&
      decoded.location.spaceId === personalSpace
        ? decoded
        : null
    const [listing, selected] = await Promise.all([
      roles.listOwnedAbilitiesAt(
        { scope: ROLE_SCOPE.personal, space: personalSpace },
        principal,
        ABILITY_KIND.role,
      ),
      locator
        ? roles.addressedRoleStatus({ personalSpace }, principal, locator)
        : Promise.resolve(null),
    ])

    return { listing, selected, locator }
  }

  return {
    listHuman: (principal: Principal, kind: 'role' | 'skill', query: AgentPackageLibraryQuery) =>
      kind === ABILITY_KIND.role ? listRoles(principal, query) : listSkills(principal, query),
    personalContext,
  }
}
