import { z } from 'zod'
import { AuthorSchema, IsoTimestampSchema, RevisionKindSchema } from '../../primitives'

/** One agent-memory CATEGORY as the personal section lists it: a
 *  derived index entry decorated with journal provenance — WHO last wrote
 *  it and WHEN. Read/edit/delete by `noteId` via the ordinary id-routes: direct
 *  read is NOT visibility-scoped, because the user owns their own memory.
 *  canon: docs/architecture.md#p14 */
export const MemoryCategorySchema = z.object({
  noteId: z.string(),
  /** = the memory note's title. */
  category: z.string(),
  /** One-line digest: the note's frontmatter `summary`, or a content snippet
   *  when none was recorded. */
  summary: z.string(),
  /** Token weight estimated over the SUMMARY, not the full body: the
   *  summary is what start_session eager-loads, so it's the honest session cost. */
  tokens: z.number(),
  /** Human-set opt-out: true = MUTED — still shown in this audit, but
   *  dropped from the agent's eager profile (start_session). Default false. */
  muted: z.boolean(),
  modifiedAt: IsoTimestampSchema,
  /** Latest writer ('ui' | 'pat:<user>:<id>' | …) and revision kind; null = no
   *  journal row for this note. `author` = the privacy-filtered display twin of
   *  `principal`. */
  principal: z.string().nullable(),
  author: AuthorSchema.nullable(),
  kind: RevisionKindSchema.nullable(),
})

/** GET /api/me/memory — every agent-memory category in the caller's personal
 *  domain, newest-write first. Empty list = BOTH "nothing remembered" and "no
 *  personal domain yet" (read never mints one) — same honest empty either way. */
export const MeMemoryResponseSchema = z.object({
  categories: z.array(MemoryCategorySchema),
})

/** GET /api/s/<slug>/projects/<id>/memory — the about-PROJECT axis, the
 *  space-scoped twin of /api/me/memory: same MemoryCategory shape, but authz is
 *  `space:read` (a member's audit), not `self:read`. An unknown id or one owned
 *  by another space answers the SAME 404 (anti-enumeration). Empty list =
 *  nothing recorded about this project yet (honest empty, not an error).
 *  canon: docs/architecture.md#p14 */
export const ProjectMemoryResponseSchema = z.object({
  categories: z.array(MemoryCategorySchema),
})

export type MemoryCategory = z.infer<typeof MemoryCategorySchema>

export type MeMemory = z.infer<typeof MeMemoryResponseSchema>

export type ProjectMemory = z.infer<typeof ProjectMemoryResponseSchema>
