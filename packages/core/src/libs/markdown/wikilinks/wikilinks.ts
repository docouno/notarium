import { Marked, type TokenizerAndRendererExtension } from 'marked'

import { isValidNoteId, RESERVED_NOTE_ID_PREFIX } from '../../id'
import { matchMathBlock, matchMathInline, mathBlockStart, mathInlineStart } from '../math'

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

const WIKILINK_PREFIX =
  /^\[\[([^\]|\r\n\u0085\u2028\u2029]+?)(?:\|([^\]\r\n\u0085\u2028\u2029]+?))?\]\]/

/** Tokenize one wikilink at the beginning of Markdown inline source. Shared by
 *  the graph extractor and the UI renderer so escaped table separators and
 *  whitespace have one interpretation. */
export const wikilinkPrefix = (
  source: string,
): { raw: string; target: string; label: string } | null => {
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

/**
 * Extract [[wikilink]] targets from a markdown body, in order of appearance.
 * `[[target|alias]]` yields the target; a `#fragment` is dropped (links resolve
 * to whole notes); duplicates are kept — edge dedup is the graph's concern.
 */
const scanWikilinksFallback = (content: string): string[] => {
  const targets: string[] = []
  const source = content || ''
  let fence: { marker: '`' | '~'; size: number } | null = null
  let codeUntil = -1
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

      if (absolute < codeUntil) {
        i = Math.min(line.length, codeUntil - lineStart)
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
          codeUntil = closing + size
          i = Math.min(line.length, codeUntil - lineStart)
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

type WikilinkToken = { type: 'notariumWikilink'; raw: string; target: string }

const wikilinkExtractionExtension: TokenizerAndRendererExtension = {
  name: 'notariumWikilink',
  level: 'inline',
  start: (source) => {
    const index = source.indexOf('[[')
    return index === -1 ? undefined : index
  },
  tokenizer: (source) => {
    const match = wikilinkPrefix(source)

    if (!match) {
      return undefined
    }

    return { type: 'notariumWikilink', raw: match.raw, target: match.target } as WikilinkToken
  },
}

const mathBlockExtractionBarrier: TokenizerAndRendererExtension = {
  name: 'notariumMathBlock',
  level: 'block',
  start: mathBlockStart,
  tokenizer: (source) => {
    const match = matchMathBlock(source)
    return match ? { type: 'notariumMathBlock', raw: match.raw } : undefined
  },
}

const mathInlineExtractionBarrier: TokenizerAndRendererExtension = {
  name: 'notariumMathInline',
  level: 'inline',
  start: mathInlineStart,
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

/** Extract with the same CommonMark/GFM block and inline grammar the UI renders.
 *  A source regex cannot faithfully distinguish prose from fenced/indented code,
 *  raw HTML blocks, blockquotes, tables, and multiline code spans. */
export const parseWikilinks = (content: string): string[] => {
  const targets: string[] = []

  try {
    const seen = new Set<object>()

    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit)
        return
      }
      if (!value || typeof value !== 'object' || seen.has(value)) {
        return
      }
      seen.add(value)
      const token = value as Record<string, unknown>

      if (token.type === 'notariumWikilink' && typeof token.target === 'string') {
        const target = normalizeWikilinkTarget(token.target)

        if (target) {
          targets.push(target)
        }

        return
      }
      for (const [key, child] of Object.entries(token)) {
        if (key !== 'raw' && key !== 'text') {
          visit(child)
        }
      }
    }

    visit(wikilinkMarkdown.lexer(content || ''))
    return targets
  } catch {
    // Marked is total for strings, but retain a non-throwing extractor contract
    // if a future extension regresses: graph derivation must degrade, not crash.
    return scanWikilinksFallback(content)
  }
}
