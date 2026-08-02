import type { FastifyInstance } from 'fastify'

import {
  TreeChildrenQuerySchema,
  TreeChildrenResponseSchema,
  TreeResponseSchema,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { treeChildren, treeSummary } from '@notarium/core'

import { type ApiRouteCtx, authz, s, treeDirsFor } from '../_shared'
import { noteToWire } from '../wire'

export const treeRoutes = async (app: FastifyInstance, ctx: ApiRouteCtx) => {
  const { spaceStoreFor, projects, folderIdentitiesFor } = ctx

  // The structure endpoint: folder skeleton + counts + base stats. The
  // sidebar tree and the Feed aside boot from this and fetch note windows per
  // folder — the full list never crosses the wire for them again.
  app.get(s('/tree'), { config: authz('space:read', 'space') }, async (req) => {
    const store = await spaceStoreFor(req)
    const space = req.spaceId
    const projectRows = projects ? await projects.listForSpace(space) : []
    return TreeResponseSchema.parse(
      treeSummary(
        await store.list(),
        await treeDirsFor(store, projectRows),
        Date.now(),
        await folderIdentitiesFor(space, projectRows),
      ),
    )
  })

  // One lazy-tree expand step: a folder's direct subfolders + its direct
  // notes, title-ordered, with offset/limit for huge folders.
  app.get(s('/tree/children'), { config: authz('space:read', 'space') }, async (req, reply) => {
    const q = TreeChildrenQuerySchema.safeParse(req.query)

    if (!q.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: q.error.issues[0]?.message || 'bad query' })
    }
    const store = await spaceStoreFor(req)
    const space = req.spaceId
    const projectRows = projects ? await projects.listForSpace(space) : []
    const step = treeChildren(
      await store.list(),
      await treeDirsFor(store, projectRows),
      q.data,
      await folderIdentitiesFor(space, projectRows),
    )
    return TreeChildrenResponseSchema.parse({ ...step, notes: step.notes.map(noteToWire) })
  })
}
