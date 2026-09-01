import { z } from 'zod'

import {
  MODEL_CAPABILITY,
  MODEL_STATUS,
  type ModelCapability,
  PROVIDER_LIMIT,
  PROVIDER_LIST_PAGE_SIZE,
  PROVIDER_STATUS,
  PROVIDER_TIMEOUT,
  WIRE,
} from '../../consts/providers'
import { enumValues } from '../../libs/enumValues'
import { AuthorSchema, DurableDisplayNameSchema, DurableNonEmptyScalarSchema } from '../primitives'
import { OkResponseSchema } from './_shared'

export const WireSchema = z.enum(enumValues(WIRE))
export const ModelCapabilitySchema = z.enum(enumValues(MODEL_CAPABILITY))
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

export const ProviderModelNameSchema = DurableNonEmptyScalarSchema.refine(
  (value) => value.length <= PROVIDER_LIMIT.modelName,
  'model name is too long',
).refine((value) => value.trim().length > 0, 'model name must contain a non-whitespace character')

export const ProviderModelWriteSchema = z
  .object({
    name: ProviderModelNameSchema,
    capabilities: z
      .array(ModelCapabilitySchema)
      .min(1)
      .max(PROVIDER_LIMIT.capabilities)
      .refine((value) => new Set(value).size === value.length, 'capabilities must be unique'),
  })
  .strict()

const ProviderModelStatusByCapabilitySchema = z
  .object({
    [MODEL_CAPABILITY.completion]: ModelStatusSchema.optional(),
    [MODEL_CAPABILITY.embedding]: ModelStatusSchema.optional(),
  })
  .strict()

export const ProviderModelSchema = ProviderModelWriteSchema.extend({
  dimensions: z.number().int().positive().nullable(),
  statusByCapability: ProviderModelStatusByCapabilitySchema,
})
  .strict()
  .superRefine((model, ctx) => {
    const capabilities = new Set(model.capabilities)
    const statuses = Object.keys(model.statusByCapability)

    if (
      statuses.length !== capabilities.size ||
      statuses.some((capability) => !capabilities.has(capability as ModelCapability))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['statusByCapability'],
        message: 'status keys must exactly match model capabilities',
      })
    }
    if (model.dimensions !== null && !capabilities.has(MODEL_CAPABILITY.embedding)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dimensions'],
        message: 'dimensions require the embedding capability',
      })
    }
  })

const ProviderModelsWriteSchema = z
  .array(ProviderModelWriteSchema)
  .max(PROVIDER_LIMIT.models)
  .refine(
    (models) => new Set(models.map(({ name }) => name)).size === models.length,
    'provider model names must be unique',
  )

const canonicalCapabilityOrder = [MODEL_CAPABILITY.completion, MODEL_CAPABILITY.embedding] as const

const hasCanonicalCapabilities = (capabilities: readonly ModelCapability[]): boolean =>
  canonicalCapabilityOrder
    .filter((capability) => capabilities.includes(capability))
    .every((capability, index) => capabilities[index] === capability)

export const ProviderModelsSchema = z
  .array(ProviderModelSchema)
  .max(PROVIDER_LIMIT.models)
  .superRefine((models, ctx) => {
    if (new Set(models.map(({ name }) => name)).size !== models.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'provider model names must be unique',
      })
    }
    models.forEach((model, index) => {
      if (!hasCanonicalCapabilities(model.capabilities)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'capabilities'],
          message: 'model capabilities must use canonical order',
        })
      }
    })
  })

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

export const ProviderLastChecksSchema = z
  .object({
    [MODEL_CAPABILITY.completion]: ProviderLastCheckSchema.optional(),
    [MODEL_CAPABILITY.embedding]: ProviderLastCheckSchema.optional(),
  })
  .strict()

/** Fields absent rather than nulled are the audience projection, not degradation:
 *  a viewer who is neither the owner nor a host admin learns WHAT the resource
 *  serves, never WHERE it points. What stays of the addressee for them is
 *  `addressIsPrivate` — "an external service" or "the private network".
 *  canon: docs/contract.md#routing */
const ProviderResourceFieldsSchema = z
  .object({
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
    models: ProviderModelsSchema,
    defaultModel: ProviderModelNameSchema.nullable(),
    /** Owner-management detail only; attachment viewers get `hasCredentials`. */
    credentialId: z.string().nullable().optional(),
    hasCredentials: z.boolean(),
    /** Derived from the origin, so it names the addressee — it travels with it. */
    vendor: z.enum(['openrouter', 'generic']).optional(),
    consentEpoch: z.number().int().nonnegative(),
    runtimeEpoch: z.number().int().nonnegative(),
    disabledAt: z.string().nullable(),
    lastCheck: ProviderLastChecksSchema,
    firstByteTimeoutMs: z.number().int().positive().nullable().optional(),
    callTimeoutMs: z.number().int().positive().nullable().optional(),
  })
  .strict()

export const ProviderResourceSchema = ProviderResourceFieldsSchema.superRefine((resource, ctx) => {
  if (
    resource.defaultModel !== null &&
    !resource.models.some(({ name }) => name === resource.defaultModel)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['defaultModel'],
      message: 'default model must name one exact model',
    })
  }
  const configuredCapabilities = new Set(
    resource.models.flatMap(({ capabilities }) => capabilities),
  )

  for (const capability of Object.keys(resource.lastCheck) as ModelCapability[]) {
    if (!configuredCapabilities.has(capability)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lastCheck', capability],
        message: 'last check requires a configured model capability',
      })
    }
  }
})

/** Inventory rows carry only what the table renders. Provider-controlled model
 * records, diagnostics, epochs and write-only configuration stay behind the lazy
 * detail read. `baseUrl` retains the owner/audience projection of the full resource. */
export const ProviderResourceListItemSchema = ProviderResourceFieldsSchema.pick({
  id: true,
  name: true,
  wire: true,
  owner: true,
  baseUrl: true,
  addressIsPrivate: true,
  hasCredentials: true,
  disabledAt: true,
})
  .extend({
    capabilities: z
      .array(ModelCapabilitySchema)
      .max(PROVIDER_LIMIT.capabilities)
      .refine(
        (capabilities) =>
          new Set(capabilities).size === capabilities.length &&
          hasCanonicalCapabilities(capabilities),
        'capabilities must be unique and use canonical order',
      ),
    modelCount: z.number().int().nonnegative().max(PROVIDER_LIMIT.models),
  })
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
    models: ProviderModelsWriteSchema,
    defaultModel: ProviderModelNameSchema.nullable(),
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

export const ProviderResourceResponseSchema = z
  .object({
    resource: ProviderResourceSchema,
    warnings: z.array(z.string()),
  })
  .strict()

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

export const ProviderValidateRequestSchema = z
  .object({ capability: ModelCapabilitySchema })
  .strict()

export const ProviderValidateResponseSchema = z
  .object({
    capability: ModelCapabilitySchema,
    result: ProviderLastCheckSchema,
    /** False when the captured runtime epochs moved while the call was in flight:
     *  the outcome describes an addressee that no longer exists, so the record keeps
     *  saying "unverified" and only the caller sees it. */
    saved: z.boolean(),
    resource: ProviderResourceSchema,
  })
  .strict()

export const ProviderResourceDeleteResponseSchema = OkResponseSchema

export type ProviderModel = z.infer<typeof ProviderModelSchema>
export type ProviderModelWrite = z.infer<typeof ProviderModelWriteSchema>
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
