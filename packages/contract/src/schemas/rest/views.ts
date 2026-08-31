import { z } from 'zod'

import { FIELD_COLOR } from '../../consts/fields'
import { VIEW_WINDOW_MAX } from '../../consts/views'
import { enumValues } from '../../libs/enumValues'
import {
  DurableNonEmptyScalarSchema,
  DurableScalarSchema,
  prototypeSafeRecord,
} from '../primitives'
import { FieldFilterAstV1Schema } from './notes'

export const ViewSourceV1Schema = z
  .object({
    kind: DurableNonEmptyScalarSchema,
    scope: z.enum(['project', 'space']).optional(),
    filter: FieldFilterAstV1Schema.optional(),
  })
  .passthrough()

export const ViewDefinitionV1Schema = z
  .object({
    name: DurableNonEmptyScalarSchema,
    type: DurableNonEmptyScalarSchema,
    filter: FieldFilterAstV1Schema.optional(),
    fields: z.array(DurableNonEmptyScalarSchema).max(128).optional(),
    limit: z.number().int().positive().optional(),
    options: prototypeSafeRecord(z.unknown()).optional(),
  })
  .passthrough()

export const ViewValueStateSchema = z.enum([
  'value',
  'absent',
  'empty-string',
  'empty-list',
  'unreadable',
])

export const ViewProjectedValueSchema = z.object({
  state: ViewValueStateSchema,
  value: z.union([z.string(), z.array(z.string())]).optional(),
  label: z.string().optional(),
  color: z.enum(enumValues(FIELD_COLOR)).optional(),
})

export const ViewGroupSchema = ViewProjectedValueSchema.extend({
  key: DurableNonEmptyScalarSchema,
  count: z.number().int().min(0),
})

export const ViewRowSchema = z.object({
  id: DurableNonEmptyScalarSchema,
  title: z.string(),
  filePath: z.string(),
  noteType: DurableScalarSchema.optional(),
  group: ViewProjectedValueSchema.optional(),
  fields: prototypeSafeRecord(ViewProjectedValueSchema).optional(),
})

export const ViewExecutionStateSchema = z.object({
  exactFallbackTruncated: z.literal(true).optional(),
  exactReads: z.number().int().min(0),
  exactCacheHits: z.number().int().min(0),
  exactRemaining: z.number().int().min(0),
})

export const ViewMutationCapabilitiesSchema = z
  .object({
    move: z.literal(true).optional(),
    editOptions: z.literal(true).optional(),
  })
  .strict()

export const ViewManifestQuerySchema = z.object({ id: DurableNonEmptyScalarSchema })

export const ViewManifestItemSchema = z.object({
  viewRef: DurableNonEmptyScalarSchema.optional(),
  block: z.number().int().min(0),
  occurrence: z.number().int().min(0),
  name: z.string(),
  type: z.string(),
  status: z.enum(['ready', 'unsupported', 'invalid', 'incomplete']),
  total: z.number().int().min(0).optional(),
  groups: z.array(ViewGroupSchema).optional(),
  totalGroups: z.number().int().min(0).optional(),
  groupsTruncated: z.literal(true).optional(),
  diagnostics: z.array(z.string()).optional(),
  execution: ViewExecutionStateSchema.optional(),
  capabilities: ViewMutationCapabilitiesSchema.optional(),
  snapshotGeneration: z.string().optional(),
  schemaVersionToken: z.string().optional(),
})

export const ViewManifestResponseSchema = z.object({
  documentId: DurableNonEmptyScalarSchema,
  documentVersionToken: z.string(),
  snapshotGeneration: z.string(),
  schemaVersionToken: z.string().optional(),
  marker: z.string().optional(),
  primaryType: z.string().optional(),
  markerMismatch: z.boolean().optional(),
  views: z.array(ViewManifestItemSchema),
  diagnostics: z.array(z.string()).optional(),
})

export const ViewWindowRequestSchema = z.object({
  viewRef: DurableNonEmptyScalarSchema,
  /** Bind every independently loaded window to the manifest that requested it.
   * A cache miss may recompute, but it must conflict rather than mix generations. */
  snapshotGeneration: DurableNonEmptyScalarSchema,
  schemaVersionToken: z.string().optional(),
  group: DurableNonEmptyScalarSchema.optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(VIEW_WINDOW_MAX).default(50),
})

export const ViewWindowResponseSchema = z.object({
  viewRef: DurableNonEmptyScalarSchema,
  group: DurableNonEmptyScalarSchema.optional(),
  offset: z.number().int().min(0),
  limit: z.number().int().min(1).max(VIEW_WINDOW_MAX),
  total: z.number().int().min(0),
  snapshotGeneration: z.string(),
  schemaVersionToken: z.string().optional(),
  rows: z.array(ViewRowSchema).max(VIEW_WINDOW_MAX),
  execution: ViewExecutionStateSchema,
})

export const DraftViewQueryRequestSchema = z.object({
  context: z.object({ kind: z.literal('draft'), directory: z.string() }),
  source: ViewSourceV1Schema,
  view: ViewDefinitionV1Schema,
  snapshotGeneration: DurableNonEmptyScalarSchema.optional(),
  schemaVersionToken: z.string().optional(),
  window: z.object({
    group: DurableNonEmptyScalarSchema.optional(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(VIEW_WINDOW_MAX).default(50),
  }),
})

export const DraftViewQueryResponseSchema = ViewWindowResponseSchema.omit({ viewRef: true }).extend(
  {
    draft: z.literal(true),
    groups: z.array(ViewGroupSchema).optional(),
  },
)

export const ViewObjectPatchSchema = z
  .object({
    set: prototypeSafeRecord(z.unknown()).optional(),
    remove: z.array(DurableNonEmptyScalarSchema).max(128).optional(),
  })
  .strict()
  .refine(
    (patch) =>
      Object.getOwnPropertyNames(patch.set ?? {}).length > 0 || Boolean(patch.remove?.length),
    'view object patch must set or remove at least one key',
  )

export const ViewConfigPatchSchema = z
  .object({
    viewRef: DurableNonEmptyScalarSchema,
    source: ViewObjectPatchSchema.optional(),
    common: ViewObjectPatchSchema.optional(),
    options: ViewObjectPatchSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.source && !value.common && !value.options) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'view patch is empty' })
    }
    const order = value.options?.set?.order

    if (
      order &&
      typeof order === 'object' &&
      !Array.isArray(order) &&
      Object.hasOwn(order, 'ranks')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options', 'set', 'order'],
        message: 'manual ranks are not agent-editable',
      })
    }
  })

/** JSON-schema publication twins: runtime prototype safety/refinements stay above,
 * while MCP discovery needs representable open-object shapes. */
export const ViewObjectPatchPublishedSchema = z
  .object({
    set: z.record(z.string(), z.unknown()).optional(),
    remove: z.array(DurableNonEmptyScalarSchema).max(128).optional(),
  })
  .strict()

export const ViewConfigPatchPublishedSchema = z
  .object({
    viewRef: DurableNonEmptyScalarSchema,
    source: ViewObjectPatchPublishedSchema.optional(),
    common: ViewObjectPatchPublishedSchema.optional(),
    options: ViewObjectPatchPublishedSchema.optional(),
  })
  .strict()

export const BoardMoveRequestSchema = z
  .object({
    viewRef: DurableNonEmptyScalarSchema,
    cardId: DurableNonEmptyScalarSchema,
    to: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('value'), value: DurableScalarSchema }),
      z.object({ kind: z.literal('absent') }),
    ]),
    beforeId: DurableNonEmptyScalarSchema.optional(),
    afterId: DurableNonEmptyScalarSchema.optional(),
  })
  .strict()
  .refine((value) => value.beforeId !== value.cardId && value.afterId !== value.cardId, {
    message: 'a card cannot be its own move neighbour',
  })

export const BoardMoveResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('moved'),
    cardVersionToken: z.string(),
    viewVersionToken: z.string(),
    rank: z.string(),
    rebalanced: z.literal(true).optional(),
  }),
  z.object({
    status: z.literal('moved-unranked'),
    cardVersionToken: z.string(),
    viewVersionToken: z.string(),
    reason: z.literal('rank-write-failed'),
  }),
  z.object({
    status: z.literal('moved-partial'),
    fieldEffect: z.object({
      key: z.string(),
      value: z.string().nullable(),
      versionToken: z.string(),
    }),
    reason: z.enum(['view-changed', 'view-deleted', 'membership-changed']),
  }),
  z.object({
    status: z.literal('unchanged'),
    cardVersionToken: z.string(),
    viewVersionToken: z.string(),
  }),
])

export type ViewSourceV1 = z.infer<typeof ViewSourceV1Schema>
export type ViewDefinitionV1 = z.infer<typeof ViewDefinitionV1Schema>
export type ViewManifestResponse = z.infer<typeof ViewManifestResponseSchema>
export type ViewWindowRequest = z.infer<typeof ViewWindowRequestSchema>
export type ViewWindowResponse = z.infer<typeof ViewWindowResponseSchema>
export type ViewRow = z.infer<typeof ViewRowSchema>
export type ViewGroup = z.infer<typeof ViewGroupSchema>
export type ViewProjectedValue = z.infer<typeof ViewProjectedValueSchema>
export type ViewMutationCapabilities = z.infer<typeof ViewMutationCapabilitiesSchema>
export type DraftViewQueryRequest = z.infer<typeof DraftViewQueryRequestSchema>
export type DraftViewQueryResponse = z.infer<typeof DraftViewQueryResponseSchema>
export type ViewConfigPatch = z.infer<typeof ViewConfigPatchSchema>
export type BoardMoveRequest = z.infer<typeof BoardMoveRequestSchema>
export type BoardMoveResponse = z.infer<typeof BoardMoveResponseSchema>
