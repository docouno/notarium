import {
  ABILITY_AVAILABILITY_MODE,
  ABILITY_KIND,
  ABILITY_SAVE_OUTCOME,
  ABILITY_SAVE_STEP,
  type AbilitySaveResponse,
  type AgentAbilityAvailabilityState,
  AgentAbilityDetailResponseSchema,
  ROLE_SCOPE,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { basenameOf, directoryOf, DOCUMENT_ROLE, STORE_ERROR_REASON } from '@notarium/core'

import { clientFailureOf } from '../../libs/clientFailure'
import { AuthError } from '../auth'
import { can, type Principal, scopeAllows } from '../authz'
import {
  AbilityUnavailableError,
  type EffectiveRoleContext,
  type OwnedAbilitySnapshot,
  type OwnedAbilityTarget,
  ownedRoleLocator,
  ownedSkillLocator,
  RoleAlreadyExistsError,
  RoleInstallUnavailableError,
  type RoleLocation,
  RolePlacementUnconfirmedError,
  type RolesService,
  SkillAlreadyExistsError,
  type SkillHomeLocation,
} from '../roles'
import { readNoteAccess } from '../storeAccess'
import { AbilityPackageNotRestorableError, SystemAbilityNameConflictError } from './errors'
import { createAbilityDiscovery } from './helpers/discovery'
import { createAbilityInventory } from './helpers/inventory'
import { createAbilityPlacement } from './helpers/placement'
import { createAbilityDocumentWriter } from './helpers/save'
import type {
  AbilitiesService,
  AbilityCreateRequest,
  AbilityDocumentTarget,
  AbilityDocumentWrite,
  AbilityEditResponse,
  AgentAbilityListQuery,
  AuthoredWriteResult,
  CreateAbilitiesOptions,
  PreparedAbilityCreate,
} from './types'

const FULL_ABILITY_TOKEN_BUDGET = 1_000_000

const authoredInstructions = (title: string, body: string): string =>
  /^(?:[ \t]*\r?\n)*[ \t]*#(?!#)[ \t]+\S/.test(body) ? body : `# ${title}\n\n${body}`

const sameReach = (
  left: { mode: 'all-projects' } | { mode: 'selected-projects'; projectIds: string[] },
  right: { mode: 'all-projects' } | { mode: 'selected-projects'; projectIds: string[] },
): boolean => {
  if (
    left.mode === ABILITY_AVAILABILITY_MODE.allProjects ||
    right.mode === ABILITY_AVAILABILITY_MODE.allProjects
  ) {
    return left.mode === right.mode
  }
  const current = new Set(left.projectIds)
  const desired = new Set(right.projectIds)

  return current.size === desired.size && [...desired].every((id) => current.has(id))
}

const failedStep = (
  step: (typeof ABILITY_SAVE_STEP)[keyof typeof ABILITY_SAVE_STEP],
  error: unknown,
) => {
  const failure = error as { message?: unknown; reason?: unknown }
  const clientFailure = clientFailureOf(error)
  const versionConflict = failure.reason === STORE_ERROR_REASON.versionConflict
  let message: string

  if (versionConflict) {
    message = 'ability changed since read'
  } else if (clientFailure?.kind === 'not-found') {
    message = 'not found'
  } else if (clientFailure) {
    message = clientFailure.message
  } else {
    console.error(`[abilities] ${step} ->`, failure.message ?? error)
    message = 'internal error'
  }

  return {
    step,
    outcome: ABILITY_SAVE_OUTCOME.failed,
    error: message,
    ...(versionConflict ? { reason: STORE_ERROR_REASON.versionConflict } : {}),
  } as const
}

export const createAbilities = (options: CreateAbilitiesOptions): AbilitiesService => {
  const { roles, spaces, auth, projects, sessions, store, customCreator } = options
  const placement = createAbilityPlacement(options)
  const inventory = createAbilityInventory({ roles, spaces, auth, projects, sessions }, placement)
  const discovery = createAbilityDiscovery({ roles, spaces, projects }, placement)
  const documentWriter = createAbilityDocumentWriter(options, placement.personalSpaceFor)

  const contextFor = async (
    principal: Principal,
    locator: Parameters<AbilitiesService['get']>[2],
  ) => {
    const personalSpace = await placement.personalSpaceFor(principal)
    const project =
      locator.source === 'owned' && locator.location.scope === ROLE_SCOPE.project && projects
        ? await projects.getById(locator.location.projectId)
        : undefined

    if (
      locator.source === 'owned' &&
      locator.location.scope === ROLE_SCOPE.project &&
      (!project || project.space !== locator.location.spaceId)
    ) {
      return null
    }

    return { personalSpace, ...(project ? { project } : {}) }
  }

  const getHuman = async (
    principal: Principal,
    locator: Parameters<AbilitiesService['get']>[2],
  ) => {
    const context = await contextFor(principal, locator)

    if (!context) {
      return null
    }
    const detail = await roles.describeAbility(
      context,
      principal,
      locator,
      FULL_ABILITY_TOKEN_BUDGET,
    )

    if (!detail) {
      return null
    }
    const versions =
      locator.source === 'owned' &&
      locator.kind === ABILITY_KIND.role &&
      locator.location.scope !== ROLE_SCOPE.project
        ? await roles.listRoleVersions(
            principal,
            locator,
            context.personalSpace,
            (await placement.contextProjectsFor([locator.location.spaceId])).map(
              (entry) => entry.id,
            ),
          )
        : null
    const baseLocator =
      locator.source === 'owned' &&
      locator.kind === ABILITY_KIND.role &&
      locator.location.scope === ROLE_SCOPE.project
        ? await roles.findRoleBase(principal, locator, context.personalSpace)
        : null
    const { health, truncated, ...ability } = detail

    return AgentAbilityDetailResponseSchema.parse({
      ability: {
        ...ability,
        ...(versions ? { versions } : {}),
        ...(baseLocator ? { baseLocator } : {}),
      },
      ...(health ? { health } : {}),
      truncated,
    })
  }

  const locateOwnedPackageForDocument = async (
    principal: Principal,
    kind: Parameters<RolesService['resolveOwnedAt']>[2],
    packageId: string,
    sourceSpace: string,
    manifestPath: string,
    registryNoteId: string,
  ) => {
    const personal = await placement.personalSpaceFor(principal)
    const readableSpaces = spaces
      .list()
      .map((space) => space.id)
      .filter((space) => can(principal, 'space:read', { space }))
    const projectRows = await placement.contextProjectsFor(readableSpaces)
    const locations: RoleLocation[] = [
      ...(personal ? [{ scope: ROLE_SCOPE.personal, space: personal } as const] : []),
      ...readableSpaces
        .filter((space) => space !== personal && space === sourceSpace)
        .map((space) => ({ scope: ROLE_SCOPE.space, space }) as const),
      ...(kind === ABILITY_KIND.role
        ? projectRows
            .filter((project) => project.space === sourceSpace)
            .map(
              (project) =>
                ({
                  scope: ROLE_SCOPE.project,
                  space: project.space,
                  projectId: project.id,
                }) as const,
            )
        : []),
    ].filter((location) => location.space === sourceSpace)

    for (const location of locations) {
      if (roles.manifestPath(location, packageId) !== manifestPath) {
        continue
      }
      const found = await roles.captureOwnedAt(location, principal, kind, packageId, registryNoteId)

      if (found) {
        return found
      }
    }

    return null
  }

  const captureOwnedAuthoringTarget = async (
    principal: Principal,
    subject: Parameters<AbilitiesService['save']>[1] | OwnedAbilityTarget,
  ) => {
    const locator = 'registryNoteId' in subject ? subject.locator : subject

    if (
      !scopeAllows(principal, 'space:write') ||
      !can(principal, 'space:write', { space: locator.location.spaceId })
    ) {
      return null
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot =
        'registryNoteId' in subject
          ? await roles.captureOwnedTarget(subject, principal)
          : await roles.captureCurrentOwnedTarget(subject, principal)

      if (!snapshot) {
        return null
      }
      const context = await contextFor(principal, snapshot.locator)

      if (!context) {
        return null
      }
      const access = await readNoteAccess(store, principal, snapshot.registryNoteId, 'note:write')

      if (!access) {
        return null
      }
      if (
        access.note.versionToken &&
        access.noteId === snapshot.registryNoteId &&
        access.note.id === snapshot.registryNoteId &&
        access.note.filePath === snapshot.filePath &&
        access.note.versionToken === snapshot.versionToken
      ) {
        return { snapshot, context, access }
      }
    }

    return null
  }

  const withOwnedAuthoringTarget = async <T>(
    principal: Principal,
    subject: Parameters<AbilitiesService['save']>[1] | OwnedAbilityTarget,
    task: (target: {
      authority: OwnedAbilityTarget
      snapshot: OwnedAbilitySnapshot
      locator: OwnedAbilityTarget['locator']
      context: EffectiveRoleContext
      detail: NonNullable<Awaited<ReturnType<typeof getHuman>>> & {
        ability: Extract<
          NonNullable<Awaited<ReturnType<typeof getHuman>>>['ability'],
          { source: 'owned' }
        >
      }
      access: NonNullable<Awaited<ReturnType<typeof readNoteAccess>>>
    }) => Promise<T>,
  ): Promise<T | null> => {
    const captured = await captureOwnedAuthoringTarget(principal, subject)

    if (!captured) {
      return null
    }
    const described = await roles.describeOwnedAbility(
      captured.context,
      principal,
      captured.snapshot,
      FULL_ABILITY_TOKEN_BUDGET,
    )

    if (
      !described ||
      described.source !== 'owned' ||
      described.noteId !== captured.snapshot.registryNoteId
    ) {
      return null
    }
    const selectedLocator = captured.snapshot.locator
    const versions =
      selectedLocator.kind === ABILITY_KIND.role &&
      selectedLocator.location.scope !== ROLE_SCOPE.project
        ? await roles.listRoleVersions(
            principal,
            selectedLocator,
            captured.context.personalSpace,
            (await placement.contextProjectsFor([selectedLocator.location.spaceId])).map(
              (entry) => entry.id,
            ),
          )
        : null
    const baseLocator =
      selectedLocator.kind === ABILITY_KIND.role &&
      selectedLocator.location.scope === ROLE_SCOPE.project
        ? await roles.findRoleBase(principal, selectedLocator, captured.context.personalSpace)
        : null
    const { health, truncated, ...ability } = described
    const detail = AgentAbilityDetailResponseSchema.parse({
      ability: {
        ...ability,
        ...(versions ? { versions } : {}),
        ...(baseLocator ? { baseLocator } : {}),
      },
      ...(health ? { health } : {}),
      truncated,
    })

    return task({
      authority: captured.snapshot,
      snapshot: captured.snapshot,
      locator: captured.snapshot.locator,
      context: captured.context,
      detail: {
        ...detail,
        ability: detail.ability as Extract<typeof detail.ability, { source: 'owned' }>,
      },
      access: captured.access,
    })
  }

  const withRevalidatedTarget = <T>(
    principal: Principal,
    target: OwnedAbilityTarget,
    task: (snapshot: OwnedAbilitySnapshot) => Promise<T>,
  ): Promise<T | null> => roles.withOwnedTargetMutation(target, principal, task)

  const withFreshMetadataTarget = <T>(
    principal: Principal,
    target: OwnedAbilityTarget,
    context: EffectiveRoleContext,
    task: (
      snapshot: OwnedAbilitySnapshot,
      state: { enabled: boolean; availability?: AgentAbilityAvailabilityState },
    ) => Promise<T>,
  ): Promise<T | null> =>
    withRevalidatedTarget(principal, target, async (snapshot) => {
      const state = await roles.readOwnedAbilityMetadataState(context, principal, snapshot)

      if (!state) {
        throw new AbilityUnavailableError('no such Owned ability')
      }

      return task(snapshot, state)
    })

  const withTargetMutation =
    (
      principal: Principal,
      target: OwnedAbilityTarget,
    ): NonNullable<AbilityDocumentWrite['withTargetMutation']> =>
    async (task) => {
      const result = await withRevalidatedTarget(principal, target, task)

      if (!result) {
        throw new AbilityUnavailableError('no such Owned ability')
      }

      return result
    }

  const get = (async (
    surface: 'human' | 'authoring',
    principal: Principal,
    locator: Parameters<AbilitiesService['get']>[2],
  ) => {
    if (surface === 'human') {
      return getHuman(principal, locator)
    }
    if (!scopeAllows(principal, 'space:write') || locator.source === 'catalog') {
      return null
    }
    if (locator.source === 'owned') {
      return withOwnedAuthoringTarget(principal, locator, async (resolved) => ({
        ...resolved.detail,
        writable: true,
        versionToken: resolved.access.note.versionToken!,
      }))
    }
    const detail = await getHuman(principal, locator)

    return detail?.ability.source === 'system' ? { ...detail, writable: false } : null
  }) as AbilitiesService['get']

  const authorizeDocument: AbilitiesService['authorizeDocument'] = (principal, candidate) =>
    candidate.note.documentState?.role === DOCUMENT_ROLE.skillRoot &&
    can(principal, 'note:write', { space: candidate.space })
      ? (candidate as AbilityDocumentTarget)
      : null

  const publishedVersion = async (principal: Principal, noteId: string): Promise<string> => {
    const hit = await readNoteAccess(store, principal, noteId, 'note:read')

    if (!hit?.note.versionToken) {
      throw new Error('published ability has no readable version token')
    }

    return hit.note.versionToken
  }

  const prepareCreate = (
    principal: Principal,
    request: AbilityCreateRequest,
  ): Promise<PreparedAbilityCreate> => placement.prepareCreate(principal, request)

  const create: AbilitiesService['create'] = async (prepared, attribution, operation, complete) => {
    const systemNamePolicy = operation?.systemNamePolicy ?? 'allow'

    // A keyed call may be a replay of an already committed durable operation. Mutable
    // name inventories are checked inside that operation only after replay detection.
    if (
      prepared.source === 'custom' &&
      systemNamePolicy === 'reject' &&
      !operation?.idempotencyKey &&
      (await roles.hasSystemAbility(prepared.kind, prepared.body.name))
    ) {
      throw new SystemAbilityNameConflictError(
        `${prepared.kind} "${prepared.body.name}" conflicts with a System ability`,
      )
    }
    if (
      prepared.source === 'custom' &&
      !operation?.idempotencyKey &&
      (await roles.hasOwnedAbilityAt(prepared.location, prepared.body.name))
    ) {
      throw prepared.kind === ABILITY_KIND.role
        ? new RoleAlreadyExistsError(
            `role "${prepared.body.name}" already exists in ${prepared.location.scope}`,
          )
        : new SkillAlreadyExistsError(
            `skill "${prepared.body.name}" already exists in ${prepared.location.scope}`,
          )
    }
    if (prepared.source === 'custom') {
      if (!customCreator) {
        throw new AbilityUnavailableError('durable ability creation is unavailable on this host')
      }
      const preparePackage = async () => {
        const ready = complete ? await complete(prepared) : prepared
        const target = { kind: 'location' as const, location: ready.location }
        const personalSpace =
          ready.location.scope === ROLE_SCOPE.personal
            ? ready.location.space
            : ready.principal.userId
              ? ready.personalSpace
              : null
        const publishable =
          ready.kind === ABILITY_KIND.role
            ? roles.canAddRoleAt(target, personalSpace)
            : roles.canAddSkillAt(target)

        if (!publishable) {
          throw new RoleInstallUnavailableError(
            'role installation is unavailable for this location',
          )
        }
        const pkg =
          ready.kind === ABILITY_KIND.skill
            ? roles.prepareCustomSkill(
                ready.body.name,
                ready.body.description,
                ready.body.instructions,
              )
            : await roles.prepareCustomRole(
                ready.body.name,
                ready.body.description,
                ready.body.instructions,
                ready.location as RoleLocation,
                {
                  principal: ready.principal,
                  ...(ready.body.attachments ? { attachments: ready.body.attachments } : {}),
                  ...(ready.availability ? { availability: ready.availability } : {}),
                  personalSpace: ready.personalSpace,
                },
              )

        return { prepared: ready, pkg }
      }

      return customCreator.createDurably({
        prepared,
        attribution: attribution ?? { principal: prepared.principal.id },
        preparePackage,
        operation: { ...operation, systemNamePolicy },
      })
    }
    if (prepared.kind === ABILITY_KIND.skill) {
      const location = prepared.location as SkillHomeLocation
      const ability = await roles.addSkillFromCatalog(
        prepared.body.name,
        location,
        prepared.availability,
      )
      const locator = ownedSkillLocator(location, ability.packageId)

      return {
        kind: ABILITY_KIND.skill,
        body: prepared.body,
        location,
        ability,
        locator,
        versionToken: await publishedVersion(prepared.principal, ability.noteId),
      }
    }
    const location = prepared.location as RoleLocation
    const ability = await roles.addFromCatalog(prepared.body.name, location, prepared.personalSpace)
    const locator = ownedRoleLocator(location, ability.packageId)

    return {
      kind: ABILITY_KIND.role,
      body: prepared.body,
      location,
      ability,
      locator,
      versionToken: await publishedVersion(prepared.principal, ability.noteId),
    }
  }

  const applyAvailability = async (
    principal: Principal,
    target: OwnedAbilityTarget,
    availability: AgentAbilityAvailabilityState,
  ) => {
    const { locator } = target

    if (locator.location.scope !== ROLE_SCOPE.space || !projects) {
      throw new AbilityUnavailableError('availability needs a Space ability')
    }
    if (availability.mode === ABILITY_AVAILABILITY_MODE.selectedProjects) {
      const projectRows = await Promise.all(
        availability.projectIds.map((projectId) => projects.getById(projectId)),
      )

      if (projectRows.some((project) => !project || project.space !== locator.location.spaceId)) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
    }
    await roles.setAbilityAvailability(
      { personalSpace: await placement.personalSpaceFor(principal) },
      principal,
      target,
      availability,
    )
  }

  const setAvailability: AbilitiesService['setAvailability'] = async (
    principal,
    locator,
    availability,
  ) => {
    const applied = await withOwnedAuthoringTarget(principal, locator, async ({ authority }) => {
      return withRevalidatedTarget(principal, authority, async (snapshot) => {
        await applyAvailability(principal, snapshot, availability)
        return true
      })
    })

    if (!applied) {
      throw new AbilityUnavailableError('no such Owned ability')
    }
  }

  const setHome: AbilitiesService['setHome'] = async (principal, locator) => {
    const target = await withOwnedAuthoringTarget(
      principal,
      locator,
      async ({ snapshot, context }) =>
        snapshot.locator.kind === ABILITY_KIND.role ? { snapshot, context } : null,
    )

    if (!target || target.snapshot.locator.kind !== ABILITY_KIND.role) {
      throw new AbilityUnavailableError('no such Owned Role')
    }
    if (target.snapshot.locator.location.scope === ROLE_SCOPE.space) {
      const state = await roles.readOwnedAbilityMetadataState(
        target.context,
        principal,
        target.snapshot,
      )

      if (!state?.availability) {
        throw new AbilityUnavailableError('no such Owned Role')
      }

      return {
        locator: target.snapshot.locator,
        availability: state.availability,
        noteId: target.snapshot.registryNoteId,
      }
    }
    const moved = await roles.moveRolePlacement(
      principal,
      target.snapshot as OwnedAbilityTarget & {
        locator: Extract<OwnedAbilityTarget['locator'], { kind: 'role' }>
      },
      await placement.personalSpaceFor(principal),
    )

    return { locator: moved.locator, availability: moved.availability!, noteId: moved.role.noteId }
  }

  const setEnabled: AbilitiesService['setEnabled'] = async (principal, locator, enabled) => {
    if (locator.source === 'owned') {
      // The legacy human toggle is an owner-scoped preference, not package authoring:
      // a reader may disable a readable ability for themselves. Agent edit/save paths
      // intentionally do not call this door and keep the writer-only helper above.
      const captured = await roles.captureCurrentOwnedTarget(locator, principal)
      const context = captured ? await contextFor(principal, captured.locator) : null
      const applied =
        captured && context
          ? await roles.withOwnedTargetMutation(captured, principal, async (snapshot) => {
              await roles.setEnabled(context, principal, snapshot, enabled)
              return true
            })
          : null

      if (!applied) {
        throw new AbilityUnavailableError('no such ability')
      }

      return
    }
    const context = await contextFor(principal, locator)

    if (!context) {
      throw new AbilityUnavailableError('no such ability')
    }
    await roles.setEnabled(context, principal, locator, enabled)
  }

  const save: AbilitiesService['save'] = async (principal, requestedLocator, request) => {
    const resolved = await withOwnedAuthoringTarget(
      principal,
      requestedLocator,
      async (admitted) => {
        const { locator, access } = admitted

        if (request.attachments !== undefined && locator.kind !== ABILITY_KIND.role) {
          throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'Skill abilities do not have attachments')
        }
        const target = authorizeDocument(principal, {
          store: access.store,
          space: access.space,
          note: access.note,
        })

        if (!target) {
          throw new AbilityUnavailableError('no such Owned ability')
        }
        const commitDocument = await documentWriter.prepareDocument(principal, {
          target,
          input: documentWriter.writeInput({
            content: request.content,
            description: request.description,
            noteId: access.noteId,
            versionToken: request.versionToken,
            principal: principal.id,
          }),
          description: request.description,
          ...(request.attachments !== undefined && locator.kind === ABILITY_KIND.role
            ? {
                locator: {
                  ...admitted.snapshot,
                  locator: admitted.snapshot.locator as Extract<
                    OwnedAbilitySnapshot['locator'],
                    { kind: 'role' }
                  >,
                },
                attachments: request.attachments,
              }
            : {}),
          semanticNoop: true,
          withTargetMutation: withTargetMutation(principal, admitted.authority),
        })

        return { ...admitted, commitDocument }
      },
    )

    if (!resolved) {
      throw new AbilityUnavailableError('no such Owned ability')
    }
    const { locator } = resolved
    const authored = await resolved.commitDocument()
    const steps: AbilitySaveResponse['steps'] = [
      { step: ABILITY_SAVE_STEP.document, outcome: authored.outcome },
    ]
    let currentLocator = locator
    let currentTarget = resolved.authority

    if (
      requestedLocator.kind === ABILITY_KIND.role &&
      requestedLocator.location.scope === ROLE_SCOPE.project &&
      currentLocator.kind === ABILITY_KIND.role &&
      currentLocator.location.scope === ROLE_SCOPE.space
    ) {
      steps.push({ step: ABILITY_SAVE_STEP.home, outcome: ABILITY_SAVE_OUTCOME.skipped })
    }

    if (
      currentLocator.kind === ABILITY_KIND.role &&
      currentLocator.location.scope === ROLE_SCOPE.project
    ) {
      const staysInProject =
        request.covers !== null &&
        request.covers.length === 1 &&
        request.covers[0] === currentLocator.location.projectId

      if (!staysInProject) {
        try {
          const movedRole = await roles.moveRolePlacement(
            principal,
            currentTarget as OwnedAbilityTarget & {
              locator: Extract<OwnedAbilityTarget['locator'], { kind: 'role' }>
            },
            await placement.personalSpaceFor(principal),
          )
          const moved = {
            locator: movedRole.locator,
            availability: movedRole.availability!,
            noteId: movedRole.role.noteId,
          }
          currentLocator = moved.locator
          currentTarget = movedRole.target
          steps.push({ step: ABILITY_SAVE_STEP.home, outcome: ABILITY_SAVE_OUTCOME.applied })
        } catch (error) {
          // A move can fail AFTER it committed, and then the package is at its new
          // home whatever this step reports. The locator is the address the client
          // reads and retries with, so it follows the package rather than the step.
          if (error instanceof RolePlacementUnconfirmedError) {
            currentLocator = error.locator
          }
          steps.push(failedStep(ABILITY_SAVE_STEP.home, error))
          return {
            locator: currentLocator,
            noteId: authored.id,
            versionToken: authored.versionToken,
            steps,
          }
        }
      }
    }
    if (currentLocator.location.scope === ROLE_SCOPE.space) {
      const desired: AgentAbilityAvailabilityState =
        request.covers === null
          ? { mode: ABILITY_AVAILABILITY_MODE.allProjects }
          : {
              mode: ABILITY_AVAILABILITY_MODE.selectedProjects,
              projectIds: [...new Set(request.covers)],
            }

      try {
        const outcome = await withOwnedAuthoringTarget(principal, currentTarget, async (live) =>
          withFreshMetadataTarget(
            principal,
            live.authority,
            live.context,
            async (snapshot, state) => {
              const current: AgentAbilityAvailabilityState =
                state.availability ??
                (snapshot.locator.kind === ABILITY_KIND.role
                  ? { mode: ABILITY_AVAILABILITY_MODE.allProjects }
                  : { mode: ABILITY_AVAILABILITY_MODE.selectedProjects, projectIds: [] })

              if (sameReach(current, desired)) {
                return ABILITY_SAVE_OUTCOME.skipped
              }

              await applyAvailability(principal, snapshot, desired)
              return ABILITY_SAVE_OUTCOME.applied
            },
          ),
        )

        if (!outcome) {
          throw new AbilityUnavailableError('no such Owned ability')
        }
        steps.push({ step: ABILITY_SAVE_STEP.availability, outcome })
      } catch (error) {
        steps.push(failedStep(ABILITY_SAVE_STEP.availability, error))
        return {
          locator: currentLocator,
          noteId: authored.id,
          versionToken: authored.versionToken,
          steps,
        }
      }
    }
    if (request.enabled !== undefined) {
      try {
        const outcome = await withOwnedAuthoringTarget(principal, currentTarget, async (live) =>
          withFreshMetadataTarget(
            principal,
            live.authority,
            live.context,
            async (snapshot, state) => {
              if (request.enabled === state.enabled) {
                return ABILITY_SAVE_OUTCOME.skipped
              }

              await roles.setEnabled(live.context, principal, snapshot, request.enabled!)
              return ABILITY_SAVE_OUTCOME.applied
            },
          ),
        )

        if (!outcome) {
          throw new AbilityUnavailableError('no such Owned ability')
        }
        steps.push({ step: ABILITY_SAVE_STEP.enabled, outcome })
      } catch (error) {
        steps.push(failedStep(ABILITY_SAVE_STEP.enabled, error))
      }
    }

    return {
      locator: currentLocator,
      noteId: authored.id,
      versionToken: authored.versionToken,
      steps,
    }
  }

  const edit: AbilitiesService['edit'] = async (principal, requestedLocator, request) => {
    const authored =
      request.description !== undefined ||
      request.instructions !== undefined ||
      request.attachments !== undefined

    if (authored && !request.versionToken) {
      throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'versionToken is required for authored fields')
    }
    const resolved = await withOwnedAuthoringTarget(
      principal,
      requestedLocator,
      async (admitted) => {
        const { locator, detail, access } = admitted

        if (request.attachments !== undefined && locator.kind !== ABILITY_KIND.role) {
          throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'Skill abilities do not have attachments')
        }
        if (!authored) {
          return admitted
        }
        const target = authorizeDocument(principal, {
          store: access.store,
          space: access.space,
          note: access.note,
        })

        if (!target) {
          throw new AbilityUnavailableError('no such Owned ability')
        }
        const commitDocument = await documentWriter.prepareDocument(principal, {
          target,
          input: documentWriter.writeInput({
            content:
              request.instructions ??
              authoredInstructions(detail.ability.title, detail.ability.instructions),
            description: request.description ?? detail.ability.description,
            noteId: access.noteId,
            versionToken: request.versionToken!,
            principal: principal.id,
          }),
          description: request.description ?? detail.ability.description,
          ...(request.attachments !== undefined && locator.kind === ABILITY_KIND.role
            ? {
                locator: {
                  ...admitted.snapshot,
                  locator: admitted.snapshot.locator as Extract<
                    OwnedAbilitySnapshot['locator'],
                    { kind: 'role' }
                  >,
                },
                attachments: request.attachments,
              }
            : {}),
          semanticNoop: true,
          withTargetMutation: withTargetMutation(principal, admitted.authority),
        })

        return { ...admitted, commitDocument }
      },
    )

    if (!resolved) {
      throw new AbilityUnavailableError('no such Owned ability')
    }
    const { locator } = resolved
    const steps: AbilityEditResponse['steps'] = []
    let currentLocator = locator
    let currentTarget = resolved.authority
    let versionToken: string | undefined

    if (authored) {
      if (!('commitDocument' in resolved)) {
        throw new Error('ability document preparation produced no result')
      }
      let written: AuthoredWriteResult

      try {
        written = await resolved.commitDocument()
      } catch (writeError) {
        const failure = failedStep(ABILITY_SAVE_STEP.document, writeError)
        steps.push(
          failure.reason === STORE_ERROR_REASON.versionConflict
            ? {
                ...failure,
                error:
                  'ability changed since read; call get_ability with the returned ref and retry with its versionToken',
              }
            : failure,
        )
        return { locator: currentLocator, steps }
      }
      versionToken = written.versionToken
      steps.push({ step: ABILITY_SAVE_STEP.document, outcome: written.outcome })
    }

    if (request.home) {
      if (
        currentLocator.kind === ABILITY_KIND.role &&
        currentLocator.location.scope === ROLE_SCOPE.project
      ) {
        try {
          const moved = await roles.moveRolePlacement(
            principal,
            currentTarget as OwnedAbilityTarget & {
              locator: Extract<OwnedAbilityTarget['locator'], { kind: 'role' }>
            },
            await placement.personalSpaceFor(principal),
          )
          currentLocator = moved.locator
          currentTarget = moved.target
          steps.push({ step: ABILITY_SAVE_STEP.home, outcome: ABILITY_SAVE_OUTCOME.applied })
        } catch (error) {
          // Same reason as the covers-driven move above: an unconfirmed move is still
          // a committed one, and the answer has to address the home the role now has.
          if (error instanceof RolePlacementUnconfirmedError) {
            currentLocator = error.locator
          }
          steps.push(failedStep(ABILITY_SAVE_STEP.home, error))
          return { locator: currentLocator, ...(versionToken ? { versionToken } : {}), steps }
        }
      } else if (
        currentLocator.kind === ABILITY_KIND.role &&
        currentLocator.location.scope === ROLE_SCOPE.space
      ) {
        steps.push({ step: ABILITY_SAVE_STEP.home, outcome: ABILITY_SAVE_OUTCOME.skipped })
      } else {
        steps.push(
          failedStep(
            ABILITY_SAVE_STEP.home,
            new AbilityUnavailableError('only a project Role can move to a Space home'),
          ),
        )
        return { locator: currentLocator, ...(versionToken ? { versionToken } : {}), steps }
      }
    }

    if (request.availability) {
      if (currentLocator.location.scope !== ROLE_SCOPE.space) {
        steps.push(
          failedStep(
            ABILITY_SAVE_STEP.availability,
            new AbilityUnavailableError('availability needs a Space ability'),
          ),
        )
        return { locator: currentLocator, ...(versionToken ? { versionToken } : {}), steps }
      }
      try {
        const desired = await placement.resolveAvailabilityHandles(
          currentLocator.location.spaceId,
          request.availability,
        )
        const outcome = await withOwnedAuthoringTarget(principal, currentTarget, async (live) =>
          withFreshMetadataTarget(
            principal,
            live.authority,
            live.context,
            async (snapshot, state) => {
              const current: AgentAbilityAvailabilityState =
                state.availability ??
                (snapshot.locator.kind === ABILITY_KIND.role
                  ? { mode: ABILITY_AVAILABILITY_MODE.allProjects }
                  : { mode: ABILITY_AVAILABILITY_MODE.selectedProjects, projectIds: [] })

              if (sameReach(current, desired)) {
                return ABILITY_SAVE_OUTCOME.skipped
              }

              await applyAvailability(principal, snapshot, desired)
              return ABILITY_SAVE_OUTCOME.applied
            },
          ),
        )

        if (!outcome) {
          throw new AbilityUnavailableError('no such Owned ability')
        }
        steps.push({ step: ABILITY_SAVE_STEP.availability, outcome })
      } catch (error) {
        steps.push(failedStep(ABILITY_SAVE_STEP.availability, error))
        return { locator: currentLocator, ...(versionToken ? { versionToken } : {}), steps }
      }
    }

    if (request.enabled !== undefined) {
      try {
        const outcome = await withOwnedAuthoringTarget(principal, currentTarget, async (live) =>
          withFreshMetadataTarget(
            principal,
            live.authority,
            live.context,
            async (snapshot, state) => {
              if (request.enabled === state.enabled) {
                return ABILITY_SAVE_OUTCOME.skipped
              }

              await roles.setEnabled(live.context, principal, snapshot, request.enabled!)
              return ABILITY_SAVE_OUTCOME.applied
            },
          ),
        )

        if (!outcome) {
          throw new AbilityUnavailableError('no such Owned ability')
        }
        steps.push({ step: ABILITY_SAVE_STEP.enabled, outcome })
      } catch (error) {
        steps.push(failedStep(ABILITY_SAVE_STEP.enabled, error))
      }
    }

    return { locator: currentLocator, ...(versionToken ? { versionToken } : {}), steps }
  }

  const removeOwnedPackage = async ({
    principal,
    authority,
    target,
    attribution,
    failClosed,
  }: {
    principal: Principal
    authority: OwnedAbilityTarget
    target: AbilityDocumentTarget
    attribution: Parameters<AbilitiesService['remove']>[2]
    failClosed: boolean
  }): Promise<boolean> => {
    if (!target.note.filePath || !target.store.removeDir) {
      return false
    }

    return roles.inspectAndRemoveOwned(authority, await placement.personalSpaceFor(principal), {
      assertSafe: (files, inspectedMembers) => {
        const members = inspectedMembers ?? [...files.keys()]
        const resource =
          failClosed && (members.length !== 1 || members[0] !== 'SKILL.md')
            ? (members.find((path) => path !== 'SKILL.md') ?? members[0] ?? 'missing SKILL.md')
            : undefined

        if (resource) {
          throw new AbilityPackageNotRestorableError(
            `ability package contains auxiliary member "${resource}"; remove it in the Agents UI`,
          )
        }
      },
      remove: (beforeDetach) =>
        target.store.removeDir!(directoryOf(target.note.filePath!), {
          principal: attribution.principal,
          ...(attribution.agent ? { agent: attribution.agent } : {}),
          internalAddress: true,
          ...(failClosed ? { requiredRevision: true } : {}),
          beforeDetach: async (victimNoteIds) => {
            if (
              failClosed &&
              (victimNoteIds?.length !== 1 || victimNoteIds[0] !== authority.registryNoteId)
            ) {
              throw new AbilityPackageNotRestorableError(
                'ability package has auxiliary indexed members; remove it in the Agents UI',
              )
            }
            await beforeDetach(victimNoteIds)
          },
        }),
    })
  }

  const list = (async (surface, context, principal, query) =>
    surface === 'human'
      ? inventory.listHuman(principal, (context as { kind: 'role' | 'skill' }).kind, query)
      : surface === 'bundle'
        ? discovery.bundle(context as EffectiveRoleContext, principal)
        : discovery.list(
            surface,
            context as EffectiveRoleContext,
            principal,
            query as AgentAbilityListQuery,
          )) as AbilitiesService['list']

  return {
    personalSpaceFor: placement.personalSpaceFor,
    list,
    personalContext: inventory.personalContext,
    get,
    prepareCreate,
    create,
    createVersion: async (principal, locator, projectId) => {
      if (!projects) {
        throw new AbilityUnavailableError('projects are unavailable')
      }
      const project = await projects.getById(projectId)

      if (
        !project ||
        project.status !== 'active' ||
        project.space !== locator.location.spaceId ||
        !can(principal, 'space:write', { space: project.space })
      ) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
      const source = await captureOwnedAuthoringTarget(principal, locator)

      if (
        !source ||
        source.snapshot.locator.kind !== ABILITY_KIND.role ||
        source.snapshot.locator.location.scope !== ROLE_SCOPE.space
      ) {
        throw new AbilityUnavailableError('no such Owned Role')
      }
      const version = await roles.createRoleVersion(
        principal,
        { ...source.snapshot, locator: source.snapshot.locator },
        source.context.personalSpace,
        project.id,
      )
      const next = ownedRoleLocator(
        { scope: ROLE_SCOPE.project, space: version.space, projectId: project.id },
        version.packageId,
      )

      return {
        locator: next,
        noteId: version.noteId,
        versionToken: await publishedVersion(principal, version.noteId),
      }
    },
    authorizeDocument,
    writeDocument: documentWriter.writeDocument,
    save,
    edit,
    setHome,
    setAvailability,
    setEnabled,
    removeDocument: async (principal, target, attribution) => {
      const live = target.note

      if (
        live.documentState?.role !== DOCUMENT_ROLE.skillRoot ||
        live.filePath == null ||
        !target.store.removeDir
      ) {
        return false
      }
      const skill = live.documentState.projection?.skill
      const packageId = basenameOf(directoryOf(live.filePath))
      const authority =
        skill && live.id
          ? await locateOwnedPackageForDocument(
              principal,
              skill.role ? ABILITY_KIND.role : ABILITY_KIND.skill,
              packageId,
              target.space,
              live.filePath,
              live.id,
            )
          : null

      if (authority) {
        return removeOwnedPackage({ principal, authority, target, attribution, failClosed: false })
      }
      await target.store.removeDir(directoryOf(live.filePath), {
        principal: attribution.principal,
        internalAddress: true,
        beforeDetach: (victimNoteIds) => {
          if (!live.id || !victimNoteIds?.includes(live.id)) {
            throw new AbilityUnavailableError('ability document changed before delete')
          }
        },
      })
      return true
    },
    remove: async (principal, requestedLocator, attribution) => {
      const resolved = await withOwnedAuthoringTarget(
        principal,
        requestedLocator,
        async (target) => target,
      )

      if (!resolved) {
        throw new AbilityUnavailableError('no such Owned ability')
      }
      const { locator, detail, access } = resolved
      const target = access
        ? authorizeDocument(principal, {
            store: access.store,
            space: access.space,
            note: access.note,
          })
        : null

      if (!target || !target.note.filePath || !target.store.removeDir) {
        throw new AbilityUnavailableError('ability package cannot be removed')
      }
      const removed = await removeOwnedPackage({
        principal,
        authority: resolved.authority,
        target,
        attribution,
        failClosed: true,
      })

      if (!removed) {
        throw new AbilityUnavailableError('ability package cannot be removed')
      }

      return { locator, name: detail.ability.name }
    },
  }
}
