import type { FastifyInstance } from 'fastify'

import {
  AUTH_MODE,
  SSE_EVENT,
  SseJobPayloadSchema,
  STORE_EVENT,
  StoreEventSchema,
} from '@notarium/contract'

import { can } from '../../../../services/authz'
import { type ApiRouteCtx, authz, s } from '../_shared'

export const acquireEventSubscriptions = async <T>(
  items: Iterable<T>,
  acquire: (item: T) => Promise<() => void>,
  closed: () => boolean = () => false,
): Promise<Array<() => void>> => {
  const releases: Array<() => void> = []

  try {
    for (const item of items) {
      const release = await acquire(item)

      if (closed()) {
        release()
        throw new Error('event stream closed during subscription setup')
      }
      releases.push(release)
    }

    return releases
  } catch (error) {
    releases.reverse().forEach((release) => release())
    throw error
  }
}

export const eventsRoutes = async (app: FastifyInstance, ctx: ApiRouteCtx) => {
  const { spaces, auth, spaceStoreFor } = ctx

  // Active-space server-push channel (SSE). Isolation is structural by default; an
  // explicit bounded `watch` list may multiplex other independently authorised buses
  // for a surface that is already rendering cross-space context rows.
  // canon: docs/spaces.md#wire-two-route-families
  app.get(
    s('/events'),
    { config: { ...authz('space:read', 'space'), longLived: true } },
    async (req, reply) => {
      const space = req.spaceId
      const watch = (req.query as { watch?: unknown }).watch
      const watchedSpaces = new Set([space])

      if (typeof watch === 'string') {
        for (const slug of watch.split(',').slice(0, 250)) {
          const watched = spaces.has(slug) ? slug : spaces.resolveId(slug)

          if (watched && can(req.principal, 'space:read', { space: watched })) {
            watchedSpaces.add(watched)
          }
        }
      }
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      const send = (event: unknown) =>
        reply.raw.write(`data: ${JSON.stringify(StoreEventSchema.parse(event))}\n\n`)
      // Grant-side nudge: a NAMED `access` event, outside the StoreEvent `data:`
      // frames. Empty body is intentional — client refetches /api/auth/session.
      // canon: docs/auth.md#loss-of-access-at-runtime-explicit-takeover-111
      const notify = () => reply.raw.write(`event: ${SSE_EVENT.ACCESS}\ndata: {}\n\n`)
      // NAMED `members` event; empty body — the truth is GET /members.
      const notifyMembers = () => reply.raw.write(`event: ${SSE_EVENT.MEMBERS}\ndata: {}\n\n`)
      // NAMED `rename` event; empty body — the truth is GET /api/spaces.
      const notifyRename = () => reply.raw.write(`event: ${SSE_EVENT.RENAME}\ndata: {}\n\n`)
      // Owner-global durable session nudge. The socket registry targets only
      // handles belonging to the session owner; truth stays in the REST list.
      const notifyAgentSessions = () =>
        reply.raw.write(`event: ${SSE_EVENT.AGENT_SESSIONS}\ndata: {}\n\n`)
      // NAMED `job` event with wire job status. notifyJobOf targets ONLY the owner's
      // handles (filters by principalId) — status/error/artifact never leaks to other
      // space members. canon: docs/jobs.md#wiring
      const notifyJob = (payload: unknown) =>
        reply.raw.write(
          `event: ${SSE_EVENT.JOB}\ndata: ${JSON.stringify(SseJobPayloadSchema.parse(payload))}\n\n`,
        )
      const notifyContextChanged = (sourceSpace: string, event: unknown) =>
        reply.raw.write(
          `event: ${SSE_EVENT.CONTEXT_CHANGED}\ndata: ${JSON.stringify({ sourceSpace, event: StoreEventSchema.parse(event) })}\n\n`,
        )
      const notifyReady = () => reply.raw.write(`event: ${SSE_EVENT.READY}\ndata: {}\n\n`)
      const unsubscribes: Array<() => void> = []
      let keepalive: ReturnType<typeof setInterval> | null = null

      let unregister = () => {}
      let tornDown = false

      const teardown = () => {
        if (tornDown) {
          return
        }
        tornDown = true
        if (keepalive) {
          clearInterval(keepalive)
        }
        unregister()
        unsubscribes.forEach((unsubscribe) => unsubscribe())
        reply.raw.end()
      }
      req.raw.on('close', teardown)
      // Register the complete authorization footprint BEFORE any lazy store boot.
      // A revoke/archive racing subscription setup can now find and tear down this
      // socket; `acquireEventSubscriptions` observes `tornDown` and rolls back legs.
      unregister = auth.registerSse({
        principalId: req.principal.id,
        userId: req.principal.userId,
        space,
        spaces: watchedSpaces,
        close: teardown,
        notify,
        notifyMembers,
        notifyRename,
        notifyAgentSessions,
        notifyJob,
      })

      try {
        // Authz ran before the handler, so a revoke could have committed before this
        // handle entered the registry. Registration linearizes later revokes; this
        // second credential/grant read closes the earlier side of that boundary.
        if (auth.mode === AUTH_MODE.password) {
          const current = await auth.authenticate(req.headers)

          if (
            !current ||
            current.principal.id !== req.principal.id ||
            [...watchedSpaces].some(
              (watched) => !can(current.principal, 'space:read', { space: watched }),
            )
          ) {
            teardown()
            return
          }
          req.principal = current.principal
        }
        // Registration above is deliberately synchronous and precedes this first lazy
        // store boot. A revoke/archive during boot can therefore tear the request down;
        // a closed request never reaches bus acquisition afterward.
        const store = await spaceStoreFor(req)

        if (tornDown) {
          return
        }
        const acquired = await acquireEventSubscriptions(
          watchedSpaces,
          (watched) =>
            spaces.subscribe(watched, (event) => {
              try {
                if (watched === space) {
                  send(event)
                } else if (event.type === STORE_EVENT.CHANGED) {
                  notifyContextChanged(watched, event)
                }
              } catch (err) {
                console.error('[api] /api/events send ->', (err as Error).message)
              }
            }),
          () => tornDown,
        )

        for (const unsubscribe of acquired) {
          unsubscribes.push(unsubscribe)
        }
        try {
          const status = await store.syncStatus()

          if (!tornDown) {
            send({ type: STORE_EVENT.STATUS, status })
          }
        } catch (err) {
          console.error('[api] /api/events initial status ->', (err as Error).message)
        }
        if (tornDown) {
          return
        }
        // `open` only means HTTP headers reached EventSource. This marker is the
        // stronger handoff barrier: every supplemental bus is now owned by the handle
        // and the initial active-space status snapshot has been emitted.
        notifyReady()
      } catch (error) {
        teardown()
        throw error
      }
      keepalive = setInterval(() => reply.raw.write(':ka\n\n'), 25_000)
    },
  )
}
