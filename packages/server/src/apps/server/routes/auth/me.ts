// The principal's own corner: /api/me* self-management routes. Me-scoped authz
// (self:read/self:manage, never a space membership check); the personal-domain
// slug never crosses the wire. Handlers throw AuthError; the root error handler
// maps it to the wire envelope.
// canon: docs/auth.md#model · docs/projects.md#personal-domain-as-a-working-space-13-2026-06-20
import type { FastifyInstance, FastifyRequest } from 'fastify'

import {
  ABILITY_AVAILABILITY_MODE,
  ABILITY_KIND,
  AddAgentRoleRequestSchema,
  AddAgentRoleResponseSchema,
  type AddAgentSkillRequest,
  AddAgentSkillRequestSchema,
  AddAgentSkillResponseSchema,
  type AgentAbilityAvailability,
  AgentAbilityDetailResponseSchema,
  type AgentAbilitySummary,
  AgentAuditQuerySchema,
  AgentAuditResponseSchema,
  AgentContextQuerySchema,
  AgentPackageLibraryQuerySchema,
  AgentSessionEventsQuerySchema,
  AgentSessionEventsResponseSchema,
  AgentSessionsQuerySchema,
  AgentSessionsResponseSchema,
  type AgentSkillSummary,
  ConnectionPatchRequestSchema,
  ConnectionsResponseSchema,
  CONTEXT_KIND,
  ContextOrderRequestSchema,
  ContextPinRequestSchema,
  CreateAbilityVersionRequestSchema,
  CreateAbilityVersionResponseSchema,
  CreateAgentRoleRequestSchema,
  CreateAgentRoleResponseSchema,
  type CreateAgentSkillRequest,
  CreateAgentSkillRequestSchema,
  CreateAgentSkillResponseSchema,
  MeAgentContextResponseSchema,
  MeAgentRolesResponseSchema,
  MeAgentSkillsResponseSchema,
  MeMemoryQuerySchema,
  MeMemoryResponseSchema,
  MeSchema,
  OkResponseSchema,
  type OwnedAbilityLocation,
  type OwnedAbilityLocator,
  PasswordChangeRequestSchema,
  PatCreateRequestSchema,
  PatCreateResponseSchema,
  PatPatchRequestSchema,
  PatsResponseSchema,
  ProfilePutRequestSchema,
  ProfileResponseSchema,
  PROJECT_STATUS,
  type RoleInventoryEntry,
  SetAbilityHomeRequestSchema,
  SetAbilityHomeResponseSchema,
  SetAgentAbilityAvailabilityRequestSchema,
  SetAgentAbilityAvailabilityResponseSchema,
  SetAgentAbilityEnabledRequestSchema,
  SetAgentAbilityEnabledResponseSchema,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { AgentSessionIdSchema } from '@notarium/contract/tools'
import { decodeAbilityLocator, encodeAbilityLocator } from '@notarium/core'

import { withAuthors } from '../../../../libs/authors'
import { AGENT_SESSION_IDLE_MS } from '../../../../services/agentSessions'
import { AuthError, type AuthService } from '../../../../services/auth'
import { agentOwnerOf, can } from '../../../../services/authz'
import { projectSummaryOf } from '../../../../services/mcp/helpers/projectAddressing'
import type {
  AgentSessionAuditEvent,
  AgentSessionAuditPersistence,
  AgentSessionsPersistence,
  ContextOrderPersistence,
  ContextSetsPersistence,
  ProjectRecord,
  ProjectsPersistence,
  RetrievalLogPersistence,
  ScopePinsPersistence,
} from '../../../../services/metaDb'
import {
  abilityReachesProject,
  CatalogRoleNotFoundError,
  CatalogSkillNotFoundError,
  ownedRoleLocator,
  ownedSkillLocator,
  ROLE_SCOPE,
  RoleAlreadyExistsError,
  RoleDependencyConflictError,
  type RolesService,
  SkillAlreadyExistsError,
  weighRoleContext,
} from '../../../../services/roles'
import {
  curatePersonalScope,
  ensurePersonalSpaceFor,
  listMemoryCategories,
  peekPersonalSpace,
  PERSONAL_TOKEN_BUDGET,
  readProfileNote,
  type SpaceManager,
  weighAlwaysLoad,
  writeProfileNote,
} from '../../../../services/spaces'
import {
  readNoteAccess,
  type StoreAccess,
  weighScopeContextSets,
  weighScopeOrder,
  weighScopePins,
} from '../../../../services/storeAccess'
import { contextRoleSummaryOf, roleContextViewOf } from '../wire'
import { authz, setSessionCookie } from './_helpers'
import {
  type PackageLibraryCandidate,
  PackageLibraryCursorError,
  pagePackageLibrary,
} from './packageLibrary'

const encodeAuditCursor = (value: Record<string, string>): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')

const isCanonicalIsoInstant = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false
  }
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

const isPositiveSqliteInteger = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return false
  }
  try {
    const n = BigInt(value)
    return n > 0n && n <= 9_223_372_036_854_775_807n
  } catch {
    return false
  }
}

const decodeSummaryCursor = (raw: string | undefined): { at: string; id: string } | undefined => {
  if (!raw) {
    return undefined
  }
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >

    if (isCanonicalIsoInstant(value.at) && AgentSessionIdSchema.safeParse(value.id).success) {
      return { at: value.at, id: value.id as string }
    }
  } catch {
    throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'bad cursor')
  }
  throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'bad cursor')
}

const decodeEventCursor = (
  raw: string | undefined,
): { at: string; source: 'retrieval' | 'write'; id: string } | undefined => {
  if (!raw) {
    return undefined
  }
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >

    if (
      isCanonicalIsoInstant(value.at) &&
      isPositiveSqliteInteger(value.id) &&
      (value.source === 'retrieval' || value.source === 'write')
    ) {
      return { at: value.at, id: value.id, source: value.source }
    }
  } catch {
    throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'bad cursor')
  }
  throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'bad cursor')
}

const sessionEventToWire = (event: AgentSessionAuditEvent) => {
  if (event.type === 'write') {
    return event
  }
  const r = event.record
  return {
    type: 'retrieval' as const,
    id: r.id,
    at: r.createdAt,
    tool: r.tool,
    query: r.query,
    project: r.project,
    classFilter: r.classFilter,
    resultCount: r.resultCount,
    topScore: r.topScore,
    hits: r.hits,
    agent: r.agent,
    principal: r.principal,
    sessionId: r.sessionId,
    sessionName: r.sessionName,
    sessionAttach: r.sessionAttach,
  }
}

const emptyRetrievalAggregates = () => ({
  totalQueries: 0,
  missCount: 0,
  top: [],
  misses: [],
})

const ROLE_DETAIL_TOKEN_BUDGET = 65_536
const ROLE_INVENTORY_LOCATION_LIMIT = 128
const ROLE_PROJECT_SUMMARY_LIMIT = 128
const SKILL_INVENTORY_LOCATION_LIMIT = 128
const SKILL_PROJECT_SUMMARY_LIMIT = 128

type OwnedRoleSummary = Extract<AgentAbilitySummary, { source: 'owned' }>
type ProjectRoleLocator = Extract<OwnedAbilityLocator, { kind: 'role' }> & {
  location: Extract<OwnedAbilityLocation, { scope: 'project' }>
}
/** One role as the library shows it: the base that owns the name, plus the project
 *  versions that override it. Either half may be missing — a Space role with no
 *  override, or an override whose base was never created. */
type OwnedRoleGroup = {
  base?: OwnedRoleSummary
  versions: Array<OwnedRoleSummary & { locator: ProjectRoleLocator }>
}

/** Where a just-published Role landed, in the shape the wire states it. A project
 *  placement CANNOT be spelled without the handle the caller named — the literal that
 *  used to fill it in with `''` when the branch was unreachable is now unwritable. */
type PublishedRolePlacement =
  | { scope: typeof ROLE_SCOPE.personal }
  | { scope: typeof ROLE_SCOPE.space; space: string }
  | { scope: typeof ROLE_SCOPE.project; space: string; project: string }

/** The wire form of a Role that was just published. One producer, because it was
 *  written four times — a personal special case plus one literal per endpoint — and
 *  the copies had already diverged in what they spelled back. */
const publishedRoleForWire = (
  role: {
    name: string
    title: string
    description: string
    noteId: string
    origin?: string
    originRevision?: string
  },
  placement: PublishedRolePlacement,
): RoleInventoryEntry => ({
  name: role.name,
  title: role.title,
  description: role.description,
  noteId: role.noteId,
  ...placement,
  ...(role.origin !== undefined ? { origin: role.origin } : {}),
  ...(role.originRevision !== undefined ? { originRevision: role.originRevision } : {}),
})

/** The placement half, resolved once: the space by its slug, and the project by the
 *  handle the caller named. Kept beside the builder so the two endpoints cannot spell
 *  the same landing differently. */
const rolePlacementForWire = (
  role: { scope: RoleInventoryEntry['scope']; space: string },
  project: string,
  slugOf: (space: string) => string | undefined,
): PublishedRolePlacement =>
  role.scope === ROLE_SCOPE.personal
    ? { scope: ROLE_SCOPE.personal }
    : role.scope === ROLE_SCOPE.space
      ? { scope: ROLE_SCOPE.space, space: slugOf(role.space) ?? role.space }
      : { scope: ROLE_SCOPE.project, space: slugOf(role.space) ?? role.space, project }

/** The wire form of a Skill that was just published — the same one answer for both
 *  entries. Space placement carries a reach, and it is normalised HERE rather than
 *  echoed raw: one endpoint deduplicated the projects it sent back and the other did
 *  not, so the same request produced two different answers depending on which door it
 *  came through. */
const publishedSkillForWire = (
  skill: {
    name: string
    title: string
    description: string
    noteId: string
    scope: RoleInventoryEntry['scope']
    space: string
    origin?: string
    originRevision?: string
  },
  space: { space: string; availability: AgentAbilityAvailability } | null,
): AgentSkillSummary => {
  const identity = {
    name: skill.name,
    title: skill.title,
    description: skill.description,
    noteId: skill.noteId,
    ...(skill.origin !== undefined ? { origin: skill.origin } : {}),
    ...(skill.originRevision !== undefined ? { originRevision: skill.originRevision } : {}),
  }

  return space
    ? {
        ...identity,
        scope: ROLE_SCOPE.space,
        space: space.space,
        availability:
          space.availability.mode === ABILITY_AVAILABILITY_MODE.allProjects
            ? space.availability
            : {
                mode: ABILITY_AVAILABILITY_MODE.selectedProjects,
                projects: [...new Set(space.availability.projects)],
              },
      }
    : { ...identity, scope: ROLE_SCOPE.personal }
}

export const meRoutes = async (
  app: FastifyInstance,
  {
    spaces,
    auth,
    storeAccess,
    contextSets,
    scopePins,
    contextOrder,
    retrievalLog,
    sessionAudit,
    roles,
    sessions,
    projects: projectsForRoles,
  }: {
    spaces: SpaceManager
    auth: AuthService
    storeAccess: StoreAccess
    contextSets?: ContextSetsPersistence
    scopePins?: ScopePinsPersistence
    contextOrder?: ContextOrderPersistence
    retrievalLog?: RetrievalLogPersistence
    sessionAudit?: AgentSessionAuditPersistence
    roles?: RolesService
    sessions?: AgentSessionsPersistence
    projects?: ProjectsPersistence
  },
) => {
  /** Every project of these spaces, archived ones included. A reach that names a
   * project does not stop naming it when the project is archived, and a list that
   * omitted it would make the reach unreadable — and unsendable, since the client
   * can only echo back what it was shown. Surfaces that OFFER a project to create
   * something in filter by status themselves; being nameable and being a valid
   * destination are different questions. */
  const contextProjectsFor = async (readableSpaces: string[]) =>
    !projectsForRoles || !readableSpaces.length
      ? []
      : projectsForRoles.listForSpaces(readableSpaces)

  const activeProjectsFor = async (readableSpaces: string[]) =>
    (await contextProjectsFor(readableSpaces)).filter(
      (project) => project.status === PROJECT_STATUS.active,
    )

  const publishedVersion = async (req: FastifyRequest, noteId: string): Promise<string> => {
    const hit = await readNoteAccess(storeAccess, req.principal, noteId, 'note:read')

    if (!hit?.note.versionToken) {
      throw new Error('published ability has no readable version token')
    }

    return hit.note.versionToken
  }

  /** Publication requests name projects by handle — the caller is creating the
   *  ability and has no ids yet — while the reach itself is keyed by stable ids. A
   *  handle outside the ability's home space is a 404, not a silently dropped entry. */
  const resolveAvailabilityHandles = async (
    space: string,
    availability: AgentAbilityAvailability,
  ) => {
    if (availability.mode === ABILITY_AVAILABILITY_MODE.allProjects) {
      return { mode: ABILITY_AVAILABILITY_MODE.allProjects }
    }
    const projects = await contextProjectsFor([space])
    const byHandle = new Map(
      projects.map((project) => [
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

  /** The caller's own library, minted on demand. Owning a personal space is the
   *  ordinary case, but it is not a given: where the host cannot mint one, the
   *  resolver honestly degrades to the first space it can see (P5), and that space is
   *  somebody's shared library — so writability is asked either way. */
  const writablePersonalSpace = async (req: FastifyRequest): Promise<string> => {
    if (!req.principal.username && !req.principal.system) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    const personal = req.principal.username
      ? await ensurePersonalSpaceFor({ auth, spaces }, req.principal.username)
      : spaces.list()[0]?.id

    if (!personal || !can(req.principal, 'space:write', { space: personal })) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }

    return personal
  }

  /** A SHARED space, named the way the client names it. A personal one is refused
   *  rather than silently accepted: Personal and a Space root are one directory, and
   *  the two scopes do not carry the same writer rules. */
  const writableSharedSpace = async (req: FastifyRequest, slug: string): Promise<string> => {
    const space = spaces.resolveId(slug)

    if (
      !space ||
      !can(req.principal, 'space:write', { space }) ||
      (await auth.isPersonalSpace(space))
    ) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }

    return space
  }

  /** A project by the handle the client sends, searched across every space the caller
   *  can read — the handle is space-qualified, so the search is not a guess. An absent
   *  handle names no project, which is the same answer as naming a missing one. */
  const writableProject = async (
    req: FastifyRequest,
    handle: string | undefined,
  ): Promise<ProjectRecord> => {
    const readableSpaces = spaces
      .list()
      .map((space) => space.id)
      .filter((space) => can(req.principal, 'space:read', { space }))
    const project = (await activeProjectsFor(readableSpaces)).find(
      (entry) =>
        projectSummaryOf(entry, spaces.slugOf(entry.space) ?? entry.space).handle === handle,
    )

    if (!project || !can(req.principal, 'space:write', { space: project.space })) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }

    return project
  }

  const skillPlacementFor = async (
    req: FastifyRequest,
    body: AddAgentSkillRequest | CreateAgentSkillRequest,
  ) => {
    if (body.scope === ROLE_SCOPE.personal) {
      return {
        location: { scope: ROLE_SCOPE.personal, space: await writablePersonalSpace(req) } as const,
        availability: undefined,
      }
    }
    const space = await writableSharedSpace(req, body.space)

    return {
      location: { scope: ROLE_SCOPE.space, space } as const,
      availability: await resolveAvailabilityHandles(space, body.availability),
    }
  }

  app.get('/api/me', { config: authz('self:read', 'host') }, async (req) => {
    if (!req.principal.username) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    } // 'none' mode: no user to describe

    return MeSchema.parse(await auth.me(req.principal.username))
  })

  app.post('/api/me/password', { config: authz('self:manage', 'host') }, async (req, reply) => {
    const body = PasswordChangeRequestSchema.parse(req.body ?? {})

    if (!req.principal.username) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    // The change drops every session (other devices included); the fresh
    // token keeps THIS tab logged in.
    const { sessionToken } = await auth.changePassword(
      req.principal.username,
      body.currentPassword,
      body.newPassword,
    )
    setSessionCookie(req, reply, sessionToken)
    return OkResponseSchema.parse({ ok: true })
  })

  app.get('/api/me/tokens', { config: authz('self:manage', 'host') }, async (req) => {
    if (!req.principal.username) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }

    return PatsResponseSchema.parse({ tokens: await auth.listPats(req.principal.username) })
  })

  // The wire narrows by slug; grants key on the stable id — resolve, then check
  // membership on the id. A token narrowed to a space the owner can't read is dead
  // weight at best, a confusion channel at worst — reject honestly.
  const assertSpacesReadable = (req: FastifyRequest, slugs: string[]) => {
    for (const slug of slugs) {
      const id = spaces.resolveId(slug)

      if (!id || !req.principal.grants.has(id)) {
        throw new AuthError(HTTP_STATUS.BAD_REQUEST, `not a member of space "${slug}"`, 'bad_space')
      }
    }
  }

  app.post('/api/me/tokens', { config: authz('self:manage', 'host') }, async (req, reply) => {
    const body = PatCreateRequestSchema.parse(req.body ?? {})

    if (!req.principal.username) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    if (body.spaces) {
      assertSpacesReadable(req, body.spaces)
    }
    const created = await auth.createPat(req.principal.username, body)
    return reply.code(HTTP_STATUS.CREATED).send(PatCreateResponseSchema.parse(created))
  })

  // Rights change takes effect on the token's next request (the principal is
  // re-derived per request) — no re-mint, no re-login.
  app.patch('/api/me/tokens/:id', { config: authz('self:manage', 'host') }, async (req) => {
    const body = PatPatchRequestSchema.parse(req.body ?? {})

    if (!req.principal.username) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    if (body.spaces) {
      assertSpacesReadable(req, body.spaces)
    }
    await auth.updatePat(req.principal.username, (req.params as { id: string }).id, body)
    return OkResponseSchema.parse({ ok: true })
  })

  app.delete('/api/me/tokens/:id', { config: authz('self:manage', 'host') }, async (req) => {
    if (!req.principal.username) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    await auth.revokePat(req.principal.username, (req.params as { id: string }).id)
    return OkResponseSchema.parse({ ok: true })
  })

  // ── connected apps: the user's OAuth connections (claude.ai/chatgpt) ──
  // self:manage but session-only — a connector token can't manage connections.
  // No POST: a connection is born from the OAuth consent flow, not created here.
  app.get('/api/me/connections', { config: authz('self:manage', 'host') }, async (req) => {
    if (!req.principal.username) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }

    return ConnectionsResponseSchema.parse({
      connections: await auth.listConnections(req.principal.username),
    })
  })

  // The id is the OAuth client id (like revoke); the change covers all the app's
  // live tokens (access + refresh), so it survives the hourly rotation.
  app.patch('/api/me/connections/:id', { config: authz('self:manage', 'host') }, async (req) => {
    if (!req.principal.username) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    const body = ConnectionPatchRequestSchema.parse(req.body ?? {})

    if (body.spaces) {
      assertSpacesReadable(req, body.spaces)
    }
    await auth.updateConnection(req.principal.username, (req.params as { id: string }).id, body)
    return OkResponseSchema.parse({ ok: true })
  })

  app.delete('/api/me/connections/:id', { config: authz('self:manage', 'host') }, async (req) => {
    if (!req.principal.username) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    // The id is the OAuth client id (a CIMD url is url-encoded by the client).
    await auth.revokeConnection(req.principal.username, (req.params as { id: string }).id)
    return OkResponseSchema.parse({ ok: true })
  })

  // ── the personal layer: the human's read of their agent-memory + curated profile.
  //    canon: docs/note-model.md#agent-memory

  // The agent-memory audit feed. A read NEVER mints a personal space (peek, not
  // ensure) — a fresh user sees an honest empty feed, not a side-effect space.
  app.get('/api/me/memory', { config: authz('self:read', 'host') }, async (req) => {
    const query = MeMemoryQuerySchema.parse(req.query)
    const slug = await peekPersonalSpace({ auth, spaces }, req.principal)

    if (!slug) {
      return MeMemoryResponseSchema.parse({ categories: [] })
    }
    const cats = await listMemoryCategories(await spaces.store(slug), '', query)
    return MeMemoryResponseSchema.parse({
      categories: await withAuthors(cats, req.principal.username, auth.describeAuthor),
    })
  })

  // The PERSONAL agent-context preview. Mirrors EXACTLY what start_session's
  // curateAgentContext loads, so the pult never re-derives the trim. Read-only,
  // peek (no personal-space mint).
  // canon: docs/projects.md#init-context-curation-165-a-idinit-context-curationa
  app.get('/api/me/agent-context', { config: authz('self:read', 'host') }, async (req) => {
    const query = AgentContextQuerySchema.parse(req.query)
    const slug = await peekPersonalSpace({ auth, spaces }, req.principal)

    if (!slug) {
      return MeAgentContextResponseSchema.parse({
        roles: [],
        pins: [],
        memory: [],
        sets: [],
        loadedTokens: 0,
        totalTokens: 0,
        budgetTokens: PERSONAL_TOKEN_BUDGET,
      })
    }
    const store = await spaces.store(slug)
    // `eager` order = the ORDER the agent loads memory in, so the loaded/trimmed
    // flags match the bundle exactly (never modified-sorted). Sets and cross-space
    // pins resolve under THIS reader — honest degradation (P5).
    const resolveDeps = { store: storeAccess, spaces, contextSets, scopePins, contextOrder }
    const encodedRole = query.role ? decodeAbilityLocator(query.role) : null
    const selectedRoleLocator =
      encodedRole?.source === 'owned' &&
      encodedRole.kind === 'role' &&
      encodedRole.location.scope === ROLE_SCOPE.personal &&
      encodedRole.location.spaceId === slug
        ? encodedRole
        : null
    const [tagPins, loosePins, memory, sets, order, roleListing, selectedRole] = await Promise.all([
      weighAlwaysLoad(store),
      weighScopePins(resolveDeps, req.principal, { kind: CONTEXT_KIND.personal, id: slug }),
      listMemoryCategories(store, '', { order: 'eager' }),
      weighScopeContextSets(resolveDeps, req.principal, { kind: CONTEXT_KIND.personal, id: slug }),
      weighScopeOrder(resolveDeps, { kind: CONTEXT_KIND.personal, id: slug }),
      roles
        ? roles.listOwnedAbilitiesAt(
            { scope: ROLE_SCOPE.personal, space: slug },
            req.principal,
            ABILITY_KIND.role,
          )
        : Promise.resolve({ abilities: [], truncated: false }),
      selectedRoleLocator && roles
        ? roles.addressedRoleStatus({ personalSpace: slug }, req.principal, selectedRoleLocator)
        : Promise.resolve(null),
    ])
    // Weighed ONLY when the agent would load it. This door's whole job is to mirror
    // that load, so a layer it does not load must not enter the budget: charged
    // anyway, it displaced a personal always-load pin the agent DOES load and reported
    // it dropped. Which role the address names is the identity door's question.
    const roleContext = selectedRole?.active
      ? await weighRoleContext(resolveDeps, req.principal, selectedRole.role)
      : undefined
    const curated = curatePersonalScope(
      [...tagPins, ...loosePins],
      sets,
      memory,
      PERSONAL_TOKEN_BUDGET,
      order,
      roleContext,
    )
    const roleView =
      selectedRole?.active && selectedRoleLocator
        ? roleContextViewOf(selectedRole, selectedRoleLocator, (space) => space, null, curated.role)
        : undefined
    return MeAgentContextResponseSchema.parse({
      roles: roleListing.abilities.flatMap(({ ability }) => {
        const role = contextRoleSummaryOf(ability)
        return role ? [role] : []
      }),
      ...(roleListing.truncated ? { rolesTruncated: true } : {}),
      ...(roleView ? { role: roleView } : {}),
      pins: curated.pins,
      memory: await withAuthors(curated.memory, req.principal.username, auth.describeAuthor),
      sets: curated.sets,
      loadedTokens: curated.loadedTokens,
      totalTokens: curated.totalTokens,
      budgetTokens: PERSONAL_TOKEN_BUDGET,
    })
  })

  // ── roles: packaged catalog is discovery-only; only owned copies are effective.
  app.get('/api/me/agent-skills', { config: authz('self:read', 'host') }, async (req) => {
    const query = AgentPackageLibraryQuerySchema.parse(req.query)

    if (!roles) {
      return MeAgentSkillsResponseSchema.parse({
        items: [],
        projects: [],
        filteredTotal: 0,
        nextCursor: null,
        facets: {
          source: { system: 0, catalog: 0, owned: 0 },
          home: { personal: 0, space: 0 },
          availability: { all: 0, selected: 0 },
          projects: [],
        },
      })
    }
    const readableSpaces = spaces
      .list()
      .map((entry) => entry.id)
      .filter((space) => can(req.principal, 'space:read', { space }))

    if (
      query.spaceId &&
      (!spaces.recOf(query.spaceId) || !readableSpaces.includes(query.spaceId))
    ) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    const scopedSpaces = query.spaceId ? [query.spaceId] : readableSpaces
    const [personal, readableProjects, bundled] = await Promise.all([
      peekPersonalSpace({ auth, spaces }, req.principal),
      contextProjectsFor(scopedSpaces),
      roles.listBundledAbilities(req.principal),
    ])
    const projectSources = readableProjects
      .map((project) => ({
        id: project.id,
        space: project.space,
        project: projectSummaryOf(project, spaces.slugOf(project.space) ?? project.space),
      }))
      .sort((left, right) =>
        left.project.handle < right.project.handle
          ? -1
          : left.project.handle > right.project.handle
            ? 1
            : 0,
      )
    const projectHandleById = new Map(
      projectSources.map(({ id, project }) => [id, project.handle] as const),
    )
    const allLocations = [
      ...(personal ? [{ location: { scope: ROLE_SCOPE.personal, space: personal } as const }] : []),
      ...scopedSpaces
        .filter((space) => space !== personal)
        .map((space) => ({ location: { scope: ROLE_SCOPE.space, space } as const })),
    ]
    const locations = allLocations.slice(0, SKILL_INVENTORY_LOCATION_LIMIT)
    const candidates: PackageLibraryCandidate<AgentAbilitySummary>[] = bundled
      .filter(({ locator }) => locator.kind === 'skill')
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
        (!query.spaceId || query.spaceId === space) && can(req.principal, 'space:write', { space }),
    )
    let truncated =
      allLocations.length > SKILL_INVENTORY_LOCATION_LIMIT ||
      writableProjects.length > SKILL_PROJECT_SUMMARY_LIMIT

    for (const source of locations) {
      const listing = await roles.listOwnedAbilitiesAt(
        source.location,
        req.principal,
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

    return MeAgentSkillsResponseSchema.parse({
      ...page,
      projects: writableProjects
        .slice(0, SKILL_PROJECT_SUMMARY_LIMIT)
        .map(({ project }) => project),
      ...(truncated ? { truncated: true } : {}),
    })
  })

  app.post('/api/me/agent-skills', { config: authz('self:manage', 'host') }, async (req, reply) => {
    if (!roles) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    const body = CreateAgentSkillRequestSchema.parse(req.body ?? {})
    const { location, availability } = await skillPlacementFor(req, body)

    try {
      const skill = await roles.createCustomSkill(
        body.name,
        body.description,
        body.instructions,
        location,
        availability,
      )
      const locator = ownedSkillLocator(location, skill.packageId)

      return reply.code(HTTP_STATUS.CREATED).send(
        CreateAgentSkillResponseSchema.parse({
          skill: publishedSkillForWire(
            skill,
            body.scope === ROLE_SCOPE.space
              ? {
                  space: spaces.slugOf(skill.space) ?? skill.space,
                  availability: body.availability,
                }
              : null,
          ),
          noteId: skill.noteId,
          locator,
          versionToken: await publishedVersion(req, skill.noteId),
        }),
      )
    } catch (error) {
      if (error instanceof SkillAlreadyExistsError) {
        throw new AuthError(HTTP_STATUS.CONFLICT, error.message, 'skill_exists')
      }
      throw error
    }
  })

  app.post(
    '/api/me/agent-skills/catalog',
    { config: authz('self:manage', 'host') },
    async (req, reply) => {
      if (!roles) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
      const body = AddAgentSkillRequestSchema.parse(req.body ?? {})

      if (!(await roles.hasCatalogSkill(body.name))) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
      const { location, availability } = await skillPlacementFor(req, body)

      try {
        const skill = await roles.addSkillFromCatalog(body.name, location, availability)
        const locator = ownedSkillLocator(location, skill.packageId)

        return reply.code(HTTP_STATUS.CREATED).send(
          AddAgentSkillResponseSchema.parse({
            skill: publishedSkillForWire(
              skill,
              body.scope === ROLE_SCOPE.space
                ? {
                    space: spaces.slugOf(skill.space) ?? skill.space,
                    availability: body.availability,
                  }
                : null,
            ),
            noteId: skill.noteId,
            locator,
            versionToken: await publishedVersion(req, skill.noteId),
          }),
        )
      } catch (error) {
        if (error instanceof SkillAlreadyExistsError) {
          throw new AuthError(HTTP_STATUS.CONFLICT, error.message, 'skill_exists')
        }
        if (error instanceof CatalogSkillNotFoundError) {
          throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
        }
        throw error
      }
    },
  )

  app.get('/api/me/agent-roles', { config: authz('self:read', 'host') }, async (req) => {
    const query = AgentPackageLibraryQuerySchema.parse(req.query)

    if (!roles) {
      return MeAgentRolesResponseSchema.parse({
        items: [],
        projects: [],
        activeRole: null,
        filteredTotal: 0,
        nextCursor: null,
        facets: {
          source: { system: 0, catalog: 0, owned: 0 },
          home: { personal: 0, space: 0 },
          availability: { all: 0, selected: 0 },
          projects: [],
        },
      })
    }
    const readableSpaces = spaces
      .list()
      .map((space) => space.id)
      .filter((space) => can(req.principal, 'space:read', { space }))

    if (
      query.spaceId &&
      (!spaces.recOf(query.spaceId) || !readableSpaces.includes(query.spaceId))
    ) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    const scopedSpaces = query.spaceId ? [query.spaceId] : readableSpaces
    const [personal, projects, bundled] = await Promise.all([
      peekPersonalSpace({ auth, spaces }, req.principal),
      contextProjectsFor(scopedSpaces),
      roles.listBundledAbilities(req.principal),
    ])
    const projectSources = projects
      .map((project) => ({
        id: project.id,
        space: project.space,
        project: projectSummaryOf(project, spaces.slugOf(project.space) ?? project.space),
      }))
      .sort((left, right) =>
        left.project.handle < right.project.handle
          ? -1
          : left.project.handle > right.project.handle
            ? 1
            : 0,
      )
    const summaries = []
    let writableProjectCount = 0

    for (const source of projectSources) {
      if (!can(req.principal, 'space:write', { space: source.space })) {
        continue
      }
      writableProjectCount++
      if (summaries.length < ROLE_PROJECT_SUMMARY_LIMIT) {
        summaries.push(source.project)
      }
    }
    const personalLocations = [
      ...(personal ? [{ location: { scope: ROLE_SCOPE.personal, space: personal } as const }] : []),
    ]
    const projectLocations = projectSources.map((project) => ({
      location: {
        scope: ROLE_SCOPE.project,
        space: project.space,
        projectId: project.id,
      } as const,
      project: project.project.handle,
    }))
    const spaceLocations = [
      ...scopedSpaces
        .filter((space) => space !== personal)
        .map((space) => ({ location: { scope: ROLE_SCOPE.space, space } as const })),
    ]
    // Bases before versions. A version is not an item of this listing — it collapses
    // into the base it overrides — so a scan that reached the project but not its
    // Space would render the version as a role of its own, which is precisely the
    // duplicate this listing exists to stop showing.
    const locations = [...personalLocations, ...spaceLocations, ...projectLocations].slice(
      0,
      ROLE_INVENTORY_LOCATION_LIMIT,
    )
    const candidates: PackageLibraryCandidate<AgentAbilitySummary>[] = bundled
      .filter(({ locator }) => locator.kind === 'role')
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

    // One role, one entry. The base and its project versions share a name inside one
    // Space by construction, which is exactly what makes `(spaceId, name)` the role's
    // identity here — a Space has at most one non-project placement, so a group can
    // never hold two candidate bases.
    const groups = new Map<string, OwnedRoleGroup>()

    for (const source of locations.slice(0, ROLE_INVENTORY_LOCATION_LIMIT)) {
      const listing = await roles.listOwnedAbilitiesAt(
        source.location,
        req.principal,
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

    const ownedRoleCandidate = (
      item: OwnedRoleSummary,
      versions: OwnedRoleGroup['versions'],
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
                  abilityReachesProject(availability, id, 'skill')),
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

    for (const group of groups.values()) {
      const versions = [...group.versions].sort((left, right) =>
        left.locator.location.projectId.localeCompare(right.locator.location.projectId),
      )

      if (group.base) {
        candidates.push(ownedRoleCandidate(group.base, versions))
        continue
      }
      // Nothing to override, so nothing is a version: a project role with no Space
      // base is an independent role that happens to share a name across projects, and
      // each is its own entry named by the project it lives in. Collapsing THESE
      // would have to elect an arbitrary one to stand for the rest, and the others
      // would vanish from the library entirely.
      for (const version of versions) {
        candidates.push(ownedRoleCandidate(version, []))
      }
    }
    const owner = req.principal.username ?? (req.principal.system ? 'system' : null)
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

      if (saved.roleLocator && saved.roleLocator.kind === ABILITY_KIND.role) {
        const contextProject =
          saved.roleContextProjectId && projectsForRoles
            ? await projectsForRoles.getById(saved.roleContextProjectId)
            : null
        // Asked of the service, in the episode's OWN context. Deciding it here meant
        // judging reach by space alone, so a role narrowed away from the project was
        // drawn as active on a surface where `use_role` would refuse to raise it.
        const resolved = await roles.resolveSavedRole(
          { personalSpace: personal, ...(contextProject ? { project: contextProject } : {}) },
          req.principal,
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

    return MeAgentRolesResponseSchema.parse({
      ...page,
      projects: summaries,
      activeRole,
      ...(inventoryTruncated ? { truncated: true } : {}),
    })
  })

  // Read the exact catalog template or owned fork the card addresses. This is
  // deliberately NOT effective-role resolution: two same-name forks at different
  // scopes remain separately inspectable instead of the narrower one replacing the
  // content the user clicked.
  app.get(
    '/api/me/agent-abilities/:locator',
    { config: authz('self:read', 'host') },
    async (req) => {
      if (!roles) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
      const locator = decodeAbilityLocator((req.params as { locator: string }).locator)

      if (!locator) {
        throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'bad ability locator')
      }
      const personalSpace = await peekPersonalSpace({ auth, spaces }, req.principal)
      const project =
        locator.source === 'owned' &&
        locator.location.scope === ROLE_SCOPE.project &&
        projectsForRoles
          ? await projectsForRoles.getById(locator.location.projectId)
          : undefined

      if (
        locator.source === 'owned' &&
        locator.location.scope === ROLE_SCOPE.project &&
        (!project || project.space !== locator.location.spaceId)
      ) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
      const detail = await roles.describeAbility(
        { personalSpace, ...(project ? { project } : {}) },
        req.principal,
        locator,
        ROLE_DETAIL_TOKEN_BUDGET,
      )

      if (!detail) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
      // A base names its versions here too, so the reader can see where this role has
      // its own body — and the kebab can offer only the projects that do not have one
      // yet, instead of offering a conflict. Any HOME is a base: Personal is the home a
      // project of the caller's own space falls back to, and the service answers for it.
      const versions =
        locator.source === 'owned' &&
        locator.kind === 'role' &&
        locator.location.scope !== ROLE_SCOPE.project
          ? await roles.listRoleVersions(
              req.principal,
              locator,
              personalSpace,
              (await contextProjectsFor([locator.location.spaceId])).map((entry) => entry.id),
            )
          : null
      // The other direction of the same relation. Without it a project role cannot
      // say whether the body it shows overrides another one of the same name, and the
      // reader has no way back to it.
      const baseLocator =
        locator.source === 'owned' &&
        locator.kind === 'role' &&
        locator.location.scope === ROLE_SCOPE.project
          ? await roles.findRoleBase(req.principal, locator, personalSpace)
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
    },
  )

  app.put(
    '/api/me/agent-abilities/:locator/enabled',
    { config: authz('self:manage', 'host') },
    async (req) => {
      if (!roles) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
      const locator = decodeAbilityLocator((req.params as { locator: string }).locator)
      const body = SetAgentAbilityEnabledRequestSchema.parse(req.body)

      if (!locator) {
        throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'bad ability locator')
      }
      if (locator.source === 'catalog') {
        throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'Catalog abilities cannot be enabled')
      }
      const personalSpace = await peekPersonalSpace({ auth, spaces }, req.principal)
      const project =
        locator.source === 'owned' &&
        locator.location.scope === ROLE_SCOPE.project &&
        projectsForRoles
          ? await projectsForRoles.getById(locator.location.projectId)
          : undefined

      if (
        locator.source === 'owned' &&
        locator.location.scope === ROLE_SCOPE.project &&
        (!project || project.space !== locator.location.spaceId)
      ) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
      await roles.setEnabled(
        { personalSpace, ...(project ? { project } : {}) },
        req.principal,
        locator,
        body.enabled,
      )

      return SetAgentAbilityEnabledResponseSchema.parse({ locator, enabled: body.enabled })
    },
  )

  app.put(
    '/api/me/agent-abilities/:locator/availability',
    { config: authz('self:manage', 'host') },
    async (req) => {
      if (!roles || !projectsForRoles) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
      const locator = decodeAbilityLocator((req.params as { locator: string }).locator)
      const availability = SetAgentAbilityAvailabilityRequestSchema.parse(req.body)

      if (!locator || locator.source !== 'owned' || locator.location.scope !== ROLE_SCOPE.space) {
        throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'bad ability locator')
      }
      // Membership in the home space is the whole question. Archiving a project does
      // not unbind a reach that names it — the row still describes where the ability
      // applies, and only deleting or re-typing the folder removes it (meta-db
      // cascades). Rejecting archived ids here would make an existing reach
      // unsendable, and the client would have to drop it to save anything at all.
      if (availability.mode === ABILITY_AVAILABILITY_MODE.selectedProjects) {
        const projects = await Promise.all(
          availability.projectIds.map((projectId) => projectsForRoles.getById(projectId)),
        )

        if (projects.some((project) => !project || project.space !== locator.location.spaceId)) {
          throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
        }
      }
      await roles.setAbilityAvailability(
        { personalSpace: await peekPersonalSpace({ auth, spaces }, req.principal) },
        req.principal,
        locator,
        availability,
      )

      return SetAgentAbilityAvailabilityResponseSchema.parse({ locator, availability })
    },
  )

  // Fork a Space base into a project version of the SAME role. Not a second role:
  // it shares the name, and effective resolution picks it over the base inside that
  // one project. The listing collapses it back into its base.
  app.post(
    '/api/me/agent-abilities/:locator/versions',
    { config: authz('self:manage', 'host') },
    async (req, reply) => {
      if (!roles || !projectsForRoles) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
      const locator = decodeAbilityLocator((req.params as { locator: string }).locator)
      const body = CreateAbilityVersionRequestSchema.parse(req.body ?? {})

      if (
        !locator ||
        locator.source !== 'owned' ||
        locator.kind !== 'role' ||
        locator.location.scope !== ROLE_SCOPE.space
      ) {
        throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'bad ability locator')
      }
      const project = await projectsForRoles.getById(body.projectId)

      if (
        !project ||
        project.status !== 'active' ||
        project.space !== locator.location.spaceId ||
        !can(req.principal, 'space:write', { space: project.space })
      ) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
      try {
        const version = await roles.createRoleVersion(
          req.principal,
          locator,
          await peekPersonalSpace({ auth, spaces }, req.principal),
          project.id,
        )

        return reply.code(HTTP_STATUS.CREATED).send(
          CreateAbilityVersionResponseSchema.parse({
            // Minted, not spelled out: this literal is an argument of `.parse()`, so
            // the compiler never checked it — a shape change to the locator would have
            // reached every other door and failed HERE at runtime, after the version
            // package was already published.
            locator: ownedRoleLocator(
              { scope: ROLE_SCOPE.project, space: version.space, projectId: project.id },
              version.packageId,
            ),
            noteId: version.noteId,
            versionToken: await publishedVersion(req, version.noteId),
          }),
        )
      } catch (error) {
        if (error instanceof RoleAlreadyExistsError) {
          throw new AuthError(HTTP_STATUS.CONFLICT, error.message, 'role_exists')
        }
        throw error
      }
    },
  )

  // Change where a Role belongs, inside its own space. The package keeps its address
  // and every durable pointer moves with it. This is the edit behind the aside's
  // `Belongs to` — never a menu command, because where an ability lives is a property
  // of it and commits with the document's one Save.
  app.put(
    '/api/me/agent-abilities/:locator/home',
    { config: authz('self:manage', 'host') },
    async (req) => {
      if (!roles || !projectsForRoles) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
      const locator = decodeAbilityLocator((req.params as { locator: string }).locator)
      SetAbilityHomeRequestSchema.parse(req.body ?? {})

      if (!locator || locator.source !== 'owned' || locator.kind !== 'role') {
        throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'bad ability locator')
      }
      try {
        const moved = await roles.moveRolePlacement(
          req.principal,
          locator,
          await peekPersonalSpace({ auth, spaces }, req.principal),
        )

        return SetAbilityHomeResponseSchema.parse({
          locator: moved.locator,
          availability: moved.availability,
          noteId: moved.role.noteId,
        })
      } catch (error) {
        if (error instanceof RoleAlreadyExistsError) {
          throw new AuthError(HTTP_STATUS.CONFLICT, error.message, 'role_exists')
        }
        throw error
      }
    },
  )

  app.post('/api/me/agent-roles', { config: authz('self:manage', 'host') }, async (req, reply) => {
    if (!roles) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    const body = AddAgentRoleRequestSchema.parse(req.body ?? {})

    // Validate the discovery-only source before a Personal add can lazily mint
    // durable user state. A missing template is a pure 404.
    if (!(await roles.hasCatalog(body.name))) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    let location

    if (body.scope === ROLE_SCOPE.personal) {
      location = { scope: ROLE_SCOPE.personal, space: await writablePersonalSpace(req) } as const
    } else {
      const project = await writableProject(req, body.project)

      location = {
        scope: ROLE_SCOPE.project,
        space: project.space,
        projectId: project.id,
      } as const
    }
    try {
      const role = await roles.addFromCatalog(
        body.name,
        location,
        await peekPersonalSpace({ auth, spaces }, req.principal),
      )
      const locator = ownedRoleLocator(location, role.packageId)
      return reply.code(HTTP_STATUS.CREATED).send(
        AddAgentRoleResponseSchema.parse({
          role: publishedRoleForWire(
            role,
            rolePlacementForWire(role, body.project ?? '', (space) => spaces.slugOf(space)),
          ),
          locator,
          versionToken: await publishedVersion(req, role.noteId),
        }),
      )
    } catch (err) {
      if (err instanceof RoleAlreadyExistsError) {
        throw new AuthError(HTTP_STATUS.CONFLICT, err.message, 'role_exists')
      }
      if (err instanceof RoleDependencyConflictError) {
        throw new AuthError(HTTP_STATUS.CONFLICT, err.message, 'role_dependency_conflict')
      }
      if (err instanceof CatalogRoleNotFoundError) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
      throw err
    }
  })

  app.post(
    '/api/me/agent-roles/custom',
    { config: authz('self:manage', 'host') },
    async (req, reply) => {
      if (!roles) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
      const body = CreateAgentRoleRequestSchema.parse(req.body ?? {})
      let location

      if (body.scope === ROLE_SCOPE.personal) {
        location = { scope: ROLE_SCOPE.personal, space: await writablePersonalSpace(req) } as const
      } else if (body.scope === ROLE_SCOPE.space) {
        location = {
          scope: ROLE_SCOPE.space,
          space: await writableSharedSpace(req, body.space),
        } as const
      } else {
        const project = await writableProject(req, body.project)

        location = {
          scope: ROLE_SCOPE.project,
          space: project.space,
          projectId: project.id,
        } as const
      }

      // A Space role may state its reach at creation, in the same handle-named shape a
      // Skill uses. Omitted means the Space-wide default, which is what a Space role
      // meant before reach existed.
      const availability =
        body.scope === ROLE_SCOPE.space && body.availability
          ? await resolveAvailabilityHandles(location.space, body.availability)
          : undefined

      try {
        const role = await roles.createCustomRole(
          body.name,
          body.description,
          body.instructions,
          location,
          {
            principal: req.principal,
            attachments: body.attachments,
            personalSpace: await peekPersonalSpace({ auth, spaces }, req.principal),
            ...(availability ? { availability } : {}),
          },
        )
        const locator = ownedRoleLocator(location, role.packageId)
        return reply.code(HTTP_STATUS.CREATED).send(
          CreateAgentRoleResponseSchema.parse({
            role: publishedRoleForWire(
              role,
              rolePlacementForWire(
                role,
                body.scope === ROLE_SCOPE.project ? body.project : '',
                (space) => spaces.slugOf(space),
              ),
            ),
            noteId: role.noteId,
            locator,
            versionToken: await publishedVersion(req, role.noteId),
          }),
        )
      } catch (error) {
        if (error instanceof RoleAlreadyExistsError) {
          throw new AuthError(HTTP_STATUS.CONFLICT, error.message, 'role_exists')
        }
        if (error instanceof RoleDependencyConflictError) {
          throw new AuthError(HTTP_STATUS.CONFLICT, error.message, 'role_dependency_conflict')
        }
        throw error
      }
    },
  )

  // Attach a context set to MY personal scope. The receiver is only me, so no
  // personal/shared restriction (unlike a shared project). Mints the personal
  // space on first attach (write path).
  // canon: docs/projects.md#context-sets-209-reusable-cross-space-bundles
  app.put('/api/me/context-sets/:id', { config: authz('self:manage', 'host') }, async (req) => {
    if (!contextSets || !req.principal.username) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    const set = await contextSets.getSet((req.params as { id?: string }).id ?? '')

    if (!set || !can(req.principal, 'space:read', { space: set.homeSpace })) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    const slug = await ensurePersonalSpaceFor({ auth, spaces }, req.principal.username)
    await contextSets.attach({
      setId: set.id,
      targetKind: CONTEXT_KIND.personal,
      targetId: slug,
      targetSpace: slug,
      createdAt: new Date().toISOString(),
    })
    return OkResponseSchema.parse({ ok: true })
  })

  // Detach a set from my personal scope. Idempotent — a peek (no mint) is enough.
  app.delete('/api/me/context-sets/:id', { config: authz('self:manage', 'host') }, async (req) => {
    if (!contextSets || !req.principal.username) {
      return OkResponseSchema.parse({ ok: true })
    }
    const slug = await peekPersonalSpace({ auth, spaces }, req.principal)

    if (slug) {
      await contextSets.detach(
        (req.params as { id?: string }).id ?? '',
        CONTEXT_KIND.personal,
        slug,
      )
    }

    return OkResponseSchema.parse({ ok: true })
  })

  // Pin a note into MY personal scope from ANY readable space (the loose
  // cross-space pin). Its authoritative space comes from the registry (hit.space),
  // not the body. Mints the personal space on first pin (write path).
  app.put('/api/me/context-pins', { config: authz('self:manage', 'host') }, async (req) => {
    if (!scopePins || !req.principal.username) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    const body = ContextPinRequestSchema.safeParse(req.body ?? {})

    if (!body.success) {
      throw new AuthError(HTTP_STATUS.BAD_REQUEST, body.error.issues[0]?.message || 'bad request')
    }
    const hit = await readNoteAccess(storeAccess, req.principal, body.data.noteId, 'note:read')

    if (!hit) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    const slug = await ensurePersonalSpaceFor({ auth, spaces }, req.principal.username)
    await scopePins.addPin({
      targetKind: CONTEXT_KIND.personal,
      targetId: slug,
      targetSpace: slug,
      noteSpace: hit.space,
      noteId: hit.noteId,
      createdAt: new Date().toISOString(),
    })
    return OkResponseSchema.parse({ ok: true })
  })

  // Unpin a cross-space pin from my personal scope. Idempotent — a peek (no mint) is enough.
  app.delete(
    '/api/me/context-pins/:noteId',
    { config: authz('self:manage', 'host') },
    async (req) => {
      if (!scopePins || !req.principal.username) {
        return OkResponseSchema.parse({ ok: true })
      }
      const slug = await peekPersonalSpace({ auth, spaces }, req.principal)

      if (slug) {
        const requestedId = (req.params as { noteId?: string }).noteId ?? ''
        const live = await readNoteAccess(storeAccess, req.principal, requestedId, 'note:read')
        await scopePins.removePin(CONTEXT_KIND.personal, slug, live?.noteId ?? requestedId)
      }

      return OkResponseSchema.parse({ ok: true })
    },
  )

  // Reorder MY personal scope's pin+set list (order = load priority). Membership
  // is not re-validated (a stale entry ranks nothing). Mints the personal space
  // on first reorder (write path).
  app.put('/api/me/context-order', { config: authz('self:manage', 'host') }, async (req) => {
    if (!contextOrder || !req.principal.username) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    const body = ContextOrderRequestSchema.safeParse(req.body ?? {})

    if (!body.success) {
      throw new AuthError(HTTP_STATUS.BAD_REQUEST, body.error.issues[0]?.message || 'bad request')
    }
    const slug = await ensurePersonalSpaceFor({ auth, spaces }, req.principal.username)
    const entries = await Promise.all(
      body.data.entries.map(async (entry) => {
        if (entry.kind !== 'pin') {
          return { entryKind: entry.kind, entryRef: entry.ref }
        }
        const live = await readNoteAccess(storeAccess, req.principal, entry.ref, 'note:read')
        return { entryKind: entry.kind, entryRef: live?.noteId ?? entry.ref }
      }),
    )
    await contextOrder.setOrder(CONTEXT_KIND.personal, slug, slug, entries)
    return OkResponseSchema.parse({ ok: true })
  })

  // Compatibility feed for retrieval-only clients; the UI is session-first.
  // A meta-DB-less host has nothing captured → an honest empty audit.
  // canon: docs/projects.md#activity-auditing-agent-work-243-321-mem-audita
  app.get('/api/me/agent-audit', { config: authz('self:read', 'host') }, async (req, reply) => {
    const owner = agentOwnerOf(req.principal)

    if (!retrievalLog || !owner) {
      return AgentAuditResponseSchema.parse({
        events: [],
        total: 0,
        hasMore: false,
        nextCursor: null,
        aggregates: { totalQueries: 0, missCount: 0, top: [], misses: [] },
      })
    }
    const q = AgentAuditQuerySchema.safeParse(req.query)

    if (!q.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: q.error.issues[0]?.message ?? 'bad query' })
    }
    if ((q.data.beforeAt && !q.data.beforeId) || (!q.data.beforeAt && q.data.beforeId)) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: 'beforeAt and beforeId must be passed together' })
    }
    // Aggregates are whole-history — unchanged by paging or a tool-filter switch.
    // Compute ONLY on a genuine first load (no cursor AND client didn't opt out via
    // aggregates=0), so neither scroll nor a filter flip re-scans the whole log.
    const isFirstPage = !q.data.beforeAt && q.data.aggregates !== '0'
    const [history, aggregates] = await Promise.all([
      retrievalLog.history({
        owner,
        offset: q.data.offset,
        limit: q.data.limit,
        tool: q.data.tool,
        missesOnly: q.data.filter === 'misses',
        before:
          q.data.beforeAt && q.data.beforeId
            ? { at: q.data.beforeAt, id: q.data.beforeId }
            : undefined,
      }),
      isFirstPage ? retrievalLog.aggregates(owner) : Promise.resolve(null),
    ])
    const events = history.items.map((r) => ({
      id: r.id,
      at: r.createdAt,
      tool: r.tool,
      query: r.query,
      project: r.project,
      classFilter: r.classFilter,
      resultCount: r.resultCount,
      topScore: r.topScore,
      hits: r.hits,
      agent: r.agent,
      principal: r.principal,
    }))
    const last = history.hasMore ? history.items.at(-1) : null
    return AgentAuditResponseSchema.parse({
      events,
      total: history.total,
      hasMore: history.hasMore,
      nextCursor: last ? { beforeAt: last.createdAt, beforeId: last.id } : null,
      aggregates,
    })
  })

  // Retained lifecycle rows and archived audit snapshots are folded server-side;
  // global retrieval insights ride only the first page unless explicitly skipped.
  app.get('/api/me/agent-sessions', { config: authz('self:read', 'host') }, async (req, reply) => {
    const q = AgentSessionsQuerySchema.safeParse(req.query)

    if (!q.success) {
      return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: q.error.issues[0]?.message })
    }
    const owner = agentOwnerOf(req.principal)
    const includeAggregates = !q.data.cursor && q.data.aggregates !== '0'
    const before = decodeSummaryCursor(q.data.cursor)

    if (!owner || !sessionAudit) {
      return AgentSessionsResponseSchema.parse({
        sessions: [],
        total: 0,
        active: 0,
        outside: null,
        hasMore: false,
        nextCursor: null,
        aggregates: includeAggregates
          ? { totalQueries: 0, missCount: 0, top: [], misses: [] }
          : null,
      })
    }
    const activeSince = new Date(Date.now() - AGENT_SESSION_IDLE_MS).toISOString()
    const [overview, aggregates] = await Promise.all([
      sessionAudit.overview({
        owner,
        activeSince,
        type:
          q.data.filter === 'reads'
            ? 'retrieval'
            : q.data.filter === 'writes'
              ? 'write'
              : undefined,
        limit: q.data.limit,
        before,
      }),
      includeAggregates && retrievalLog
        ? retrievalLog.aggregates(owner)
        : Promise.resolve(
            includeAggregates ? { totalQueries: 0, missCount: 0, top: [], misses: [] } : null,
          ),
    ])
    const last = overview.hasMore ? overview.items.at(-1) : null
    return AgentSessionsResponseSchema.parse({
      sessions: overview.items,
      total: overview.total,
      active: overview.active,
      outside: overview.outside,
      hasMore: overview.hasMore,
      nextCursor: last ? encodeAuditCursor({ at: last.lastSeenAt, id: last.id }) : null,
      aggregates,
    })
  })

  app.get(
    '/api/me/agent-sessions/:id',
    { config: authz('self:read', 'host') },
    async (req, reply) => {
      const q = AgentSessionEventsQuerySchema.safeParse(req.query)

      if (!q.success) {
        return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: q.error.issues[0]?.message })
      }
      const id = (req.params as { id: string }).id
      const scope =
        id === 'all'
          ? ({ kind: 'all' } as const)
          : id === 'outside'
            ? ({ kind: 'outside' } as const)
            : ({ kind: 'session', id } as const)

      if (scope.kind === 'session' && !AgentSessionIdSchema.safeParse(id).success) {
        throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'bad session id')
      }
      const owner = agentOwnerOf(req.principal)

      if (!owner || (!sessionAudit && scope.kind === 'session')) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
      const before = decodeEventCursor(q.data.cursor)

      if (!sessionAudit) {
        return AgentSessionEventsResponseSchema.parse({
          target: scope.kind === 'all' ? { kind: 'all' } : { kind: 'outside', lastSeenAt: null },
          events: [],
          total: null,
          hasMore: false,
          nextCursor: null,
          aggregates:
            q.data.aggregates === '1'
              ? { retrieval: emptyRetrievalAggregates(), agents: [] }
              : null,
        })
      }
      const activeSince = new Date(Date.now() - AGENT_SESSION_IDLE_MS).toISOString()
      const [sessionTarget, events, aggregates] = await Promise.all([
        scope.kind === 'session'
          ? sessionAudit.find(owner, id, activeSince)
          : Promise.resolve(null),
        sessionAudit.events({
          owner,
          scope,
          type:
            q.data.filter === 'reads'
              ? 'retrieval'
              : q.data.filter === 'writes'
                ? 'write'
                : undefined,
          agent: q.data.agent,
          tool: q.data.tool,
          query: q.data.q,
          limit: q.data.limit,
          before,
        }),
        q.data.aggregates === '1'
          ? Promise.all([
              retrievalLog
                ? retrievalLog.aggregates(owner)
                : Promise.resolve(emptyRetrievalAggregates()),
              sessionAudit.agentFacet(owner),
            ]).then(([retrieval, agents]) => ({ retrieval, agents }))
          : Promise.resolve(null),
      ])

      if (scope.kind === 'session' && !sessionTarget) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
      const first = events.items[0]
      const target =
        scope.kind === 'all'
          ? { kind: 'all' as const }
          : scope.kind === 'outside'
            ? {
                kind: 'outside' as const,
                lastSeenAt:
                  first?.type === 'retrieval' ? first.record.createdAt : (first?.at ?? null),
              }
            : { kind: 'session' as const, ...sessionTarget! }
      const last = events.hasMore ? events.items.at(-1) : null
      const cursor = last
        ? last.type === 'retrieval'
          ? encodeAuditCursor({
              at: last.record.createdAt,
              source: 'retrieval',
              id: last.record.id,
            })
          : encodeAuditCursor({ at: last.at, source: 'write', id: last.id })
        : null
      return AgentSessionEventsResponseSchema.parse({
        target,
        events: events.items.map((event) =>
          event.type === 'write'
            ? sessionEventToWire({
                ...event,
                space: spaces.slugOf(event.space) ?? event.space,
              })
            : sessionEventToWire(event),
        ),
        total: events.total,
        hasMore: events.hasMore,
        nextCursor: cursor,
        aggregates,
      })
    },
  )

  // Read the curated profile (always-load note + display name). 404 in 'none'
  // mode, like /api/me. Read does not mint.
  app.get('/api/me/profile', { config: authz('self:read', 'host') }, async (req) => {
    if (!req.principal.username) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    const me = await auth.me(req.principal.username)
    const slug = await peekPersonalSpace({ auth, spaces }, req.principal)
    const profile = slug ? await readProfileNote(await spaces.store(slug)) : null
    return ProfileResponseSchema.parse({
      displayName: me.displayName,
      content: profile?.content ?? '',
      noteId: profile?.noteId ?? null,
      versionToken: profile?.versionToken ?? null,
    })
  })

  // Save the profile: display name (user record) + always-load note. Mints the
  // personal space on first save (write path).
  app.put('/api/me/profile', { config: authz('self:manage', 'host') }, async (req) => {
    if (!req.principal.username) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    const body = ProfilePutRequestSchema.parse(req.body ?? {})

    if (body.displayName) {
      await auth.setDisplayName(req.principal.username, body.displayName)
    }
    const slug = await ensurePersonalSpaceFor({ auth, spaces }, req.principal.username)
    const store = await spaces.store(slug)
    await writeProfileNote(store, {
      content: body.content,
      versionToken: body.versionToken,
      principal: req.principal.id,
    })
    // Re-read for the canonical post-write token + the fresh display name.
    const me = await auth.me(req.principal.username)
    const saved = await readProfileNote(store)
    return ProfileResponseSchema.parse({
      displayName: me.displayName,
      content: saved?.content ?? body.content,
      noteId: saved?.noteId ?? null,
      versionToken: saved?.versionToken ?? null,
    })
  })
}
