import type { FastifyInstance } from 'fastify'

import { GraphHealthResponseSchema, GraphResponseSchema } from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'

import { type ApiRouteCtx, authz, s } from '../_shared'
import { graphHealthToWire, graphToWire } from '../wire'

export const graphRoutes = async (app: FastifyInstance, ctx: ApiRouteCtx) => {
  const { spaceStoreFor } = ctx

  app.get(s('/graph'), { config: authz('space:read', 'space') }, async (req) =>
    GraphResponseSchema.parse(graphToWire(await (await spaceStoreFor(req)).graph())),
  )

  // Grooming health: the read-only count of wikilink edges resolving
  // through a FORMER name + the broken (ghost) links. A fresh derivation (the store
  // bypasses the incremental graph cache, whose resolvedVia would be stale after a
  // target rename). Capability-honest: a store without graphHealth 404s and the
  // dashboard hides the card (same as the activity aggregate).
  app.get(s('/graph/health'), { config: authz('space:read', 'space') }, async (req, reply) => {
    const store = await spaceStoreFor(req)

    if (!store.graphHealth) {
      return reply.code(HTTP_STATUS.NOT_FOUND).send({ error: 'graph_health_unavailable' })
    }

    return GraphHealthResponseSchema.parse(graphHealthToWire(await store.graphHealth()))
  })
}
