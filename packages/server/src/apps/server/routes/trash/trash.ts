import type { FastifyInstance } from 'fastify'

import {
  type Author,
  RestoreResponseSchema,
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

import { type ApiRouteCtx, authz, s } from '../_shared'
import { trashItemToWire } from '../wire'

export const trashRoutes = async (app: FastifyInstance, ctx: ApiRouteCtx) => {
  const { spaceStoreFor, auth, restoreCoordinator, bulkRestoreCoordinator } = ctx

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
    const restoreAvailable = bulkRestoreCoordinator != null

    if (!store.listTrashed) {
      throw revisionsUnavailable()
    }
    const result =
      !restoreAvailable && q.data.availability === 'restorable'
        ? { items: [], total: 0, restorableTotal: 0, partialTotal: 0 }
        : await store.listTrashed({
            offset: q.data.offset,
            limit: q.data.limit,
            q: q.data.q,
            availability: restoreAvailable ? q.data.availability : undefined,
            scope: READ_SCOPE.trash,
          })
    const { items, total, restorableTotal, partialTotal } = result
    const cache = new Map<string | null, Author>()
    const wireItems = []

    for (const e of items) {
      let author = cache.get(e.principal)

      if (author === undefined) {
        author = await auth.describeAuthor(e.principal, req.principal.username)
        cache.set(e.principal, author)
      }
      wireItems.push(
        trashItemToWire(e, e.principal === null ? null : author, restoreCoordinator != null),
      )
    }

    return TrashResponseSchema.parse({
      items: wireItems,
      total,
      restorableTotal: restoreAvailable ? restorableTotal : 0,
      partialTotal: restoreAvailable ? partialTotal : 0,
      restoreAvailable,
    })
  })

  // POST /trash/restore: resurrect from the tombstone blob, keeping note-id + last
  // folder; a live note at the target path fails typed, no silent clobber (P3).
  // canon: docs/trash.md#restore
  app.post(
    s('/trash/restore'),
    { config: authz('space:write', 'space-replay') },
    async (req, reply) => {
      const body = TrashRestoreRequestSchema.safeParse(req.body)

      if (!body.success) {
        return reply
          .code(HTTP_STATUS.BAD_REQUEST)
          .send({ error: body.error.issues[0]?.message || 'bad request' })
      }
      if (!restoreCoordinator) {
        return reply.code(HTTP_STATUS.SERVICE_UNAVAILABLE).send(
          RestoreResponseSchema.parse({
            status: 'busy',
            error: 'restore unavailable',
            reason: 'strict-restore-unavailable',
          }),
        )
      }
      const result = await restoreCoordinator.execute({
        mode: 'trash',
        principal: req.principal,
        space: req.spaceId,
        noteId: body.data.id,
        revisionId: body.data.revisionId,
        idempotencyKey: body.data.idempotencyKey,
      })

      if (
        result.status === 'not-found' ||
        (result.status === 'busy' && result.reason === 'space-not-active')
      ) {
        return reply.code(HTTP_STATUS.NOT_FOUND).send({ error: 'note not found' })
      }
      const wire =
        result.status === 'succeeded'
          ? { ...result, id: result.noteId, noteId: undefined }
          : result.status === 'conflict'
            ? { ...result, error: 'restore conflict' }
            : result.status === 'not-restorable'
              ? { ...result, error: 'revision is not restorable' }
              : result.status === 'busy'
                ? { ...result, error: 'restore unavailable' }
                : result
      const status =
        result.status === 'succeeded'
          ? HTTP_STATUS.OK
          : result.status === 'pending'
            ? HTTP_STATUS.ACCEPTED
            : result.status === 'conflict'
              ? HTTP_STATUS.CONFLICT
              : result.status === 'not-restorable'
                ? HTTP_STATUS.UNPROCESSABLE_ENTITY
                : HTTP_STATUS.SERVICE_UNAVAILABLE

      return reply.code(status).send(RestoreResponseSchema.parse(wire))
    },
  )

  // POST /trash/restore-many: a persisted ordered roster whose deterministic
  // children execute the same strict single-note protocol.
  // canon: docs/trash.md#wire-and-ui
  app.post(
    s('/trash/restore-many'),
    { config: authz('space:write', 'space-replay') },
    async (req, reply) => {
      const body = TrashRestoreManyRequestSchema.safeParse(req.body)

      if (!body.success) {
        return reply
          .code(HTTP_STATUS.BAD_REQUEST)
          .send({ error: body.error.issues[0]?.message || 'bad request' })
      }
      if (!bulkRestoreCoordinator) {
        return reply.code(HTTP_STATUS.SERVICE_UNAVAILABLE).send(
          TrashRestoreManyResponseSchema.parse({
            status: 'busy',
            error: 'bulk restore unavailable',
            reason: 'strict-restore-unavailable',
          }),
        )
      }
      const result = await bulkRestoreCoordinator.execute({
        principal: req.principal,
        space: req.spaceId,
        idempotencyKey: body.data.idempotencyKey,
        ids: body.data.ids,
        all: body.data.all,
        q: body.data.q,
        onlyRestorable: body.data.onlyRestorable,
      })

      if (result.status === 'busy' && result.reason === 'space-not-active') {
        return reply.code(HTTP_STATUS.NOT_FOUND).send({ error: 'not found' })
      }

      const wire =
        result.status === 'conflict'
          ? { ...result, error: 'bulk restore idempotency conflict' }
          : result.status === 'busy'
            ? { ...result, error: 'bulk restore unavailable' }
            : result
      const status =
        result.status === 'completed'
          ? HTTP_STATUS.OK
          : result.status === 'running'
            ? HTTP_STATUS.ACCEPTED
            : result.status === 'conflict'
              ? HTTP_STATUS.CONFLICT
              : HTTP_STATUS.SERVICE_UNAVAILABLE

      return reply.code(status).send(TrashRestoreManyResponseSchema.parse(wire))
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
    if (!bulkRestoreCoordinator && body.data.availability === 'restorable') {
      return TrashPurgeResponseSchema.parse({ ok: true, purged: 0 })
    }
    const { purged } = await store.purgeTrash({
      ...body.data,
      availability:
        !bulkRestoreCoordinator && body.data.availability === 'unavailable'
          ? undefined
          : body.data.availability,
      scope: READ_SCOPE.trash,
    })
    return TrashPurgeResponseSchema.parse({ ok: true, purged })
  })
}
