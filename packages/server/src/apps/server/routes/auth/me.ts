// The principal's own corner: /api/me* self-management routes. Me-scoped authz
// (self:read/self:manage, never a space membership check); the personal-domain
// slug never crosses the wire. Handlers throw AuthError; the root error handler
// maps it to the wire envelope.
// canon: docs/auth.md#model · docs/projects.md#personal-domain-as-a-working-space-13-2026-06-20
import type { FastifyInstance, FastifyRequest } from 'fastify'

import {
  AgentAuditQuerySchema,
  AgentAuditResponseSchema,
  ConnectionPatchRequestSchema,
  ConnectionsResponseSchema,
  CONTEXT_KIND,
  ContextOrderRequestSchema,
  ContextPinRequestSchema,
  MeAgentContextResponseSchema,
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
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'

import { withAuthors } from '../../../../libs/authors'
import { AuthError, type AuthService } from '../../../../services/auth'
import { can } from '../../../../services/authz'
import type {
  ContextOrderPersistence,
  ContextSetsPersistence,
  RetrievalLogPersistence,
  ScopePinsPersistence,
} from '../../../../services/metaDb'
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
  }: {
    spaces: SpaceManager
    auth: AuthService
    storeAccess: StoreAccess
    contextSets?: ContextSetsPersistence
    scopePins?: ScopePinsPersistence
    contextOrder?: ContextOrderPersistence
    retrievalLog?: RetrievalLogPersistence
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

  // The agent-retrieval audit feed. A meta-DB-less host (or a principal with no
  // username, e.g. none-mode) has nothing captured → an honest empty audit, not
  // an error.
  // canon: docs/projects.md#audit-auditing-the-runtime-retrieval-243-mem-audita
  app.get('/api/me/agent-audit', { config: authz('self:read', 'host') }, async (req, reply) => {
    const owner = req.principal.username

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
