import type { FastifyInstance, FastifyReply } from 'fastify'

import {
  PROVIDER_ATTACHMENT_CONFLICT,
  ProviderAttachmentAcceptRequestSchema,
  ProviderAttachmentAcceptResponseSchema,
  ProviderAttachmentConflictResponseSchema,
  ProviderAttachmentDetachResponseSchema,
  ProviderAttachmentDetailResponseSchema,
  ProviderAttachmentOfferRequestSchema,
  ProviderAttachmentOfferResponseSchema,
  ProviderAttachmentsResponseSchema,
  ProviderInventoryQuerySchema,
  ProviderRetargetConflictResponseSchema,
  ProviderRetargetRequestSchema,
  ProviderRetargetResponseSchema,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'

import { agentOwnerOf, can } from '../../../../services/authz'
import { ProviderRateLimitError } from '../../../../services/providerRuntime'
import {
  type ApiRouteCtx,
  authz,
  notFound,
  PROVIDER_INVENTORY_FETCH_LIMIT,
  providerInventoryAfter,
  providerInventoryPage,
  s,
} from '../_shared'

const badRequest = (reply: FastifyReply, error: string) =>
  reply.code(HTTP_STATUS.BAD_REQUEST).send({ error })

const conflict = (
  reply: FastifyReply,
  reason: 'already-attached' | 'epoch-conflict' | 'expired',
  view?: unknown,
) =>
  reply.code(HTTP_STATUS.CONFLICT).send(
    ProviderAttachmentConflictResponseSchema.parse({
      error: reason,
      reason,
      ...(view ? { view } : {}),
    }),
  )

export const providerAttachmentsRoutes = async (app: FastifyInstance, ctx: ApiRouteCtx) => {
  const { providerRegistry } = ctx

  app.get(
    s('/providers/attachments'),
    { config: authz('space:manage', 'space') },
    async (req, reply) => {
      const viewerOwner = agentOwnerOf(req.principal)
      const query = ProviderInventoryQuerySchema.safeParse(req.query)

      if (!providerRegistry || !viewerOwner) {
        return notFound(reply)
      }
      if (!query.success) {
        return badRequest(reply, 'invalid provider cursor')
      }
      const after = providerInventoryAfter(query.data.cursor)

      if (after === 'invalid') {
        return badRequest(reply, 'invalid provider cursor')
      }
      const selected = await providerRegistry.pageAttachmentsForSpace(
        req.spaceId,
        viewerOwner,
        after,
        PROVIDER_INVENTORY_FETCH_LIMIT,
      )
      const page = providerInventoryPage(selected.items, selected.total, ({ attachment }) => [
        attachment.createdAt,
        attachment.id,
      ])

      return ProviderAttachmentsResponseSchema.parse(page)
    },
  )

  app.post(
    '/api/providers/attachments',
    { config: authz('self:manage', 'host') },
    async (req, reply) => {
      const owner = agentOwnerOf(req.principal)
      const body = ProviderAttachmentOfferRequestSchema.safeParse(req.body)

      if (!providerRegistry || !owner) {
        return notFound(reply)
      }
      if (!body.success) {
        return badRequest(reply, body.error.issues[0]?.message ?? 'bad request')
      }
      const targetSpace = await providerRegistry.attachmentTargetSpace(
        body.data.targetKind,
        body.data.targetId,
      )

      if (!targetSpace || !can(req.principal, 'space:read', { space: targetSpace })) {
        return notFound(reply)
      }
      const result = await providerRegistry.offerAttachment({ owner, ...body.data })

      if (result.status === 'not-found') {
        return notFound(reply)
      }
      if (result.status === 'already-attached') {
        return conflict(reply, PROVIDER_ATTACHMENT_CONFLICT.alreadyAttached, result.view)
      }

      return ProviderAttachmentOfferResponseSchema.parse({ view: result.view })
    },
  )

  app.post(
    '/api/providers/attachments/:id/accept',
    { config: authz('spaces:list', 'host') },
    async (req, reply) => {
      const id = (req.params as { id?: string }).id
      const viewerOwner = agentOwnerOf(req.principal)
      const body = ProviderAttachmentAcceptRequestSchema.safeParse(req.body)

      if (!providerRegistry || !viewerOwner || !id) {
        return notFound(reply)
      }
      if (!body.success) {
        return badRequest(reply, body.error.issues[0]?.message ?? 'bad request')
      }
      const attachment = await providerRegistry.getAttachment(id)

      if (!attachment || !can(req.principal, 'space:manage', { space: attachment.targetSpace })) {
        return notFound(reply)
      }
      const result = await providerRegistry.acceptAttachment(
        id,
        body.data,
        viewerOwner,
        req.principal.admin || req.principal.system ? null : viewerOwner,
      )

      if (result.status === 'not-found') {
        return notFound(reply)
      }
      if (result.status === 'epoch-conflict' || result.status === 'expired') {
        return conflict(reply, result.status, result.view)
      }

      return ProviderAttachmentAcceptResponseSchema.parse({
        outcome: result.status,
        view: result.view,
      })
    },
  )

  app.get(
    '/api/providers/attachments/:id',
    { config: authz('spaces:list', 'host') },
    async (req, reply) => {
      const id = (req.params as { id?: string }).id
      const viewerOwner = agentOwnerOf(req.principal)

      if (!providerRegistry || !viewerOwner || !id) {
        return notFound(reply)
      }
      const attachment = await providerRegistry.getAttachment(id)

      if (!attachment || !can(req.principal, 'space:manage', { space: attachment.targetSpace })) {
        return notFound(reply)
      }
      const view = await providerRegistry.getAttachmentDetail(id, viewerOwner)
      return view ? ProviderAttachmentDetailResponseSchema.parse({ view }) : notFound(reply)
    },
  )

  app.delete(
    '/api/providers/attachments/:id',
    { config: authz('spaces:list', 'host') },
    async (req, reply) => {
      const id = (req.params as { id?: string }).id
      const manager = agentOwnerOf(req.principal)

      if (!providerRegistry || !id || !manager) {
        return notFound(reply)
      }
      const attachment = await providerRegistry.getAttachment(id)

      if (!attachment || !can(req.principal, 'space:manage', { space: attachment.targetSpace })) {
        return notFound(reply)
      }
      const result = await providerRegistry.detachAttachment(
        id,
        req.principal.admin || req.principal.system ? null : manager,
      )

      return result.status === 'detached'
        ? ProviderAttachmentDetachResponseSchema.parse({ ok: true })
        : notFound(reply)
    },
  )

  app.post(
    '/api/providers/credentials/:id/retarget',
    { config: authz('self:manage', 'host') },
    async (req, reply) => {
      const owner = agentOwnerOf(req.principal)
      const id = (req.params as { id?: string }).id
      const body = ProviderRetargetRequestSchema.safeParse(req.body)

      if (!providerRegistry || !owner || !id) {
        return notFound(reply)
      }
      if (!body.success) {
        return badRequest(reply, body.error.issues[0]?.message ?? 'bad request')
      }
      const abort = new AbortController()

      // The parsed POST body is complete here, so client-gone rides the response
      // stream. `req.raw.aborted` only covers an incomplete incoming request and would
      // let DNS admission plus the eventual retarget commit continue after the caller
      // closed the socket.
      const disconnected = () => {
        if (!reply.raw.writableEnded) {
          abort.abort(new Error('retarget request disconnected'))
        }
      }

      reply.raw.once('close', disconnected)

      try {
        const result = await providerRegistry.retargetCredential(owner, id, body.data, abort.signal)
        return result ? ProviderRetargetResponseSchema.parse(result) : notFound(reply)
      } catch (error) {
        if (error instanceof ProviderRateLimitError) {
          return reply
            .code(HTTP_STATUS.TOO_MANY_REQUESTS)
            .header('retry-after', Math.ceil(error.retryAfterMs / 1000))
            .send({ error: 'provider retarget limit is exhausted' })
        }
        const value = error as { code?: unknown; message?: unknown; references?: unknown }

        if (value.code === 'PROVIDER_RETARGET_CONFLICT') {
          return reply.code(HTTP_STATUS.CONFLICT).send(
            ProviderRetargetConflictResponseSchema.parse({
              error: typeof value.message === 'string' ? value.message : 'retarget conflict',
              references: value.references,
            }),
          )
        }
        if (value.code === 'PROVIDER_VALIDATION') {
          return badRequest(
            reply,
            typeof value.message === 'string' ? value.message : 'provider validation failed',
          )
        }
        throw error
      } finally {
        reply.raw.removeListener('close', disconnected)
      }
    },
  )
}
