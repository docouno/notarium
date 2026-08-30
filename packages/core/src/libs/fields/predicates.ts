import { isSafePlainMappingKey, parseFrontmatterLines } from '../markdown/frontmatter'
import { FIELD_TYPE, type FieldType } from './consts'
import type { FieldDeclaration } from './types'

const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const ISO_MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/

const validDay = (value: string): boolean => {
  if (!ISO_DAY.test(value)) {
    return false
  }
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))

  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

export const isFieldNumber = (value: string): boolean =>
  DECIMAL.test(value) && Number.isFinite(Number(value))

export const isFieldDate = (value: string): boolean =>
  validDay(value) ||
  (ISO_MOMENT.test(value) && validDay(value.slice(0, 10)) && !Number.isNaN(Date.parse(value)))

export const isFieldCheckbox = (value: string): boolean => value === 'true' || value === 'false'

/** A field key must survive the exact plain mapping syntax the note writer uses.
 * The conservative YAML predicate alone accepts `a: b`; parsing the emitted line
 * back catches that key being truncated to `a`. */
export const isWritableFieldKey = (key: string): boolean =>
  isSafePlainMappingKey(key) && parseFrontmatterLines(`${key}: value`)[0]?.key === key

export const fieldValueMatchesType = (
  type: FieldType,
  value: string | string[],
  declaration?: Pick<FieldDeclaration, 'values'>,
): boolean => {
  switch (type) {
    case FIELD_TYPE.text:
      return typeof value === 'string'
    case FIELD_TYPE.number:
      return typeof value === 'string' && isFieldNumber(value)
    case FIELD_TYPE.date:
      return typeof value === 'string' && isFieldDate(value)
    case FIELD_TYPE.checkbox:
      return typeof value === 'string' && isFieldCheckbox(value)
    case FIELD_TYPE.list:
      return typeof value === 'string' || Array.isArray(value)
    case FIELD_TYPE.enum:
      return (
        typeof value === 'string' &&
        Boolean(declaration?.values?.some((candidate) => candidate.key === value))
      )
  }
}
