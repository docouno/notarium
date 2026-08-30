import { z } from 'zod'

import {
  MODEL_STATUS,
  PROVIDER_LIMIT,
  PROVIDER_LIST_PAGE_SIZE,
  PROVIDER_STATUS,
  PROVIDER_TIMEOUT,
  PURPOSE,
  WIRE,
} from '../../consts/providers'
import { enumValues } from '../../libs/enumValues'
import { AuthorSchema, DurableDisplayNameSchema, DurableNonEmptyScalarSchema } from '../primitives'
import { OkResponseSchema } from './_shared'

export const WireSchema = z.enum(enumValues(WIRE))
export const PurposeSchema = z.enum(enumValues(PURPOSE))
export const ProviderStatusSchema = z.enum(enumValues(PROVIDER_STATUS))
export const ModelStatusSchema = z.enum(enumValues(MODEL_STATUS))

export const ProviderInventoryCursorSchema = z.string().min(1).max(PROVIDER_LIMIT.cursor)
export const ProviderInventoryQuerySchema = z
  .object({ cursor: ProviderInventoryCursorSchema.optional() })
  .strict()
export const ProviderInventoryPageFields = {
  total: z.number().int().nonnegative(),
  nextCursor: ProviderInventoryCursorSchema.nullable(),
}

export const ProviderModelSchema = z
  .object({
    name: DurableNonEmptyScalarSchema.refine(
      (value) => value.length <= PROVIDER_LIMIT.modelName,
      'model name is too long',
    ),
    dimensions: z.number().int().positive().nullable(),
    status: ModelStatusSchema,
  })
  .strict()

export const ProviderLastCheckSchema = z
  .object({
    status: ProviderStatusSchema,
    checkedAt: z.string(),
    diagnostic: z.string().max(PROVIDER_LIMIT.diagnostic).nullable(),
    /** False means the probe proved runtime reachability only, not the credential
     *  — `wire: ollama` never checks authentication. Part of the status contract,
     *  not a hint the UI is free to drop. */
    credentialProven: z.boolean(),
  })
  .strict()

/** Fields absent rather than nulled are the audience projection, not degradation:
 *  a viewer who is neither the owner nor a host admin learns WHAT the resource
 *  serves, never WHERE it points. What stays of the addressee for them is
 *  `addressIsPrivate` — "an external service" or "the private network".
 *  canon: docs/contract.md#routing */
export const ProviderResourceSchema = z.object({
  id: z.string(),
  name: DurableDisplayNameSchema,
  wire: WireSchema,
  /** Who pays for the call. Everyone who may see the record sees this. */
  owner: AuthorSchema,
  baseUrl: z.string().optional(),
  /** Values are write-only. Only canonical names cross the response wire, and a
   *  name can be a secret of its own (`x-<tenant>-internal`), so they follow the
   *  addressee rather than the inventory. */
  headerNames: z.array(z.string()).max(PROVIDER_LIMIT.headers).optional(),
  /** What stays of the addressee for a viewer who may not have it: whether the call
   *  leaves the host at all. DERIVED — a literal private/loopback origin, or an
   *  opt-in the operator's allow-list actually admits — never the opt-in alone, which
   *  is legal on a public origin and would read as "inside our network". */
  addressIsPrivate: z.boolean(),
  /** The owner's opt-in, which is a setting rather than a fact about the address. */
  allowPrivateNetwork: z.boolean().optional(),
  purposes: z.array(PurposeSchema).max(PROVIDER_LIMIT.purposes),
  models: z.array(ProviderModelSchema).max(PROVIDER_LIMIT.models),
  defaultModel: z.string().nullable(),
  /** Owner-management detail only; attachment viewers get `hasCredentials`. */
  credentialId: z.string().nullable().optional(),
  hasCredentials: z.boolean(),
  /** Derived from the origin, so it names the addressee — it travels with it. */
  vendor: z.enum(['openrouter', 'generic']).optional(),
  consentEpoch: z.number().int().nonnegative(),
  runtimeEpoch: z.number().int().nonnegative(),
  disabledAt: z.string().nullable(),
  lastCheck: z
    .object({
      [PURPOSE.chat]: ProviderLastCheckSchema.optional(),
      [PURPOSE.embedding]: ProviderLastCheckSchema.optional(),
    })
    .strict(),
  firstByteTimeoutMs: z.number().int().positive().nullable().optional(),
  callTimeoutMs: z.number().int().positive().nullable().optional(),
})

/** Inventory rows carry only what the table renders. Provider-controlled model
 * records, diagnostics, epochs and write-only configuration stay behind the lazy
 * detail read. `baseUrl` retains the owner/audience projection of the full resource. */
export const ProviderResourceListItemSchema = ProviderResourceSchema.pick({
  id: true,
  name: true,
  wire: true,
  owner: true,
  baseUrl: true,
  addressIsPrivate: true,
  purposes: true,
  hasCredentials: true,
  disabledAt: true,
})
  .extend({ modelCount: z.number().int().nonnegative().max(PROVIDER_LIMIT.models) })
  .strict()

const ProviderResourceWriteFieldsSchema = z
  .object({
    name: DurableDisplayNameSchema,
    wire: WireSchema,
    baseUrl: z.string().min(1).max(PROVIDER_LIMIT.baseUrl),
    headers: z
      .record(z.string().max(PROVIDER_LIMIT.headerName), z.string().max(PROVIDER_LIMIT.headerValue))
      .refine((value) => Object.keys(value).length <= PROVIDER_LIMIT.headers, 'too many headers'),
    allowPrivateNetwork: z.boolean(),
    purposes: z
      .array(PurposeSchema)
      .min(1)
      .max(PROVIDER_LIMIT.purposes)
      .refine((value) => new Set(value).size === value.length, 'purposes must be unique'),
    models: z.array(ProviderModelSchema).max(PROVIDER_LIMIT.models),
    defaultModel: z.string().max(PROVIDER_LIMIT.modelName).nullable(),
    credentialId: z.string().nullable(),
    firstByteTimeoutMs: z
      .number()
      .int()
      .min(PROVIDER_TIMEOUT.minimumMs)
      .max(PROVIDER_TIMEOUT.firstByteMaximumMs)
      .nullable(),
    callTimeoutMs: z
      .number()
      .int()
      .min(PROVIDER_TIMEOUT.minimumMs)
      .max(PROVIDER_TIMEOUT.callMaximumMs)
      .nullable(),
  })
  .strict()

/** A resource response exposes header names but never their values. PATCH therefore
 *  cannot replace the whole map without making every edit destructive: the client
 *  has no honest way to resend untouched values. Keys in this map are operations —
 *  a string sets/replaces one value, null removes it, and an absent key retains it. */
export const ProviderResourceHeaderPatchSchema = z
  .record(
    z.string().max(PROVIDER_LIMIT.headerName),
    z.string().max(PROVIDER_LIMIT.headerValue).nullable(),
  )
  .refine((value) => Object.keys(value).length > 0, 'header patch must not be empty')
  .refine((value) => Object.keys(value).length <= PROVIDER_LIMIT.headers, 'too many headers')

export const ProviderResourceCreateRequestSchema = ProviderResourceWriteFieldsSchema.extend({
  headers: ProviderResourceWriteFieldsSchema.shape.headers.default({}),
  allowPrivateNetwork: z.boolean().default(false),
  models: ProviderResourceWriteFieldsSchema.shape.models.default([]),
  defaultModel: ProviderResourceWriteFieldsSchema.shape.defaultModel.default(null),
  credentialId: ProviderResourceWriteFieldsSchema.shape.credentialId.default(null),
  firstByteTimeoutMs: ProviderResourceWriteFieldsSchema.shape.firstByteTimeoutMs.default(null),
  callTimeoutMs: ProviderResourceWriteFieldsSchema.shape.callTimeoutMs.default(null),
}).strict()

export const ProviderResourcePatchRequestSchema = ProviderResourceWriteFieldsSchema.omit({
  headers: true,
})
  .partial()
  .extend({
    headers: ProviderResourceHeaderPatchSchema.optional(),
    disabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required')

export const ProviderResourceResponseSchema = z.object({
  resource: ProviderResourceSchema,
  warnings: z.array(z.string()),
})

export const ProviderResourcesResponseSchema = z
  .object({
    items: z.array(ProviderResourceListItemSchema),
    ...ProviderInventoryPageFields,
  })
  .strict()

/** A bounded owner-only status reconciliation. It deliberately carries no resource
 * projection: the caller already has its owned compact row, and a status read must
 * not become another address/header/diagnostic audience. */
export const ProviderResourceStatusesRequestSchema = z
  .object({
    ids: z
      .array(z.string().min(1))
      .min(1)
      .max(PROVIDER_LIST_PAGE_SIZE)
      .refine((ids) => new Set(ids).size === ids.length, 'provider ids must be unique'),
  })
  .strict()

export const ProviderResourceStatusSchema = z
  .object({
    id: z.string().min(1),
    unusableBecause: ProviderStatusSchema.nullable(),
  })
  .strict()

export const ProviderResourceStatusesResponseSchema = z
  .object({ items: z.array(ProviderResourceStatusSchema).max(PROVIDER_LIST_PAGE_SIZE) })
  .strict()

/** One row of an effective list. `unusableBecause` is null exactly when the resource
 *  can be called; every other value is a member of the closed invalidity list, so a
 *  surface can say WHY instead of showing a silent gap. A never-accepted offer is not
 *  a row here at all — consent is the only place it is disclosed.
 *  canon: #387 design/11 */
export const ProviderEffectiveEntrySchema = z
  .object({
    resource: ProviderResourceListItemSchema,
    unusableBecause: ProviderStatusSchema.nullable(),
  })
  .strict()

export const ProviderEffectiveResponseSchema = z
  .object({
    items: z.array(ProviderEffectiveEntrySchema),
    ...ProviderInventoryPageFields,
  })
  .strict()

export const ProviderValidateRequestSchema = z.object({ purpose: PurposeSchema }).strict()

export const ProviderValidateResponseSchema = z.object({
  purpose: PurposeSchema,
  result: ProviderLastCheckSchema,
  /** False when the captured runtime epochs moved while the call was in flight:
   *  the outcome describes an addressee that no longer exists, so the record keeps
   *  saying "unverified" and only the caller sees it. */
  saved: z.boolean(),
  resource: ProviderResourceSchema,
})

export const ProviderResourceDeleteResponseSchema = OkResponseSchema

export type ProviderModel = z.infer<typeof ProviderModelSchema>
export type ProviderLastCheck = z.infer<typeof ProviderLastCheckSchema>
export type ProviderResource = z.infer<typeof ProviderResourceSchema>
export type ProviderResourceListItem = z.infer<typeof ProviderResourceListItemSchema>
export type ProviderInventoryQuery = z.infer<typeof ProviderInventoryQuerySchema>
export type ProviderInventoryQueryInput = z.input<typeof ProviderInventoryQuerySchema>
export type ProviderResourceCreateRequest = z.infer<typeof ProviderResourceCreateRequestSchema>
export type ProviderResourceHeaderPatch = z.infer<typeof ProviderResourceHeaderPatchSchema>
export type ProviderResourcePatchRequest = z.infer<typeof ProviderResourcePatchRequestSchema>
export type ProviderResourceResponse = z.infer<typeof ProviderResourceResponseSchema>
export type ProviderResourcesResponse = z.infer<typeof ProviderResourcesResponseSchema>
export type ProviderResourceStatusesRequest = z.infer<typeof ProviderResourceStatusesRequestSchema>
export type ProviderResourceStatus = z.infer<typeof ProviderResourceStatusSchema>
export type ProviderResourceStatusesResponse = z.infer<
  typeof ProviderResourceStatusesResponseSchema
>
export type ProviderValidateRequest = z.infer<typeof ProviderValidateRequestSchema>
export type ProviderValidateResponse = z.infer<typeof ProviderValidateResponseSchema>
export type ProviderEffectiveEntry = z.infer<typeof ProviderEffectiveEntrySchema>
export type ProviderEffectiveResponse = z.infer<typeof ProviderEffectiveResponseSchema>
