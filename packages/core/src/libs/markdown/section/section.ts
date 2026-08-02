// Markdown section addressing (edit_note replaceSection). A pure,
// dependency-free splitter: given a note body and a heading, find the region
// "under" that heading so edit_note can replace just that slice instead of
// rewriting the whole note. Deliberately NOT a CommonMark parser — it
// recognises ATX headings (`## Foo`) and respects fenced code blocks (a `#`
// inside ``` is not a heading), which is the whole surface notes here use; the
// honest degradation everywhere else applies (a setext-underlined heading is
// simply not addressable, the caller gets a clear "no such section").

import type { Heading, SectionResult } from './types'

/** An ATX heading line: 1–6 leading `#`, whitespace, the text, an optional
 *  closing `#` run (`## Foo ##`). The text capture is non-greedy so the closing
 *  run is stripped, not kept. */
const ATX = /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/

/** A fenced code-block delimiter (``` or ~~~, three or more), optional indent. */
const FENCE = /^[ \t]*(`{3,}|~{3,})/

/** Every ATX heading in a markdown body, in document order — its level, its
 *  (trimmed) text, and the line it sits on. Lines inside a fenced code block are
 *  skipped so a `#` in a code sample is never mistaken for a heading (a splitter
 *  that matched it would replace the wrong region). */
export const listHeadings = (body: string): Heading[] => {
  const lines = (body || '').split('\n')
  const out: Heading[] = []
  let fence: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const f = FENCE.exec(lines[i])

    if (fence) {
      // Close on a fence using the same char, at least as long as the opener.
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) {
        fence = null
      }
      continue
    }
    if (f) {
      fence = f[1]
      continue
    }
    const m = ATX.exec(lines[i])

    if (m) {
      out.push({ level: m[1].length, text: m[2].trim(), line: i })
    }
  }

  return out
}

/** Replace the BODY beneath the first heading whose text matches `heading`
 *  (trimmed, case-insensitive) with `replacement`, keeping the heading line
 *  itself. The section runs from just after the heading to the next heading of
 *  the SAME or a HIGHER level (a sibling or an ancestor) — sub-sections nested
 *  under it are part of the section and are replaced with it. No match →
 *  `ok:false` carrying the headings present, so the caller can point the agent
 *  at a real one rather than failing opaquely. Spacing around the replacement is
 *  normalised to one blank line so repeated edits don't pile up blanks. */
export const replaceMarkdownSection = (
  body: string,
  heading: string,
  replacement: string,
): SectionResult => {
  const lines = (body || '').split('\n')
  const headings = listHeadings(body)
  const want = heading.trim().toLowerCase()
  const target = headings.find((h) => h.text.toLowerCase() === want)

  if (!target) {
    return { ok: false, headings: headings.map((h) => h.text) }
  }
  // The section ends at the next heading of level <= target.level, or EOF.
  const next = headings.find((h) => h.line > target.line && h.level <= target.level)
  const endLine = next ? next.line : lines.length
  const before = lines.slice(0, target.line + 1)
  const after = lines.slice(endLine)
  const repl = replacement.replace(/\s+$/, '') // drop trailing whitespace
  // One blank line on each side of the replacement; an EMPTY replacement (the
  // agent clearing a section) collapses to a single blank between the heading
  // and whatever follows — never a pile-up of blanks on repeated edits.
  const out = [...before]

  if (repl) {
    out.push('', repl)
  }
  if (after.length) {
    out.push('', ...after)
  }

  return { ok: true, body: out.join('\n') }
}
