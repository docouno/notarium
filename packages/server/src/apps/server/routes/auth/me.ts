// The principal's own corner: /api/me* self-management routes. Me-scoped authz
// (self:read/self:manage, never a space membership check); the personal-domain
// slug never crosses the wire. Handlers throw AuthError; the root error handler
// maps it to the wire envelope.
// canon: docs/auth.md#model · docs/projects.md#personal-domain-as-a-working-space-13-2026-06-20
import type { FastifyInstance, FastifyRequest } from 'fastify'

import {
  ABILITY_AVAILABILITY_MODE,
  ABILITY_KIND,
  AbilitySaveRequestSchema,
  AbilitySaveResponseSchema,
  AddAgentRoleRequestSchema,
  AddAgentRoleResponseSchema,
  AddAgentSkillRequestSchema,
  AddAgentSkillResponseSchema,
  type AgentAbilityAvailability,
  AgentAbilityDetailResponseSchema,
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
  CreateAgentSkillRequestSchema,
  CreateAgentSkillResponseSchema,
  MeAgentContextResponseSchema,
  MeAgentRolesResponseSchema,
  MeAgentSkillsResponseSchema,
  MeMemoryQuerySchema,
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
  SetAbilityHomeRequestSchema,
  SetAbilityHomeResponseSchema,
  SetAgentAbilityAvailabilityRequestSchema,
  SetAgentAbilityAvailabilityResponseSchema,
  SetAgentAbilityEnabledRequestSchema,
  SetAgentAbilityEnabledResponseSchema,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { AgentSessionIdSchema } from '@notarium/contract/tools'
import { decodeAbilityLocator } from '@notarium/core'

import { withAuthors } from '../../../../libs/authors'
import type { AbilitiesService } from '../../../../services/abilities'
import { AGENT_SESSION_IDLE_MS } from '../../../../services/agentSessions'
import { AuthError, type AuthService } from '../../../../services/auth'
import { agentOwnerOf, can } from '../../../../services/authz'
import type {
  AgentSessionAuditEvent,
  AgentSessionAuditPersistence,
  ContextOrderPersistence,
  ContextSetsPersistence,
  RetrievalLogPersistence,
  ScopePinsPersistence,
} from '../../../../services/metaDb'
import {
  CatalogRoleNotFoundError,
  CatalogSkillNotFoundError,
  ROLE_SCOPE,
  RoleAlreadyExistsError,
  RoleDependencyConflictError,
  RoleInstallUnavailableError,
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
    abilities,
  }: {
    spaces: SpaceManager
    auth: AuthService
    storeAccess: StoreAccess
    contextSets?: ContextSetsPersistence
    scopePins?: ScopePinsPersistence
    contextOrder?: ContextOrderPersistence
    retrievalLog?: RetrievalLogPersistence
    sessionAudit?: AgentSessionAuditPersistence
    abilities?: AbilitiesService
  },
) => {
  app.get('/api/me', { config: authz('self:read', 'host') }, async (req) => {
    if (!req.principal.username) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    } // 'none' mode: no user to describe

    return MeSchema.parse(await auth.me(req.principal.username, req.principal))
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
    const abilityPersonalSpace = abilities ? await abilities.personalSpaceFor(req.principal) : null
    const store = await spaces.store(slug)
    // `eager` order = the ORDER the agent loads memory in, so the loaded/trimmed
    // flags match the bundle exactly (never modified-sorted). Sets and cross-space
    // pins resolve under THIS reader — honest degradation (P5).
    const resolveDeps = { store: storeAccess, spaces, contextSets, scopePins, contextOrder }
    const [tagPins, loosePins, memory, sets, order, abilityContext] = await Promise.all([
      weighAlwaysLoad(store),
      weighScopePins(resolveDeps, req.principal, { kind: CONTEXT_KIND.personal, id: slug }),
      listMemoryCategories(store, '', { order: 'eager' }),
      weighScopeContextSets(resolveDeps, req.principal, { kind: CONTEXT_KIND.personal, id: slug }),
      weighScopeOrder(resolveDeps, { kind: CONTEXT_KIND.personal, id: slug }),
      abilities && abilityPersonalSpace
        ? abilities.personalContext(req.principal, abilityPersonalSpace, query.role)
        : Promise.resolve({
            listing: { abilities: [], truncated: false },
            selected: null,
            locator: null,
          }),
    ])
    const selectedRole = abilityContext.selected
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
      selectedRole?.active && abilityContext.locator
        ? roleContextViewOf(
            selectedRole,
            abilityContext.locator,
            (space) => space,
            null,
            curated.role,
          )
        : undefined
    return MeAgentContextResponseSchema.parse({
      roles: abilityContext.listing.abilities.flatMap(({ ability }) => {
        const role = contextRoleSummaryOf(ability)
        return role ? [role] : []
      }),
      ...(abilityContext.listing.truncated ? { rolesTruncated: true } : {}),
      ...(roleView ? { role: roleView } : {}),
      pins: curated.pins,
      memory: await withAuthors(curated.memory, req.principal.username, auth.describeAuthor),
      sets: curated.sets,
      loadedTokens: curated.loadedTokens,
      totalTokens: curated.totalTokens,
      budgetTokens: PERSONAL_TOKEN_BUDGET,
    })
  })

  // ── Abilities: wire adapters over the shared application producer.
  const installUnavailable = (): AuthError =>
    new AuthError(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      'role installation is unavailable for this location',
      'role_install_unavailable',
    )

  app.get('/api/me/agent-skills', { config: authz('self:read', 'host') }, async (req) => {
    const query = AgentPackageLibraryQuerySchema.parse(req.query)

    if (!abilities) {
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
    const listed = await abilities.list('human', { kind: ABILITY_KIND.skill }, req.principal, query)

    if (listed.kind !== ABILITY_KIND.skill) {
      throw new Error('ability producer returned the wrong human projection')
    }

    return MeAgentSkillsResponseSchema.parse(listed.page)
  })

  app.post('/api/me/agent-skills', { config: authz('self:manage', 'host') }, async (req, reply) => {
    if (!abilities) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    const body = CreateAgentSkillRequestSchema.parse(req.body ?? {})

    try {
      const created = await abilities.create(
        await abilities.prepareCreate(req.principal, {
          kind: ABILITY_KIND.skill,
          source: 'custom',
          body,
        }),
      )

      if (created.kind !== ABILITY_KIND.skill) {
        throw new Error('ability producer returned the wrong publication kind')
      }

      return reply.code(HTTP_STATUS.CREATED).send(
        CreateAgentSkillResponseSchema.parse({
          skill: publishedSkillForWire(
            created.ability,
            body.scope === ROLE_SCOPE.space
              ? {
                  space: spaces.slugOf(created.ability.space) ?? created.ability.space,
                  availability: body.availability,
                }
              : null,
          ),
          noteId: created.ability.noteId,
          locator: created.locator,
          versionToken: created.versionToken,
        }),
      )
    } catch (error) {
      if (error instanceof SkillAlreadyExistsError) {
        throw new AuthError(HTTP_STATUS.CONFLICT, error.message, 'skill_exists')
      }
      if (error instanceof RoleInstallUnavailableError) {
        throw installUnavailable()
      }
      throw error
    }
  })

  app.post(
    '/api/me/agent-skills/catalog',
    { config: authz('self:manage', 'host') },
    async (req, reply) => {
      if (!abilities) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
      const body = AddAgentSkillRequestSchema.parse(req.body ?? {})

      try {
        const created = await abilities.create(
          await abilities.prepareCreate(req.principal, {
            kind: ABILITY_KIND.skill,
            source: 'catalog',
            body,
          }),
        )

        if (created.kind !== ABILITY_KIND.skill) {
          throw new Error('ability producer returned the wrong publication kind')
        }

        return reply.code(HTTP_STATUS.CREATED).send(
          AddAgentSkillResponseSchema.parse({
            skill: publishedSkillForWire(
              created.ability,
              body.scope === ROLE_SCOPE.space
                ? {
                    space: spaces.slugOf(created.ability.space) ?? created.ability.space,
                    availability: body.availability,
                  }
                : null,
            ),
            noteId: created.ability.noteId,
            locator: created.locator,
            versionToken: created.versionToken,
          }),
        )
      } catch (error) {
        if (error instanceof SkillAlreadyExistsError) {
          throw new AuthError(HTTP_STATUS.CONFLICT, error.message, 'skill_exists')
        }
        if (error instanceof CatalogSkillNotFoundError) {
          throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
        }
        if (error instanceof RoleInstallUnavailableError) {
          throw installUnavailable()
        }
        throw error
      }
    },
  )

  app.get('/api/me/agent-roles', { config: authz('self:read', 'host') }, async (req) => {
    const query = AgentPackageLibraryQuerySchema.parse(req.query)

    if (!abilities) {
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
    const listed = await abilities.list('human', { kind: ABILITY_KIND.role }, req.principal, query)

    if (listed.kind !== ABILITY_KIND.role) {
      throw new Error('ability producer returned the wrong human projection')
    }

    return MeAgentRolesResponseSchema.parse(listed.page)
  })

  app.get(
    '/api/me/agent-abilities/:locator',
    { config: authz('self:read', 'host') },
    async (req) => {
      if (!abilities) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
      const locator = decodeAbilityLocator((req.params as { locator: string }).locator)

      if (!locator) {
        throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'bad ability locator')
      }
      const detail = await abilities.get('human', req.principal, locator)

      if (!detail) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }

      return AgentAbilityDetailResponseSchema.parse(detail)
    },
  )

  app.put(
    '/api/me/agent-abilities/:locator/enabled',
    { config: authz('self:manage', 'host') },
    async (req) => {
      if (!abilities) {
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
      await abilities.setEnabled(req.principal, locator, body.enabled)

      return SetAgentAbilityEnabledResponseSchema.parse({ locator, enabled: body.enabled })
    },
  )

  app.put(
    '/api/me/agent-abilities/:locator/availability',
    { config: authz('self:manage', 'host') },
    async (req) => {
      if (!abilities) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
      const locator = decodeAbilityLocator((req.params as { locator: string }).locator)
      const availability = SetAgentAbilityAvailabilityRequestSchema.parse(req.body)

      if (!locator || locator.source !== 'owned' || locator.location.scope !== ROLE_SCOPE.space) {
        throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'bad ability locator')
      }
      await abilities.setAvailability(req.principal, locator, availability)

      return SetAgentAbilityAvailabilityResponseSchema.parse({ locator, availability })
    },
  )

  app.post(
    '/api/me/agent-abilities/:locator/versions',
    { config: authz('self:manage', 'host') },
    async (req, reply) => {
      if (!abilities) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
      const locator = decodeAbilityLocator((req.params as { locator: string }).locator)
      const body = CreateAbilityVersionRequestSchema.parse(req.body ?? {})

      if (
        !locator ||
        locator.source !== 'owned' ||
        locator.kind !== ABILITY_KIND.role ||
        locator.location.scope !== ROLE_SCOPE.space
      ) {
        throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'bad ability locator')
      }
      try {
        return reply
          .code(HTTP_STATUS.CREATED)
          .send(
            CreateAbilityVersionResponseSchema.parse(
              await abilities.createVersion(req.principal, locator, body.projectId),
            ),
          )
      } catch (error) {
        if (error instanceof RoleAlreadyExistsError) {
          throw new AuthError(HTTP_STATUS.CONFLICT, error.message, 'role_exists')
        }
        if (error instanceof RoleInstallUnavailableError) {
          throw installUnavailable()
        }
        throw error
      }
    },
  )

  app.put(
    '/api/me/agent-abilities/:locator/home',
    { config: authz('self:manage', 'host') },
    async (req) => {
      if (!abilities) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
      const locator = decodeAbilityLocator((req.params as { locator: string }).locator)
      SetAbilityHomeRequestSchema.parse(req.body ?? {})

      if (!locator || locator.source !== 'owned' || locator.kind !== ABILITY_KIND.role) {
        throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'bad ability locator')
      }
      try {
        return SetAbilityHomeResponseSchema.parse(await abilities.setHome(req.principal, locator))
      } catch (error) {
        if (error instanceof RoleAlreadyExistsError) {
          throw new AuthError(HTTP_STATUS.CONFLICT, error.message, 'role_exists')
        }
        if (error instanceof RoleInstallUnavailableError) {
          throw installUnavailable()
        }
        throw error
      }
    },
  )

  app.put(
    '/api/me/agent-abilities/:locator/save',
    { config: authz('self:manage', 'host') },
    async (req, reply) => {
      if (!abilities) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
      const locator = decodeAbilityLocator((req.params as { locator: string }).locator)

      if (!locator || locator.source !== 'owned') {
        throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'bad ability locator')
      }
      const body = AbilitySaveRequestSchema.parse(req.body ?? {})

      try {
        return AbilitySaveResponseSchema.parse(await abilities.save(req.principal, locator, body))
      } catch (error) {
        if (error instanceof RoleDependencyConflictError) {
          return reply.code(HTTP_STATUS.CONFLICT).send({
            error: error.message,
            reason: 'role_dependency_conflict',
          })
        }
        throw error
      }
    },
  )

  app.post('/api/me/agent-roles', { config: authz('self:manage', 'host') }, async (req, reply) => {
    if (!abilities) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    const body = AddAgentRoleRequestSchema.parse(req.body ?? {})

    try {
      const created = await abilities.create(
        await abilities.prepareCreate(req.principal, {
          kind: ABILITY_KIND.role,
          source: 'catalog',
          body,
        }),
      )

      if (created.kind !== ABILITY_KIND.role) {
        throw new Error('ability producer returned the wrong publication kind')
      }

      return reply.code(HTTP_STATUS.CREATED).send(
        AddAgentRoleResponseSchema.parse({
          role: publishedRoleForWire(
            created.ability,
            rolePlacementForWire(created.ability, body.project ?? '', (space) =>
              spaces.slugOf(space),
            ),
          ),
          locator: created.locator,
          versionToken: created.versionToken,
        }),
      )
    } catch (error) {
      if (error instanceof RoleAlreadyExistsError) {
        throw new AuthError(HTTP_STATUS.CONFLICT, error.message, 'role_exists')
      }
      if (error instanceof RoleDependencyConflictError) {
        throw new AuthError(HTTP_STATUS.CONFLICT, error.message, 'role_dependency_conflict')
      }
      if (error instanceof CatalogRoleNotFoundError) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
      if (error instanceof RoleInstallUnavailableError) {
        throw installUnavailable()
      }
      throw error
    }
  })

  app.post(
    '/api/me/agent-roles/custom',
    { config: authz('self:manage', 'host') },
    async (req, reply) => {
      if (!abilities) {
        throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
      }
      const body = CreateAgentRoleRequestSchema.parse(req.body ?? {})

      try {
        const created = await abilities.create(
          await abilities.prepareCreate(req.principal, {
            kind: ABILITY_KIND.role,
            source: 'custom',
            body,
          }),
        )

        if (created.kind !== ABILITY_KIND.role) {
          throw new Error('ability producer returned the wrong publication kind')
        }

        return reply.code(HTTP_STATUS.CREATED).send(
          CreateAgentRoleResponseSchema.parse({
            role: publishedRoleForWire(
              created.ability,
              rolePlacementForWire(
                created.ability,
                body.scope === ROLE_SCOPE.project ? body.project : '',
                (space) => spaces.slugOf(space),
              ),
            ),
            noteId: created.ability.noteId,
            locator: created.locator,
            versionToken: created.versionToken,
          }),
        )
      } catch (error) {
        if (error instanceof RoleAlreadyExistsError) {
          throw new AuthError(HTTP_STATUS.CONFLICT, error.message, 'role_exists')
        }
        if (error instanceof RoleDependencyConflictError) {
          throw new AuthError(HTTP_STATUS.CONFLICT, error.message, 'role_dependency_conflict')
        }
        if (error instanceof RoleInstallUnavailableError) {
          throw installUnavailable()
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

  // Retrieval-only compatibility read-model; the UI is session-first. self:manage keeps
  // this self-scoped audit session-only — no bearer (narrowed or not) may read it (#395).
  // A meta-DB-less host has nothing captured → an honest empty audit.
  // canon: docs/projects.md#activity-auditing-agent-work-243-321-mem-audita
  app.get('/api/me/agent-audit', { config: authz('self:manage', 'host') }, async (req, reply) => {
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
  app.get(
    '/api/me/agent-sessions',
    { config: authz('self:manage', 'host') },
    async (req, reply) => {
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
    },
  )

  app.get(
    '/api/me/agent-sessions/:id',
    { config: authz('self:manage', 'host') },
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
