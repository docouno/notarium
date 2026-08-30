import { z } from 'zod'
import {
  FIELD_COLOR,
  FIELD_SCHEMA_MAX_FIELDS,
  FIELD_SCHEMA_MAX_VALUES,
  FIELD_SCHEMA_VERSION,
  FIELD_TYPE,
  PROTECTED_FIELD_KEYS,
} from '../../consts/fields'
import { enumValues } from '../../libs/enumValues'
import { DurableScalarSchema } from '../primitives'

export const FieldTypeSchema = z.enum(enumValues(FIELD_TYPE))
export const FieldColorSchema = z.enum(enumValues(FIELD_COLOR))

const displayName = (key: string, label: string | undefined, fallback: string): string =>
  label?.trim() ||
  key
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ') ||
  fallback
const nameIdentity = (name: string): string => name.normalize('NFC').trim().toLowerCase()

export const FieldEnumOptionSchema = z
  .object({
    key: DurableScalarSchema,
    label: DurableScalarSchema.optional(),
    color: FieldColorSchema.optional(),
  })
  .strict()

export const FieldDeclarationSchema = z
  .object({
    key: DurableScalarSchema,
    type: FieldTypeSchema,
    label: DurableScalarSchema.optional(),
    card: z.boolean().optional(),
    values: z.array(FieldEnumOptionSchema).max(FIELD_SCHEMA_MAX_VALUES).optional(),
  })
  .strict()
  .superRefine((field, ctx) => {
    if ((PROTECTED_FIELD_KEYS as readonly string[]).includes(field.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['key'],
        message: `protected field key: ${field.key}`,
      })
    }
    if (field.type !== FIELD_TYPE.enum && field.values !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['values'],
        message: 'values are supported only for enum fields',
      })
    }
    const seen = new Set<string>()
    const names = new Set<string>()

    for (let i = 0; i < (field.values ?? []).length; i++) {
      const key = field.values![i].key

      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['values', i, 'key'],
          message: `duplicate enum key: ${key}`,
        })
      }
      seen.add(key)
      const option = field.values![i]
      const display = displayName(option.key, option.label, 'Empty value')
      const name = nameIdentity(display)

      if (names.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['values', i, option.label === undefined ? 'key' : 'label'],
          message: `duplicate enum value name: ${display}`,
        })
      }
      names.add(name)
    }
  })

const FieldDeclarationsSchema = z
  .array(FieldDeclarationSchema)
  .max(FIELD_SCHEMA_MAX_FIELDS)
  .superRefine((fields, ctx) => {
    const seen = new Set<string>()
    const names = new Set<string>()

    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]

      if (seen.has(field.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, 'key'],
          message: `duplicate field key: ${field.key}`,
        })
      }
      seen.add(field.key)
      const display = displayName(field.key, field.label, 'Unnamed field')
      const name = nameIdentity(display)

      if (names.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, field.label === undefined ? 'key' : 'label'],
          message: `duplicate field name: ${display}`,
        })
      }
      names.add(name)
    }
  })

export const FieldSchemaResponseSchema = z.object({
  version: z.number().int().positive(),
  fields: FieldDeclarationsSchema,
  versionToken: z.string().min(1),
  /** Schema management and note-value writes degrade independently. */
  valueWrites: z.boolean(),
  readOnly: z.literal(true).optional(),
  error: z.string().optional(),
})

export const FieldSchemaUpdateSchema = z
  .object({
    version: z.literal(FIELD_SCHEMA_VERSION),
    fields: FieldDeclarationsSchema,
    versionToken: z.string().min(1),
  })
  .strict()

export const FieldSchemaConflictResponseSchema = z.object({
  error: z.string(),
  reason: z.enum(['field_schema_conflict', 'field_schema_read_only']),
  current: FieldSchemaResponseSchema,
})

export type FieldEnumOption = z.infer<typeof FieldEnumOptionSchema>
export type FieldDeclaration = z.infer<typeof FieldDeclarationSchema>
export type FieldSchemaResponse = z.infer<typeof FieldSchemaResponseSchema>
export type FieldSchemaUpdate = z.infer<typeof FieldSchemaUpdateSchema>
export type FieldSchemaConflictResponse = z.infer<typeof FieldSchemaConflictResponseSchema>
