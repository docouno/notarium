import fastifyMultipart from '@fastify/multipart'
// The same app serves any KnowledgeStore: production wires the Notarium engine,
// the e2e fake wires InMemoryStore into this very app — so tests hit the real edge code.
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { AUTH_MODE } from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { STORE_ERROR_REASON } from '@notarium/core'
import type { ConflictNote, ExistingNote, InteractiveSignal } from '@notarium/core'

import type { ArtifactStore } from '../../libs/artifactStore'
import type { BuildInfo } from '../../libs/buildInfo'
import type { HostInfo } from '../../libs/hostInfo'
import type { ImportStagingStore } from '../../libs/importStaging'
import type { MutationGate, MutationRelease } from '../../libs/mutationGate'
import { AuthError, type AuthService, createAuthService } from '../../services/auth'
import type {
  AgentDeltaCursorsPersistence,
  AgentSessionAuditPersistence,
  AgentSessionsPersistence,
  ContextOrderPersistence,
  ContextSetsPersistence,
  FavoritesPersistence,
  FolderIdentityPersistence,
  GatewayStatePersistence,
  JobsPersistence,
  OAuthPersistence,
  ProjectsPersistence,
  RetrievalLogPersistence,
  ScopePinsPersistence,
  SpacesPersistence,
} from '../../services/metaDb'
import type { BulkRestoreCoordinator, RestoreCoordinator } from '../../services/noteRestore'
import type { MarkerStore } from '../../services/projects'
import type { RolesService } from '../../services/roles'
import type { SpaceManager } from '../../services/spaces'
import { installAuthz } from './perimeter/authz'
import { spaFallbackDecision, spaRequestDecision } from './perimeter/spaFallback'
import { validationIssuesOf } from './perimeter/validationError'
import { apiRoutes } from './routes'
import { registerMcp } from './routes/mcp'
import { registerOAuthRoutes } from './routes/oauth'
import { conflictToWire } from './routes/wire'

/** Assembly inputs for the host. Optional facets are absent on a meta-DB-less host
 *  and degrade honestly (the surface 404s / returns empty) rather than break.
 *  canon: docs/architecture.md#p5 */
export type BuildAppOptions = {
  spaces: SpaceManager
  auth?: AuthService
  sessions?: AgentSessionsPersistence
  roles?: RolesService
  agentDeltaCursors?: AgentDeltaCursorsPersistence
  gatewayState?: GatewayStatePersistence
  projects?: ProjectsPersistence
  folders?: FolderIdentityPersistence
  favorites?: FavoritesPersistence
  contextSets?: ContextSetsPersistence
  scopePins?: ScopePinsPersistence
  contextOrder?: ContextOrderPersistence
  retrievalLog?: RetrievalLogPersistence
  sessionAudit?: AgentSessionAuditPersistence
  markerStore?: MarkerStore
  spacesPersistence?: SpacesPersistence
  spaDist?: string
  about?: HostInfo
  /** Overrides the bundle's own inlined build identity (test harnesses only —
   *  production has exactly one honest answer). canon: docs/release.md#identity */
  build?: BuildInfo
  /** The `auth` service MUST have been built with the SAME OAuth facet, else an
   *  issued token won't validate through its chokepoint. */
  oauth?: OAuthPersistence
  publicBaseUrl?: string
  /** Explicit proxy IP/CIDR allowlist for Fastify's canonical request IP.
   *  Unset means X-Forwarded-For cannot affect rate limits.
   *  canon: docs/auth.md#csrf-and-proxy */
  trustProxy?: string[]
  scheduler?: InteractiveSignal
  jobs?: JobsPersistence
  /** Present whenever `jobs` is. */
  artifacts?: ArtifactStore
  /** Present whenever `jobs` is; absent ⇒ /import uses the synchronous streaming path. */
  staging?: ImportStagingStore
  wakeJobs?: () => void
  /** Process-local online-backup barrier. Only mutating HTTP requests enter it;
   *  reads stay available while a checkpoint briefly drains writes. */
  mutationGate?: MutationGate
  restoreCoordinator?: RestoreCoordinator
  bulkRestoreCoordinator?: BulkRestoreCoordinator
}

export const buildApp = async ({
  spaces,
  auth,
  sessions,
  roles,
  agentDeltaCursors,
  gatewayState,
  retrievalLog,
  sessionAudit,
  projects,
  folders,
  favorites,
  contextSets,
  scopePins,
  contextOrder,
  markerStore,
  spacesPersistence,
  spaDist,
  about,
  build,
  oauth,
  publicBaseUrl,
  trustProxy,
  scheduler,
  jobs,
  artifacts,
  staging,
  wakeJobs,
  mutationGate,
  restoreCoordinator,
  bulkRestoreCoordinator,
}: BuildAppOptions): Promise<FastifyInstance> => {
  const app = Fastify({ bodyLimit: 4 * 1024 * 1024, trustProxy: trustProxy ?? false })
  const authService = auth ?? createAuthService({ mode: AUTH_MODE.none })
  app.addHook('preClose', async () => authService.disconnectAllSse())

  // Interactive-traffic signal: count each short request in flight so the background
  // embed backfill yields while a user is served. LONG-LIVED routes (SSE, streaming
  // import/export) opt out via `config.longLived` — else an SSE socket pins the count
  // for the tab's lifetime and starves background work (import self-marks via its bulk
  // bracket; /mcp self-counts, onResponse never fires for a hijacked reply).
  //
  // Release on the RESPONSE stream's `close` — the one terminal signal firing for both a
  // normal finish AND a client abort, body-less or body-bearing. `onResponse` misses a
  // socket aborted mid-handler; `onRequestAbort` misses a request whose body was already
  // consumed (its 'close' fired at body-end with aborted=false). The count is
  // PROCESS-GLOBAL, so one leaked mark pins the backfill to the drip floor forever. The
  // `onResponse` hook is a belt for app.inject mock sockets that may not emit 'close'; the
  // COUNTED marker makes release idempotent so the two can't double-fire.
  if (scheduler) {
    const COUNTED = Symbol('bgCounted')

    const release = (req: unknown): void => {
      const r = req as Record<symbol, boolean>

      if (r[COUNTED]) {
        r[COUNTED] = false
        scheduler.exitInteractive()
      }
    }
    app.addHook('onRequest', (req, reply, done) => {
      const longLived = (req.routeOptions?.config as { longLived?: boolean } | undefined)?.longLived

      if (!longLived) {
        scheduler.enterInteractive()
        ;(req as unknown as Record<symbol, boolean>)[COUNTED] = true
        reply.raw.once('close', () => release(req))
      }
      done()
    })
    app.addHook('onResponse', (req, _reply, done) => {
      release(req)
      done()
    })
  }

  if (mutationGate) {
    const RELEASE = Symbol('backupMutationRelease')
    const HANDLER_STARTED = Symbol('backupMutationHandlerStarted')
    const mutating = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

    const release = (req: unknown): void => {
      const record = req as Record<symbol, MutationRelease | undefined>
      const done = record[RELEASE]

      if (done) {
        record[RELEASE] = undefined
        done()
      }
    }

    // Hold the barrier until the route handler's Promise actually settles. A
    // disconnected response socket is not proof that a handler stopped mutating.
    app.addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method]

      if (!methods.some((method) => mutating.has(method)) || route.path === '/mcp') {
        return
      }
      const handler = route.handler

      route.handler = async function (req, reply) {
        const record = req as unknown as Record<symbol, MutationRelease | boolean | undefined>
        record[HANDLER_STARTED] = true
        if (!record[RELEASE]) {
          record[RELEASE] = await mutationGate.enter()
        }
        try {
          return await handler.call(this, req, reply)
        } finally {
          release(req)
        }
      }
    })

    app.addHook('onRequest', async (req, reply) => {
      if (!mutating.has(req.method) || req.url === '/mcp') {
        return
      }
      const controller = new AbortController()
      const abort = (): void => controller.abort(new Error('request disconnected before admission'))
      req.raw.once('aborted', abort)
      reply.raw.once('close', abort)
      if (req.raw.aborted) {
        abort()
      }
      try {
        ;(req as unknown as Record<symbol, MutationRelease | undefined>)[RELEASE] =
          await mutationGate.enter({ signal: controller.signal })
      } finally {
        req.raw.off('aborted', abort)
        reply.raw.off('close', abort)
      }
      reply.raw.once('close', () => {
        const record = req as unknown as Record<symbol, boolean | undefined>

        if (!record[HANDLER_STARTED]) {
          release(req)
        }
      })
    })
    app.addHook('onResponse', (req, _reply, done) => {
      release(req)
      done()
    })
    app.addHook('onError', (req, _reply, _error, done) => {
      release(req)
      done()
    })
  }

  // The authz chokepoint: authenticates every request and space-scopes /api in one place.
  // Archived-space invariant: an archived space keeps its slug registered (O(1) restore)
  // but is not served, so resolve it to null here — every space-scoped route then 404s via
  // can()'s deny, INCLUDING mutation routes (rename, projects CRUD) that bypass
  // spaces.store(); DELETE archive still works because the space is live when it resolves.
  // canon: docs/auth.md#model · docs/spaces.md#deleting-a-space-soft-archive-110
  installAuthz(
    app,
    authService,
    (slug) => {
      const id = spaces.resolveId(slug)
      return id && !spaces.recOf(id)?.archivedAt ? id : null
    },
    (slug) => spaces.resolveId(slug),
  )

  // Thrown errors → JSON envelopes; the 409 conflict carries the live note (CAS loser
  // gets the other side, nothing overwritten). canon: docs/contract.md#cas
  app.setErrorHandler(
    (
      err: Error & {
        isToolError?: boolean
        isUnavailable?: boolean
        isNotFound?: boolean
        isConflict?: boolean
        current?: ConflictNote
        existing?: ExistingNote
        suggestedTitle?: string
        reason?: string
      },
      req,
      reply,
    ) => {
      if (err instanceof AuthError) {
        return reply
          .code(err.status)
          .send({ error: err.message, ...(err.reason ? { reason: err.reason } : {}) })
      }
      // Without this, a `.parse()` throw would fall through to the 500 below and leak the
      // raw zod issue JSON as the error message.
      const issues = validationIssuesOf(err)

      if (issues) {
        const lead = issues[0]
        const message = lead
          ? lead.path
            ? `${lead.path}: ${lead.message}`
            : lead.message
          : 'invalid request'
        return reply
          .code(HTTP_STATUS.BAD_REQUEST)
          .send({ error: message, reason: 'validation', issues })
      }
      console.error(`[api] ${req.method} ${req.url} ->`, err.message)
      if (err.isUnavailable) {
        return reply
          .code(HTTP_STATUS.SERVICE_UNAVAILABLE)
          .send({ error: err.message, reason: err.reason || 'engine_unavailable' })
      }
      if (err.isNotFound) {
        return reply
          .code(HTTP_STATUS.NOT_FOUND)
          .send({ error: err.message, reason: err.reason || STORE_ERROR_REASON.noteNotFound })
      }
      if (err.isConflict) {
        // Error envelopes cross the domain↔wire seam too. canon: docs/contract.md#mappers
        return reply.code(HTTP_STATUS.CONFLICT).send({
          error: err.message,
          reason: err.reason || STORE_ERROR_REASON.versionConflict,
          current: err.current ? conflictToWire(err.current) : undefined,
        })
      }
      // A create refused because the destination is taken is a state conflict, not a
      // malformed request — same 409 the folder and folder-page name clashes answer
      // with. canon: docs/note-model.md#create-collisions
      if (err.reason === STORE_ERROR_REASON.noteAlreadyExists) {
        return reply.code(HTTP_STATUS.CONFLICT).send({
          error: err.message,
          reason: STORE_ERROR_REASON.noteAlreadyExists,
          existing: err.existing,
          suggestedTitle: err.suggestedTitle,
        })
      }
      reply
        .code(err.isToolError ? HTTP_STATUS.BAD_REQUEST : HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .send({
          error: err.message,
          ...(err.isToolError && err.reason ? { reason: err.reason } : {}),
        })
    },
  )

  // Multipart import: the upload is streamed to disk and stream-parsed (bounded memory at
  // any size), so this 2 GB cap can be generous. canon: docs/import.md#data-path
  await app.register(fastifyMultipart, {
    limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 1, fields: 4 },
  })

  await app.register(apiRoutes, {
    spaces,
    auth: authService,
    projects,
    folders,
    favorites,
    contextSets,
    scopePins,
    contextOrder,
    retrievalLog,
    sessionAudit,
    sessions,
    roles,
    markerStore,
    spacesPersistence,
    about,
    build,
    jobs,
    artifacts,
    staging,
    wakeJobs,
    restoreCoordinator,
    bulkRestoreCoordinator,
  })

  // The OAuth connector facade (discovery + flow endpoints), registered BEFORE the SPA
  // fallback and OUTSIDE /api so it self-authenticates. canon: docs/mcp-oauth.md#surfaces
  if (oauth) {
    await registerOAuthRoutes(app, { store: oauth, auth: authService, publicBaseUrl })
  }

  // The MCP gateway: the agent-facing JSON-RPC tool surface at /mcp. Registered before the
  // SPA fallback so a GET answers 405 (never index.html) and it self-authenticates; with the
  // OAuth facade on, an unauthenticated 401 carries the RFC 9728 challenge.
  // canon: docs/mcp-gateway.md#connect
  await registerMcp(app, {
    spaces,
    auth: authService,
    roles,
    sessions,
    agentDeltaCursors,
    gatewayState,
    retrievalLog,
    projects,
    folders,
    contextSets,
    scopePins,
    contextOrder,
    markerStore,
    oauthChallenge: Boolean(oauth),
    publicBaseUrl,
    // The MCP handler hijacks the reply, so the app-level onResponse hook can't
    // balance its count — it marks itself busy inside the handler instead.
    scheduler,
    mutationGate,
  })

  if (spaDist && existsSync(spaDist)) {
    app.addHook('onRequest', async (req, reply) => {
      const decision = spaRequestDecision(req.url)

      if (decision === 'bad-request') {
        return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: 'bad request' })
      }
      if (decision === 'not-found') {
        return reply.code(HTTP_STATUS.NOT_FOUND).send({ error: 'not found' })
      }
    })
    // Keep the static wildcard in its own scope. The global hook above lets
    // direct server routes reach the router; this narrower hook runs only when
    // that router missed, so even a future dist/api/* file cannot occupy a
    // reserved server namespace.
    await app.register(async (staticApp) => {
      staticApp.addHook('onRequest', async (req, reply) => {
        const decision = spaFallbackDecision(req.url)

        if (decision === 'bad-request') {
          return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: 'bad request' })
        }
        if (decision === 'not-found') {
          return reply.code(HTTP_STATUS.NOT_FOUND).send({ error: 'not found' })
        }
      })
      await staticApp.register(fastifyStatic, { root: spaDist })
    })
    app.setNotFoundHandler((req, reply) => {
      // History fallback is a representation lookup, never a catch-all endpoint.
      // The static wildcard owns GET/HEAD (and carries sendFile in its scope);
      // unknown mutating/preflight methods stay an ordinary JSON 404.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return reply.code(HTTP_STATUS.NOT_FOUND).send({ error: 'not found' })
      }

      const decision = spaFallbackDecision(req.url)

      if (decision === 'bad-request') {
        return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: 'bad request' })
      }
      if (decision === 'not-found') {
        return reply.code(HTTP_STATUS.NOT_FOUND).send({ error: 'not found' })
      }

      return reply.sendFile('index.html')
    })
  }

  return app
}

/** Locates the built SPA via the @notarium/web package so the path survives both dev
 *  (tsx over src/) and production (bundled dist/) — import.meta-relative paths would differ. */
export const webDist = (): string => {
  try {
    const require = createRequire(import.meta.url)
    return join(dirname(require.resolve('@notarium/web/package.json')), 'dist')
  } catch {
    return ''
  }
}
