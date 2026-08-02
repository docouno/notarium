import type { FastifyInstance } from 'fastify'

import { SearchResponseSchema } from '@notarium/contract'

import { type ApiRouteCtx, authz, s } from '../_shared'
import { searchResultToWire } from '../wire'

export const searchRoutes = async (app: FastifyInstance, ctx: ApiRouteCtx) => {
  const { spaceStoreFor } = ctx

  app.get(s('/search'), { config: authz('space:read', 'space') }, async (req) => {
    const q = ((req.query as { q?: string }).q || '').trim()

    if (!q) {
      return SearchResponseSchema.parse({ results: [] })
    }
    const store = await spaceStoreFor(req)
    return SearchResponseSchema.parse({ results: (await store.search(q)).map(searchResultToWire) })
  })
}
