import { z } from 'zod'

import { CREDENTIAL_KIND, CREDENTIAL_REFERENCE_KIND, PROVIDER_LIMIT } from '../../consts/providers'
import { enumValues } from '../../libs/enumValues'
import { DurableDisplayNameSchema, DurableScalarSchema } from '../primitives'
import { OkResponseSchema } from './_shared'
import { ProviderInventoryPageFields } from './providers'

export const CredentialKindSchema = z.enum(enumValues(CREDENTIAL_KIND))

export const CredentialInjectionSchema = z
  .object({
    /** Empty means the default for the credential-kind × resource-wire pair. */
    header: DurableScalarSchema.refine(
      (value) => value.length <= PROVIDER_LIMIT.headerName,
      'header name is too long',
    ),
    prefix: DurableScalarSchema.refine(
      (value) => value.length <= PROVIDER_LIMIT.headerValue,
      'credential prefix is too long',
    ),
  })
  .strict()

export const CredentialSchema = z.object({
  id: z.string(),
  name: DurableDisplayNameSchema,
  kind: CredentialKindSchema,
  origin: z.string(),
  injection: CredentialInjectionSchema,
  disabledAt: z.string().nullable(),
  rpm: z.number().int().positive().nullable(),
  tpm: z.number().int().positive().nullable(),
  consentEpoch: z.number().int().nonnegative(),
  runtimeEpoch: z.number().int().nonnegative(),
})

/** The inventory row is deliberately smaller than credential detail: injection and
 * epochs are editor/runtime state, while the table needs only this stable summary. */
export const CredentialListItemSchema = CredentialSchema.pick({
  id: true,
  name: true,
  kind: true,
  origin: true,
  disabledAt: true,
  rpm: true,
  tpm: true,
}).strict()

export const CredentialCreateRequestSchema = z
  .object({
    name: DurableDisplayNameSchema,
    kind: CredentialKindSchema,
    secret: z.string().min(1).max(PROVIDER_LIMIT.headerValue),
    origin: z.string().max(PROVIDER_LIMIT.baseUrl),
    injection: CredentialInjectionSchema.default({ header: '', prefix: '' }),
    rpm: z.number().int().positive().nullable().default(null),
    tpm: z.number().int().positive().nullable().default(null),
  })
  .strict()

export const CredentialPatchRequestSchema = z
  .object({
    name: DurableDisplayNameSchema.optional(),
    secret: z.string().min(1).max(PROVIDER_LIMIT.headerValue).optional(),
    origin: z.string().max(PROVIDER_LIMIT.baseUrl).optional(),
    injection: CredentialInjectionSchema.optional(),
    disabled: z.boolean().optional(),
    rpm: z.number().int().positive().nullable().optional(),
    tpm: z.number().int().positive().nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required')

export const CredentialReferenceSchema = z
  .object({
    kind: z.literal(CREDENTIAL_REFERENCE_KIND.providerResource),
    id: z.string(),
    name: DurableDisplayNameSchema,
  })
  .strict()

export const CredentialResponseSchema = z.object({
  credential: CredentialSchema,
  references: z.array(CredentialReferenceSchema),
})

export const CredentialsResponseSchema = z
  .object({
    items: z.array(CredentialListItemSchema),
    ...ProviderInventoryPageFields,
  })
  .strict()

export const CredentialReferenceConflictResponseSchema = z.object({
  error: z.string(),
  references: z.array(CredentialReferenceSchema),
})

export const CredentialDeleteResponseSchema = OkResponseSchema

export type CredentialInjection = z.infer<typeof CredentialInjectionSchema>
export type Credential = z.infer<typeof CredentialSchema>
export type CredentialListItem = z.infer<typeof CredentialListItemSchema>
export type CredentialCreateRequest = z.infer<typeof CredentialCreateRequestSchema>
export type CredentialPatchRequest = z.infer<typeof CredentialPatchRequestSchema>
export type CredentialReference = z.infer<typeof CredentialReferenceSchema>
export type CredentialResponse = z.infer<typeof CredentialResponseSchema>
export type CredentialsResponse = z.infer<typeof CredentialsResponseSchema>
export type CredentialReferenceConflictResponse = z.infer<
  typeof CredentialReferenceConflictResponseSchema
>
