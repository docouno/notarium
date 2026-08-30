import { z } from 'zod'

import {
  ATTACHMENT_STATE,
  PROVIDER_ATTACHMENT_ACCEPT_OUTCOME,
  PROVIDER_ATTACHMENT_CONFLICT,
  PROVIDER_LIMIT,
  PROVIDER_RETARGET_RESOLUTION,
  PROVIDER_TARGET_KIND,
} from '../../consts/providers'
import { enumValues } from '../../libs/enumValues'
import { CredentialSchema } from './credentials'
import {
  ProviderInventoryPageFields,
  ProviderModelSchema,
  ProviderResourceListItemSchema,
  ProviderResourceSchema,
  PurposeSchema,
} from './providers'

export const ProviderAttachmentStateSchema = z.enum(enumValues(ATTACHMENT_STATE))
export const ProviderTargetKindSchema = z.enum(enumValues(PROVIDER_TARGET_KIND))
export const ProviderAttachmentAcceptOutcomeSchema = z.enum(
  enumValues(PROVIDER_ATTACHMENT_ACCEPT_OUTCOME),
)
export const ProviderAttachmentConflictSchema = z.enum(enumValues(PROVIDER_ATTACHMENT_CONFLICT))
export const ProviderRetargetResolutionSchema = z.enum(enumValues(PROVIDER_RETARGET_RESOLUTION))

export const ProviderDisclosureSnapshotSchema = z
  .object({
    targetSpace: z.string(),
    resourceOwner: z.string(),
    baseUrl: z.string(),
    purposes: z.array(PurposeSchema),
    models: z.array(ProviderModelSchema),
    allowPrivateNetwork: z.boolean(),
    headerNames: z.array(z.string()),
  })
  .strict()

export const ProviderAttachmentSchema = z
  .object({
    id: z.string(),
    resourceId: z.string(),
    targetKind: ProviderTargetKindSchema,
    targetId: z.string(),
    targetSpace: z.string(),
    state: ProviderAttachmentStateSchema,
    resourceEpoch: z.number().int().nonnegative().nullable(),
    credentialEpoch: z.number().int().nonnegative().nullable(),
    disclosure: ProviderDisclosureSnapshotSchema.nullable(),
    createdAt: z.string(),
    expiresAt: z.string(),
  })
  .strict()

export const ProviderAttachmentOfferRequestSchema = z
  .object({
    resourceId: z.string().min(1),
    targetKind: ProviderTargetKindSchema,
    targetId: z.string().min(1),
  })
  .strict()

export const ProviderAttachmentAcceptRequestSchema = z
  .object({
    resourceEpoch: z.number().int().nonnegative(),
    credentialEpoch: z.number().int().nonnegative().nullable(),
  })
  .strict()

export const ProviderAttachmentDiffSchema = z
  .object({
    before: ProviderDisclosureSnapshotSchema.nullable(),
    after: ProviderDisclosureSnapshotSchema,
    changed: z.boolean(),
  })
  .strict()

export const ProviderAttachmentViewSchema = z
  .object({
    attachment: ProviderAttachmentSchema,
    resource: ProviderResourceSchema,
    /** The current pair the manager was shown and may conditionally accept. The
     *  epochs on `attachment` are the previously accepted pair (or null for a new
     *  offer), so overloading them would erase the automaton's stored state. */
    currentEpochs: ProviderAttachmentAcceptRequestSchema,
    currentDisclosure: ProviderDisclosureSnapshotSchema,
    diff: ProviderAttachmentDiffSchema,
  })
  .strict()

export const ProviderAttachmentListRecordSchema = ProviderAttachmentSchema.pick({
  id: true,
  resourceId: true,
  targetKind: true,
  targetId: true,
  targetSpace: true,
  state: true,
  createdAt: true,
  expiresAt: true,
}).strict()

export const ProviderAttachmentListItemSchema = z
  .object({
    attachment: ProviderAttachmentListRecordSchema,
    resource: ProviderResourceListItemSchema.omit({ baseUrl: true }),
  })
  .strict()

export const ProviderAttachmentsResponseSchema = z
  .object({
    items: z.array(ProviderAttachmentListItemSchema),
    ...ProviderInventoryPageFields,
  })
  .strict()

export const ProviderAttachmentOfferResponseSchema = z
  .object({ view: ProviderAttachmentViewSchema })
  .strict()

export const ProviderAttachmentDetailResponseSchema = z
  .object({ view: ProviderAttachmentViewSchema })
  .strict()

export const ProviderAttachmentAcceptResponseSchema = z
  .object({
    outcome: ProviderAttachmentAcceptOutcomeSchema,
    view: ProviderAttachmentViewSchema,
  })
  .strict()

export const ProviderAttachmentConflictResponseSchema = z
  .object({
    error: z.string(),
    reason: ProviderAttachmentConflictSchema,
    view: ProviderAttachmentViewSchema.optional(),
  })
  .strict()

export const ProviderAttachmentDetachResponseSchema = z.object({ ok: z.literal(true) }).strict()

export const ProviderRetargetResourceSchema = z
  .object({
    id: z.string().min(1),
    baseUrl: z.string().min(1).max(PROVIDER_LIMIT.baseUrl),
    detachCredential: z.boolean().default(false),
  })
  .strict()

export const ProviderRetargetRequestSchema = z
  .object({
    origin: z.string().min(1).max(PROVIDER_LIMIT.baseUrl),
    resources: z.array(ProviderRetargetResourceSchema),
  })
  .strict()
  .refine(
    ({ resources }) => new Set(resources.map(({ id }) => id)).size === resources.length,
    'retarget resources must be unique',
  )

export const ProviderRetargetResponseSchema = z
  .object({
    credential: CredentialSchema,
    resources: z.array(ProviderResourceSchema),
  })
  .strict()

export const ProviderRetargetConflictReferenceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    reason: z.string(),
    resolution: ProviderRetargetResolutionSchema,
  })
  .strict()

export const ProviderRetargetConflictResponseSchema = z
  .object({
    error: z.string(),
    references: z.array(ProviderRetargetConflictReferenceSchema),
  })
  .strict()

export type ProviderDisclosureSnapshot = z.infer<typeof ProviderDisclosureSnapshotSchema>
export type ProviderAttachment = z.infer<typeof ProviderAttachmentSchema>
export type ProviderAttachmentOfferRequest = z.infer<typeof ProviderAttachmentOfferRequestSchema>
export type ProviderAttachmentAcceptRequest = z.infer<typeof ProviderAttachmentAcceptRequestSchema>
export type ProviderAttachmentDiff = z.infer<typeof ProviderAttachmentDiffSchema>
export type ProviderAttachmentView = z.infer<typeof ProviderAttachmentViewSchema>
export type ProviderAttachmentListItem = z.infer<typeof ProviderAttachmentListItemSchema>
export type ProviderAttachmentsResponse = z.infer<typeof ProviderAttachmentsResponseSchema>
export type ProviderAttachmentOfferResponse = z.infer<typeof ProviderAttachmentOfferResponseSchema>
export type ProviderAttachmentDetailResponse = z.infer<
  typeof ProviderAttachmentDetailResponseSchema
>
export type ProviderAttachmentAcceptResponse = z.infer<
  typeof ProviderAttachmentAcceptResponseSchema
>
export type ProviderAttachmentConflictResponse = z.infer<
  typeof ProviderAttachmentConflictResponseSchema
>
export type ProviderRetargetRequest = z.infer<typeof ProviderRetargetRequestSchema>
export type ProviderRetargetResponse = z.infer<typeof ProviderRetargetResponseSchema>
export type ProviderRetargetConflictReference = z.infer<
  typeof ProviderRetargetConflictReferenceSchema
>
export type ProviderRetargetConflictResponse = z.infer<
  typeof ProviderRetargetConflictResponseSchema
>
