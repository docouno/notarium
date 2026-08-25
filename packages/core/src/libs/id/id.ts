// The internal note-id (P7): a short URL-safe random string that lives in the
// note's frontmatter and in the identity registry. 12 chars over a 64-symbol
// alphabet = 72 bits — collisions are out of the picture even at millions of
// notes. Web-crypto based so the same code runs in Node hosts and (if ever
// needed) the browser; no dependency.

import { NOTE_ID_LENGTH } from './consts'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'
const ALPHABET_SET = new Set(ALPHABET)

/** JavaScript strings may contain isolated UTF-16 surrogates even though neither
 *  UTF-8 nor URI encoding can represent them. Never let such a value become a
 *  durable identity/path and silently round-trip as U+FFFD. */
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

/** Text that can be persisted as UTF-8 without silent substitution. Markdown
 *  keeps tabs/newlines; NUL and the remaining C0 controls are not content. */
export const isDurableText = (value: string): boolean =>
  isWellFormedUnicode(value) &&
  // Intentional C0/C1 ranges: these are the exact non-text controls rejected at ingress.
  // eslint-disable-next-line no-control-regex
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)

export type DurableTextViolation = {
  kind: 'control' | 'surrogate'
  /** The violating code point (for an unpaired surrogate, the lone UTF-16 unit). */
  codePoint: number
  /** 0-based UTF-16 index in the value. */
  index: number
  /** 1-based. Lines are cut by `\n` ONLY: a lone CR is content `isDurableText`
   *  accepts, so treating it as a break would move the coordinate of a legal byte. */
  line: number
  /** 1-based, counted in CODE POINTS within the line. */
  column: number
  /** How many violations of the SAME kind the whole value carries. */
  total: number
}

/** Locate what `isDurableText` refused — on the refusal path only, so `isDurableText`
 *  itself stays the fast per-write predicate and never delegates here. One pass, and
 *  that is contract, not detail: "first" means the smallest UTF-16 index REGARDLESS of
 *  kind — a per-kind scan names the wrong violator whenever a surrogate precedes a
 *  control. */
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
        // A well-formed pair: one astral code point, two units, one column.
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

/** One YAML/path/identity scalar. Unicode line separators count as line breaks
 *  even though ordinary `/\r?\n/` checks miss them. */
export const isDurableScalar = (value: string): boolean =>
  isDurableText(value) && !/[\r\n\u0085\u2028\u2029]/u.test(value)

/** Transport syntax prefix. Raw opaque ids may themselves start with it: their
 * canonical envelope percent-encodes the nested colon, while resolver context
 * distinguishes ordinary id/storage reads from authored wikilinks. */
export const RESERVED_NOTE_ID_PREFIX = 'notarium-id:'

export const isValidNoteId = (value: string): boolean => value.length > 0 && isDurableScalar(value)

/** Exact storage-address form minted by freshNoteId(). The broader note-id
 * domain also accepts imported opaque ids, which are not safe path components. */
export const isGeneratedNoteId = (value: string): boolean =>
  value.length === NOTE_ID_LENGTH && [...value].every((char) => ALPHABET_SET.has(char))

export const freshNoteId = (size = NOTE_ID_LENGTH): string => {
  const bytes = new Uint8Array(size)
  crypto.getRandomValues(bytes)
  let id = ''

  // 64 symbols exactly → masking has no modulo bias.
  for (let i = 0; i < size; i++) {
    id += ALPHABET[bytes[i] & 63]
  }

  return id
}
