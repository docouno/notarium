import { z } from 'zod'
import { DurableScalarSchema, IsoTimestampSchema, NoteClassSchema } from '../primitives'

/** One search hit — always a known note: the identity layer maps every engine
 *  hit onto a note-id and drops the ones it can't place. Note references are ids only,
 *  never a path-shaped open channel.
 *  canon: docs/architecture.md#p7 */
export const SearchResultSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  filePath: z.string().optional(),
  /** The note's real modification signal (mtime/journal) — the quick-jump
   *  surfaces use it as the fallback date when the note has no authored
   *  creation date. */
  modifiedAt: IsoTimestampSchema,
  /** The note's authored creation instant — a stable historical signal
   *  the quick-jump surfaces can show without an extra notes fetch. */
  createdAt: IsoTimestampSchema,
  score: z.number().optional(),
  snippet: z.string(),
  /** Decorative note type label (frontmatter `type:` / write `noteType`) — free-form.
   *  Optional: absent means the note stays on the implicit default `note`
   *  (@notarium/core `DEFAULT_NOTE_TYPE`). */
  noteType: z.string().optional(),
  /** Dedicated view marker for Spotlight/search discovery; never runtime authority. */
  viewType: DurableScalarSchema.optional(),
  /** Decorative engine-supplied hit kind — NOT the model class and not the
   *  noteType badge. Kept for back-compat; usually `note`. */
  type: z.string().optional(),
  /** The note's class — READ-ONLY label. User search only returns classes with
   *  `userSearch=✓` (agent-memory excluded here, reachable to agents via `recall`).
   *  canon: docs/note-model.md#note-classes */
  class: NoteClassSchema.optional(),
})

export const SearchResponseSchema = z.object({ results: z.array(SearchResultSchema) })

export type SearchResult = z.infer<typeof SearchResultSchema>
