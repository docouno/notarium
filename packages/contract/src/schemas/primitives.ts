import { z } from 'zod'
import {
  AUTHOR_KIND,
  NOTE_CLASS,
  PROJECT_STATUS,
  REVISION_KIND,
  REVISION_UNAVAILABLE_REASON,
} from '../consts/primitives'
import { enumValues } from '../libs/enumValues'

export const isWellFormedUnicode = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i)

    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i)

      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false
    }
  }

  return true
}

/** A UTF-8-persistable text value. Newlines/tabs are valid document content. */
export const DurableTextSchema = z.string().refine(
  (value) =>
    isWellFormedUnicode(value) &&
    // Intentional C0/C1 ranges: these are the exact non-text controls rejected at ingress.
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value),
  'must contain well-formed Unicode and no binary control characters',
)

/** One durable identity/path/frontmatter scalar: never a physical line break. */
export const DurableScalarSchema = DurableTextSchema.refine(
  (value) => !/[\r\n\u0085\u2028\u2029]/u.test(value),
  'must be a single-line string',
)

export const DurableNonEmptyTextSchema = DurableTextSchema.refine(
  (value) => value.length > 0,
  'must not be empty',
)

export const DurableNonEmptyScalarSchema = DurableScalarSchema.refine(
  (value) => value.length > 0,
  'must not be empty',
)

/** A persisted human-facing label. It is a scalar because project markers and
 *  registry rows must agree on the exact value across re-clone/recovery, and it
 *  is bounded to keep every write surface from amplifying metadata storage. */
export const DurableDisplayNameSchema = DurableNonEmptyScalarSchema.refine(
  (value) => value.trim().length > 0,
  'must not be blank',
).refine((value) => value.length <= 200, 'must contain at most 200 characters')

const utf8Bytes = (value: string): number => {
  let bytes = 0

  for (const char of value) {
    const codePoint = char.codePointAt(0)!
    bytes += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4
  }

  return bytes
}

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu
const portablePathComponent = (value: string): boolean =>
  value.length > 0 &&
  utf8Bytes(value) <= 255 &&
  !/[\\/<>:"|?*]/u.test(value) &&
  !/[. ]$/u.test(value) &&
  !WINDOWS_DEVICE_NAME.test(value)

const portableRelativePath = (value: string): boolean => {
  const raw = value.replaceAll('\\', '/')

  if (raw.startsWith('/')) {
    return false
  }

  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') {
      continue
    }
    if (segment === '..' || segment.startsWith('.') || !portablePathComponent(segment)) {
      return false
    }
  }

  return true
}

const durableRelativeAddress = (value: string): boolean => {
  const raw = value

  if (raw.startsWith('/')) {
    return false
  }

  return raw
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .every((segment) => segment !== '..' && !segment.startsWith('.'))
}

export const DurablePathSchema = DurableScalarSchema.refine(
  portableRelativePath,
  'must be a public relative path whose components are portable and fit in 255 UTF-8 bytes',
)

export const DurableNonEmptyPathSchema = DurablePathSchema.refine(
  (value) => value.length > 0,
  'must not be empty',
)

/** Structural address for an existing public entry. It accepts legacy
 * POSIX-only components so paths returned by list/tree can be fed back into
 * read/move/delete; the engine separately fences every newly-created component. */
export const DurableAddressPathSchema = DurableScalarSchema.refine(
  durableRelativeAddress,
  'must be a public relative path without traversal',
)

export const DurableNonEmptyAddressPathSchema = DurableAddressPathSchema.refine(
  (value) => value.length > 0,
  'must not be empty',
)

export const PortablePathComponentSchema = DurableNonEmptyScalarSchema.refine(
  portablePathComponent,
  'must be a portable path component that fits in 255 UTF-8 bytes',
)

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
  // `asciiSlug`/`idToSlug` (they trim separator edges). `asciiSlug`, NOT `slugify`:
  // the latter is the NAME axis and keeps the letters of a script it cannot romanise
  // (#296), which this regex rejects — a handle derived with it would fail at the wire
  // instead of falling back to an id-shaped one.
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
/** A journal GAP marker (#327). Present ONLY on a sanitized entry: its payload,
 *  attribution and chain links are withheld because a cross-space id collision
 *  contaminated the note's history. Every surface that can carry a revision
 *  carries this field optionally, so the addition is backwards-compatible. */
export const RevisionUnavailableReasonSchema = z.enum(enumValues(REVISION_UNAVAILABLE_REASON))
/** Project lifecycle: active projects fill the default lists; archived ones stay
 *  addressable but drop out (archive-not-delete — agent delete does not exist, C1). */
export const ProjectStatusSchema = z.enum(enumValues(PROJECT_STATUS))
