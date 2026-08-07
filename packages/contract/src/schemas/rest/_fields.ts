import { z } from 'zod'
import { DurableAddressPathSchema, DurableScalarSchema, DurableTextSchema } from '../primitives'

export const noteWriteFields = {
  /** Optional: a note's title is a PROJECTION of its body (the leading
   *  `# H1`). The web editor omits this field entirely and authors the title as the
   *  document's first line; the server derives it at the write chokepoint. A present
   *  value is still honoured as an explicit title (and a leading duplicate `# title`
   *  in the body is peeled off), but no client need send it. */
  title: DurableScalarSchema.optional(),
  content: DurableTextSchema.optional(),
  /** Untrusted storage path — the server normalises and rejects traversal
   *  (`..`/absolute) BEFORE the engine sees it (security spec). */
  directory: DurableAddressPathSchema.optional(),
  noteType: DurableScalarSchema.optional(),
  tags: z.union([z.array(DurableScalarSchema), DurableScalarSchema]).optional(),
  /** The editable display slug the user typed — three-state like the
   *  domain WriteInput: absent LEAVES the file's `slug:` untouched, a string SETS
   *  it (cleaned + kept only when it diverges from slug(title)), `''` CLEARS a
   *  custom slug. The server passes it straight to WriteInput.slug. */
  slug: DurableScalarSchema.optional(),
  /** Authored creation instant: the date-as-data axis the user edits in the
   *  metadata aside to correct historicity (an imported note, a migration). A FULL
   *  ISO-8601 datetime — this REST channel carries (and STRICTLY validates) minute
   *  precision, so a future time-of-day UI lands an exact instant, even though today's
   *  picker only sets a calendar day (the client builds local-midnight). Absent LEAVES
   *  the note's existing `created:` untouched (a normal body save never restamps it);
   *  a value SETS/overwrites it. `modified` is NOT editable — it stays the real mtime
   *  signal. The DOMAIN channel is shared with the agent `create_note.createdAt`
   *  (WriteInput.createdAt), but that MCP tool validates its own input — this
   *  strict datetime guard is REST-only. */
  createdAt: z.string().datetime({ offset: true }).optional(),
}
