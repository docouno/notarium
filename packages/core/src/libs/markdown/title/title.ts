/** Normalise a stored body for the UI: drop leading blank lines and a leading `# <title>` H1 —
 *  but ONLY when it merely repeats the note title (the title reaches the UI as a separate field).
 *  A first heading that does NOT match the title is kept; dropping the blanks avoids compounding
 *  them on every re-save. */
export const stripTitleHeading = (content: string, title?: string): string => {
  if (!content) {
    return content || ''
  }
  const lines = content.split('\n')
  let i = 0

  while (i < lines.length && lines[i].trim() === '') {
    i++
  } // leading blank lines
  const m = lines[i] && lines[i].match(/^#\s+(.+?)\s*$/)

  if (m && (!title || m[1].trim() === String(title).trim())) {
    i++
    if (i < lines.length && lines[i].trim() === '') {
      i++
    } // one blank line after the heading
  }

  return lines.slice(i).join('\n')
}

/** A block that opens the body and CANNOT be a title line — peeling it would corrupt the block
 *  (unclosed fence, dropped list item, half table/quote, demoted h2). Only plain prose or a real
 *  `# H1` may title a note. */
const STRUCTURAL_BLOCK_START =
  /^\s*(?:```|~~~|#|>|\||[-*+]\s|\d+[.)]\s|<|(?:-{3,}|\*{3,}|_{3,}|={3,})\s*$)/

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
  // Carry a leading inline-frontmatter block through untouched — the title lives
  // in the markdown body below it, and serializeNoteFile folds this block into the
  // file's own frontmatter.
  const fm = /^\uFEFF?\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(src)?.[0] ?? ''
  const rest = src.slice(fm.length)
  const lines = rest.split('\n')
  let i = 0

  while (i < lines.length && lines[i].trim() === '') {
    i++
  } // skip leading blanks
  // De-BOM the first line for detection (a BOM survives when there's no frontmatter
  // for the fm regex to eat it); the strip below drops the whole raw line anyway.
  const first = (lines[i] ?? '').replace(/^\uFEFF/, '')
  const next = lines[i + 1] ?? '' // the line under the first — decides setext / table
  const ex = explicit?.trim()
  // An ATX H1 at column 0 — the form the engine serializes (`# title`) and the reader
  // strips. Drop an optional closing `#` sequence (CommonMark: `# Title #` ⇒ "Title")
  // so the derived title is clean and the dedup still matches. h2–h6 are structural.
  const h1 = /^#\s+(.+?)(?:\s+#+)?\s*$/.exec(first)
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
  let title = ex || ''
  let strip = 0 // leading lines to peel: 1 (h1 / plain), 2 (setext line + underline)

  if (h1) {
    title = ex || h1[1].trim()
    if (h1[1].trim() === title) {
      strip = 1
    } // dedup: peel the H1 iff it equals the title
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
    i += strip
    if (i < lines.length && lines[i].trim() === '') {
      i++
    } // one blank line after it

    return { title, body: fm + lines.slice(i).join('\n') }
  }

  return { title, body: src }
}

/** The title promoteBodyTitle would derive — the thin read-only wrapper the editor
 *  save-gate and slug preview use so client and server never disagree on what
 *  titles a note. */
export const deriveNoteTitle = (content: string, explicit?: string): string =>
  promoteBodyTitle(content, explicit).title
