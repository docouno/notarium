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
    const [results, notes] = await Promise.all([store.search(q), store.list()])
    const markers = new Map(
      notes.flatMap((note) =>
        note.id && note.viewType ? [[note.id, note.viewType] as const] : [],
      ),
    )

    return SearchResponseSchema.parse({
      results: results.map((result) =>
        searchResultToWire({
          ...result,
          ...(result.id && markers.get(result.id) ? { viewType: markers.get(result.id) } : {}),
        }),
      ),
    })
  })
}
