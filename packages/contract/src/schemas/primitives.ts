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

/** The positional half of the durable-text fence, duplicated from core `libs/id`
 *  exactly like `isWellFormedUnicode` above: the P8 seam keeps this package free of a
 *  core dependency, and `test/primitiveParity.test.ts` holds the two copies together.
 *  One pass by contract: "first" is the smallest UTF-16 index regardless of kind. */
export type DurableTextViolation = {
  kind: 'control' | 'surrogate'
  codePoint: number
  /** 0-based UTF-16 index in the value. */
  index: number
  /** 1-based; lines are cut by `\n` only — a lone CR is legal content, not a break. */
  line: number
  /** 1-based, counted in code points within the line. */
  column: number
  /** Violations of the SAME kind in the whole value. */
  total: number
}

export const firstDurableTextViolation = (value: string): DurableTextViolation | null => {
  let first: DurableTextViolation | null = null
  let line = 1
  let column = 1

  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    let kind: DurableTextViolation['kind'] | null = null

    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)

      if (next >= 0xdc00 && next <= 0xdfff) {
        index++
        column++
        continue
      }
      kind = 'surrogate'
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      kind = 'surrogate'
    } else if (
      unit <= 0x08 ||
      unit === 0x0b ||
      unit === 0x0c ||
      (unit >= 0x0e && unit <= 0x1f) ||
      (unit >= 0x7f && unit <= 0x9f)
    ) {
      kind = 'control'
    }
    if (kind) {
      if (first == null) {
        first = { kind, codePoint: unit, index, line, column, total: 1 }
      } else if (first.kind === kind) {
        first.total++
      }
      column++
      continue
    }
    if (unit === 0x0a) {
      line++
      column = 1
    } else {
      column++
    }
  }

  return first
}

/** Predicate grammar — no field name: zod's issue `path` carries the field, and the
 *  same schema serves body-sized text and one-line scalars, so the position always
 *  names line AND column in the submitted value. */
const violationMessage = (violation: DurableTextViolation): string => {
  const codePoint = `U+${violation.codePoint.toString(16).toUpperCase().padStart(4, '0')}`
  const noun = violation.kind === 'control' ? 'a control character' : 'an unpaired UTF-16 surrogate'
  const more = violation.total > 1 ? `; ${violation.total - 1} more` : ''

  return `must not contain ${noun} (${codePoint} at line ${violation.line}, column ${violation.column}${more})`
}

/** A UTF-8-persistable text value. Newlines/tabs are valid document content. */
export const DurableTextSchema = z.string().superRefine((value, ctx) => {
  const violation = firstDurableTextViolation(value)

  if (violation) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: violationMessage(violation) })
  }
})

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

export const FieldValueSchema = z.union([
  DurableScalarSchema,
  z.array(DurableScalarSchema),
  z.null(),
])

/** Parse a JSON object without assigning through Object.prototype. Zod's record
 * parser writes into a normal object and silently loses an own `__proto__`; read
 * contracts are open-world file projections, so they must preserve every own key.
 * Write ingress keeps its separate explicit rejection policy below. */
export const prototypeSafeRecord = <Schema extends z.ZodTypeAny>(schema: Schema) =>
  z.unknown().transform((value, ctx): Record<string, z.output<Schema>> => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected object record' })
      return Object.create(null) as Record<string, z.output<Schema>>
    }
    const result = Object.create(null) as Record<string, z.output<Schema>>

    for (const key of Object.getOwnPropertyNames(value)) {
      const parsed = schema.safeParse((value as Record<string, unknown>)[key])

      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({ ...issue, path: [key, ...issue.path] })
        }
      } else {
        result[key] = parsed.data
      }
    }

    return result
  })

const PROTO_REJECTION_KEY = '__proto__ (unsupported field key)'

/** z.record assigns through ordinary object properties and silently loses an
 * own `__proto__`. Rewrite that raw key to an invalid value so the transport
 * rejects it explicitly; host-internal store callers remain able to address it. */
export const FieldPatchSchema = z.preprocess(
  (value) => {
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !Object.hasOwn(value, '__proto__')
    ) {
      return value
    }
    const rejected = Object.create(null) as Record<string, unknown>

    for (const key of Object.getOwnPropertyNames(value)) {
      if (key !== '__proto__') {
        rejected[key] = (value as Record<string, unknown>)[key]
      }
    }
    rejected[PROTO_REJECTION_KEY] = { error: 'unsupported field key __proto__' }
    return rejected
  },
  z.record(DurableScalarSchema, FieldValueSchema),
)

export type FieldPatch = z.infer<typeof FieldPatchSchema>

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
