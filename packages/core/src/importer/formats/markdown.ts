// A dropped plain-text / markdown FILE → one note: imported verbatim as a single note, not
// run through the JSON content-detector (a markdown body can start with `{`/`[`, so the extension is
// the reliable signal). The file's own text IS the body. Title precedence mirrors the editor's
// body-first model: a leading `# H1` wins (lifted out of the body — the write path re-adds the
// storage heading), else the filename (sans extension) — so an Obsidian note (filename == title, no
// H1) or a `.txt` imports with the right title.

import { IMPORT_SOURCE } from '../consts'
import { cappedSlug, shortHash } from '../helpers/format'
import type { ImportNote } from '../types'

/** A leading YAML frontmatter block (`---\n…\n---`). v1 STRIPS it rather than
 *  merging it (the write path serialises its own frontmatter, so re-emitting the
 *  source block would double it / render as a stray rule). Lifting frontmatter
 *  metadata (title/tags/created) into the note is a deliberate follow-up. The
 *  closing `---` is required, so a lone `---` thematic break is not mistaken for
 *  frontmatter. */
const FRONTMATTER = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/

/** A leading `# Heading` on the first non-empty line → the note title (lifted out
 *  of the body). Only the FIRST content line counts (body-first altitude), so a
 *  `#tag` mid-document or a later heading is left in the body. The capture is a
 *  GREEDY `.+` (dot excludes newlines) with NO overlapping trailing `[ \t]*` — a
 *  lazy capture next to a trailing space-run backtracks quadratically on a long
 *  first line (a ReDoS on a big single-line drop); the caller `.trim()`s instead. */
const LEADING_H1 = /^[ \t]*#[ \t]+(.+)(?:\r?\n|$)/

/** Strip the extension from an upload's basename for the title fallback
 *  (`My Note.md` → `My Note`). Only a known text extension is peeled so a dotted
 *  name (`v1.2 notes`) keeps its dots. */
const baseTitle = (fileName: string): string => {
  const base = fileName.split('/').pop() ?? fileName
  return base.replace(/\.(md|markdown|mdown|mkd|txt|text)$/i, '').trim() || base
}

/** One dropped text file → one note. `raw` is the file's text, `fileName` its
 *  original name (used for the title fallback and the deterministic storage
 *  filename). Pure and deterministic — a re-drop of the same file lands on the
 *  same path (idempotent, slug of the basename), so `skipExisting` can no-op it.
 *  `directory` is '' — the host nests it under the drop target folder (`root`). */
export const markdownFileToNote = (
  raw: string,
  fileName: string,
  createdAt?: string,
): ImportNote => {
  let body = raw.replace(/^\uFEFF/, '')
  const fm = body.match(FRONTMATTER)

  if (fm) {
    body = body.slice(fm[0].length)
  }
  body = body.replace(/^(?:\r?\n)+/, '') // drop blank lines the frontmatter left behind

  const fallback = baseTitle(fileName) || 'Untitled'
  let title = fallback
  const h1 = body.match(LEADING_H1)

  if (h1) {
    title = h1[1].trim() || fallback
    body = body.slice(h1[0].length).replace(/^(?:\r?\n)+/, '')
  }

  return {
    title,
    // trimEnd (native, linear) — NOT `/\s+$/` which is a quadratic-backtracking
    // ReDoS on attacker-controlled content (a long whitespace run + a trailing char).
    body: body.trimEnd(),
    directory: '',
    // The storage key intentionally keeps the legacy ASCII algebra: changing an
    // importer's deterministic path across an upgrade makes a re-import duplicate its
    // own source. A basename outside that alphabet falls back to the raw source-name
    // hash, so distinct files stay distinct while the note TITLE remains Unicode.
    fileName: cappedSlug(fallback) || `note-${shortHash(fileName)}`,
    createdAt,
    source: IMPORT_SOURCE.file,
  }
}
