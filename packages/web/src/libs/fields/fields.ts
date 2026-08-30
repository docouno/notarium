import type { FieldColor, FieldDeclaration } from '@notarium/contract'
import { fieldDisplayName, fieldEnumOptionDisplayName, fieldValueMatchesType } from '@notarium/core'
import { fieldDate } from '../datetime'

export { fieldDisplayName, fieldEnumOptionDisplayName }

export type PresentedCardField = {
  key: string
  fieldLabel: string
  label: string
  color?: FieldColor
}

export const cardFieldValues = (
  values: Record<string, string | string[]> | undefined,
  schema: readonly FieldDeclaration[],
): PresentedCardField[] =>
  schema
    .filter((field) => field.card && values && Object.hasOwn(values, field.key))
    .map((field) => {
      const value = values![field.key]
      const conforming = fieldValueMatchesType(field.type, value, field)
      const option = conforming
        ? field.values?.find((candidate) => candidate.key === value)
        : undefined
      const label = option
        ? fieldEnumOptionDisplayName(option)
        : conforming && field.type === 'date' && typeof value === 'string'
          ? fieldDate(value) || value
          : Array.isArray(value)
            ? value.join(', ') || 'Empty value'
            : value || 'Empty value'

      return {
        key: field.key,
        fieldLabel: fieldDisplayName(field),
        label,
        ...(option?.color ? { color: option.color } : {}),
      }
    })
