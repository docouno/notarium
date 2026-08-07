// The principal's own corner: /api/me* self-management routes. Me-scoped authz
// (self:read/self:manage, never a space membership check); the personal-domain
// slug never crosses the wire. Handlers throw AuthError; the root error handler
// maps it to the wire envelope.
// canon: docs/auth.md#model · docs/projects.md#personal-domain-as-a-working-space-13-2026-06-20
import type { FastifyInstance, FastifyRequest } from 'fastify'

import {
  AddAgentRoleRequestSchema,
  AddAgentRoleResponseSchema,
  AgentAuditQuerySchema,
  AgentAuditResponseSchema,
  AgentRoleDetailParamsSchema,
  AgentRoleDetailQuerySchema,
  AgentRoleDetailResponseSchema,
  AgentSessionEventsQuerySchema,
  AgentSessionEventsResponseSchema,
  AgentSessionsQuerySchema,
  AgentSessionsResponseSchema,
  ConnectionPatchRequestSchema,
  ConnectionsResponseSchema,
  CONTEXT_KIND,
  ContextOrderRequestSchema,
  ContextPinRequestSchema,
  MeAgentContextResponseSchema,
  MeAgentRolesResponseSchema,
  MeMemoryResponseSchema,
  MeSchema,
  OkResponseSchema,
  PasswordChangeRequestSchema,
  PatCreateRequestSchema,
  PatCreateResponseSchema,
  PatPatchRequestSchema,
  PatsResponseSchema,
  ProfilePutRequestSchema,
  ProfileResponseSchema,
  type RoleInventoryEntry,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { AgentSessionIdSchema } from '@notarium/contract/tools'

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
  ProjectsPersistence,
  RetrievalLogPersistence,
  ScopePinsPersistence,
} from '../../../../services/metaDb'
import {
  CatalogRoleNotFoundError,
  ROLE_SCOPE,
  RoleAlreadyExistsError,
  RoleDependencyConflictError,
  type RolesService,
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
import { authz, setSessionCookie } from './_helpers'

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
    sessionAttach: r.sessionAttach,
  }
}

const ROLE_DETAIL_TOKEN_BUDGET = 65_536
const ROLE_INVENTORY_LIMIT = 512
const ROLE_INVENTORY_LOCATION_LIMIT = 128
const ROLE_PROJECT_SUMMARY_LIMIT = 128

const personalRoleForWire = (role: {
  name: string
  description: string
  origin?: string
  originRevision?: string
}): RoleInventoryEntry => ({
  name: role.name,
  description: role.description,
  scope: ROLE_SCOPE.personal,
  ...(role.origin !== undefined ? { origin: role.origin } : {}),
  ...(role.originRevision !== undefined ? { originRevision: role.originRevision } : {}),
})

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
    const slug = await peekPersonalSpace({ auth, spaces }, req.principal)

    if (!slug) {
      return MeMemoryResponseSchema.parse({ categories: [] })
    }
    const cats = await listMemoryCategories(await spaces.store(slug))
    return MeMemoryResponseSchema.parse({
      categories: await withAuthors(cats, req.principal.username, auth.describeAuthor),
    })
  })

  // The PERSONAL agent-context preview. Mirrors EXACTLY what start_session's
  // curateAgentContext loads, so the pult never re-derives the trim. Read-only,
  // peek (no personal-space mint).
  // canon: docs/projects.md#init-context-curation-165-a-idinit-context-curationa
  app.get('/api/me/agent-context', { config: authz('self:read', 'host') }, async (req) => {
    const slug = await peekPersonalSpace({ auth, spaces }, req.principal)

    if (!slug) {
      return MeAgentContextResponseSchema.parse({
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
    const [tagPins, loosePins, memory, sets, order] = await Promise.all([
      weighAlwaysLoad(store),
      weighScopePins(resolveDeps, req.principal, { kind: CONTEXT_KIND.personal, id: slug }),
      listMemoryCategories(store, '', { order: 'eager' }),
      weighScopeContextSets(resolveDeps, req.principal, { kind: CONTEXT_KIND.personal, id: slug }),
      weighScopeOrder(resolveDeps, { kind: CONTEXT_KIND.personal, id: slug }),
    ])
    const curated = curatePersonalScope(
      [...tagPins, ...loosePins],
      sets,
      memory,
      PERSONAL_TOKEN_BUDGET,
      order,
    )
    return MeAgentContextResponseSchema.parse({
      pins: curated.pins,
      memory: await withAuthors(curated.memory, req.principal.username, auth.describeAuthor),
      sets: curated.sets,
      loadedTokens: curated.loadedTokens,
      totalTokens: curated.totalTokens,
      budgetTokens: PERSONAL_TOKEN_BUDGET,
    })
  })

  // ── roles: packaged catalog is discovery-only; only owned copies are effective.
  app.get('/api/me/agent-roles', { config: authz('self:read', 'host') }, async (req) => {
    if (!roles) {
      return MeAgentRolesResponseSchema.parse({
        catalog: [],
        roles: [],
        projects: [],
        activeRole: null,
      })
    }
    const personal = await peekPersonalSpace({ auth, spaces }, req.principal)
    const readableSpaces = spaces
      .list()
      .map((space) => space.id)
      .filter((space) => can(req.principal, 'space:read', { space }))
    const projects = await contextProjectsFor(readableSpaces)
    const summaries = []
    let writableProjectCount = 0

    for (const project of projects) {
      if (!can(req.principal, 'space:write', { space: project.space })) {
        continue
      }
      writableProjectCount++
      if (summaries.length < ROLE_PROJECT_SUMMARY_LIMIT) {
        summaries.push(projectSummaryOf(project, spaces.slugOf(project.space) ?? project.space))
      }
    }
    const personalLocations = [
      ...(personal ? [{ location: { scope: ROLE_SCOPE.personal, space: personal } as const }] : []),
    ]
    const projectLocations = projects.map((project) => ({
      location: {
        scope: ROLE_SCOPE.project,
        space: project.space,
        projectId: project.id,
      } as const,
      project: projectSummaryOf(project, spaces.slugOf(project.space) ?? project.space).handle,
    }))
    const spaceLocations = [
      ...readableSpaces
        .filter((space) => space !== personal)
        .map((space) => ({ location: { scope: ROLE_SCOPE.space, space } as const })),
    ]
    // Settings primarily creates Project forks. Keep those visible before the
    // descriptive Space layer when a principal can read more locations than one
    // bounded inventory request may scan.
    const locations = [...personalLocations, ...projectLocations, ...spaceLocations].slice(
      0,
      ROLE_INVENTORY_LOCATION_LIMIT,
    )
    const inventory: RoleInventoryEntry[] = []
    let inventoryTruncated =
      personalLocations.length + projectLocations.length + spaceLocations.length >
        ROLE_INVENTORY_LOCATION_LIMIT || writableProjectCount > ROLE_PROJECT_SUMMARY_LIMIT

    for (const source of locations.slice(0, ROLE_INVENTORY_LOCATION_LIMIT)) {
      const listing = await roles.listAt(source.location)
      inventoryTruncated ||= listing.truncated
      const entries = listing.roles.map((role): RoleInventoryEntry => {
        if (role.scope === ROLE_SCOPE.personal) {
          return personalRoleForWire(role)
        }

        return {
          ...role,
          space: spaces.slugOf(role.space) ?? role.space,
          ...('project' in source ? { project: source.project } : {}),
        } as RoleInventoryEntry
      })
      const remaining: number = ROLE_INVENTORY_LIMIT - inventory.length

      if (entries.length > remaining) {
        inventoryTruncated = true
      }
      inventory.push(...entries.slice(0, remaining))
      if (inventory.length === ROLE_INVENTORY_LIMIT) {
        inventoryTruncated ||= source !== locations.at(-1)
        break
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

    return MeAgentRolesResponseSchema.parse({
      catalog: await roles.listCatalog(),
      roles: inventory,
      projects: summaries,
      activeRole: active.length === 1 ? active[0].role : null,
      ...(inventoryTruncated ? { truncated: true } : {}),
    })
  })

  // Read the exact catalog template or owned fork the card addresses. This is
  // deliberately NOT effective-role resolution: two same-name forks at different
  // scopes remain separately inspectable instead of the narrower one replacing the
  // content the user clicked.
  app.get('/api/me/agent-roles/:name', { config: authz('self:read', 'host') }, async (req) => {
    if (!roles) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    const { name } = AgentRoleDetailParamsSchema.parse(req.params)
    const query = AgentRoleDetailQuerySchema.parse(req.query)
    let detail

    if (query.scope === ROLE_SCOPE.catalog) {
      detail = await roles.loadCatalog(name, ROLE_DETAIL_TOKEN_BUDGET)
    } else if (query.scope === ROLE_SCOPE.personal) {
      const personal = await peekPersonalSpace({ auth, spaces }, req.principal)

      if (personal) {
        detail = await roles.loadAt(
          { scope: ROLE_SCOPE.personal, space: personal },
          name,
          ROLE_DETAIL_TOKEN_BUDGET,
        )
      }
    } else if (query.scope === ROLE_SCOPE.space) {
      const space = spaces.resolveId(query.space)

      if (
        space &&
        can(req.principal, 'space:read', { space }) &&
        !(await auth.isPersonalSpace(space))
      ) {
        detail = await roles.loadAt(
          { scope: ROLE_SCOPE.space, space },
          name,
          ROLE_DETAIL_TOKEN_BUDGET,
        )
      }
    } else {
      const readableSpaces = spaces
        .list()
        .map((space) => space.id)
        .filter((space) => can(req.principal, 'space:read', { space }))
      const project = (await contextProjectsFor(readableSpaces)).find(
        (entry) =>
          projectSummaryOf(entry, spaces.slugOf(entry.space) ?? entry.space).handle ===
          query.project,
      )

      if (project) {
        detail = await roles.loadAt(
          { scope: ROLE_SCOPE.project, space: project.space, projectId: project.id },
          name,
          ROLE_DETAIL_TOKEN_BUDGET,
        )
      }
    }

    if (!detail) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }

    return AgentRoleDetailResponseSchema.parse(detail)
  })

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
      if (!req.principal.username && !req.principal.system) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
      const personal = req.principal.username
        ? await ensurePersonalSpaceFor({ auth, spaces }, req.principal.username)
        : spaces.list()[0]?.id

      if (!personal) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
      location = { scope: ROLE_SCOPE.personal, space: personal } as const
    } else {
      const readableSpaces = spaces
        .list()
        .map((space) => space.id)
        .filter((space) => can(req.principal, 'space:read', { space }))
      const projects = await contextProjectsFor(readableSpaces)
      const project = projects.find(
        (entry) =>
          projectSummaryOf(entry, spaces.slugOf(entry.space) ?? entry.space).handle ===
          body.project,
      )

      if (!project || !can(req.principal, 'space:write', { space: project.space })) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
      location = {
        scope: ROLE_SCOPE.project,
        space: project.space,
        projectId: project.id,
      } as const
    }
    try {
      const role = await roles.addFromCatalog(body.name, location)
      const project = role.projectId && body.project ? { project: body.project } : {}
      const wireRole =
        role.scope === ROLE_SCOPE.personal
          ? personalRoleForWire(role)
          : {
              ...role,
              space: spaces.slugOf(role.space) ?? role.space,
              ...project,
            }
      return reply.code(HTTP_STATUS.CREATED).send(
        AddAgentRoleResponseSchema.parse({
          role: wireRole,
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

  const contextProjectsFor = async (readableSpaces: string[]) => {
    if (!projectsForRoles || !readableSpaces.length) {
      return []
    }

    return (await projectsForRoles.listForSpaces(readableSpaces)).filter(
      (project) => project.status === 'active',
    )
  }

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
  // canon: docs/projects.md#sessions-auditing-agent-episodes-243-321-mem-audita
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
        limit: q.data.limit,
        before: decodeSummaryCursor(q.data.cursor),
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
      const owner = agentOwnerOf(req.principal)

      if (!owner || !sessionAudit) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
      const id = (req.params as { id: string }).id
      const outside = id === 'outside'

      if (!outside && !AgentSessionIdSchema.safeParse(id).success) {
        throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'bad session id')
      }
      const activeSince = new Date(Date.now() - AGENT_SESSION_IDLE_MS).toISOString()
      const [target, events] = await Promise.all([
        outside
          ? sessionAudit
              .overview({ owner, activeSince, limit: 1 })
              .then((result) =>
                result.outside ? { kind: 'outside' as const, ...result.outside } : null,
              )
          : sessionAudit
              .find(owner, id, activeSince)
              .then((result) => (result ? { kind: 'session' as const, ...result } : null)),
        sessionAudit.events({
          owner,
          sessionId: outside ? null : id,
          type:
            q.data.filter === 'reads'
              ? 'retrieval'
              : q.data.filter === 'writes'
                ? 'write'
                : undefined,
          limit: q.data.limit,
          before: decodeEventCursor(q.data.cursor),
        }),
      ])

      if (!target) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
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
