import type { FastifyInstance } from 'fastify'

import {
  FieldSchemaConflictResponseSchema,
  FieldSchemaResponseSchema,
  FieldSchemaUpdateSchema,
  FieldsQuerySchema,
  FieldsResponseSchema,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { fieldFacet, isWritableFieldKey } from '@notarium/core'

import { fieldSchemaToWire } from '../../../../services/fields'
import { type ApiRouteCtx, authz, s } from '../_shared'

export const fieldsRoutes = async (app: FastifyInstance, ctx: ApiRouteCtx) => {
  const { fieldSchemaStore, spaceStoreFor } = ctx

  app.get(s('/fields'), { config: authz('space:read', 'space') }, async (req, reply) => {
    const query = FieldsQuerySchema.safeParse(req.query)

    if (!query.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: query.error.issues[0]?.message || 'bad query' })
    }
    const [notes, schema] = await Promise.all([
      (await spaceStoreFor(req)).list(),
      fieldSchemaStore?.read(req.spaceId),
    ])

    return FieldsResponseSchema.parse(
      fieldFacet(
        notes.map((note) => note.fields),
        schema?.fields ?? [],
        query.data,
      ),
    )
  })

  if (!fieldSchemaStore) {
    return
  }

  app.get(s('/fields/schema'), { config: authz('space:read', 'space') }, async (req) =>
    FieldSchemaResponseSchema.parse(fieldSchemaToWire(await fieldSchemaStore.read(req.spaceId))),
  )

  app.put(s('/fields/schema'), { config: authz('space:write', 'space') }, async (req, reply) => {
    const parsed = FieldSchemaUpdateSchema.parse(req.body)

    for (let index = 0; index < parsed.fields.length; index++) {
      const key = parsed.fields[index].key

      if (!isWritableFieldKey(key)) {
        return reply.code(HTTP_STATUS.BAD_REQUEST).send({
          error: `fields.${index}.key: not a safe plain YAML mapping key`,
          reason: 'validation',
          issues: [{ path: `fields.${index}.key`, message: 'not a safe plain YAML mapping key' }],
        })
      }
    }
    const result = await fieldSchemaStore.update(req.spaceId, parsed)

    if (result.status === 'saved') {
      return FieldSchemaResponseSchema.parse(fieldSchemaToWire(result.current))
    }
    if (result.status === 'invalid') {
      return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: result.error, reason: 'validation' })
    }

    return reply.code(HTTP_STATUS.CONFLICT).send(
      FieldSchemaConflictResponseSchema.parse({
        error:
          result.reason === 'field_schema_read_only'
            ? 'field schema is read-only until schema.yaml is repaired'
            : 'field schema changed concurrently',
        reason: result.reason,
        current: fieldSchemaToWire(result.current),
      }),
    )
  })
}
