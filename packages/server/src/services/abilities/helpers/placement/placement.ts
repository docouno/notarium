import {
  ABILITY_AVAILABILITY_MODE,
  type AgentAbilityAvailabilityState,
  PROJECT_STATUS,
  ROLE_SCOPE,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'

import { AuthError } from '../../../auth'
import { can, type Principal, scopeAllows } from '../../../authz'
import { projectSummaryOf } from '../../../mcp/helpers/projectAddressing'
import type { ProjectRecord } from '../../../metaDb'
import { RoleInstallUnavailableError, type RoleLocation } from '../../../roles'
import { ensurePersonalSpaceFor, peekPersonalSpace } from '../../../spaces'
import type {
  AbilityCreateRequest,
  CreateAbilitiesOptions,
  PreparedAbilityCreate,
} from '../../types'

export type AbilityPlacement = ReturnType<typeof createAbilityPlacement>

export const createAbilityPlacement = ({
  roles,
  spaces,
  auth,
  projects,
}: Pick<CreateAbilitiesOptions, 'roles' | 'spaces' | 'auth' | 'projects'>) => {
  const contextProjectsFor = async (readableSpaces: string[]): Promise<ProjectRecord[]> =>
    !projects || !readableSpaces.length ? [] : projects.listForSpaces(readableSpaces)

  const activeProjectsFor = async (readableSpaces: string[]): Promise<ProjectRecord[]> =>
    (await contextProjectsFor(readableSpaces)).filter(
      (project) => project.status === PROJECT_STATUS.active,
    )

  const personalSpaceFor = async (principal: Principal): Promise<string | null> => {
    // Generic Personal content deliberately maps the authless system principal to
    // the first configured Space. An operator-static ability root cannot carry that
    // alias: it would make explicit Space packages indistinguishable from Personal.
    if (principal.system && !spaces.capabilities.spaceCreate) {
      return null
    }

    return peekPersonalSpace({ auth, spaces }, principal)
  }

  const personalInstallAvailable = (
    kind: AbilityCreateRequest['kind'],
    personalSpace: string | null,
  ): boolean => {
    // A pointer-less static root cannot distinguish Personal packages from explicit
    // Space packages. Capability honesty is a refusal, not an address that later
    // consumers reinterpret differently.
    if (!personalSpace && !spaces.capabilities.spaceCreate) {
      return false
    }
    const target = personalSpace
      ? {
          kind: 'location' as const,
          location: { scope: ROLE_SCOPE.personal, space: personalSpace },
        }
      : ({ kind: 'prospective-personal' } as const)

    return kind === 'role' ? roles.canAddRoleAt(target, personalSpace) : roles.canAddSkillAt(target)
  }

  const writablePersonalSpace = async (
    principal: Principal,
    knownPersonal: string | null,
  ): Promise<{ personalSpace: string | null; principal: Principal; space: string }> => {
    if (principal.system) {
      const space = spaces.list()[0]?.id

      if (!space || !can(principal, 'space:write', { space })) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }

      return { personalSpace: knownPersonal, principal, space }
    }
    if (!principal.username || !scopeAllows(principal, 'space:write')) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }

    // A narrowed credential cannot name a Personal space that does not exist yet.
    // Refuse before provisioning: minting first would create durable state outside
    // the credential's reach and only then discover the stale request principal
    // cannot see the grant. Operator-static fallback is reserved for an unrestricted
    // credential and still passes through the ordinary grant check below.
    if (principal.spaces && !knownPersonal) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    if (knownPersonal && principal.spaces && !principal.spaces.has(knownPersonal)) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }

    const personal = await ensurePersonalSpaceFor({ auth, spaces }, principal.username)
    // A matching pointer proves `ensurePersonalSpaceFor` took the real Personal path
    // and awaited its owner grant. No pointer means operator-static fallback and keeps
    // the original grants. Principal is an immutable request snapshot, so project only
    // the proven owner fact into the continuation; scope and narrowing remain intact.
    const ownerEstablished = (await auth.personalSpaceOf(principal.username)) === personal

    if (!ownerEstablished) {
      throw new RoleInstallUnavailableError(
        'ability installation requires a durable Personal namespace',
      )
    }
    const admittedPrincipal: Principal = {
      ...principal,
      grants: new Map(principal.grants).set(personal, 'owner'),
    }

    if (!can(admittedPrincipal, 'space:write', { space: personal })) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }

    return {
      personalSpace: personal,
      principal: admittedPrincipal,
      space: personal,
    }
  }

  const writableSharedSpace = async (principal: Principal, slug: string): Promise<string> => {
    const space = spaces.resolveId(slug)
    const personalSpace = await personalSpaceFor(principal)

    if (
      !space ||
      !can(principal, 'space:write', { space }) ||
      space === personalSpace ||
      (await auth.isPersonalSpace(space))
    ) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }

    return space
  }

  const writableProject = async (
    principal: Principal,
    handle: string | undefined,
  ): Promise<ProjectRecord> => {
    const readableSpaces = spaces
      .list()
      .map((space) => space.id)
      .filter((space) => can(principal, 'space:read', { space }))
    const project = (await activeProjectsFor(readableSpaces)).find(
      (entry) =>
        projectSummaryOf(entry, spaces.slugOf(entry.space) ?? entry.space).handle === handle,
    )

    if (!project || !can(principal, 'space:write', { space: project.space })) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }

    return project
  }

  const resolveAvailabilityHandles = async (
    space: string,
    availability: { mode: 'all-projects' } | { mode: 'selected-projects'; projects: string[] },
  ): Promise<AgentAbilityAvailabilityState> => {
    if (availability.mode === ABILITY_AVAILABILITY_MODE.allProjects) {
      return { mode: ABILITY_AVAILABILITY_MODE.allProjects }
    }
    const byHandle = new Map(
      (await contextProjectsFor([space])).map((project) => [
        projectSummaryOf(project, spaces.slugOf(project.space) ?? project.space).handle,
        project,
      ]),
    )
    const selected = availability.projects.map((handle) => byHandle.get(handle))

    if (selected.some((project) => !project)) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }

    return {
      mode: ABILITY_AVAILABILITY_MODE.selectedProjects,
      projectIds: [...new Set(selected.map((project) => project!.id))],
    }
  }

  const prepareCreate = async (
    principal: Principal,
    request: AbilityCreateRequest,
  ): Promise<PreparedAbilityCreate> => {
    if (request.source === 'catalog') {
      const exists =
        request.kind === 'role'
          ? await roles.hasCatalog(request.body.name)
          : await roles.hasCatalogSkill(request.body.name)

      if (!exists) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
    }
    let personalSpace = await personalSpaceFor(principal)
    let createPrincipal = principal
    let location: RoleLocation

    if (request.body.scope === ROLE_SCOPE.personal) {
      const available = personalInstallAvailable(request.kind, personalSpace)

      if (!personalSpace && !available) {
        throw new RoleInstallUnavailableError('role installation is unavailable for this location')
      }
      const personal = await writablePersonalSpace(principal, personalSpace)

      personalSpace = personal.personalSpace
      createPrincipal = personal.principal
      location = {
        scope: ROLE_SCOPE.personal,
        space: personal.space,
      }
    } else if (request.body.scope === ROLE_SCOPE.space) {
      location = {
        scope: ROLE_SCOPE.space,
        space: await writableSharedSpace(principal, request.body.space),
      }
    } else {
      const project = await writableProject(principal, request.body.project)
      location = {
        scope: ROLE_SCOPE.project,
        space: project.space,
        projectId: project.id,
      }
    }
    const addressed = roles.resolveOwnedPlacement(
      location,
      location.scope === ROLE_SCOPE.personal
        ? location.space
        : principal.username
          ? personalSpace
          : null,
    )

    if (!addressed || !can(createPrincipal, 'space:write', { space: addressed.space })) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    const availability =
      location.scope === ROLE_SCOPE.space &&
      'availability' in request.body &&
      request.body.availability
        ? await resolveAvailabilityHandles(location.space, request.body.availability)
        : undefined

    return {
      ...request,
      principal: createPrincipal,
      personalSpace,
      location: addressed,
      ...(availability ? { availability } : {}),
    }
  }

  return {
    contextProjectsFor,
    activeProjectsFor,
    personalSpaceFor,
    personalInstallAvailable,
    writableProject,
    resolveAvailabilityHandles,
    prepareCreate,
  }
}
