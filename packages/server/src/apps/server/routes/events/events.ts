import type { FastifyInstance } from 'fastify'

import { SSE_EVENT, SseJobPayloadSchema, STORE_EVENT, StoreEventSchema } from '@notarium/contract'

import { type ApiRouteCtx, authz, s } from '../_shared'

export const eventsRoutes = async (app: FastifyInstance, ctx: ApiRouteCtx) => {
  const { spaces, auth, spaceStoreFor } = ctx

  // Per-space server-push channel (SSE). Isolation is structural — the
  // subscription IS this space's CachedStore bus, no filter to forget.
  // canon: docs/spaces.md#wire-two-route-families
  app.get(
    s('/events'),
    { config: { ...authz('space:read', 'space'), longLived: true } },
    async (req, reply) => {
      const store = await spaceStoreFor(req)
      const space = req.spaceId
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

      void store
        .syncStatus()
        .then((status) => send({ type: STORE_EVENT.STATUS, status }))
        .catch((err) =>
          console.error('[api] /api/events initial status ->', (err as Error).message),
        )
      const unsubscribe = await spaces.subscribe(space, (event) => {
        try {
          send(event)
        } catch (err) {
          console.error('[api] /api/events send ->', (err as Error).message)
        }
      })
      const keepalive = setInterval(() => reply.raw.write(':ka\n\n'), 25_000)

      const teardown = () => {
        clearInterval(keepalive)
        unsubscribe()
        reply.raw.end()
      }
      // Revoke = disconnect: membership removal / user disable closes the socket
      // server-side instead of letting it starve silently.
      // canon: docs/auth.md#sse-revoke-disconnect
      const unregister = auth.registerSse({
        principalId: req.principal.id,
        username: req.principal.username,
        space,
        close: teardown,
        notify,
        notifyMembers,
        notifyRename,
        notifyAgentSessions,
        notifyJob,
      })
      req.raw.on('close', () => {
        unregister()
        teardown()
      })
    },
  )
}
