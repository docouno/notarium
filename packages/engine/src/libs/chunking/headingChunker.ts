// Heading-first chunker (#81 Stage 3) — the production default. Splits a note at
// its markdown headings into topically-focused chunks, each carrying a breadcrumb
// (`title › section › subsection`) so a chunk embeds WITH the context of where it
// lives. Retires the whole-note chunker's truncate-on-overflow: a long note is
// now windowed (with overlap) instead of losing its tail, and search can point at
// the specific section that matched (per-chunk snippets, Stage 3 read-path).
//
// REUSES core's `listHeadings` (the canonical ATX + fenced-code parser that
// edit_note's replaceSection already trusts) rather than re-implementing heading
// detection — one source of truth, so the chunker splits exactly where the rest
// of the system thinks a note's sections are.
//
// STRICT SUPERSET of the whole-note chunker: a note with NO headings yields
// exactly one chunk `title\n\nbody` (the same text whole-v1 produced), so the
// only behavioural change for the common short note is the bumped `version`.
//
// Determinism is load-bearing (P13): content_hash is sha256 over this output, so
// chunk() must be pure — same input, same chunks, forever. A change to the
// algorithm or the size constants below is a new `version`, which rebuilds the
// vector partition; never silently reuse old vectors against new splitting.

import { listHeadings } from '@notarium/core'

import type { Chunk, Chunker, ChunkInput } from './types'

/** Soft target for one chunk: small sections pack up to this, a larger section
 *  windows at it. ~1800 chars ≈ 450 EN tokens — topically focused without
 *  flooding the index with one-line chunks. A change re-splits every note, so it
 *  rides `version`. Tuning the chunk size on a real corpus is a Stage-4 tail (it
 *  bumps `version` → re-embed); these are principled RAG defaults until then. */
export const TARGET_CHUNK_CHARS = 1800
/** Hard ceiling (the bge-m3 window proxy, the old whole-note budget): a single
 *  section longer than this is windowed into pieces no bigger than this. */
export const MAX_CHUNK_CHARS = 8000
/** Overlap carried between windows of one oversized section so a sentence split
 *  across a boundary still embeds whole in at least one chunk (~11% of target). */
export const OVERLAP_CHARS = 200
/** Cap on a breadcrumb prefix. A crumb is navigation context, not content — a
 *  pathological note (a multi-kB line pasted as a heading) must not let the crumb
 *  eat the whole chunk budget (which would starve windowSplit and blow a chunk
 *  past MAX). Truncated with an ellipsis; the prose under it still chunks in full. */
export const MAX_CRUMB_CHARS = 200

type Section = { crumb: string; content: string }

/** Split a note into heading-delimited sections, each tagged with its breadcrumb
 *  path (the enclosing headings). The lead prose before the first heading is the
 *  title-only section. A heading with no prose of its own contributes no chunk
 *  but still appears in its children's breadcrumbs (via the ancestor stack). */
const buildSections = (title: string, body: string): Section[] => {
  const lines = body.split('\n')
  const headings = listHeadings(body) // doc order, fence-aware (a `#` in ``` is not a heading)
  const sections: Section[] = []

  const crumb = (parts: string[]): string => {
    const c = [title, ...parts]
      .map((p) => p.trim())
      .filter(Boolean)
      .join(' › ')
    return c.length > MAX_CRUMB_CHARS ? `${c.slice(0, MAX_CRUMB_CHARS - 1)}…` : c
  }

  // Lead: prose before the first heading → the breadcrumb is the title alone.
  const firstLine = headings.length ? headings[0].line : lines.length
  const lead = lines.slice(0, firstLine).join('\n').trim()

  if (lead) {
    sections.push({ crumb: crumb([]), content: lead })
  }

  // Each heading owns the lines from just after it to the next heading; the
  // ancestor stack (most recent heading of each lower level) builds the crumb.
  const stack: { level: number; text: string }[] = []

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i]

    while (stack.length && stack[stack.length - 1].level >= h.level) {
      stack.pop()
    }
    const ancestors = stack.map((s) => s.text)
    stack.push({ level: h.level, text: h.text })
    const end = i + 1 < headings.length ? headings[i + 1].line : lines.length
    const content = lines
      .slice(h.line + 1, end)
      .join('\n')
      .trim()
    // A heading with prose → a normal section. A heading with NO prose of its own
    // still carries its TEXT into the embedding via the crumb — but ONLY if its
    // text would otherwise vanish. It reaches a descendant's crumb iff the next
    // heading is deeper (its child); a LEAF heading with no prose has no such
    // carrier, so emit a crumb-only section for it (else its words — a question or
    // a bare index entry, mainstream PKM patterns — would be dropped from the
    // vector channel, regressing recall vs the whole-note chunker). #81 Stage-3 review.
    const carriedByDescendant = i + 1 < headings.length && headings[i + 1].level > h.level

    if (content) {
      sections.push({ crumb: crumb([...ancestors, h.text]), content })
    } else if (!carriedByDescendant) {
      sections.push({ crumb: crumb([...ancestors, h.text]), content: '' })
    }
  }

  return sections
}

/** Break a too-long text into overlapping windows no bigger than `max`, backing
 *  off to the last space near the boundary so a word isn't cut mid-token. Pure
 *  and deterministic. */
const windowSplit = (text: string, max: number): string[] => {
  if (text.length <= max) {
    return [text]
  }
  // Clamp overlap to a quarter of the window so the step (max − overlap) is always
  // a healthy fraction of the window: with OVERLAP_CHARS == max the loop would
  // advance one char per iteration (the start+1 guard) and explode a long section
  // into ~length chunks. (#81 Stage-3 review.)
  const overlap = Math.min(OVERLAP_CHARS, Math.floor(max / 4))
  const out: string[] = []
  let start = 0

  while (start < text.length) {
    let end = Math.min(start + max, text.length)

    if (end < text.length) {
      const ws = text.lastIndexOf(' ', end)

      if (ws > start + max - 80) {
        end = ws
      } // only back off if a space is close to the edge
    }
    const piece = text.slice(start, end).trim()

    if (piece) {
      out.push(piece)
    }
    if (end >= text.length) {
      break
    }
    start = Math.max(end - overlap, start + 1) // overlap, but always advance
  }

  return out
}

export const createHeadingChunker = (): Chunker => ({
  version: 'heading-v1',
  chunk: ({ title, body }: ChunkInput): Chunk[] => {
    const t = title.trim()
    const sections = buildSections(t, body)
    // Crumb-only section (an empty leaf heading): content is '' → the chunk is
    // just the crumb (which carries the heading text). Otherwise crumb + content.
    const decorate = (c: string, content: string): string =>
      content ? (c ? `${c}\n\n${content}` : content) : c
    const pieces: string[] = []
    let buf = ''

    const flush = (): void => {
      if (buf) {
        pieces.push(buf)
      }
      buf = ''
    }

    for (const s of sections) {
      const full = decorate(s.crumb, s.content)

      if (full.length > MAX_CHUNK_CHARS) {
        // Oversized section: window the CONTENT and re-prefix each window with the
        // crumb so every piece stays self-describing (budget leaves room for it).
        flush()
        // Leave room for the crumb so decorate(crumb, window) stays within MAX.
        // The crumb is capped (MAX_CRUMB_CHARS), so the budget is always healthy;
        // the floor is just belt-and-braces for a degenerate config.
        const budget = MAX_CHUNK_CHARS - (s.crumb ? s.crumb.length + 2 : 0)

        for (const w of windowSplit(s.content, Math.max(OVERLAP_CHARS * 2, budget))) {
          pieces.push(decorate(s.crumb, w))
        }
        continue
      }
      if (!buf) {
        buf = full
      } else if (buf.length + 2 + full.length <= TARGET_CHUNK_CHARS) {
        buf = `${buf}\n\n${full}`
      } else {
        flush()
        buf = full
      }
    }
    flush()
    // A note that is all title and no prose (a stub) still embeds its title so it
    // stays findable — matches the whole-note chunker's title-only behaviour.
    if (!pieces.length) {
      return t ? [{ index: 0, text: t }] : []
    }

    return pieces.map((text, index) => ({ index, text }))
  },
})
