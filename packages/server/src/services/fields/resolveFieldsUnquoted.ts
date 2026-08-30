import { FIELD_TYPE, fieldValueMatchesType } from '@notarium/core'

import { FIELD_SCHEMA_STATUS } from './consts'
import type { FieldSchemaSnapshot } from './fieldSchemaStore'

export type FieldValuePatch = Record<string, string | string[] | null>

/** Resolve the host-internal hint that V03 will pass to schema-agnostic stores.
 * Read-only schemas cannot advise byte shape; values that disagree with their
 * declaration remain quoted rather than being coerced. */
export const resolveFieldsUnquoted = (
  schema: FieldSchemaSnapshot,
  fields: FieldValuePatch,
): string[] => {
  if (schema.status !== FIELD_SCHEMA_STATUS.ready || schema.readOnly || schema.error) {
    return []
  }
  const declarations = new Map(schema.fields.map((field) => [field.key, field]))
  const unquoted: string[] = []

  for (const key of Object.getOwnPropertyNames(fields)) {
    const declaration = declarations.get(key)
    const value = fields[key]

    if (
      typeof value === 'string' &&
      (declaration?.type === FIELD_TYPE.number || declaration?.type === FIELD_TYPE.checkbox) &&
      fieldValueMatchesType(declaration.type, value, declaration)
    ) {
      unquoted.push(key)
    }
  }

  return unquoted
}
