import { z } from 'zod'
import { VIEW_AGENT_ROW_MAX } from '../../consts/views'
import {
  DurableScalarSchema,
  IsoTimestampSchema,
  NoteClassSchema,
  prototypeSafeRecord,
} from '../primitives'
import { ViewManifestItemSchema, ViewRowSchema } from '../rest/views'
import { locationFields, sessionField } from './_fields'
import {
  ProjectHandleSchema,
  ProvenanceSchema,
  RefSchema,
  RESPONSE_FORMAT,
  ResponseFormatSchema,
} from './primitives'

/** Tool `search`: hybrid ranked search over reachable knowledge, incl. the agent's
 *  own memory. canon: docs/mcp-gateway.md#tools */
export const SearchInputSchema = z
  .object({
    ...sessionField,
    query: z.string().min(1),
    project: ProjectHandleSchema.optional(),
    /** `agent-memory` = only memory, `user-doc` = exclude it, omit = every visible
     *  class. canon: docs/note-model.md#agent-memory */
    class: NoteClassSchema.optional(),
    responseFormat: ResponseFormatSchema.default(RESPONSE_FORMAT.concise),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict()

/** One ranked hit (not the full note — use get_note). `score` is engine-native,
 *  comparable only within one response; location per `locationFields`. */
export const SearchHitSchema = z.object({
  noteId: z.string(),
  title: z.string(),
  snippet: z.string(),
  ...locationFields,
  class: NoteClassSchema.optional(),
  score: z.number().optional(),
  modifiedAt: IsoTimestampSchema,
  viewType: DurableScalarSchema.optional(),
})

export const SearchOutputSchema = z.object({ results: z.array(SearchHitSchema) })

/** Tool `get_note`: a full note by ref (note-id or in-space wiki-ref).
 *  canon: docs/mcp-gateway.md#tools */
export const GetNoteInputSchema = z
  .object({
    ...sessionField,
    ref: RefSchema,
    responseFormat: ResponseFormatSchema.default(RESPONSE_FORMAT.detailed),
  })
  .strict()

/** One heading in a note's outline: `title` is a valid `section` for edit_note's
 *  replaceSection. canon: docs/mcp-gateway.md#tools */
export const OutlineEntrySchema = z.object({
  level: z.number().int().min(1).max(6),
  title: z.string(),
})

/** One graph edge touching the note. `relation` is the mono-typed graph link
 *  (`links-to`), not the authored label; `noteId` is absent for an unresolved ghost.
 *  canon: docs/architecture.md#p5 */
export const NoteLinkSchema = z.object({
  noteId: z.string().optional(),
  title: z.string(),
  relation: z.string(),
})

export const GetNoteViewSchema = ViewManifestItemSchema.extend({
  rows: z.array(ViewRowSchema).max(VIEW_AGENT_ROW_MAX).optional(),
  rowsTruncated: z.literal(true).optional(),
})

const ViewRowPublishedSchema = ViewRowSchema.extend({
  fields: z.record(z.string(), ViewRowSchema.shape.group.unwrap()).optional(),
})

const GetNoteViewPublishedSchema = ViewManifestItemSchema.extend({
  rows: z.array(ViewRowPublishedSchema).max(VIEW_AGENT_ROW_MAX).optional(),
  rowsTruncated: z.literal(true).optional(),
})

/** get_note's full-note payload. `frontmatter` is the raw free-form metadata map,
 *  orthogonal to the mount-derived `class`; `outline`/`links` ride only on a
 *  `detailed` read. canon: docs/mcp-gateway.md#tools */
export const GetNoteOutputSchema = z.object({
  noteId: z.string(),
  title: z.string(),
  content: z.string(),
  frontmatter: prototypeSafeRecord(z.unknown()),
  unsafeFrontmatterKeysOmitted: z.number().int().positive().optional(),
  ...locationFields,
  class: NoteClassSchema.optional(),
  versionToken: z.string(),
  provenance: ProvenanceSchema.optional(),
  outline: z.array(OutlineEntrySchema).optional(),
  links: z
    .object({
      outgoing: z.array(NoteLinkSchema),
      incoming: z.array(NoteLinkSchema),
    })
    .optional(),
  /** Semantic view projection in authored order. Raw nota config remains in content. */
  views: z.array(GetNoteViewSchema).optional(),
  viewRowsTruncated: z.literal(true).optional(),
})

/** JSON-schema publication twin: prototype safety is a runtime parsing concern,
 * while MCP discovery needs a representable open-object schema. */
export const GetNotePublishedOutputSchema = GetNoteOutputSchema.extend({
  frontmatter: z.record(z.string(), z.unknown()),
  views: z.array(GetNoteViewPublishedSchema).optional(),
})

/** Tool `recall`: assemble a token-budgeted context bundle around a query (seed
 *  notes + their graph neighbours). canon: docs/mcp-gateway.md#tools */
export const RecallInputSchema = z
  .object({
    ...sessionField,
    query: z.string().min(1),
    project: ProjectHandleSchema.optional(),
    /** Token cap on the whole assembled bundle. */
    budgetTokens: z.number().int().min(1).default(4000),
    /** Graph hops around the seed notes; bounded to keep traversal (and budget) sane. */
    depth: z.number().int().min(0).max(3).default(1),
    /** Per-source token cap so one big note can't starve its neighbours; omitted =
     *  half the budget (floor 500). */
    maxPerSource: z.number().int().min(1).optional(),
  })
  .strict()

/** A note that fed the assembled context: the `agentRecall` classes (`user-doc` +
 *  `agent-memory`, never `chat` — injection surface). Location per `locationFields`. */
export const RecallSourceSchema = z.object({
  noteId: z.string(),
  title: z.string(),
  ...locationFields,
  class: NoteClassSchema.optional(),
})

/** recall's output: the assembled context blob + its sources; `truncated` is
 *  honest when the budget capped the bundle. canon: docs/mcp-gateway.md#tools */
export const RecallOutputSchema = z.object({
  context: z.string(),
  sources: z.array(RecallSourceSchema),
  truncated: z.boolean().optional(),
})

export type SearchInput = z.infer<typeof SearchInputSchema>

export type SearchHit = z.infer<typeof SearchHitSchema>

export type SearchOutput = z.infer<typeof SearchOutputSchema>

export type GetNoteInput = z.infer<typeof GetNoteInputSchema>

export type GetNoteOutput = z.infer<typeof GetNoteOutputSchema>

export type OutlineEntry = z.infer<typeof OutlineEntrySchema>

export type NoteLink = z.infer<typeof NoteLinkSchema>

export type GetNoteView = z.infer<typeof GetNoteViewSchema>

export type RecallInput = z.infer<typeof RecallInputSchema>

export type RecallSource = z.infer<typeof RecallSourceSchema>

export type RecallOutput = z.infer<typeof RecallOutputSchema>
