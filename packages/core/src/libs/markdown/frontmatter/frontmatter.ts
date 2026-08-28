// The ONE frontmatter reader/writer. Line-based, not a YAML parser: top-level
// scalars and block lists are understood, anything fancier (nested maps, anchors)
// is carried VERBATIM as the owning entry's continuation lines. Preservation is
// the point — a key we don't model survives a rewrite byte-for-byte, which is
// what lets a note be co-owned by us and its author (#69), and what lets an
// IMPORTED file keep its own frontmatter (#280).
//
// It lives in core because both sides need it and core is the lower tier: the
// engine's file parse/serialize (`engine/notariumStore/noteFile.ts`) and the
// importer (`core/importer/formats/markdown.ts`). They used to carry separate
// copies of this parsing, and the divergence was a real bug (see unquoteScalar).

import { isDurableScalar } from '../../id'
import { normTags } from '../../tags'
import { FrontmatterGeometryError } from './frontmatterGeometryError'

/**
 * Cut a leading YAML frontmatter block off a markdown document — the cheap strip, for
 * previews/metrics/exports that only need the prose. It cuts exactly the block
 * `parseFrontmatterBlock` reads and nothing else, so a `---` the domain calls a thematic
 * break stays in the prose around it. Use the parser when the entries themselves matter.
 * An oversized block degrades to "no block": every caller here renders text and has no
 * failure branch to take.
 */
export const stripFrontmatter = (content: string): string => {
  const raw = content || ''

  try {
    const block = parseFrontmatterBlock(raw)
    return block ? raw.slice(block.bodyStart) : raw
  } catch (error) {
    // Only the budget refusal degrades. Anything else is a real fault in the parser, and
    // swallowing it here would hide it behind a document that merely looks block-less.
    if (error instanceof FrontmatterLimitError) {
      return raw
    }

    throw error
  }
}

/** One frontmatter entry as RAW lines. `key` is null for passthrough lines the
 *  parser doesn't model (a comment at column 0) — they re-emit verbatim. Keeping
 *  the lines rather than a parsed value is deliberate: it is what makes an
 *  unmodelled key (a nested map, a plugin's own field) survive a rewrite. */
export type FrontmatterEntry = { key: string | null; lines: string[] }

/** Reserved date projection used only when an authored, unreadable `created:`
 *  must survive verbatim while the note still needs a resolved source-mtime.
 *  Keeping the two claims under distinct keys preserves valid YAML; normal notes
 *  continue to use the public `created:` convention. */
export const CREATED_FALLBACK_FRONTMATTER_KEY = 'notarium-created'

export type FrontmatterBlock = {
  entries: FrontmatterEntry[]
  /** Offset just past the closing delimiter line — where the body starts. */
  bodyStart: number
}

/** The opening delimiter, at byte 0 (a BOM aside). Strict on purpose: YAML
 *  frontmatter is frontmatter only on the FIRST line — a `---` further down is a
 *  thematic break, and requiring the closing `---` keeps a lone rule from being
 *  mistaken for an unterminated block. */
const FM_OPEN = /^\uFEFF?---\r?\n/
const COLUMN_COMMENT = /^#/
const isYamlHorizontal = (char: string | undefined): boolean => char === ' ' || char === '\t'

const yamlIndent = (line: string): number => {
  let indent = 0

  while (line[indent] === ' ') {
    indent++
  }

  return indent
}

const isYamlBlank = (line: string): boolean => {
  for (let i = 0; i < line.length; i++) {
    if (!isYamlHorizontal(line[i])) {
      return false
    }
  }

  return true
}

const trimYamlHorizontalStart = (value: string): string => {
  let start = 0

  while (isYamlHorizontal(value[start])) {
    start++
  }

  return value.slice(start)
}

const trimYamlHorizontalEnd = (value: string): string => {
  let end = value.length

  while (end > 0 && isYamlHorizontal(value[end - 1])) {
    end--
  }

  return value.slice(0, end)
}
const trimYamlHorizontal = (value: string): string =>
  trimYamlHorizontalEnd(trimYamlHorizontalStart(value))
// Indentation is optional: flush-left `- item` is exactly the YAML our own
// serializer writes — requiring leading whitespace silently dropped every real
// tag list (caught live on the stand).
const LIST_ITEM = /^( *)-[ \t]+(.*)$/
/** A YAML block-scalar header. The indentation and chomping indicators are both
 *  optional and YAML permits either order (`|2-` and `|-2`). Indentation is one
 *  digit, 1–9 — accepting arbitrary digit runs would turn a malformed scalar into
 *  a value we claim to understand and then remove from the verbatim carry. */
const BLOCK_SCALAR = /^[|>](?:(?:[1-9][+-]?)|(?:[+-][1-9]?))?$/
// Ownership is a little wider than projection: YAML permits an inline comment
// after a valid block-scalar header. We still conservatively decline to PROJECT
// that annotated value below, but must recognise its physical lines as scalar
// content or blank lines disappear from the verbatim carry.
const BLOCK_SCALAR_OWNER = /^[|>](?:(?:[1-9][+-]?)|(?:[+-][1-9]?))?(?:[ \t]*|[ \t]+#.*)$/

type YamlNodeProperties = {
  anchor: boolean
  tag: boolean
  rest: string
}

/** Split the node properties YAML permits before a value (`&anchor`, `!tag`) from
 *  that value. This is intentionally narrower than a YAML parser: properties must
 *  be standalone, horizontally separated tokens, with at most one anchor and one
 *  tag. That is exactly the distinction ownership needs — `&a |` / `!!seq` leave
 *  the value slot open, while `&a text` already contains a scalar value. */
const leadingYamlNodeProperties = (inline: string): YamlNodeProperties | null => {
  let cursor = 0
  let anchor = false
  let tag = false

  while (inline[cursor] === ' ' || inline[cursor] === '\t') {
    cursor++
  }
  while (inline[cursor] === '&' || inline[cursor] === '!') {
    const indicator = inline[cursor]

    if ((indicator === '&' && anchor) || (indicator === '!' && tag)) {
      return null
    }
    if (indicator === '&') {
      const nameStart = ++cursor

      while (
        cursor < inline.length &&
        inline[cursor] !== ' ' &&
        inline[cursor] !== '\t' &&
        !'[]{},'.includes(inline[cursor])
      ) {
        cursor++
      }
      if (cursor === nameStart) {
        return null
      }
      anchor = true
    } else if (inline[cursor + 1] === '<') {
      const close = inline.indexOf('>', cursor + 2)

      if (close === -1 || close === cursor + 2) {
        return null
      }
      cursor = close + 1
      tag = true
    } else {
      cursor++ // `!` itself is a valid non-specific tag.
      while (
        cursor < inline.length &&
        inline[cursor] !== ' ' &&
        inline[cursor] !== '\t' &&
        !'[]{},'.includes(inline[cursor])
      ) {
        cursor++
      }
      tag = true
    }
    if (cursor < inline.length && inline[cursor] !== ' ' && inline[cursor] !== '\t') {
      return null
    }
    while (inline[cursor] === ' ' || inline[cursor] === '\t') {
      cursor++
    }
  }

  return { anchor, tag, rest: inline.slice(cursor) }
}

const isBlockScalarOwnerInline = (inline: string): boolean => {
  const properties = leadingYamlNodeProperties(inline)
  return Boolean(properties && BLOCK_SCALAR_OWNER.test(properties.rest))
}

type PlainMappingLine = { key: string; inline: string }

/** A conservative top-level PLAIN mapping key. YAML keys are Unicode strings and
 *  may contain spaces; treating only ASCII identifiers as keys turned ordinary
 *  `review owner:` / `автор:` properties into unsafe keyless structure. Quoted and
 *  explicit keys remain unsupported, as do merge/document/directive indicators.
 *
 *  The first colon followed by separation whitespace (or end-of-line) is the YAML
 *  key/value separator. A colon inside a plain key is therefore safe when it is
 *  not followed by whitespace (`https://example: note`). */
const isSafePlainMappingKey = (key: string): boolean => {
  if (
    !key ||
    key !== trimYamlHorizontal(key) ||
    !isDurableScalar(key) ||
    key === '<<' ||
    /^(?:---|\.\.\.)(?:[ \t]|$)/.test(key) ||
    /^[!&*#|>@`"'%]/.test(key) ||
    /[{}[\],]/.test(key) ||
    /^(?:-|\?|:)[ \t]/.test(key)
  ) {
    return false
  }

  for (let i = 0; i < key.length; i++) {
    if (key[i] === '#' && (i === 0 || /[ \t]/.test(key[i - 1]))) {
      return false
    }
  }

  return true
}

const plainMappingLine = (line: string): PlainMappingLine | null => {
  if (!line || /^[ \t]/.test(line)) {
    return null
  }

  for (let i = 0; i < line.length; i++) {
    if (line[i] !== ':' || (i + 1 < line.length && line[i + 1] !== ' ' && line[i + 1] !== '\t')) {
      continue
    }
    const key = trimYamlHorizontalEnd(line.slice(0, i))

    if (!isSafePlainMappingKey(key)) {
      return null
    }

    return { key, inline: trimYamlHorizontalStart(line.slice(i + 1)) }
  }

  return null
}

// An inline YAML comment does not occupy the value slot: `tags: # authored`
// may still own the indentless sequence on the following line.
const isEmptyInlineListOwner = (inline: string): boolean => {
  const properties = leadingYamlNodeProperties(inline)
  return Boolean(properties && (properties.rest === '' || COLUMN_COMMENT.test(properties.rest)))
}

/** Maximum UTF-8 bytes between a note's frontmatter fences. Metadata should be
 *  small; bounding it at 64 KiB prevents a hostile leading block from becoming
 *  several simultaneous full-size strings plus a line array during parsing. The
 *  markdown body after the closing fence is deliberately outside this limit. */
export const FRONTMATTER_BYTE_CAP = 64 * 1024

/** A confirmed frontmatter block exceeded the metadata budget. Typed separately
 *  from malformed/absent frontmatter so import boundaries can classify the same
 *  deterministic bad upload as terminal while ordinary file readers retain the
 *  precise cause. */
export class FrontmatterLimitError extends Error {
  constructor() {
    super(`frontmatter exceeds the ${FRONTMATTER_BYTE_CAP / 1024} KiB limit`)
    this.name = 'FrontmatterLimitError'
  }
}

/** UTF-8 byte count without allocating an encoded copy. Lone surrogates count as
 *  TextEncoder's replacement sequence; callers that require durability reject
 *  them separately. */
const utf8Bytes = (value: string): number => {
  let bytes = 0

  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)

    if (code <= 0x7f) {
      bytes++
    } else if (code <= 0x7ff) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1)

      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        i++
      } else {
        bytes += 3
      }
    } else {
      bytes += 3
    }
  }

  return bytes
}

/** Whether a bare frontmatter payload fits the parser's metadata budget. Exposed
 *  for snapshot fixtures that receive the YAML without document fences and must
 *  reject it before wrapping/parsing it. */
export const isWithinFrontmatterByteCap = (value: string): boolean => {
  let bytes = 0

  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)

    if (code <= 0x7f) {
      bytes++
    } else if (code <= 0x7ff) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1)

      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        i++
      } else {
        bytes += 3
      }
    } else {
      bytes += 3
    }
    if (bytes > FRONTMATTER_BYTE_CAP) {
      return false
    }
  }

  return true
}

/** End offset of a closing fence at this physical-line start, or -1. */
const closingFenceEndAt = (content: string, start: number): number => {
  if (content[start] !== '-' || content[start + 1] !== '-' || content[start + 2] !== '-') {
    return -1
  }
  let i = start + 3

  while (content[i] === ' ' || content[i] === '\t') {
    i++
  }
  if (i === content.length) {
    return i
  }
  if (content[i] === '\n') {
    return i + 1
  }
  if (content[i] === '\r' && content[i + 1] === '\n') {
    return i + 2
  }

  return -1
}

const entryInline = (e: FrontmatterEntry): string | null => {
  const mapping = plainMappingLine(e.lines[0])

  return mapping?.key === e.key ? mapping.inline : null
}

type YamlNodeReferenceFlags = { anchor: boolean; alias: boolean }

/** Indentation of a block-scalar header on this line, or null. A bare `|`/`>` is
 *  a header only while the surrounding YAML node still has an empty value slot;
 *  nested mapping and sequence headers identify their own slot on the line. */
const blockScalarHeaderIndent = (line: string, allowBare: boolean): number | null => {
  const indent = yamlIndent(line)
  const body = line.slice(indent)

  if (allowBare && isBlockScalarOwnerInline(body)) {
    return indent
  }
  const sequence = /^-[ \t]+/.exec(body)

  if (sequence && isBlockScalarOwnerInline(body.slice(sequence[0].length))) {
    return indent
  }
  let quote: '"' | "'" | null = null

  for (let i = 0; i < body.length; i++) {
    const ch = body[i]

    if (quote === '"') {
      if (ch === '\\') {
        i++
      } else if (ch === '"') {
        quote = null
      }
      continue
    }
    if (quote === "'") {
      if (ch === "'" && body[i + 1] === "'") {
        i++
      } else if (ch === "'") {
        quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '#' && (i === 0 || body[i - 1] === ' ' || body[i - 1] === '\t')) {
      return null
    }
    if (
      ch === ':' &&
      (i + 1 === body.length || body[i + 1] === ' ' || body[i + 1] === '\t') &&
      isBlockScalarOwnerInline(trimYamlHorizontalStart(body.slice(i + 1)))
    ) {
      return indent
    }
  }

  return null
}

/** Whether this physical line ends with a mapping node whose value slot remains
 *  empty (possibly after standalone node properties). The following indented
 *  bare block-scalar indicator may therefore own the value. */
const lineOpensBareValue = (line: string): boolean => {
  const indent = yamlIndent(line)
  const body = line.slice(indent)
  const sequence = /^-[ \t]+/.exec(body)
  const mapping = plainMappingLine(sequence ? body.slice(sequence[0].length) : body)

  return Boolean(mapping && isEmptyInlineListOwner(mapping.inline))
}

type YamlNodeLexerState = {
  quote: '"' | "'" | null
  flowDepth: number
  flowStack: Array<'[' | '{'>
  nodeStart: boolean
  /** A quoted or collection node just completed inside a flow collection. YAML's
   *  JSON-compatible mapping form permits its following `:` without separation
   *  (`{"key":&anchor value}`). A plain node does NOT: `key:&literal` remains one
   *  plain scalar, so remembering the node kind avoids rejecting authored text. */
  flowNonPlainNodeComplete: boolean
  /** Indentation where the current block plain/quoted node began. A deeper next
   *  line continues that scalar; an equal/dedented one starts fresh structure. */
  plainIndent: number | null
  blockScalarIndent: number | null
}

const newYamlNodeLexerState = (): YamlNodeLexerState => ({
  quote: null,
  flowDepth: 0,
  flowStack: [],
  nodeStart: true,
  flowNonPlainNodeComplete: false,
  plainIndent: null,
  blockScalarIndent: null,
})

/** A flow collection may close at its owning mapping key's indentation. At column
 *  zero that line would otherwise look like unsafe root structure, so ownership
 *  consults the same quote-aware flow state as the reference detector. */
const isMatchingDedentedFlowCloser = (line: string, state: YamlNodeLexerState): boolean => {
  if (state.quote !== null || state.flowDepth === 0) {
    return false
  }
  const opener = state.flowStack[state.flowStack.length - 1]

  return (opener === '[' && line[0] === ']') || (opener === '{' && line[0] === '}')
}

const yamlNodeReferencesInLine = (
  line: string,
  state: YamlNodeLexerState,
): YamlNodeReferenceFlags => {
  let anchor = false
  let alias = false
  const indent = yamlIndent(line)

  if (state.blockScalarIndent !== null) {
    if (isYamlBlank(line) || indent > state.blockScalarIndent) {
      return { anchor, alias } // literal/folded scalar CONTENT, never YAML syntax
    }
    state.blockScalarIndent = null
    state.nodeStart = true
    state.plainIndent = null
  }
  if (isYamlBlank(line)) {
    return { anchor, alias }
  }
  if (
    state.quote === null &&
    state.flowDepth === 0 &&
    !state.nodeStart &&
    state.plainIndent !== null &&
    indent <= state.plainIndent
  ) {
    state.nodeStart = true
    state.plainIndent = null
  }
  const quoteAtStart = state.quote
  const flowDepthAtStart = state.flowDepth
  const bareHeaderAllowed = state.nodeStart

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    const previous = line[i - 1]

    if (state.quote === '"') {
      if (ch === '\\') {
        i++
      } else if (ch === '"') {
        state.quote = null
        state.nodeStart = false
        state.flowNonPlainNodeComplete = state.flowDepth > 0
      }
      continue
    }
    if (state.quote === "'") {
      if (ch === "'" && line[i + 1] === "'") {
        i++
      } else if (ch === "'") {
        state.quote = null
        state.nodeStart = false
        state.flowNonPlainNodeComplete = state.flowDepth > 0
      }
      continue
    }
    if (ch === '#' && (i === 0 || previous === ' ' || previous === '\t')) {
      break // the rest is a YAML comment, not syntax
    }
    if (ch === ' ' || ch === '\t') {
      continue
    }
    if (state.nodeStart && (ch === '"' || ch === "'")) {
      state.quote = ch
      state.flowNonPlainNodeComplete = false
      if (state.flowDepth === 0) {
        state.plainIndent = indent
      }
      continue
    }
    if (state.nodeStart && (ch === '&' || ch === '*')) {
      let end = i + 1

      while (
        end < line.length &&
        line[end] !== ' ' &&
        line[end] !== '\t' &&
        !'[]{},'.includes(line[end])
      ) {
        end++
      }
      if (end > i + 1) {
        anchor ||= ch === '&'
        alias ||= ch === '*'
      }
      state.nodeStart = false
      if (state.flowDepth === 0) {
        state.plainIndent = indent
      }
      i = end - 1
      continue
    }
    if (state.nodeStart && ch === '!') {
      if (line[i + 1] === '<') {
        const close = line.indexOf('>', i + 2)

        if (close === -1) {
          state.nodeStart = false
        } else {
          i = close
        }
      } else {
        while (
          i + 1 < line.length &&
          line[i + 1] !== ' ' &&
          line[i + 1] !== '\t' &&
          !'[]{},'.includes(line[i + 1])
        ) {
          i++
        }
      }
      continue // a tag is a node property; another property/value may follow
    }
    if (
      state.nodeStart &&
      (ch === '-' || ch === '?') &&
      (line[i + 1] === ' ' || line[i + 1] === '\t')
    ) {
      continue // block sequence / explicit-key indicator; the node follows it
    }
    if (state.nodeStart && (ch === '[' || ch === '{')) {
      state.flowDepth++
      state.flowStack.push(ch)
      state.flowNonPlainNodeComplete = false
      state.plainIndent = null
      continue
    }
    if (state.flowDepth && (ch === ']' || ch === '}')) {
      state.flowDepth--
      state.flowStack.pop()
      state.nodeStart = false
      state.flowNonPlainNodeComplete = state.flowDepth > 0
      if (state.flowDepth === 0) {
        state.plainIndent = indent
      }
      continue
    }
    if (state.flowDepth && ch === ',') {
      state.nodeStart = true
      state.flowNonPlainNodeComplete = false
      state.plainIndent = null
      continue
    }
    if (
      ch === ':' &&
      (state.flowNonPlainNodeComplete ||
        i + 1 === line.length ||
        line[i + 1] === ' ' ||
        line[i + 1] === '\t' ||
        line[i + 1] === '[' ||
        line[i + 1] === '{')
    ) {
      state.nodeStart = true
      state.flowNonPlainNodeComplete = false
      state.plainIndent = null
      continue
    }
    state.flowNonPlainNodeComplete = false
    if (state.nodeStart) {
      state.nodeStart = false
      if (state.flowDepth === 0) {
        state.plainIndent = indent
      }
    }
  }

  // A block scalar cannot start while a quote/flow collection remains open. The
  // helper itself is quote-aware for a complete quoted mapping key on one line.
  if (
    quoteAtStart === null &&
    state.quote === null &&
    flowDepthAtStart === 0 &&
    state.flowDepth === 0
  ) {
    state.blockScalarIndent = blockScalarHeaderIndent(line, bareHeaderAllowed)
    if (state.blockScalarIndent !== null) {
      state.nodeStart = false
      state.plainIndent = state.blockScalarIndent
    }
  }

  return { anchor, alias }
}

const frontmatterYamlNodeReferences = (
  entries: readonly FrontmatterEntry[] | undefined,
): YamlNodeReferenceFlags => {
  let anchor = false
  let alias = false

  for (const entry of entries ?? []) {
    const state = newYamlNodeLexerState()

    for (const line of entry.lines) {
      const found = yamlNodeReferencesInLine(line, state)

      anchor ||= found.anchor
      alias ||= found.alias
      if (anchor && alias) {
        return { anchor, alias }
      }
    }
  }

  return { anchor, alias }
}

/** Whether carried raw YAML contains a structural anchor definition or alias node.
 *  Engines use this conservative signal before an overwrite whose key-based merge
 *  could delete an anchor or move its alias before it. Quoted/plain occurrences and
 *  block-scalar text are deliberately ignored. */
export const frontmatterHasYamlNodeReferences = (
  entries: readonly FrontmatterEntry[] | undefined,
): boolean => {
  const references = frontmatterYamlNodeReferences(entries)
  return references.anchor || references.alias
}

/** Whether one entry defines an anchor (as distinct from merely using an alias).
 *  Kept as the narrow projection of the shared lexer for callers that need to
 *  reason about an individual ownership slot. */
export const frontmatterEntryDefinesYamlAnchor = (entry: FrontmatterEntry): boolean =>
  frontmatterYamlNodeReferences([entry]).anchor

/** Split a document's leading frontmatter into entries; null when there is none.
 *  `bodyStart` points right after the closing delimiter line. */
export const parseFrontmatterBlock = (raw: string): FrontmatterBlock | null => {
  const open = FM_OPEN.exec(raw)

  if (!open) {
    return null
  }
  const blockStart = open[0].length
  let lineStart = blockStart
  let cursor = blockStart
  let frontmatterBytes = 0
  let frontmatterTooLarge = false
  let closeStart = -1
  let bodyStart = -1

  // Find the closing fence and count the UTF-8 prefix in the same allocation-free
  // scan. The fence is decisive: a leading `---` with NO closing fence is a
  // markdown thematic break, not an unterminated metadata block, regardless of
  // how large the body is. Therefore crossing the budget merely records the fact;
  // it throws only after a later closing fence confirms this really was
  // frontmatter. No `slice` or `split` happens on the oversized path.
  // Crucially, no `slice` or `split` happens until the cap is proven: those are the
  // operations that amplify one huge metadata prefix into multiple allocations.
  while (cursor < raw.length) {
    // Trailing horizontal whitespace on the CLOSING fence is tolerated — real
    // files carry it, and refusing it makes their raw YAML show up as note text.
    const closingEnd = cursor === lineStart ? closingFenceEndAt(raw, lineStart) : -1

    if (closingEnd !== -1) {
      if (frontmatterTooLarge) {
        throw new FrontmatterLimitError()
      }
      closeStart = lineStart
      bodyStart = closingEnd
      break
    }
    const code = raw.charCodeAt(cursor)

    if (frontmatterTooLarge) {
      // The exact byte total no longer matters, but line starts still do. Advance
      // one code unit at a time so the remainder is scanned without allocating.
      cursor++
    } else if (code <= 0x7f) {
      frontmatterBytes++
      cursor++
    } else if (code <= 0x7ff) {
      frontmatterBytes += 2
      cursor++
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = raw.charCodeAt(cursor + 1)

      if (next >= 0xdc00 && next <= 0xdfff) {
        frontmatterBytes += 4
        cursor += 2
      } else {
        frontmatterBytes += 3 // TextEncoder's replacement for an unpaired surrogate
        cursor++
      }
    } else {
      frontmatterBytes += 3
      cursor++
    }
    if (frontmatterBytes > FRONTMATTER_BYTE_CAP) {
      frontmatterTooLarge = true
    }
    if (code === 0x0a) {
      lineStart = cursor
    }
  }
  if (closeStart === -1) {
    return null
  }

  const block = raw.slice(blockStart, closeStart)
  const entries: FrontmatterEntry[] = []
  // Ordinary blanks and column-zero comments are held until the next meaningful
  // line proves whether they sit INSIDE the current continued entry. Comments
  // become keyless when it does not; ordinary separator blanks are simply not an
  // entry. Keeping one ordered run preserves exact bytes when ownership is proven.
  let pendingInterstitial: string[] = []
  // Indentation of the active block-scalar header. Unlike a boolean derived from
  // entry line 0, this follows nested/bare/list headers and knows when a dedent
  // ends their content. Every scalar blank, including trailing keep-chomp blanks,
  // is attached immediately and therefore survives EOF/dedent exactly.
  let activeBlockScalarIndent: number | null = null
  let activeBareBlockScalarCompatible = false
  let activeFlowState: YamlNodeLexerState | null = null
  // A flush-left list is legal YAML continuation only under an empty-inline key.
  // Track that shape incrementally: inspecting all prior lines for every `- item`
  // would make one long list quadratic.
  let activeFlushListCompatible = false
  let activeFlushListStarted = false

  const lines = block.split(/\r?\n/)

  const flushInterstitialAsKeyless = (): void => {
    for (const line of pendingInterstitial) {
      if (COLUMN_COMMENT.test(line)) {
        entries.push({ key: null, lines: [line] })
      }
    }
    pendingInterstitial = []
    activeBlockScalarIndent = null
    activeBareBlockScalarCompatible = false
    activeFlowState = null
    activeFlushListCompatible = false
    activeFlushListStarted = false
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]

    // `block` ends immediately before a line-start closing fence, so its final
    // line terminator produces one split artifact. It is not block-scalar data;
    // an ACTUAL blank line before the fence produces the preceding empty element
    // and is preserved below.
    if (lineIndex === lines.length - 1 && line === '') {
      continue
    }
    // A column-zero YAML comment between continuation lines belongs to the raw
    // entry around it. Holding it until the next meaningful line is what lets us
    // distinguish that shape from a standalone comment before the next key. This
    // is deliberately conservative: a comment makes a list/map unmodelled, so the
    // importer carries the whole entry instead of lifting half and orphaning the
    // remaining lines. A dedented comment terminates a block scalar, however.
    if (COLUMN_COMMENT.test(line)) {
      const previous = entries[entries.length - 1]

      if (previous?.key && activeBlockScalarIndent === null) {
        pendingInterstitial.push(line)
      } else {
        flushInterstitialAsKeyless()
        entries.push({ key: null, lines: [line] })
        activeBlockScalarIndent = null
        activeBareBlockScalarCompatible = false
      }
      continue
    }
    // A blank block-scalar line is semantic immediately. For every other shape,
    // wait for a later continuation before assigning ownership: this preserves a
    // paragraph break inside a multiline quoted/plain scalar without letting a
    // separator blank turn an otherwise one-line `title:` into an unreadable entry.
    if (isYamlBlank(line)) {
      if (activeBlockScalarIndent !== null) {
        entries[entries.length - 1].lines.push(line)
      } else if (entries[entries.length - 1]?.key) {
        pendingInterstitial.push(line)
      }
      continue
    }
    const indent = yamlIndent(line)
    const blockScalarContent = activeBlockScalarIndent !== null && indent > activeBlockScalarIndent

    if (activeBlockScalarIndent !== null && !blockScalarContent) {
      activeBlockScalarIndent = null
      activeBareBlockScalarCompatible = false
    }
    const kv = plainMappingLine(line)
    const listItem = LIST_ITEM.exec(line)
    const indented = line[0] === ' '
    const flushListItem = Boolean(listItem && listItem[1] === '')
    const flowCloser = Boolean(
      activeFlowState && isMatchingDedentedFlowCloser(line, activeFlowState),
    )
    const continuation = Boolean(
      entries.length && (indented || flowCloser || (flushListItem && activeFlushListCompatible)),
    )

    if (pendingInterstitial.length) {
      if (continuation) {
        const previous = entries[entries.length - 1]

        for (const pending of pendingInterstitial) {
          previous.lines.push(pending)
        }
        pendingInterstitial = []
      } else {
        flushInterstitialAsKeyless()
      }
    }

    if (kv) {
      entries.push({ key: kv.key, lines: [line] })
      activeBlockScalarIndent = blockScalarHeaderIndent(line, true)
      activeBareBlockScalarCompatible =
        activeBlockScalarIndent === null && isEmptyInlineListOwner(kv.inline)
      activeFlowState = newYamlNodeLexerState()
      yamlNodeReferencesInLine(line, activeFlowState)
      activeFlushListCompatible = isEmptyInlineListOwner(kv.inline)
      activeFlushListStarted = false
    } else if (continuation) {
      entries[entries.length - 1].lines.push(line) // continuation of the entry
      if (!blockScalarContent) {
        activeBlockScalarIndent = blockScalarHeaderIndent(line, activeBareBlockScalarCompatible)
        activeBareBlockScalarCompatible =
          activeBlockScalarIndent === null && lineOpensBareValue(line)
        if (flushListItem) {
          activeFlushListStarted = true
        } else if (indented && activeFlushListCompatible && !activeFlushListStarted) {
          // An indented map/list/plain continuation before the first flush-left item
          // commits this empty key to another YAML shape. A later `- item` is then a
          // root sequence, not a continuation of this entry.
          activeFlushListCompatible = false
        }
      }
      if (activeFlowState) {
        yamlNodeReferencesInLine(line, activeFlowState)
      }
    } else {
      entries.push({ key: null, lines: [line] }) // passthrough
      activeBlockScalarIndent = null
      activeBareBlockScalarCompatible = false
      activeFlowState = null
      activeFlushListCompatible = false
      activeFlushListStarted = false
    }
  }
  flushInterstitialAsKeyless()

  return { entries, bodyStart }
}

/** Read a leading metadata block from NOTE BODY bytes. A raw file and a body ask
 * different questions: a body's fenced opening is metadata only when it carries
 * at least one keyed record and every keyless entry is a column-zero YAML comment.
 * The file reader remains deliberately syntax-only. */
export const parseBodyFrontmatterBlock = (body: string): FrontmatterBlock | null => {
  // A byte-order mark belongs only at the start of a file. Inside an already-split
  // body it is authored content, even though the raw-file grammar accepts one.
  if (body.charCodeAt(0) === 0xfeff) {
    return null
  }
  const block = parseFrontmatterBlock(body)

  if (!block) {
    return null
  }
  let hasKey = false

  for (const entry of block.entries) {
    if (entry.key !== null) {
      hasKey = true
      continue
    }
    if (entry.lines.some((line) => !COLUMN_COMMENT.test(line))) {
      return null
    }
  }

  return hasKey ? block : null
}

/** Whether an entry opens a YAML block scalar (`|`, `>`, plus valid indicators).
 * Projection can flatten that syntax into a string, but a typed scalar writer may
 * not treat the authored form as equivalent to its own one-line representation. */
export const frontmatterEntryIsBlockScalar = (entry: FrontmatterEntry): boolean => {
  const inline = entryInline(entry)
  return inline !== null && BLOCK_SCALAR.test(inline)
}

/** One entry's CHARACTER span in the source, `[start, end)` with `end` just past the
 *  line terminator of the entry's last line. Index-aligned with the block's `entries`. */
export type FrontmatterSpan = { key: string | null; start: number; end: number }

export type FrontmatterPayloadBounds = { payloadStart: number; payloadEnd: number }

/** One frontmatter line, by the rule this parser and a YAML reader both use (`\r?\n`)
 *  rather than the Markdown physical-line rule. The two disagree on a lone CR and on
 *  U+2028/U+2029, and none of those ends a YAML line: walking the block with the wider
 *  rule splits an entry the parser kept whole. `limit` is the payload end, so no walk
 *  can wander past the closing fence. */
const nextFrontmatterLineSpan = (
  text: string,
  start: number,
  limit: number,
): { end: number; next: number } | null => {
  if (start >= limit) {
    return null
  }
  const feed = text.indexOf('\n', start)
  const breakAt = feed < 0 || feed >= limit ? limit : feed

  return {
    end: breakAt > start && text[breakAt - 1] === '\r' ? breakAt - 1 : breakAt,
    next: Math.min(breakAt + 1, limit),
  }
}

/** The payload between the fences, in character offsets of `raw`: `payloadStart` is the
 *  first line after the opening fence, `payloadEnd` the start of the closing fence line
 *  — the insertion point for a new entry. `bodyStart` comes from the parsed block.
 *
 *  A byte-order mark needs no compensation here: it shares the opening fence's line, and
 *  this walk steps over that whole line. */
export const frontmatterPayloadBounds = (
  raw: string,
  bodyStart: number,
): FrontmatterPayloadBounds => {
  const payloadStart = nextFrontmatterLineSpan(raw, 0, bodyStart)?.next ?? bodyStart
  let cursor = payloadStart
  let payloadEnd = -1

  while (cursor < bodyStart) {
    const line = nextFrontmatterLineSpan(raw, cursor, bodyStart)

    if (!line) {
      break
    }
    if (trimYamlHorizontalEnd(raw.slice(cursor, line.end)) === '---') {
      payloadEnd = cursor
      break
    }
    cursor = line.next
  }
  if (payloadEnd < payloadStart) {
    throw new FrontmatterGeometryError('geometry')
  }

  return { payloadStart, payloadEnd }
}

/** Choose the terminator for a NEW frontmatter line without normalising existing
 * bytes. Existing blocks use the majority of physical payload lines, with the
 * opening fence as a deterministic tie-break; block-less documents use their
 * first physical line and otherwise default to LF. Callers that already parsed a
 * block pass its bounds so this helper never reparses a hot write path. */
export const frontmatterBlockEol = (
  raw: string,
  bounds?: FrontmatterPayloadBounds,
): '\n' | '\r\n' => {
  if (!bounds) {
    const firstFeed = raw.indexOf('\n')
    return firstFeed > 0 && raw[firstFeed - 1] === '\r' ? '\r\n' : '\n'
  }
  const openingEol = raw.slice(0, bounds.payloadStart).endsWith('\r\n') ? '\r\n' : '\n'
  let lf = 0
  let crlf = 0
  let cursor = bounds.payloadStart

  while (cursor < bounds.payloadEnd) {
    const feed = raw.indexOf('\n', cursor)

    if (feed < 0 || feed >= bounds.payloadEnd) {
      break
    }
    if (feed > cursor && raw[feed - 1] === '\r') {
      crlf++
    } else {
      lf++
    }
    cursor = feed + 1
  }

  return crlf === lf ? openingEol : crlf > lf ? '\r\n' : '\n'
}

/** Where each parsed entry physically sits in `raw`. This is the geometry a writer needs
 *  to change one entry and leave the rest byte-identical, and the geometry an analyzer
 *  needs to bind a YAML node to the lines that carry it.
 *
 *  Fail-closed: a divergence between the parser's lines and the source throws rather than
 *  returning a span that names somebody else's bytes. */
export const frontmatterEntrySpans = (raw: string, block: FrontmatterBlock): FrontmatterSpan[] => {
  const { payloadStart, payloadEnd } = frontmatterPayloadBounds(raw, block.bodyStart)
  const spans: FrontmatterSpan[] = []
  let cursor = payloadStart

  for (const entry of block.entries) {
    // A blank line BETWEEN entries is legal YAML that the parser drops: it is not an entry
    // of its own, while a blank that BELONGS to one — block-scalar content, a paragraph
    // break inside a continued value — stays in that entry's lines and is matched below.
    // Stepping over exactly the dropped ones is what keeps this walk in sync with the
    // parser; without it the first such blank shifts every later span.
    if (!isYamlBlank(entry.lines[0] ?? '')) {
      let blank = nextFrontmatterLineSpan(raw, cursor, payloadEnd)

      while (blank && isYamlBlank(raw.slice(cursor, blank.end))) {
        cursor = blank.next
        blank = nextFrontmatterLineSpan(raw, cursor, payloadEnd)
      }
    }
    const start = cursor

    // Within an entry the lines stay consecutive — with one exception the parser itself
    // creates: a blank following a KEYLESS entry is dropped outright rather than held
    // (only a keyed entry can adopt one later), and a continuation line after it is still
    // appended to that same entry. Its lines are then genuinely non-consecutive in the
    // source, and refusing here would narrow the write channel over documents the parser
    // describes perfectly.
    for (const expected of entry.lines) {
      let line = nextFrontmatterLineSpan(raw, cursor, payloadEnd)

      while (
        entry.key == null &&
        line &&
        !isYamlBlank(expected) &&
        isYamlBlank(raw.slice(cursor, line.end))
      ) {
        cursor = line.next
        line = nextFrontmatterLineSpan(raw, cursor, payloadEnd)
      }
      if (!line || raw.slice(cursor, line.end) !== expected) {
        throw new FrontmatterGeometryError('geometry')
      }
      cursor = line.next
    }
    spans.push({ key: entry.key, start, end: cursor })
  }

  return spans
}

/** A block scalar's text, FLATTENED onto one line (its lines joined by spaces).
 *
 *  Reading it at all is what a real archive needs — a Jekyll/Hugo post writes its
 *  title as `title: >`, and the old answer was the indicator character itself, the
 *  string ">". Reading it as MULTI-LINE, though, would be worse than not reading
 *  it: every scalar this module emits is one `key: value` line, so a value
 *  carrying a newline escapes its entry and lands as a bare line inside the `---`
 *  block — a structurally broken file whose `notarium-id` and `created:` claims
 *  become body text. The product has no multi-line scalar channel (a title, a
 *  slug, a summary are all one line by construction), so folding is the honest
 *  reading, and `frontmatterScalar` enforces the same invariant on the way out.
 *
 *  Linear by construction: no `Math.min(...)` spread (it throws RangeError past
 *  ~125k arguments — a 500 KB file was enough to abort a whole index rescan) and
 *  no per-line rescan of the whole block (that was quadratic: 32 KB of blank
 *  continuation lines cost ~4 s of CPU on the request path). */
const blockScalarText = (lines: readonly string[]): string => {
  let indent = Number.POSITIVE_INFINITY

  for (const l of lines) {
    if (!isYamlBlank(l)) {
      indent = Math.min(indent, yamlIndent(l))
    }
  }
  if (!Number.isFinite(indent)) {
    return '' // nothing but blank lines — an empty value
  }
  const out: string[] = []

  for (const l of lines) {
    const t = l.slice(indent).trim()

    if (t) {
      out.push(t)
    }
  }

  return out.join(' ')
}

/** A deliberately SMALL scalar reader. Returning null is not a parse failure we
 *  recover from — it is the preservation signal: the importer leaves the raw
 *  entry in the carried frontmatter instead of replacing author data with a
 *  guessed value. */
const simpleScalar = (raw: string): string | null => {
  const value = raw.trim()

  if (!value) {
    return ''
  }
  const quote = value[0]

  if (quote === '"' || quote === "'") {
    if (value.length < 2 || value[value.length - 1] !== quote) {
      return null
    }
    const inner = value.slice(1, -1)

    for (let i = 0; i < inner.length; i++) {
      if (quote === '"' && inner[i] === '\\') {
        // `unquoteScalar` is the inverse of our emitter and understands exactly
        // these two escapes. A YAML escape such as `\n` or `\u263a` needs a real
        // YAML decoder; treating it literally would corrupt the value, so carry.
        if (inner[i + 1] !== '"' && inner[i + 1] !== '\\') {
          return null
        }
        i++
      } else if (inner[i] === quote) {
        if (quote === "'" && inner[i + 1] === "'") {
          i++ // YAML's escaped apostrophe: `''`
        } else {
          return null
        }
      }
    }

    return unquoteScalar(value)
  }
  // These are valid YAML syntax, but not simple scalar syntax: collection,
  // anchor/alias/tag, explicit mapping indicators, or an inline comment. Claiming
  // the prefix as a value would make the importer drop the rest of the entry.
  if (/^(?:[[\]{}&,*!@`]|[-?:](?:\s|$))/.test(value) || /:\s/.test(value)) {
    return null
  }
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '#' && (i === 0 || /\s/.test(value[i - 1]))) {
      return null
    }
  }

  return value
}

/** A quote-aware, single-pass reader for a SIMPLE one-line flow sequence. Nested
 *  collections, mappings, anchors/tags and comments intentionally return null so
 *  their raw entry survives. */
const simpleFlowList = (inline: string): string[] | null => {
  if (inline[0] !== '[' || inline[inline.length - 1] !== ']') {
    return null
  }
  const body = inline.slice(1, -1)

  if (!body.trim()) {
    return []
  }
  const tokens: string[] = []
  let start = 0
  let quote: '"' | "'" | null = null
  let closedQuote = false
  let tokenHasContent = false

  for (let i = 0; i < body.length; i++) {
    const ch = body[i]

    if (quote === '"') {
      if (ch === '\\') {
        if (body[i + 1] !== '"' && body[i + 1] !== '\\') {
          return null
        }
        i++
      } else if (ch === '"') {
        quote = null
        closedQuote = true
      }
      continue
    }
    if (quote === "'") {
      if (ch === "'" && body[i + 1] === "'") {
        i++
      } else if (ch === "'") {
        quote = null
        closedQuote = true
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      if (tokenHasContent) {
        // Quotes have no special meaning once a YAML plain scalar has started.
        // Our own emitter relies on this for values such as `Game "night"`.
        continue
      }
      quote = ch
      tokenHasContent = true
      continue
    }
    if (ch === ',') {
      const token = body.slice(start, i).trim()

      if (!token) {
        return null
      }
      tokens.push(token)
      start = i + 1
      closedQuote = false
      tokenHasContent = false
      continue
    }
    if (closedQuote && !/\s/.test(ch)) {
      return null
    }
    if ('[]{}'.includes(ch) || (ch === '#' && (i === 0 || /\s/.test(body[i - 1])))) {
      return null
    }
    if (ch === ':' && /\s/.test(body[i + 1] ?? '')) {
      return null
    }
    if (!/\s/.test(ch)) {
      tokenHasContent = true
    }
  }
  if (quote) {
    return null
  }
  const tail = body.slice(start).trim()

  if (!tail) {
    return null
  }
  tokens.push(tail)

  const out: string[] = []

  for (const token of tokens) {
    const value = simpleScalar(token)

    if (value == null) {
      return null
    }
    if (value) {
      out.push(value)
    }
  }

  return out
}

const blockList = (lines: readonly string[]): string[] | null => {
  if (!lines.length) {
    return null
  }
  const matches = lines.map((line) => LIST_ITEM.exec(line))

  if (matches.some((match) => !match)) {
    return null
  }
  const indent = matches[0]![1]
  const out: string[] = []

  for (const match of matches) {
    if (!match || match[1] !== indent) {
      return null
    }
    const value = simpleScalar(match[2])

    if (value == null) {
      return null
    }
    if (value) {
      out.push(value)
    }
  }

  return out
}

/** An entry's value: scalar string, block/flow list, block-scalar text, or null —
 *  passthrough, an empty value, or a key whose value is a nested map (honestly
 *  absent here, but still preserved on rewrite by its raw lines). */
export const frontmatterEntryValue = (e: FrontmatterEntry): string | string[] | null => {
  if (!e.key) {
    return null
  }
  const inline = entryInline(e)

  if (inline == null) {
    return null
  }

  if (inline) {
    if (BLOCK_SCALAR.test(inline)) {
      return blockScalarText(e.lines.slice(1)) || null
    }
    // An inline value that still has continuation lines is a shape we do NOT read:
    // a plain or quoted scalar wrapped over several lines, a flow sequence broken
    // after the `[`. Reading line 0 alone would report a TRUNCATED value — and a
    // truncated value is worse than none, because a caller that treats "we got a
    // value" as "we captured the key" then drops the author's remainder. Honest
    // null keeps the whole entry unmodelled, so its raw lines ride along.
    if (e.lines.length > 1) {
      return null
    }
    if (inline.startsWith('[')) {
      return simpleFlowList(inline)
    }
    // A closing bracket/map/invalid block-scalar indicator without a matching
    // supported opener is complex YAML too, not a plain string.
    if (/^[\]{}|>]/.test(inline)) {
      return null
    }

    return simpleScalar(inline)
  }

  return blockList(e.lines.slice(1))
}

/** Parse a BARE frontmatter body (the lines between the `---` fences) into
 *  entries. The authoring form for anything that declares frontmatter without a
 *  whole document around it — seed cases and fixtures — so they read the same
 *  YAML the parser does instead of hand-building entry objects. */
export const parseFrontmatterLines = (yaml: string): FrontmatterEntry[] =>
  parseFrontmatterBlock(`---\n${yaml.replace(/^\n+|\n+$/g, '')}\n---\n`)?.entries ?? []

/** Find one key among parsed entries (passthrough entries never match). */
export const frontmatterEntryOf = (
  entries: readonly FrontmatterEntry[],
  key: string,
): FrontmatterEntry | undefined => {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].key === key) {
      return entries[i]
    }
  }

  return undefined
}

/** The parsed value of one key in a raw document, in the shape the entry carries
 *  (scalar or list); null when absent/unmodelled. */
export const frontmatterEntryValueOf = (content: string, key: string): string | string[] | null => {
  const block = parseFrontmatterBlock(content || '')
  const entry = block && frontmatterEntryOf(block.entries, key)
  return entry ? frontmatterEntryValue(entry) : null
}

/** The host-internal carried-frontmatter channel still crosses a durable storage
 *  boundary. Validate both text durability and the entry structure so a caller
 *  cannot hide a second top-level key, a closing fence, a line terminator or a
 *  control character inside an ostensibly raw line. `undefined` is the normal
 *  three-state "not addressed" value and is valid too. */
export const isDurableFrontmatter = (
  value: unknown,
): value is readonly FrontmatterEntry[] | undefined => {
  if (value === undefined) {
    return true
  }
  if (!Array.isArray(value)) {
    return false
  }
  let totalBytes = 0

  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') {
      return false
    }
    const { key, lines } = candidate as Partial<FrontmatterEntry>

    if ((key !== null && typeof key !== 'string') || !Array.isArray(lines) || !lines.length) {
      return false
    }
    if (typeof key === 'string' && !isSafePlainMappingKey(key)) {
      return false
    }
    if (
      lines.some(
        (line) => typeof line !== 'string' || !isDurableScalar(line) || /^---[ \t]*$/.test(line),
      )
    ) {
      return false
    }
    // Every carried physical line is re-emitted with one `\n` before the closing
    // fence. Enforce the same cap as the raw parser at this host-internal ingress;
    // otherwise a caller could bypass the bounded parser with a hand-built array
    // and make the engine write a file it cannot subsequently index.
    for (const line of lines) {
      totalBytes += utf8Bytes(line) + 1
      if (totalBytes > FRONTMATTER_BYTE_CAP) {
        return false
      }
    }
    const first = plainMappingLine(lines[0])

    if (key === null) {
      // A keyless value is moved to the front when frontmatter is merged. The only
      // shape whose meaning is stable under that relocation is one standalone
      // column-zero comment. Indented continuations, document markers/directives,
      // sequences and arbitrary scalars are structural YAML and may not cross the
      // durable host boundary disguised as passthrough data.
      if (lines.length !== 1 || !COLUMN_COMMENT.test(lines[0])) {
        return false
      }
    } else if (!first || first.key !== key) {
      return false
    }
    let blockScalarIndent = blockScalarHeaderIndent(lines[0], true)
    let bareBlockScalarCompatible =
      blockScalarIndent === null && first ? isEmptyInlineListOwner(first.inline) : false
    let flushListCompatible = first ? isEmptyInlineListOwner(first.inline) : false
    let flushListStarted = false
    let pendingInterstitial = false
    const flowState = newYamlNodeLexerState()

    yamlNodeReferencesInLine(lines[0], flowState)

    for (let lineIndex = 1; lineIndex < lines.length; lineIndex++) {
      const continuation = lines[lineIndex]
      // The parser only groups an indented line, a flush-left list item, or a
      // block-scalar blank with its owner. A second top-level mapping line here
      // would bypass the merge/ownership logic for that key.

      const indent = yamlIndent(continuation)
      const blockScalarContent = blockScalarIndent !== null && indent > blockScalarIndent
      let endedBlockScalar = false

      if (blockScalarIndent !== null && !isYamlBlank(continuation) && !blockScalarContent) {
        blockScalarIndent = null
        bareBlockScalarCompatible = false
        endedBlockScalar = true
      }
      if (isYamlBlank(continuation)) {
        if (blockScalarIndent === null) {
          pendingInterstitial = true
        }
        continue
      }
      if (COLUMN_COMMENT.test(continuation)) {
        // A dedented comment terminates a block scalar and the parser keeps it
        // keyless. Other comments/blanks are accepted only when a later real
        // continuation proves that this whole interstitial run belongs here.
        if (endedBlockScalar) {
          return false
        }
        pendingInterstitial = true
        continue
      }
      const continuationKey = plainMappingLine(continuation)
      const listItem = LIST_ITEM.exec(continuation)
      const indented = continuation[0] === ' '
      const flushListItem = Boolean(listItem && listItem[1] === '')
      const flowCloser = isMatchingDedentedFlowCloser(continuation, flowState)

      if (continuationKey || (!indented && !flushListItem && !flowCloser)) {
        return false
      }
      pendingInterstitial = false
      yamlNodeReferencesInLine(continuation, flowState)
      if (blockScalarContent) {
        continue
      }
      if (flushListItem) {
        if (!flushListCompatible) {
          return false
        }
        flushListStarted = true
      } else if (indented && flushListCompatible && !flushListStarted) {
        flushListCompatible = false
      }
      blockScalarIndent = blockScalarHeaderIndent(continuation, bareBlockScalarCompatible)
      bareBlockScalarCompatible = blockScalarIndent === null && lineOpensBareValue(continuation)
    }
    if (pendingInterstitial) {
      return false
    }
  }

  return true
}

/** The SCALAR value of one frontmatter key (`key: value`), or null — a list or a
 *  nested map yields null (this one's callers want a scalar, e.g. the id claim). */
export const frontmatterValue = (content: string, key: string): string | null => {
  const v = frontmatterEntryValueOf(content, key)
  return typeof v === 'string' && v ? v : null
}

/** Unwrap a YAML scalar SYMMETRICALLY with the serializer below: strip
 *  the wrapping quotes AND reverse the escaping. A double-quoted scalar un-escapes
 *  `\\`→`\` and `\"`→`"`; a single-quoted one un-escapes `''`→`'`; a plain scalar
 *  carries no escapes. The read-model snippet path and the engine must read the
 *  same bytes identically — the old asymmetric `replace(outer).trim()` left a
 *  serialized `"\"Gameverse\""` as `\"Gameverse\"` here. */
export const unquoteScalar = (s: string): string => {
  const t = s.trim()
  const dq = /^"([\s\S]*)"$/.exec(t)

  if (dq) {
    return dq[1].replace(/\\(["\\])/g, '$1')
  }
  const sq = /^'([\s\S]*)'$/.exec(t)

  if (sq) {
    return sq[1].replace(/''/g, "'")
  }

  return t
}

/** YAML-safe scalar for the values we EMIT: quote when the raw form would parse
 *  as something else (leading/trailing space, a colon-space, #, quotes, or a
 *  leading YAML indicator). A real YAML parser must read back what we wrote — this
 *  is load-bearing now that #156 lets ARBITRARY first-line prose become a `title`:
 *  a title opening with a flow indicator (`[[wiki]]` → `[`, `{a}` → `{`,
 *  `, leading` → `,`) would otherwise emit `title: [[wiki]]`, which a strict YAML
 *  reader (Obsidian, exporters) parses as a nested flow collection, not a string.
 *
 *  ONE LINE, always. Every entry this module builds is a single `key: value` line,
 *  so a value carrying a newline would escape its entry and land as a bare line
 *  inside the `---` block: the frontmatter stops parsing there, and everything
 *  below it (our `notarium-id` and `created:` among them) becomes body text. The
 *  emitter is the right place for that invariant — it holds for every channel and
 *  every caller, not just the ones we thought to check. */
/** Fold a value onto ONE line — the only shape a `key: value` entry can hold.
 *
 *  Exported because more than the frontmatter emitter needs it: the storage `#
 *  title` heading has to be written from the SAME normalised string, or the two
 *  disagree and the heading stops matching the title it is supposed to repeat —
 *  so it is never stripped on read, and every save leaves another copy behind.
 *
 *  Splits on EVERY line terminator, a lone CR included: YAML treats it as one, and
 *  so does this module's own KEY_LINE (`.` never matches a terminator), so a bare
 *  `\r` left the whole `key:` line unreadable. Linear on purpose — the obvious
 *  one-regex collapse (a global `\s*` `\r?\n` `\s*` replace) is a
 *  catastrophic-backtracking ReDoS: on a value with a long run of spaces and NO
 *  newline it backtracks position by position hunting the `\n`, and a title of
 *  120k spaces cost 14 s of event loop per save. */
export const singleLine = (v: string): string =>
  /[\r\n]/.test(v)
    ? v
        .split(/\r\n|[\r\n]/)
        .map((l) => l.trim())
        .filter(Boolean)
        .join(' ')
    : v

// Scalars the common YAML schemas resolve to a non-string even without any
// punctuation. Quoting a few extra YAML-1.1 spellings (`yes`/`on`) is harmless
// and keeps files portable across readers that have not moved to 1.2.
const YAML_SCHEMA_SCALAR =
  /^(?:~|null|true|false|yes|no|on|off|[-+]?(?:(?:0b[01_]+)|(?:0o[0-7_]+)|(?:0x[\da-f_]+)|(?:(?:\d[\d_]*)(?:\.[\d_]*)?|\.[\d_]+)(?:e[-+]?\d[\d_]*)?|\.(?:inf|nan)))$/i

export const frontmatterScalar = (v: string): string => {
  const flat = singleLine(v)
  return /(^\s|\s$|: |#|^["'&*?|>%@`![\]{},-]|: *$)/.test(flat) ||
    YAML_SCHEMA_SCALAR.test(flat) ||
    flat === ''
    ? `"${flat.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : flat
}

export const frontmatterScalarEntry = (key: string, v: string): FrontmatterEntry => ({
  key,
  lines: [`${key}: ${frontmatterScalar(v)}`],
})

export const frontmatterListEntry = (key: string, items: readonly string[]): FrontmatterEntry => ({
  key,
  lines: items.length
    ? [`${key}:`, ...items.map((t) => `- ${frontmatterScalar(t)}`)]
    : [`${key}: []`],
})

/** Set (or replace) one SERVICE key in a document's leading frontmatter block, creating
 *  the block when the document has none. It re-materializes the internal note-id on bytes
 *  that already exist; ordinary saves use the general span-aware file serializer.
 *
 *  Only the target key's own entry changes: every other entry keeps its bytes, its order
 *  and its line endings, and duplicates of the target collapse onto the FIRST slot so the
 *  reader's last-wins answer and this writer's answer are finally the same one. The whole
 *  entry is replaced rather than the value inside it — a block list, a block scalar or a
 *  bare `key:` has no value slot on its own line, and patching one glues the next line
 *  onto the value.
 *
 *  Throws `FrontmatterGeometryError` instead of writing when the parser's entries no
 *  longer describe the source, or when the target entry defines an anchor — ANY anchor,
 *  whether or not something currently aliases it: this channel replaces the whole entry,
 *  and proving that nothing points at the name is the document-wide question the byte
 *  planner exists for, not one a line reader should answer.
 *  canon: docs/core.md#identity */
export const upsertFrontmatterKey = (content: string, key: string, value: string): string => {
  const raw = content || ''
  const block = parseFrontmatterBlock(raw)
  const line = frontmatterScalarEntry(key, value).lines[0]

  if (!block) {
    const eol = frontmatterBlockEol(raw)
    // The encoding prologue opens the FILE: a mark that no longer leads its bytes is not
    // a mark at all, it is a stray zero-width space in the middle of the prose.
    const start = raw.charCodeAt(0) === 0xfeff ? 1 : 0

    return `${raw.slice(0, start)}---${eol}${line}${eol}---${eol}${raw.slice(start)}`
  }
  const spans = frontmatterEntrySpans(raw, block)
  const targets: FrontmatterSpan[] = []

  for (let index = 0; index < spans.length; index++) {
    if (spans[index].key !== key) {
      continue
    }
    if (frontmatterEntryDefinesYamlAnchor(block.entries[index])) {
      throw new FrontmatterGeometryError('anchored')
    }
    targets.push(spans[index])
  }

  if (!targets.length) {
    const bounds = frontmatterPayloadBounds(raw, block.bodyStart)
    const blockEol = frontmatterBlockEol(raw, bounds)

    return `${raw.slice(0, bounds.payloadEnd)}${line}${blockEol}${raw.slice(bounds.payloadEnd)}`
  }
  // The FIRST slot, not the last: it keeps the key where the file already carries it,
  // among the author's own fields.
  const [first, ...duplicates] = targets
  const terminator = raw.slice(first.start, first.end).endsWith('\r\n') ? '\r\n' : '\n'
  let out = `${raw.slice(0, first.start)}${line}${terminator}`
  let read = first.end

  for (const duplicate of duplicates) {
    out += raw.slice(read, duplicate.start)
    read = duplicate.end
  }

  return out + raw.slice(read)
}

/**
 * The `tags:` entry of a raw document's YAML frontmatter, in the three shapes
 * notes actually carry: a block list (`- a`), a flow list (`[a, b]`) or a
 * scalar (`a, b`). Anything fancier (anchors, nested maps) honestly yields no
 * tags — the same degradation an engine-less host accepts everywhere else.
 */
export const frontmatterTags = (content: string): string[] =>
  normTags(frontmatterEntryValueOf(content, 'tags')) ?? []
