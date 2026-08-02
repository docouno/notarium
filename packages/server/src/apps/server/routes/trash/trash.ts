import type { FastifyInstance } from 'fastify'

import {
  type Author,
  SaveResponseSchema,
  TrashPurgeRequestSchema,
  TrashPurgeResponseSchema,
  TrashQuerySchema,
  TrashResponseSchema,
  TrashRestoreManyRequestSchema,
  TrashRestoreManyResponseSchema,
  TrashRestoreRequestSchema,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { READ_SCOPE, revisionsUnavailable } from '@notarium/core'

import { type ApiRouteCtx, authz, batchFailure, s } from '../_shared'
import { trashItemToWire } from '../wire'

export const trashRoutes = async (app: FastifyInstance, ctx: ApiRouteCtx) => {
  const { spaceStoreFor, principalId, auth } = ctx

  // GET /trash: space-scoped view over the delete-journal, newest first.
  // Scope agentRecall (vs the `user` default that hides memory) unifies notes +
  // agent-memory tombstones, so a deleted memory note is restorable here.
  // canon: docs/trash.md#model · docs/trash.md#querying-the-trash
  app.get(s('/trash'), { config: authz('space:read', 'space') }, async (req, reply) => {
    const q = TrashQuerySchema.safeParse(req.query)

    if (!q.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: q.error.issues[0]?.message || 'bad query' })
    }
    const store = await spaceStoreFor(req)

    if (!store.listTrashed) {
      throw revisionsUnavailable()
    }
    const { items, total, restorableTotal } = await store.listTrashed({
      offset: q.data.offset,
      limit: q.data.limit,
      q: q.data.q,
      scope: READ_SCOPE.agentRecall,
    })
    const cache = new Map<string | null, Author>()
    const wireItems = []

    for (const e of items) {
      let author = cache.get(e.principal)

      if (author === undefined) {
        author = await auth.describeAuthor(e.principal, req.principal.username)
        cache.set(e.principal, author)
      }
      wireItems.push(trashItemToWire(e, e.principal === null ? null : author))
    }

    return TrashResponseSchema.parse({ items: wireItems, total, restorableTotal })
  })

  // POST /trash/restore: resurrect from the tombstone blob, keeping note-id + last
  // folder; a live note at the target path fails typed, no silent clobber (P3).
  // canon: docs/trash.md#restore
  app.post(s('/trash/restore'), { config: authz('space:write', 'space') }, async (req, reply) => {
    const body = TrashRestoreRequestSchema.safeParse(req.body)

    if (!body.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: body.error.issues[0]?.message || 'bad request' })
    }
    const store = await spaceStoreFor(req)

    if (!store.restoreFromTrash) {
      throw revisionsUnavailable()
    }
    const r = await store.restoreFromTrash(body.data.id, { principal: principalId(req) })
    return SaveResponseSchema.parse({
      ok: true,
      id: r.id,
      filePath: r.filePath,
      versionToken: r.versionToken,
    })
  })

  // POST /trash/restore-many: best-effort batch, NOT transactional — per-id failures
  // return in failed[] rather than one 4xx sinking the whole restore.
  // canon: docs/trash.md#wire-and-ui
  app.post(
    s('/trash/restore-many'),
    { config: authz('space:write', 'space') },
    async (req, reply) => {
      const body = TrashRestoreManyRequestSchema.safeParse(req.body)

      if (!body.success) {
        return reply
          .code(HTTP_STATUS.BAD_REQUEST)
          .send({ error: body.error.issues[0]?.message || 'bad request' })
      }
      const store = await spaceStoreFor(req)

      if (!store.restoreTrash && !store.restoreFromTrash) {
        throw revisionsUnavailable()
      }
      const ids = body.data.ids ? [...new Set(body.data.ids)] : undefined
      const result = store.restoreTrash
        ? await store.restoreTrash({
            ids,
            all: body.data.all,
            q: body.data.q,
            onlyRestorable: body.data.onlyRestorable,
            scope: READ_SCOPE.agentRecall,
            principal: principalId(req),
          })
        : await (async () => {
            let noteIds = ids ?? []

            if (!noteIds.length && body.data.all) {
              if (!store.listTrashed) {
                throw revisionsUnavailable()
              }
              noteIds = []
              const PAGE = 500
              let scanOffset = 0

              for (;;) {
                const { items } = await store.listTrashed({
                  offset: scanOffset,
                  limit: PAGE,
                  q: body.data.q,
                  scope: READ_SCOPE.agentRecall,
                })

                for (const item of items) {
                  if (body.data.onlyRestorable && item.contentHash == null) {
                    continue
                  }
                  noteIds.push(item.noteId)
                }
                scanOffset += items.length
                if (items.length < PAGE) {
                  break
                }
              }
            }
            const restored = []
            const failed = []

            for (const id of noteIds) {
              try {
                restored.push(await store.restoreFromTrash!(id, { principal: principalId(req) }))
              } catch (err) {
                failed.push(batchFailure(id, err, 'restore failed'))
              }
            }

            return { restored, failed }
          })()
      return TrashRestoreManyResponseSchema.parse({
        ok: true,
        restored: result.restored.map((r) => ({
          id: r.id,
          filePath: r.filePath,
          versionToken: r.versionToken,
        })),
        failed: result.failed,
      })
    },
  )

  // POST /trash/purge: irreversible erase (journal rows + GC of orphan blobs).
  // Scope agentRecall must MATCH the list scope so a select-all-N sweep clears exactly
  // what the list shows (else memory tombstones linger, purge-able only by id); scope
  // bounds only the {all} sweep — an explicit {ids} purge erases any trashed id.
  // canon: docs/trash.md#permanent-deletion
  app.post(s('/trash/purge'), { config: authz('space:write', 'space') }, async (req, reply) => {
    const body = TrashPurgeRequestSchema.safeParse(req.body)

    if (!body.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: body.error.issues[0]?.message || 'bad request' })
    }
    const store = await spaceStoreFor(req)

    if (!store.purgeTrash) {
      throw revisionsUnavailable()
    }
    const { purged } = await store.purgeTrash({ ...body.data, scope: READ_SCOPE.agentRecall })
    return TrashPurgeResponseSchema.parse({ ok: true, purged })
  })
}
