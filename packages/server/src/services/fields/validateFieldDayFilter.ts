import { FIELD_TYPE, type FieldFilter } from '@notarium/core'

import type { FieldSchemaSnapshot } from './fieldSchemaStore'

/** A day predicate is deliberately typed: unlike exact open-world equality it
 * cannot guess semantics without one readable declared date field. */
export const fieldDayFilterError = (
  filter: FieldFilter | undefined,
  schema: FieldSchemaSnapshot | undefined,
): string | null => {
  for (const clause of filter?.nodes ?? []) {
    if (!clause.values.some((condition) => condition.kind === 'day')) {
      continue
    }
    const declaration = schema?.fields.find((field) => field.key === clause.key)

    if (declaration?.type !== FIELD_TYPE.date) {
      return `fieldDay requires declared date field "${clause.key}"`
    }
  }

  return null
}
