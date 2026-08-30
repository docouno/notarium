import type { FastifyInstance, FastifyReply } from 'fastify'

import {
  CredentialCreateRequestSchema,
  CredentialDeleteResponseSchema,
  CredentialPatchRequestSchema,
  CredentialReferenceConflictResponseSchema,
  CredentialResponseSchema,
  CredentialsResponseSchema,
  ProviderInventoryQuerySchema,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'

import { agentOwnerOf } from '../../../../services/authz'
import {
  type ApiRouteCtx,
  authz,
  notFound,
  PROVIDER_INVENTORY_FETCH_LIMIT,
  providerInventoryAfter,
  providerInventoryPage,
} from '../_shared'

const credentialFailure = (reply: FastifyReply, error: unknown) => {
  const value = error as { code?: unknown; message?: unknown; references?: unknown }
  const message = typeof value.message === 'string' ? value.message : 'credential request failed'

  if (value.code === 'PROVIDER_VALIDATION') {
    return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: message })
  }
  if (value.code === 'PROVIDER_CREDENTIAL_REFERENCED') {
    return reply.code(HTTP_STATUS.CONFLICT).send(
      CredentialReferenceConflictResponseSchema.parse({
        error: message,
        references: value.references,
      }),
    )
  }
  if (value.code === 'PROVIDER_CONFLICT') {
    return reply.code(HTTP_STATUS.CONFLICT).send({ error: message })
  }
  if (/unique/i.test(message)) {
    return reply.code(HTTP_STATUS.CONFLICT).send({ error: message })
  }
  throw error
}

export const credentialsRoutes = async (app: FastifyInstance, ctx: ApiRouteCtx) => {
  const { providerRegistry } = ctx

  app.get(
    '/api/providers/credentials',
    { config: authz('self:manage', 'host') },
    async (req, reply) => {
      const owner = agentOwnerOf(req.principal)
      const query = ProviderInventoryQuerySchema.safeParse(req.query)

      if (!providerRegistry || !owner) {
        return notFound(reply)
      }
      if (!query.success) {
        return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: 'invalid provider cursor' })
      }
      const after = providerInventoryAfter(query.data.cursor)

      if (after === 'invalid') {
        return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: 'invalid provider cursor' })
      }
      const selected = await providerRegistry.pageCredentials(
        owner,
        after,
        PROVIDER_INVENTORY_FETCH_LIMIT,
      )
      const page = providerInventoryPage(selected.items, selected.total, (item) => [
        item.name,
        item.id,
      ])

      return CredentialsResponseSchema.parse(page)
    },
  )

  app.get(
    '/api/providers/credentials/:id',
    { config: authz('self:manage', 'host') },
    async (req, reply) => {
      const owner = agentOwnerOf(req.principal)
      const id = (req.params as { id?: string }).id

      if (!providerRegistry || !owner || !id) {
        return notFound(reply)
      }
      const result = await providerRegistry.getCredential(owner, id)
      return result ? CredentialResponseSchema.parse(result) : notFound(reply)
    },
  )

  app.post(
    '/api/providers/credentials',
    { config: authz('self:manage', 'host') },
    async (req, reply) => {
      const owner = agentOwnerOf(req.principal)

      if (!providerRegistry || !owner) {
        return notFound(reply)
      }
      const body = CredentialCreateRequestSchema.safeParse(req.body)

      if (!body.success) {
        return reply
          .code(HTTP_STATUS.BAD_REQUEST)
          .send({ error: body.error.issues[0]?.message ?? 'bad request' })
      }
      try {
        const credential = await providerRegistry.createCredential(owner, body.data)
        return CredentialResponseSchema.parse({ credential, references: [] })
      } catch (error) {
        return credentialFailure(reply, error)
      }
    },
  )

  app.patch(
    '/api/providers/credentials/:id',
    { config: authz('self:manage', 'host') },
    async (req, reply) => {
      const owner = agentOwnerOf(req.principal)
      const id = (req.params as { id?: string }).id

      if (!providerRegistry || !owner || !id) {
        return notFound(reply)
      }
      const body = CredentialPatchRequestSchema.safeParse(req.body)

      if (!body.success) {
        return reply
          .code(HTTP_STATUS.BAD_REQUEST)
          .send({ error: body.error.issues[0]?.message ?? 'bad request' })
      }
      try {
        const result = await providerRegistry.updateCredential(owner, id, body.data)
        return result ? CredentialResponseSchema.parse(result) : notFound(reply)
      } catch (error) {
        return credentialFailure(reply, error)
      }
    },
  )

  app.delete(
    '/api/providers/credentials/:id',
    { config: authz('self:manage', 'host') },
    async (req, reply) => {
      const owner = agentOwnerOf(req.principal)
      const id = (req.params as { id?: string }).id

      if (!providerRegistry || !owner || !id) {
        return notFound(reply)
      }
      try {
        if (!(await providerRegistry.deleteCredential(owner, id))) {
          return notFound(reply)
        }

        return CredentialDeleteResponseSchema.parse({ ok: true })
      } catch (error) {
        return credentialFailure(reply, error)
      }
    },
  )
}
