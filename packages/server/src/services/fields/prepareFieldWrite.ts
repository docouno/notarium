import { type FieldPatch, fieldSchemaUnavailable } from '@notarium/core'

import { FIELD_SCHEMA_STATUS } from './consts'
import type { FieldSchemaStore } from './fieldSchemaStore'
import { resolveFieldsUnquoted } from './resolveFieldsUnquoted'

/** Resolve the host-only byte-shape hint and keep schema failure policy in one
 * place for REST and MCP. Form/future documents stay writable but advise no
 * unquoted values; storage/structural failures block the whole field channel. */
export const prepareFieldWrite = async (
  store: FieldSchemaStore | undefined,
  space: string,
  fields: FieldPatch,
): Promise<string[]> => {
  if (!store) {
    throw fieldSchemaUnavailable('field schema service is not configured')
  }
  const schema = await store.read(space)

  if (
    schema.status === FIELD_SCHEMA_STATUS.unavailable ||
    schema.status === FIELD_SCHEMA_STATUS.structuralError
  ) {
    throw fieldSchemaUnavailable(schema.error ?? schema.status)
  }

  return resolveFieldsUnquoted(schema, fields)
}
