import { z } from 'zod'
import { AuthorSchema, RevisionKindSchema, RevisionUnavailableReasonSchema } from '../primitives'

export const RevisionStateFormatSchema = z
  .enum(['markdown-v1', 'markdown-v2', 'skill-markdown-v1', 'opaque-v1'])
  .nullable()

export const RestoreAvailabilitySchema = z.enum([
  'full',
  'partial',
  'opaque',
  'gap',
  'blocked',
  'unknown',
  'unreadable',
  'capability-unavailable',
])

/** One row of a note's timeline. `revisionId` is opaque and orders the
 *  timeline (newest first as served). `createdAt` here is a FULL ISO
 *  timestamp from the journal — the honest-timestamps source.
 *  `contentHash: null` marks an honest gap: the journal saw the change but
 *  couldn't capture the body (external edit the engine couldn't serve).
 *  `principal` is the raw writer id; `author` is its resolved, privacy-filtered
 *  display twin — null for external states with no writer. */
export const NoteRevisionSchema = z.object({
  revisionId: z.string(),
  noteId: z.string(),
  kind: RevisionKindSchema,
  principal: z.string().nullable(),
  author: AuthorSchema.nullable(),
  createdAt: z.string(),
  contentHash: z.string().nullable(),
  /** Versioned state encoding. Current exact rows are markdown-v2 or
   * skill-markdown-v1; opaque-v1 preserves unreadable/arbitrary source bytes;
   * markdown-v1 is the former logical-state compatibility format. null marks a
   * legacy body-only row or an honest gap. */
  stateFormat: RevisionStateFormatSchema,
  restoreAvailability: RestoreAvailabilitySchema,
  /** The revision this state was built on — the timeline chain; merge
   *  revisions additionally carry the other side in `theirRev` (both sides
   *  of a conflict are journaled, so 3-way merge can read them).
   *  @see docs/architecture.md#p3 */
  baseRev: z.string().nullable(),
  theirRev: z.string().nullable(),
  /** Restore provenance: which revision was written back. */
  sourceRev: z.string().nullable(),
  title: z.string(),
  /** Character add/remove counters vs the chain parent, computed at append
   *  time (timeline "+N −M"). null = honestly unknown (body-less gap,
   *  oversized diff, pre-stats row). */
  charsAdded: z.number().nullable(),
  charsRemoved: z.number().nullable(),
  /** A journal GAP — see `RevisionUnavailableReasonSchema`. */
  unavailableReason: RevisionUnavailableReasonSchema.optional(),
})

/** GET /api/note/revisions query: a window over the note's timeline, newest
 *  first. Windowed from day one (headroom, not need — today's UI pages by 50). */
export const NoteRevisionsQuerySchema = z.object({
  id: z.string(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export const NoteRevisionsResponseSchema = z.object({
  revisions: z.array(NoteRevisionSchema),
  total: z.number(),
})

/** GET /api/note/revision?id&revisionId — one revision with an explicit content
 *  mode. Markdown is renderable, source is literal UTF-8/base64 and must never
 *  cross a Markdown renderer, and gap means no historical bytes were captured. */
const NoteRevisionDetailBaseSchema = NoteRevisionSchema.extend({ tags: z.array(z.string()) })

export const NoteRevisionMarkdownDetailSchema = NoteRevisionDetailBaseSchema.extend({
  contentMode: z.literal('markdown'),
  content: z.string(),
  /** Exact authored source for full rows, canonical compatibility Markdown for
   * markdown-v1, null for old body-only rows. */
  snapshot: z.string().nullable(),
})

/** Literal historical source. UTF-8 stays byte-exact text; arbitrary bytes use
 * base64. Consumers must show this as plain source, never rendered Markdown. */
export const LiteralSourceSchema = z.object({
  encoding: z.enum(['utf8', 'base64']),
  data: z.string(),
})

export const NoteRevisionSourceDetailSchema = NoteRevisionDetailBaseSchema.extend({
  contentMode: z.literal('source'),
  content: z.null(),
  snapshot: z.null(),
  source: LiteralSourceSchema,
})

export const NoteRevisionGapDetailSchema = NoteRevisionDetailBaseSchema.extend({
  contentMode: z.literal('gap'),
  content: z.null(),
  snapshot: z.null(),
})

export const NoteRevisionDetailResponseSchema = z.discriminatedUnion('contentMode', [
  NoteRevisionMarkdownDetailSchema,
  NoteRevisionSourceDetailSchema,
  NoteRevisionGapDetailSchema,
])

/** POST /api/note/restore: strict, idempotent single-note restore. */
export const RestoreRequestSchema = z.object({
  id: z.string(),
  revisionId: z.string(),
  versionToken: z.string(),
  idempotencyKey: z.string().min(1).max(200),
})

export const RestorePendingPhaseSchema = z.enum([
  'staged',
  'prepared',
  'physical-published',
  'failed-recoverable',
])

export const RestoreSucceededResponseSchema = z.object({
  status: z.literal('succeeded'),
  operationId: z.string(),
  revisionId: z.string(),
  id: z.string(),
  filePath: z.string(),
  versionToken: z.string(),
})

export const RestorePendingResponseSchema = z.object({
  status: z.literal('pending'),
  operationId: z.string(),
  phase: RestorePendingPhaseSchema,
})

/** Stable machine reasons emitted by the strict single-note coordinator. */
export const RestoreConflictReasonSchema = z.enum([
  'idempotency-conflict',
  'source-or-identity-changed',
  'revision-head-missing',
  'restore-target-changed',
  'physical-target-changed',
  'version-conflict',
])

export const RestoreConflictResponseSchema = z.object({
  status: z.literal('conflict'),
  error: z.string(),
  operationId: z.string(),
  reason: RestoreConflictReasonSchema,
})

export const RestoreNotRestorableResponseSchema = z.object({
  status: z.literal('not-restorable'),
  error: z.string(),
  operationId: z.string(),
  reason: z.string(),
})

export const RestoreBusyResponseSchema = z.object({
  status: z.literal('busy'),
  error: z.string(),
  reason: z.string(),
})

export const RestoreResponseSchema = z.discriminatedUnion('status', [
  RestoreSucceededResponseSchema,
  RestorePendingResponseSchema,
  RestoreConflictResponseSchema,
  RestoreNotRestorableResponseSchema,
  RestoreBusyResponseSchema,
])

export type NoteRevision = z.infer<typeof NoteRevisionSchema>

export type NoteRevisionsQuery = z.infer<typeof NoteRevisionsQuerySchema>

export type NoteRevisionsResponse = z.infer<typeof NoteRevisionsResponseSchema>

export type NoteRevisionDetail = z.infer<typeof NoteRevisionDetailResponseSchema>

export type RestoreRequest = z.infer<typeof RestoreRequestSchema>

export type RestoreResponse = z.infer<typeof RestoreResponseSchema>
