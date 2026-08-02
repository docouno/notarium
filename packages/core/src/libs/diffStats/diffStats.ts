// Character add/remove counters for a revision against its chain parent.
// Computed ONCE at journal-append time (off the request path) and stored on
// the revision row — the timeline then shows "+N −M" without ever shipping or
// diffing bodies per list request. Word-level segmentation (the same family
// the UI diff uses), counted in characters.

import { diffWordsWithSpace } from 'diff'

export type DiffStats = { charsAdded: number; charsRemoved: number }

/** Inputs past this combined size skip the O(N·D) diff — an honest null
 *  (the wire/UI treat absent stats as "unknown") beats stalling the journal
 *  queue on a megabyte-scale paste. */
const MAX_DIFF_CHARS = 1_000_000

export const diffStats = (before: string, after: string): DiffStats | null => {
  if (before.length + after.length > MAX_DIFF_CHARS) {
    return null
  }
  let charsAdded = 0
  let charsRemoved = 0

  for (const part of diffWordsWithSpace(before, after)) {
    if (part.added) {
      charsAdded += part.value.length
    } else if (part.removed) {
      charsRemoved += part.value.length
    }
  }

  return { charsAdded, charsRemoved }
}
