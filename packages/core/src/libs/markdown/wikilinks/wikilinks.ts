import { Marked, type TokenizerAndRendererExtension } from 'marked'

import { isValidNoteId, RESERVED_NOTE_ID_PREFIX } from '../../id'
import {
  hasDollarMathPair,
  matchMathBlock,
  matchMathInline,
  mathBlockStart,
  mathInlineStart,
} from '../math'
import { lexerSource, type LocatedWikilink, locateWikilinks, WIKILINK_TOKEN } from './tokenOffsets'

/** Reserved target envelope for a stable note identity. Human note names never enter
 *  this namespace: without an envelope, an opaque id such as `foo.md` is
 *  indistinguishable from a human filename and is changed by name normalization. */
const WIKILINK_ID_PREFIX = RESERVED_NOTE_ID_PREFIX

/** Whether the authored target claims the reserved identity namespace, regardless
 *  of whether its percent payload is well-formed. */
export const isWikilinkIdentityTarget = (target: string): boolean =>
  target.startsWith(WIKILINK_ID_PREFIX)

/** Materialize an opaque stable id as a wikilink target. `encodeURIComponent` leaves
 *  dots literal, so encode them explicitly: a `.md` suffix must not look like storage
 *  syntax to `normalizeWikilinkTarget`. */
export const encodeWikilinkIdentity = (id: string): string => {
  if (!isValidNoteId(id)) {
    throw new TypeError('note identity must be a non-empty durable scalar')
  }

  return `${WIKILINK_ID_PREFIX}${encodeURIComponent(id).replace(/\./g, '%2E')}`
}

/** Encode display text that must remain inside one `[[address|alias]]`. Entities keep
 * the source grammar unambiguous while CommonMark/browser rendering restores text. */
export const encodeWikilinkAlias = (label: string): string =>
  label
    .replace(/&/g, '&amp;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

/** Recover a stable id only from a well-formed reserved envelope. `null` means either
 *  another namespace or a malformed/empty payload; callers use
 *  `isWikilinkIdentityTarget` separately to keep malformed envelopes reserved. */
export const decodeWikilinkIdentity = (target: string): string | null => {
  if (!isWikilinkIdentityTarget(target)) {
    return null
  }

  try {
    const decoded = decodeURIComponent(target.slice(WIKILINK_ID_PREFIX.length))
    return isValidNoteId(decoded) ? decoded : null
  } catch {
    return null
  }
}

/** Whether a newly minted note can close this target through the human-name axis.
 *  A missing stable identity is a tombstone, not a create intent. */
export const isCreatableWikilinkTarget = (target: string): boolean =>
  !isWikilinkIdentityTarget(target)

/** Split the address from its display alias. Inside a GFM table authors must
 *  escape the alias separator (`[[Target\|Label]]`) so the block tokenizer does
 *  not split the cell. The backslash belongs to Markdown syntax, not to the note
 *  path; consume it together with the separator. */
const wikilinkAddress = (raw: string): string => {
  const pipe = raw.indexOf('|')

  if (pipe === -1) {
    return raw
  }

  return raw[pipe - 1] === '\\' ? raw.slice(0, pipe - 1) : raw.slice(0, pipe)
}

// Sticky rather than `^`-anchored: the rewrite re-reads a construct where the
// lexer said it is, and slicing the rest of the document to anchor at 0 would
// copy the note once per link.
const WIKILINK_PREFIX =
  /\[\[([^\]|\r\n\u0085\u2028\u2029]+?)(?:\|([^\]\r\n\u0085\u2028\u2029]+?))?\]\]/y

/** Tokenize one wikilink at `at` in Markdown inline source. Shared by the graph
 *  extractor and the UI renderer so escaped table separators and whitespace have
 *  one interpretation. */
export const wikilinkPrefix = (
  source: string,
  at = 0,
): { raw: string; target: string; label: string } | null => {
  WIKILINK_PREFIX.lastIndex = at
  const match = WIKILINK_PREFIX.exec(source)

  if (!match) {
    return null
  }
  const target = (
    match[2] != null && match[1].endsWith('\\') ? match[1].slice(0, -1) : match[1]
  ).trim()

  if (!target) {
    return null
  }

  return { raw: match[0], target, label: (match[2] ?? match[1]).trim() }
}

/** The note-address part of a wikilink. Alias text and heading fragments are display /
 *  in-note concerns, and a trailing Markdown extension is storage syntax rather than
 *  part of the note name. Every graph/read/client resolver consumes this same form. */
export const normalizeWikilinkTarget = (raw: string): string => {
  const address = wikilinkAddress(raw).trim()

  // The identity payload is opaque. A literal `.md` can be part of an accepted
  // noncanonical ID envelope and must not turn `foo.md` into the different ID `foo`;
  // likewise a literal `#` belongs to that payload rather than becoming a human-note
  // heading fragment (canonical emitters percent-encode both, readers stay tolerant).
  // Strip the whole trailing storage-suffix run, not just one occurrence. The
  // normalizer is deliberately a fixed point: parseWikilinks already normalizes
  // before graph resolution, while direct client/REST calls normalize at their
  // own boundary. `Foo.md.md` must not mean Foo.md on one surface and Foo on another.
  if (isWikilinkIdentityTarget(address)) {
    return address
  }
  const target = address.split('#')[0].trim()
  const withoutSuffix = target.replace(/(?:\.md)+$/i, '')
  const slashed = withoutSuffix.replaceAll('\\', '/')
  const absolute = slashed.startsWith('/')
  const directoryIntent = slashed.endsWith('/') || slashed.endsWith('/.')
  const parts = slashed.split('/').filter((segment) => segment && segment !== '.')
  const canonical = parts.join('/')
  const rooted = absolute && canonical ? `/${canonical}` : canonical
  return directoryIntent && rooted ? `${rooted}/` : rooted
}

/** Where the address ends inside a `[[…]]` body: at an unescaped alias separator
 *  (whose escaping backslash belongs to the separator, not the address), or at
 *  the end. The same rule `wikilinkAddress` applies — one interpretation. */
const addressLengthOf = (inner: string): number => {
  const pipe = inner.indexOf('|')

  if (pipe === -1) {
    return inner.length
  }

  return inner[pipe - 1] === '\\' ? pipe - 1 : pipe
}

/**
 * Extract [[wikilink]] targets from a markdown body, in order of appearance —
 * the degraded reading `parseWikilinks` falls back to when the lexer throws.
 * `[[target|alias]]` yields the target; a `#fragment` is dropped (links resolve
 * to whole notes); duplicates are kept — edge dedup is the graph's concern.
 *
 * It knows fences, indented code and code spans, and it does NOT know math or
 * raw HTML blocks: this scan feeds the graph and nothing else, so its error is
 * an edge the renderer would not draw, never a byte. Positions come from the
 * lexer that decides what a link is — asking this one for them is what let a
 * comment be rewritten in place of the link it quoted. Exported so that the
 * degraded reading is pinned by tests instead of asserted in prose.
 */
export const scanWikilinksFallback = (content: string): string[] => {
  const targets: string[] = []
  const source = content || ''
  let fence: { marker: '`' | '~'; size: number } | null = null
  let opaqueUntil = -1
  let listContentIndent: number | null = null
  let paragraphActive = false
  let lineStart = 0

  const closingCodeRun = (from: number, size: number): number => {
    const blank = /\n[ \t]*\r?\n/g
    blank.lastIndex = from
    const paragraphBreak = blank.exec(source)?.index ?? source.length

    for (let at = source.indexOf('`', from); at !== -1 && at < paragraphBreak;) {
      let end = at + 1

      while (source[end] === '`') {
        end++
      }
      if (end - at === size) {
        return at
      }
      at = source.indexOf('`', end)
    }

    return -1
  }

  for (const segment of source.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? []) {
    const line = segment.replace(/\n$/, '').replace(/\r$/, '')
    const fenceRun = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]

    if (fence) {
      const closing = new RegExp(`^ {0,3}\\${fence.marker}{${fence.size},}[ \\t]*$`)

      if (closing.test(line)) {
        fence = null
      }
      lineStart += segment.length
      paragraphActive = false
      continue
    }
    if (fenceRun) {
      fence = {
        marker: fenceRun[0] as '`' | '~',
        size: fenceRun.length,
      }
      lineStart += segment.length
      paragraphActive = false
      continue
    }
    const leading = /^ */.exec(line)?.[0].length ?? 0
    const listMarker = /^ {0,3}(?:[-+*]|\d+[.)])[ \t]+/.exec(line)
    const blank = line.trim() === ''
    const continuedList = listContentIndent != null && (blank || leading >= listContentIndent)
    const indentedCode =
      !listMarker &&
      !paragraphActive &&
      (line.startsWith('\t') ||
        leading >= (continuedList && listContentIndent != null ? listContentIndent + 4 : 4))

    if (listMarker) {
      listContentIndent = listMarker[0].replace(/\t/g, '    ').length
    } else if (!continuedList && !blank) {
      listContentIndent = null
    }
    if (indentedCode) {
      lineStart += segment.length
      paragraphActive = false
      continue
    }
    for (let i = 0; i < line.length;) {
      const absolute = lineStart + i

      if (absolute < opaqueUntil) {
        i = Math.min(line.length, opaqueUntil - lineStart)
        continue
      }
      if (line[i] === '`') {
        let runEnd = i + 1

        while (line[runEnd] === '`') {
          runEnd++
        }
        const size = runEnd - i
        const closing = closingCodeRun(lineStart + runEnd, size)

        // An unmatched run is ordinary text; only a complete code span hides
        // wikilinks from the Markdown renderer.
        if (closing === -1) {
          i = runEnd
        } else {
          opaqueUntil = closing + size
          i = Math.min(line.length, opaqueUntil - lineStart)
        }
        continue
      }
      if (line[i] !== '[' || line[i + 1] !== '[') {
        i++
        continue
      }
      let escapes = 0

      for (let p = i - 1; p >= 0 && line[p] === '\\'; p--) {
        escapes++
      }
      if (escapes % 2 === 1) {
        i += 2
        continue
      }
      const end = line.indexOf(']]', i + 2)

      if (end === -1) {
        break
      }
      const target = normalizeWikilinkTarget(line.slice(i + 2, end))

      if (target) {
        targets.push(target)
      }
      i = end + 2
    }
    paragraphActive = blank ? false : !listMarker && !continuedList
    lineStart += segment.length
  }

  return targets
}

type WikilinkToken = { type: typeof WIKILINK_TOKEN; raw: string; target: string }

const wikilinkExtractionExtension: TokenizerAndRendererExtension = {
  name: WIKILINK_TOKEN,
  level: 'inline',
  tokenizer: (source) => {
    const match = wikilinkPrefix(source)

    if (!match) {
      return undefined
    }

    return { type: WIKILINK_TOKEN, raw: match.raw, target: match.target } as WikilinkToken
  },
}

let inlineMathPresent: boolean | undefined
let blockMathPresent: boolean | undefined

const gatedMathBlockStart = (source: string): number | undefined =>
  blockMathPresent === false ? undefined : mathBlockStart(source)

const gatedMathInlineStart = (source: string): number | undefined =>
  inlineMathPresent === false ? undefined : mathInlineStart(source)

const mathBlockExtractionBarrier: TokenizerAndRendererExtension = {
  name: 'notariumMathBlock',
  level: 'block',
  start: gatedMathBlockStart,
  tokenizer: (source) => {
    const match = matchMathBlock(source)
    return match ? { type: 'notariumMathBlock', raw: match.raw } : undefined
  },
}

const mathInlineExtractionBarrier: TokenizerAndRendererExtension = {
  name: 'notariumMathInline',
  level: 'inline',
  start: gatedMathInlineStart,
  tokenizer: (source) => {
    const match = matchMathInline(source)
    return match ? { type: 'notariumMathInline', raw: match.raw } : undefined
  },
}

const wikilinkMarkdown = new Marked({ gfm: true, breaks: true })
wikilinkMarkdown.use({ extensions: [wikilinkExtractionExtension] })
wikilinkMarkdown.use({
  extensions: [mathBlockExtractionBarrier, mathInlineExtractionBarrier],
})

/** Every link in the body, with the offset the lexer put it at. ONE traversal of
 *  ONE grammar answers both "is this a link" and "where is it": the graph reads
 *  the targets, a rewrite reads the offsets, and neither can hold an opinion the
 *  other contradicts. `start` is an offset into `lexed`, which is what the lexer
 *  was handed — not necessarily the author's bytes (see `lexerSource`). */
const lexWikilinks = (lexed: string): LocatedWikilink[] => {
  const previousInlineMathPresent = inlineMathPresent
  const previousBlockMathPresent = blockMathPresent

  inlineMathPresent = hasDollarMathPair(lexed)
  blockMathPresent = lexed.includes('$$') || lexed.includes('\\[')

  try {
    return locateWikilinks(wikilinkMarkdown.lexer(lexed), lexed)
      .map((link) => ({ ...link, target: normalizeWikilinkTarget(link.target) }))
      .filter((link) => link.target !== '')
  } finally {
    inlineMathPresent = previousInlineMathPresent
    blockMathPresent = previousBlockMathPresent
  }
}

/** Extract with the same CommonMark/GFM block and inline grammar the UI renders.
 *  A source regex cannot faithfully distinguish prose from fenced/indented code,
 *  raw HTML blocks, blockquotes, tables, and multiline code spans. */
export const parseWikilinks = (content: string): string[] => {
  // Every supported wikilink starts with the literal `[[`. Most notes contain
  // none; avoid constructing a full CommonMark/GFM token tree merely to prove
  // that absence on every write-through cache publication (#410).
  if (!content.includes('[[')) {
    return []
  }
  try {
    return lexWikilinks(content || '').map((link) => link.target)
  } catch {
    // Marked is total for strings, but retain a non-throwing extractor contract
    // if a future extension regresses: graph derivation must degrade, not crash.
    return scanWikilinksFallback(content)
  }
}

/** Raised instead of returning a document the rewrite could not prove. Losing a
 *  repoint has to be LOUD: a note whose links still address the source corpus is
 *  indistinguishable, on disk, from a note that was copied correctly, and the
 *  import that produced it has already reported success. */
export class WikilinkRewriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WikilinkRewriteError'
  }
}

/** The address this target becomes under the map, or `null` when the map does not
 *  name it (another corpus's identity, a human name, a malformed envelope). */
const remapped = (target: string, map: ReadonlyMap<string, string>): string | null => {
  const id = decodeWikilinkIdentity(target)
  const to = id === null ? undefined : map.get(id)

  return to === undefined ? null : encodeWikilinkIdentity(to)
}

type Edit = { start: number; end: number; text: string }

/** Bound the ADDRESS of a located link in the author's bytes. Every step is
 *  checked rather than assumed, because the failure being guarded is silent: the
 *  wrong offset does not throw, it edits the wrong bytes. */
const addressEdit = (
  markdown: string,
  lexed: string,
  toSource: (index: number) => number,
  link: LocatedWikilink,
  text: string,
): Edit => {
  if (link.start === null) {
    throw new WikilinkRewriteError(`cannot place [[${link.target}]] in the source`)
  }
  // Re-read the construct where the lexer said it is, with the tokenizer the
  // lexer itself used. Inside a table cell the token's own `raw` has lost the
  // backslash of an escaped separator, so the source is the only place the
  // address bounds can come from.
  const construct = wikilinkPrefix(lexed, link.start)

  if (!construct || normalizeWikilinkTarget(construct.target) !== link.target) {
    throw new WikilinkRewriteError(`[[${link.target}]] is not at offset ${link.start}`)
  }
  const inner = construct.raw.slice(2, -2)
  const length = addressLengthOf(inner)
  const address = inner.slice(0, length)
  const from = link.start + 2 + (address.length - address.trimStart().length)
  const to = link.start + 2 + length - (address.length - address.trimEnd().length)
  const start = toSource(from)
  const end = toSource(to)

  if (markdown.slice(start, end) !== lexed.slice(from, to)) {
    throw new WikilinkRewriteError(`[[${link.target}]] does not sit on the bytes at ${start}`)
  }

  return { start, end, text }
}

/**
 * Rewrite the ADDRESS of every exact-identity wikilink whose id the map names,
 * leaving every other byte of the document untouched. Used when a corpus is
 * COPIED (a Markdown-tree import): the copy's internal links must point at the
 * copies, not back at the source notes.
 *
 * The lexer that decides whether a `[[…]]` is a link also says where it is, so a
 * construct the renderer does not link — one quoted in a comment, a code span, a
 * math block — is not merely left alone, it is never a candidate. The result is
 * then read back with the same extractor: the links of the output must be the
 * links of the input under the map, or nothing is returned at all.
 *
 * @throws WikilinkRewriteError when a repoint cannot be proven — the caller gets
 * a refusal for this note, never a document that was edited on a guess.
 */
export const rewriteWikilinkIdentities = (
  markdown: string,
  map: ReadonlyMap<string, string>,
): string => {
  if (!markdown || !map.size) {
    return markdown
  }
  const { text: lexed, toSource } = lexerSource(markdown)
  const links = lexWikilinks(lexed)
  const edits: Edit[] = []

  for (const link of links) {
    const address = remapped(link.target, map)

    if (address === null) {
      continue
    }
    edits.push(addressEdit(markdown, lexed, toSource, link, address))
  }
  if (!edits.length) {
    return markdown
  }
  // Assembled in one pass rather than spliced once per link: a note with a few
  // hundred links would otherwise copy itself a few hundred times, and the import
  // this serves runs it over every note in the archive.
  const kept = edits.flatMap((edit, at) => [
    markdown.slice(at === 0 ? 0 : edits[at - 1].end, edit.start),
    edit.text,
  ])
  const out = `${kept.join('')}${markdown.slice(edits[edits.length - 1].end)}`
  const expected = links.map((link) => remapped(link.target, map) ?? link.target)
  const actual = parseWikilinks(out)

  // The total check: whatever the reconstruction believed, the rewritten document
  // must hold exactly the links the original held, remapped. It shares nothing with
  // the reconstruction that produced the edits — it re-reads the result — so it
  // catches a corrupted construct and a lost one alike. It is not free of every
  // grammar of ours, though: `parseWikilinks` degrades to `scanWikilinksFallback`
  // when the lexer throws, and on that path a hand-written scan has the last word on
  // what the copy holds. Marked is total for strings, so reaching that path takes a
  // future extension regressing first — but it is a path, not an impossibility, and
  // what the check is worth there is what the fallback is worth.
  if (actual.length !== expected.length || actual.some((target, at) => target !== expected[at])) {
    throw new WikilinkRewriteError(
      `rewritten links ${JSON.stringify(actual)} are not ${JSON.stringify(expected)}`,
    )
  }

  return out
}
