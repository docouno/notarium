import { z } from 'zod'
import { EDIT_OPERATION, WRITE_OUTCOME } from '../../consts/tools'
import { enumValues } from '../../libs/enumValues'
import { IsoTimestampSchema, SpaceSlugSchema } from '../primitives'
import { sessionField } from './_fields'
import { ProjectHandleSchema, RefSchema } from './primitives'

/** CAS + idempotency mixin for the create/edit tools (`link` takes neither —
 *  idempotent by construction). canon: docs/contract.md#cas */
const casFields = {
  versionToken: z.string().optional(),
  idempotencyKey: z.string().optional(),
}

/** Tool `remember_about_user`: record a durable fact into the user's personal
 *  agent-memory. canon: docs/note-model.md#agent-memory */
export const RememberAboutUserInputSchema = z.object({
  ...sessionField,
  observation: z.string().min(1),
  category: z.string().default('general'),
  summary: z.string().optional(),
  ...casFields,
})

/** One typed edge materialized inline while creating a note: `to` (note-id) XOR
 *  `toTitle` (forward-ref by title). canon: docs/note-model.md#note-ontology */
export const InlineLinkSchema = z.object({
  to: RefSchema.optional(),
  toTitle: z.string().min(1).optional(),
  relation: z.string().min(1),
})

/** Tool `create_note`: create a `user-doc` KB note in a project — the agent picks
 *  neither space nor class. canon: docs/mcp-gateway.md#tools */
export const CreateNoteInputSchema = z.object({
  ...sessionField,
  project: ProjectHandleSchema,
  title: z.string().optional(),
  body: z.string(),
  path: z.string().optional(),
  type: z.string().optional(),
  tags: z.array(z.string()).optional(),
  links: z.array(InlineLinkSchema).optional(),
  createdAt: IsoTimestampSchema.optional(),
  fileName: z.string().optional(),
  ...casFields,
})

/** One note in a `create_notes` batch: create_note's fields minus `project`
 *  (hoisted to the batch) and `versionToken` (a create is additive). */
export const CreateNoteItemSchema = CreateNoteInputSchema.omit({
  project: true,
  session: true,
  versionToken: true,
})

/** Tool `create_notes`: best-effort batch create in one project (per-item
 *  success/failure, never a rollback). canon: docs/mcp-gateway.md#tools */
export const CreateNotesInputSchema = z.object({
  ...sessionField,
  project: ProjectHandleSchema,
  notes: z.array(CreateNoteItemSchema).min(1).max(50),
})

/** One note's outcome in a `create_notes` batch: `index`/`title` correlate to the
 *  request; `ok:true` with the create echo, else `ok:false` + `error`. */
export const BatchCreateResultSchema = z.object({
  index: z.number().int(),
  title: z.string(),
  ok: z.boolean(),
  noteId: z.string().optional(),
  versionToken: z.string().optional(),
  outcome: z.enum(enumValues(WRITE_OUTCOME)).exclude([WRITE_OUTCOME.appended]).optional(),
  path: z.string().optional(),
  space: SpaceSlugSchema.optional(),
  bodyBytes: z.number().int().optional(),
  bodyHash: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  error: z.string().optional(),
})

export const CreateNotesOutputSchema = z.object({
  results: z.array(BatchCreateResultSchema),
})

/** One link in a `link_many` batch: `from` + a target (`to` XOR `toTitle`) +
 *  `relation`. Same edge semantics as `link`. */
export const LinkItemSchema = z.object({
  from: RefSchema,
  to: RefSchema.optional(),
  toTitle: z.string().min(1).optional(),
  relation: z.string().min(1),
})

/** Tool `link_many`: best-effort batch of typed links in one call.
 *  canon: docs/mcp-gateway.md#tools */
export const LinkManyInputSchema = z.object({
  ...sessionField,
  links: z.array(LinkItemSchema).min(1).max(100),
})

/** One link's outcome in a `link_many` batch: `index` correlates; `ok:true` with
 *  the `from` note's fresh `versionToken`, else `ok:false` + `error`. */
export const BatchLinkResultSchema = z.object({
  index: z.number().int(),
  ok: z.boolean(),
  versionToken: z.string().optional(),
  error: z.string().optional(),
})

export const LinkManyOutputSchema = z.object({
  results: z.array(BatchLinkResultSchema),
})

/** Tool `remember_about_project`: record a durable fact into the project's
 *  agent-memory. canon: docs/note-model.md#agent-memory */
export const RememberAboutProjectInputSchema = z.object({
  ...sessionField,
  project: ProjectHandleSchema,
  observation: z.string().min(1),
  category: z.string().default('general'),
  summary: z.string().optional(),
  ...casFields,
})
/** The five word-based edit addressing modes. */
export const EditOperationSchema = z.enum(enumValues(EDIT_OPERATION))
/** Tool `edit_note`: modify a note incrementally via five word-based addressing
 *  modes (never positional). `section`/`find` are kept optional so one schema
 *  covers all modes — the edit op enforces the pairing.
 *  canon: docs/mcp-gateway.md#tools */
export const EditNoteInputSchema = z.object({
  ...sessionField,
  ref: RefSchema,
  operation: EditOperationSchema,
  content: z.string(),
  section: z.string().optional(),
  find: z.string().optional(),
  ...casFields,
})

/** Tool `link`: create a typed wikilink between two notes in the same space
 *  (`to` note-id XOR `toTitle` forward-ref). canon: docs/note-model.md#note-ontology */
export const LinkInputSchema = z.object({
  ...sessionField,
  from: RefSchema,
  to: RefSchema.optional(),
  toTitle: z.string().min(1).optional(),
  relation: z.string().min(1),
})

export const LinkOutputSchema = z.object({
  ok: z.literal(true),
  versionToken: z.string(),
})

export type RememberAboutUserInput = z.infer<typeof RememberAboutUserInputSchema>

export type InlineLink = z.infer<typeof InlineLinkSchema>

export type CreateNoteInput = z.infer<typeof CreateNoteInputSchema>

export type RememberAboutProjectInput = z.infer<typeof RememberAboutProjectInputSchema>

export type EditNoteInput = z.infer<typeof EditNoteInputSchema>

export type LinkInput = z.infer<typeof LinkInputSchema>

export type LinkOutput = z.infer<typeof LinkOutputSchema>

export type CreateNoteItem = z.infer<typeof CreateNoteItemSchema>

export type CreateNotesInput = z.infer<typeof CreateNotesInputSchema>

export type BatchCreateResult = z.infer<typeof BatchCreateResultSchema>

export type CreateNotesOutput = z.infer<typeof CreateNotesOutputSchema>

export type LinkItem = z.infer<typeof LinkItemSchema>

export type LinkManyInput = z.infer<typeof LinkManyInputSchema>

export type BatchLinkResult = z.infer<typeof BatchLinkResultSchema>

export type LinkManyOutput = z.infer<typeof LinkManyOutputSchema>

export { EDIT_OPERATION }
export type { EditOperation } from '../../consts/tools'
