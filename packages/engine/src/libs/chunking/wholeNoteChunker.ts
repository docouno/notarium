// Whole-note chunker — the Stage-1 (#81) default: the entire note is one chunk.
// bge-m3 has an 8192-token window, so most notes embed whole and the chunking
// problem is deferred (the deliberate reason bge-m3 was chosen as the default,
// #81 decisions). A note longer than the window is TRUNCATED, not split — coarse
// on purpose; the heading-first chunker (Stage 3) is what makes long notes whole
// again, behind the same seam with a bumped `version`.

import type { Chunk, Chunker, ChunkInput } from './types'

/** Character budget for one chunk. A coarse proxy for bge-m3's 8192-token
 *  window: tokens-per-char varies wildly by script (≈4 for English prose, ≈1 for
 *  CJK), so this is set conservatively below the worst case rather than tuned —
 *  the transformer truncates internally anyway, and Stage 3's real chunker
 *  retires the whole-note truncation. A change here is a splitting change, so it
 *  rides `version`. */
export const CHUNK_CHAR_BUDGET = 8000

/** The text fed to the embedder: the title leads the body so a note whose
 *  meaning lives mostly in its title (a stub, a definition) still embeds with
 *  that signal. bge-m3 is symmetric (no query/passage prefix), so the seam's
 *  `kind` is a no-op here — the embedder owns that, not the chunker. */
const embedSource = ({ title, body }: ChunkInput): string => {
  const t = title.trim()
  const b = body.trim()

  if (t && b) {
    return `${t}\n\n${b}`
  }

  return t || b
}

export const createWholeNoteChunker = (): Chunker => ({
  version: 'whole-v1',
  chunk: (input: ChunkInput): Chunk[] => {
    const text = embedSource(input)

    if (!text) {
      return []
    }

    return [{ index: 0, text: text.slice(0, CHUNK_CHAR_BUDGET) }]
  },
})
