import { type FrontmatterBlock, parseFrontmatterBlock } from '../frontmatter'

export type AtxH1Line = {
  /** Heading text after removing an optional CommonMark closing `#` sequence. */
  title: string
  /** Heading text before removing the closing sequence; used to recognise our own `# ${title}`. */
  rawTitle: string
}

const isHorizontalSpace = (char: string): boolean => char === ' ' || char === '\t'

export type PhysicalLineSpan = {
  /** Inclusive start of the physical line's content. */
  start: number
  /** Exclusive end of its content, before the line terminator. */
  end: number
  /** Start of the following line, after CRLF/lone CR/LF/U+2028/U+2029. */
  next: number
}

/** Find one physical text line without allocating a split array or normalising
 *  its terminator. Markdown arrives from archives authored on more than the LF
 *  happy path: CR-only files and JavaScript's other two line separators must not
 *  fuse a heading with its body. Exported for the engine's legacy anywhere-H1
 *  scan so both title readers share the exact same boundary rule. */
export const nextPhysicalLineSpan = (text: string, start = 0): PhysicalLineSpan | null => {
  if (start < 0 || start >= text.length) {
    return null
  }
  let end = start

  while (
    end < text.length &&
    text[end] !== '\n' &&
    text[end] !== '\r' &&
    text[end] !== '\u2028' &&
    text[end] !== '\u2029'
  ) {
    end++
  }
  let next = end

  if (end < text.length) {
    next = end + (text[end] === '\r' && text[end + 1] === '\n' ? 2 : 1)
  }

  return { start, end, next }
}

/** Parse one physical Markdown line as an ATX H1 in a single pass.
 *
 *  CommonMark permits 0–3 leading spaces, but a tab or four spaces starts an
 *  indented-code shape for our purposes. Only H1 is accepted. A closing `#` run
 *  is decoration iff it is separated from the content by horizontal whitespace;
 *  `# C#` therefore remains titled "C#". */
export const parseAtxH1Line = (line: string): AtxH1Line | null => {
  let end = line.endsWith('\r') ? line.length - 1 : line.length
  let i = 0

  while (i < end && line[i] === ' ' && i < 4) {
    i++
  }
  if (i > 3 || line[i] !== '#') {
    return null
  }
  i++
  if (i < end && !isHorizontalSpace(line[i])) {
    return null // `#title` and `## title` are not H1 title lines
  }
  while (i < end && isHorizontalSpace(line[i])) {
    i++
  }
  const contentStart = i

  while (end > contentStart && isHorizontalSpace(line[end - 1])) {
    end--
  }
  const rawTitle = line.slice(contentStart, end)
  let closingStart = end

  while (closingStart > contentStart && line[closingStart - 1] === '#') {
    closingStart--
  }
  if (
    closingStart < end &&
    (closingStart === contentStart || isHorizontalSpace(line[closingStart - 1]))
  ) {
    end = closingStart
    while (end > contentStart && isHorizontalSpace(line[end - 1])) {
      end--
    }
  }

  return { title: line.slice(contentStart, end), rawTitle }
}

/** Normalise a stored body for the UI: drop leading blank lines and a leading `# <title>` H1 —
 *  but ONLY when it merely repeats the note title (the title reaches the UI as a separate field).
 *  A first heading that does NOT match the title is kept; dropping the blanks avoids compounding
 *  them on every re-save. */
export const stripTitleHeading = (content: string, title?: string): string => {
  if (!content) {
    return content || ''
  }
  let start = 0
  let line = nextPhysicalLineSpan(content, start)

  while (line && content.slice(line.start, line.end).trim() === '') {
    start = line.next
    line = nextPhysicalLineSpan(content, start)
  } // leading blank lines
  const heading = line
    ? parseAtxH1Line(content.slice(line.start, line.end).replace(/^\uFEFF/, ''))
    : null
  const expectedTitle = title == null ? '' : String(title).trim()
  const carriesTitle = heading
    ? expectedTitle
      ? heading.title === expectedTitle || heading.rawTitle === expectedTitle
      : Boolean(heading.title || heading.rawTitle)
    : false

  if (carriesTitle) {
    start = line!.next
    const blank = nextPhysicalLineSpan(content, start)

    if (blank && content.slice(blank.start, blank.end).trim() === '') {
      start = blank.next
    } // one blank line after the heading
  }

  return content.slice(start)
}

/** A block that opens the body and CANNOT be a title line — peeling it would corrupt the block
 *  (unclosed fence, dropped list item, half table/quote, demoted h2). Only plain prose or a real
 *  `# H1` may title a note. */
const STRUCTURAL_BLOCK_START =
  /^\s*(?:```|~~~|#|>|\||[-*+]\s|\d+[.)]\s|<|(?:-{3,}|\*{3,}|_{3,}|={3,})\s*$)/

/** The shared read of a body's opening: where the prose starts, and which of the three
 *  title-carrying shapes (ATX `# H1` / setext / plain first line) it is. ONE scan, two
 *  consumers — `promoteBodyTitle` (the write chokepoint) and `headingTitle` (the importer) —
 *  so "what counts as a title line" is decided in exactly one place. */
const scanOpening = (
  src: string,
): {
  /** A leading inline-frontmatter block, carried through untouched. */
  fm: string
  /** Body after the leading inline-frontmatter block. */
  rest: string
  /** First non-blank physical line and the line below it. */
  opening: PhysicalLineSpan | null
  following: PhysicalLineSpan | null
  first: string
  h1: AtxH1Line | null
  setext: boolean
  plain: boolean
} => {
  // Carry a leading inline-frontmatter block through untouched — the title lives in the
  // markdown body below it, and serializeNoteFile folds this block into the file's own
  // frontmatter. WHICH block that is, is not this file's opinion to hold.
  // canon: docs/core.md#write-through
  //
  // Local to this call: the parser throws on an oversized block and this scan must not,
  // because one consumer derives a draft title inside a React hook.
  let block: FrontmatterBlock | null

  try {
    block = parseFrontmatterBlock(src)
  } catch {
    block = null
  }
  const fm = block ? src.slice(0, block.bodyStart) : ''
  const rest = block ? src.slice(block.bodyStart) : src
  let start = 0
  let opening = nextPhysicalLineSpan(rest, start)

  while (opening && rest.slice(opening.start, opening.end).trim() === '') {
    start = opening.next
    opening = nextPhysicalLineSpan(rest, start)
  } // skip leading blanks
  // De-BOM the first line for detection (a BOM survives when there's no frontmatter
  // for the fm regex to eat it); the strip below drops the whole raw line anyway.
  const first = (opening ? rest.slice(opening.start, opening.end) : '').replace(/^\uFEFF/, '')
  const following = opening ? nextPhysicalLineSpan(rest, opening.next) : null
  const next = following ? rest.slice(following.start, following.end) : ''
  // CommonMark ATX H1: 0–3 leading spaces are allowed. The shared physical-line
  // parser keeps this scan, stripTitleHeading and the engine's legacy anywhere-H1
  // fallback on the same linear rule.
  const h1 = parseAtxH1Line(first)
  // Is the first line plain PROSE (a paragraph)? — the only kind whose peel corrupts
  // no block: not a STRUCTURAL_BLOCK_START, not indented code (≥4 spaces / tab, which
  // the regex's `^\s*` would otherwise mask), not a link/footnote reference def. Both
  // setext and the Bear promotion gate on this — a `===` under a LIST/quote/fence is
  // NOT a setext heading (CommonMark: setext underlines only a paragraph), so peeling
  // it would lose that structural opening.
  const firstIsProse =
    first.trim() !== '' &&
    !STRUCTURAL_BLOCK_START.test(first) &&
    !/^(?: {4,}|\t)/.test(first) &&
    !/^ {0,3}\[[^\]]*\]:/.test(first)
  // A setext underline directly under a prose line makes the pair a heading: the line
  // is the title and BOTH lines must be peeled, else the underline is orphaned.
  const setext = !h1 && firstIsProse && /^ {0,3}(?:=+|-+)\s*$/.test(next)
  // A table header whose delimiter row sits on the next line is structure, not a title.
  const tableDelimiterNext = /\|/.test(next) && /^[\s|:-]*-[\s|:-]*$/.test(next)
  const plain = !h1 && !setext && firstIsProse && !tableDelimiterNext
  return { fm, rest, opening, following, first, h1, setext, plain }
}

/** The title the body's leading HEADING declares — an ATX `# H1` or a setext underline — or
 *  '' when the body opens with anything else. The heading-only subset of promoteBodyTitle's
 *  precedence, for the caller whose next fallback is BETTER than Bear-style prose promotion:
 *  the importer, where a file opening with prose is titled by its FILE NAME (an Obsidian
 *  note's name IS its title). canon: docs/import.md#drag-and-drop-of-text-files-223 */
export const headingTitle = (content: string): string => {
  const { first, h1, setext } = scanOpening(content ?? '')

  if (h1) {
    return h1.title
  }

  return setext ? first.trim() : ''
}

/** Derive a note's title from its body (a projection, not an independent field) and split the
 *  title line off the stored body — the write chokepoint runs this. canon: docs/core.md#write-through
 *  Precedence (FIRST non-blank line): (1) an EXPLICIT title always wins; (2) else a leading `# H1`;
 *  (3) else that first line IF plain prose (Bear-style) — "plain" excludes anything peeling would
 *  corrupt (code fence, list, blockquote, table, heading ≥H2, thematic break, HTML, indented code,
 *  reference def); a setext heading (prose + `===`/`---` underline) counts and is peeled with its
 *  underline. The leading line is REMOVED only when it genuinely CARRIES the title: an `# H1` equal
 *  to the title, or a plain line promoted with no explicit title — never a differing heading, nor a
 *  plain line that merely coincides with an explicit title. Leading inline frontmatter is preserved. */
export const promoteBodyTitle = (
  content: string,
  explicit?: string,
): { title: string; body: string } => {
  const src = content ?? ''
  const { fm, rest, opening, following, first, h1, setext, plain } = scanOpening(src)
  const ex = explicit?.trim()
  let title = ex || ''
  let strip = 0 // leading lines to peel: 1 (h1 / plain), 2 (setext line + underline)

  if (h1 && (ex || h1.title)) {
    title = ex || h1.title
    // Dedup: peel the H1 iff it carries the title. Two ways it can, and both are
    // needed. The parsed text is the usual one. The RAW line matters because the
    // capture drops a CommonMark closing `#` run while the title keeps it: for a
    // title like `Sprint review #` the storage heading `# Sprint review #` is
    // exactly what our own serializer emits, yet the parsed forms differ — so the
    // heading survived, the write path added its own, and every export→import
    // cycle stacked one more copy.
    if (h1.title === title || h1.rawTitle === title) {
      strip = 1
    }
  } else if (setext) {
    title = ex || first.trim()
    if (first.trim() === title) {
      strip = 2
    } // peel the title line AND its underline
  } else if (plain) {
    title = ex || first.trim()
    // Bear promotion peels only when no explicit title was given; with one, the line
    // is ordinary content (even if it coincidentally equals the title).
    if (!ex && first.trim() === title) {
      strip = 1
    }
  }
  if (strip) {
    let bodyStart = strip === 2 ? following!.next : opening!.next
    const blank = nextPhysicalLineSpan(rest, bodyStart)

    if (blank && rest.slice(blank.start, blank.end).trim() === '') {
      bodyStart = blank.next
    } // one blank line after it

    return { title, body: fm + rest.slice(bodyStart) }
  }

  return { title, body: src }
}

/** The title promoteBodyTitle would derive — the thin read-only wrapper the editor
 *  save-gate and slug preview use so client and server never disagree on what
 *  titles a note. */
export const deriveNoteTitle = (content: string, explicit?: string): string =>
  promoteBodyTitle(content, explicit).title
