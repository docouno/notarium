import { z } from 'zod'
import { AUTHOR_KIND, NOTE_CLASS, PROJECT_STATUS, REVISION_KIND } from '../consts/primitives'
import { enumValues } from '../libs/enumValues'

/** Full ISO-8601 UTC timestamp, or null when the engine honestly doesn't know.
 *  canon: docs/contract.md#wire-v2 */
export const IsoTimestampSchema = z.string().nullable()

/** A space's HANDLE on the wire and in URLs: a URL-safe slug. Mutable — the
 *  stable identity is an opaque `id`; renaming retires the slug into alias history.
 *  canon: docs/note-model.md#note-ontology */
export const SpaceSlugSchema = z
  .string()
  .min(1)
  .max(64)
  // Underscore is a legal handle char: it appears in note-ids (the fallback
  // handle for a non-romanisable name). Edges stay alphanumeric, matching core
  // `slugify`/`idToSlug` (they trim separator edges).
  .regex(
    /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/,
    'lowercase alphanumeric with inner dashes or underscores',
  )

/** A note's CLASS: mount-derived, server-enforced, never client-set. On the wire a
 *  READ-ONLY label — does NOT itself carry the visibility invariant. Optional: absent on a
 *  bare engine that doesn't classify (P5).
 *  canon: docs/architecture.md#p11 · docs/note-model.md#note-classes */
export const NoteClassSchema = z.enum(enumValues(NOTE_CLASS))

/** A journal writer, RESOLVED for display and PRIVACY-FILTERED server-side
 *  — wherever a raw `principal` (`pat:<user>:<id>` | `user:<name>` | `ui`)
 *  surfaces to a human (note history, agent memory, a deleted note's banner),
 *  the server also sends this. The viewer never has to parse a principal or sees
 *  a name it shouldn't:
 *  - `kind` — `agent` (a PAT), `user` (a human), `system`, `external` (no journal).
 *  - `name` — the DISPLAY name: the viewer's OWN key name (they own it), or
 *    another user's USERNAME (never another user's key name — privacy). null =
 *    anonymous (mode-none UI, system, external).
 *  - `mine` — is this the viewer's own action/agent? Drives "you" / "your agent X"
 *    vs "<name>" / "<name>'s agent". The wording lives in the client (i18n). */
export const AuthorKindSchema = z.enum(enumValues(AUTHOR_KIND))

export const AuthorSchema = z.object({
  kind: AuthorKindSchema,
  name: z.string().nullable(),
  mine: z.boolean(),
})
export type Author = z.infer<typeof AuthorSchema>

export const RevisionKindSchema = z.enum(enumValues(REVISION_KIND))
/** Project lifecycle: active projects fill the default lists; archived ones stay
 *  addressable but drop out (archive-not-delete — agent delete does not exist, C1). */
export const ProjectStatusSchema = z.enum(enumValues(PROJECT_STATUS))
