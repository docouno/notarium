import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  ProviderEffectiveEntrySchema,
  ProviderEffectiveResponseSchema,
  ProviderInventoryQuerySchema,
  ProviderResourceCreateRequestSchema,
  ProviderResourcePatchRequestSchema,
  ProviderResourceResponseSchema,
  ProviderResourcesResponseSchema,
  ProviderResourceStatusesRequestSchema,
  ProviderResourceStatusesResponseSchema,
  ProviderValidateRequestSchema,
  ProviderValidateResponseSchema,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'

import { agentOwnerOf, can } from '../../../../services/authz'
import { ProviderHostCapError } from '../../../../services/providerRuntime'
import {
  type ApiRouteCtx,
  authz,
  notFound,
  PROVIDER_INVENTORY_FETCH_LIMIT,
  providerInventoryAfter,
  providerInventoryPage,
} from '../_shared'

const providerFailure = (reply: FastifyReply, error: unknown) => {
  const value = error as { code?: unknown; message?: unknown }
  const message = typeof value.message === 'string' ? value.message : 'provider request failed'

  if (value.code === 'PROVIDER_VALIDATION') {
    return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: message })
  }
  if (value.code === 'PROVIDER_CONFLICT') {
    return reply.code(HTTP_STATUS.CONFLICT).send({ error: message })
  }
  if (/unique/i.test(message)) {
    return reply.code(HTTP_STATUS.CONFLICT).send({ error: message })
  }
  throw error
}

export const providersRoutes = async (app: FastifyInstance, ctx: ApiRouteCtx) => {
  const { providerRegistry, spaces } = ctx

  /** Every Space this principal may read, ARCHIVED ONES INCLUDED. Resolution has to
   *  see the archived grant to answer `space-archived`; filtering it out here would
   *  turn an explainable state into a resource that silently vanished. */
  const readableSpacesOf = (req: FastifyRequest): string[] => {
    const known = req.principal.system
      ? [...spaces.list(), ...spaces.listArchived()].map((space) => space.id)
      : [...req.principal.grants.keys()]

    return known.filter((space) => can(req.principal, 'space:read', { space }))
  }

  // What the principal may actually call, with a named reason beside everything they
  // may not. Session-only like the rest of the family and for a sharper reason: a
  // narrowed token learns THAT the host has a model from `whoami`, never the names,
  // owners and addresses of the records behind it.
  app.get(
    '/api/providers/effective',
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
      const selected = await providerRegistry.resolveForPrincipalPage({
        owner,
        spaces: readableSpacesOf(req),
        after,
        limit: PROVIDER_INVENTORY_FETCH_LIMIT,
      })
      const items = selected.entries.map((entry) => ({
        resource: providerRegistry.resourceListItemToWire(entry.record, {
          owner,
          admin: req.principal.admin,
        }),
        unusableBecause: entry.unusableBecause,
      }))
      const page = providerInventoryPage(items, selected.total, ({ resource }) => [
        resource.name,
        resource.id,
      ])

      return ProviderEffectiveResponseSchema.parse(page)
    },
  )

  app.get(
    '/api/providers/effective/:id',
    { config: authz('self:manage', 'host') },
    async (req, reply) => {
      const owner = agentOwnerOf(req.principal)
      const id = (req.params as { id?: string }).id

      if (!providerRegistry || !owner || !id) {
        return notFound(reply)
      }
      const entry = await providerRegistry.resolveOneForPrincipal({
        owner,
        spaces: readableSpacesOf(req),
        resourceId: id,
      })

      return entry
        ? ProviderEffectiveEntrySchema.parse({
            resource: providerRegistry.resourceListItemToWire(entry.record, {
              owner,
              admin: req.principal.admin,
            }),
            unusableBecause: entry.unusableBecause,
          })
        : notFound(reply)
    },
  )

  app.get(
    '/api/providers/resources',
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
      const selected = await providerRegistry.pageResources(
        owner,
        after,
        PROVIDER_INVENTORY_FETCH_LIMIT,
      )
      const page = providerInventoryPage(selected.items, selected.total, (item) => [
        item.name,
        item.id,
      ])

      return ProviderResourcesResponseSchema.parse(page)
    },
  )

  app.post(
    '/api/providers/resources/statuses',
    { config: authz('self:manage', 'host') },
    async (req, reply) => {
      const owner = agentOwnerOf(req.principal)
      const body = ProviderResourceStatusesRequestSchema.safeParse(req.body)

      if (!providerRegistry || !owner) {
        return notFound(reply)
      }
      if (!body.success) {
        return reply
          .code(HTTP_STATUS.BAD_REQUEST)
          .send({ error: body.error.issues[0]?.message ?? 'invalid provider status batch' })
      }
      const entries = await providerRegistry.resolveOwnedMany({
        owner,
        resourceIds: body.data.ids,
      })

      return ProviderResourceStatusesResponseSchema.parse({
        items: entries.map(({ record, unusableBecause }) => ({
          id: record.id,
          unusableBecause,
        })),
      })
    },
  )

  app.get(
    '/api/providers/resources/:id',
    { config: authz('self:manage', 'host') },
    async (req, reply) => {
      const owner = agentOwnerOf(req.principal)
      const id = (req.params as { id?: string }).id

      if (!providerRegistry || !owner || !id) {
        return notFound(reply)
      }
      const resource = await providerRegistry.getOwnedResource(owner, id)

      if (!resource) {
        return notFound(reply)
      }

      return ProviderResourceResponseSchema.parse({
        resource: providerRegistry.resourceToWire(resource, {
          owner,
          admin: req.principal.admin,
        }),
        warnings: [],
      })
    },
  )

  app.post(
    '/api/providers/resources',
    { config: authz('self:manage', 'host') },
    async (req, reply) => {
      const owner = agentOwnerOf(req.principal)

      if (!providerRegistry || !owner) {
        return notFound(reply)
      }
      const body = ProviderResourceCreateRequestSchema.safeParse(req.body)

      if (!body.success) {
        return reply
          .code(HTTP_STATUS.BAD_REQUEST)
          .send({ error: body.error.issues[0]?.message ?? 'bad request' })
      }
      try {
        return ProviderResourceResponseSchema.parse(
          await providerRegistry.createResource(owner, body.data),
        )
      } catch (error) {
        return providerFailure(reply, error)
      }
    },
  )

  app.patch(
    '/api/providers/resources/:id',
    { config: authz('self:manage', 'host') },
    async (req, reply) => {
      const owner = agentOwnerOf(req.principal)
      const id = (req.params as { id?: string }).id

      if (!providerRegistry || !owner || !id) {
        return notFound(reply)
      }
      const body = ProviderResourcePatchRequestSchema.safeParse(req.body)

      if (!body.success) {
        return reply
          .code(HTTP_STATUS.BAD_REQUEST)
          .send({ error: body.error.issues[0]?.message ?? 'bad request' })
      }
      try {
        const result = await providerRegistry.updateResource(owner, id, body.data)
        return result ? ProviderResourceResponseSchema.parse(result) : notFound(reply)
      } catch (error) {
        return providerFailure(reply, error)
      }
    },
  )

  // A real outbound call that spends the OWNER's credential, so `self:manage` is
  // load-bearing: it is above any token's ceiling, which makes the route
  // structurally session-only without a line of extra code. `longLived` keeps a
  // 120 s local first byte from pinning background work to the drip floor, and the
  // named barrier exemption (app.ts) keeps it from freezing every mutation on the
  // instance while the provider thinks.
  app.post(
    '/api/providers/resources/:id/validate',
    { config: { ...authz('self:manage', 'host'), longLived: true } },
    async (req, reply) => {
      const owner = agentOwnerOf(req.principal)
      const id = (req.params as { id?: string }).id

      if (!providerRegistry || !owner || !id) {
        return notFound(reply)
      }
      const body = ProviderValidateRequestSchema.safeParse(req.body)

      if (!body.success) {
        return reply
          .code(HTTP_STATUS.BAD_REQUEST)
          .send({ error: body.error.issues[0]?.message ?? 'bad request' })
      }
      const abort = new AbortController()

      // The request body has already been consumed when the handler runs. A client
      // disappearing now closes the RESPONSE stream; IncomingMessage `aborted` does
      // not fire after a complete request body (Node 15+). Keep the same shipped
      // cancellation pattern as the note preview route so a closed tab cannot leave a
      // paid provider call running until its ceiling.
      const disconnected = () => {
        if (!reply.raw.writableEnded) {
          abort.abort(new Error('validate request disconnected'))
        }
      }

      reply.raw.once('close', disconnected)

      try {
        const outcome = await providerRegistry.validateResource({
          owner,
          principal: req.principal.id,
          agent: req.principal.label ?? null,
          admin: req.principal.admin,
          resourceId: id,
          capability: body.data.capability,
          signal: abort.signal,
        })

        return outcome ? ProviderValidateResponseSchema.parse(outcome) : notFound(reply)
      } catch (error) {
        if (error instanceof ProviderHostCapError) {
          return reply
            .code(HTTP_STATUS.TOO_MANY_REQUESTS)
            .header('retry-after', Math.ceil(error.retryAfterMs / 1000))
            .send({ error: 'provider validate host cap is exhausted' })
        }

        return providerFailure(reply, error)
      } finally {
        reply.raw.removeListener('close', disconnected)
      }
    },
  )

  app.delete(
    '/api/providers/resources/:id',
    { config: authz('self:manage', 'host') },
    async (req, reply) => {
      const owner = agentOwnerOf(req.principal)
      const id = (req.params as { id?: string }).id

      if (
        !providerRegistry ||
        !owner ||
        !id ||
        !(await providerRegistry.deleteResource(owner, id))
      ) {
        return notFound(reply)
      }

      return { ok: true }
    },
  )
}
