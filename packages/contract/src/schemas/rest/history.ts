import { z } from 'zod'
import { AuthorSchema, RevisionKindSchema } from '../primitives'

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

/** GET /api/note/revision?id&revisionId — one revision with its body.
 *  `content: null` mirrors `contentHash: null` (the honest gap). */
export const NoteRevisionDetailResponseSchema = NoteRevisionSchema.extend({
  content: z.string().nullable(),
  tags: z.array(z.string()),
})

/** POST /api/note/restore: write `revisionId`'s state back over the live
 *  note. `versionToken` is the same CAS proof a save carries — a stale
 *  one 409s with ConflictResponse, nothing is overwritten silently. Answers
 *  with SaveResponse (a restore IS a save). */
export const RestoreRequestSchema = z.object({
  id: z.string(),
  revisionId: z.string(),
  versionToken: z.string(),
})

export type NoteRevision = z.infer<typeof NoteRevisionSchema>

export type NoteRevisionsQuery = z.infer<typeof NoteRevisionsQuerySchema>

export type NoteRevisionsResponse = z.infer<typeof NoteRevisionsResponseSchema>

export type NoteRevisionDetail = z.infer<typeof NoteRevisionDetailResponseSchema>

export type RestoreRequest = z.infer<typeof RestoreRequestSchema>
