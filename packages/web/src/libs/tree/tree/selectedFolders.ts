// The selected-folder set algebra (#93/#109) — the INCLUSION folder filter shared
// by the Graph (client-side `visibleIds` mask) and the Feed (server `folders`
// channel). A note is shown when its folder is under ANY selected path (subtree-
// prefix), so selecting a parent pulls its whole subtree; an empty set = no filter
// = everything shown. This is the app's one filter language: a click ADDS a folder
// to the focus, never hides — "show only this folder" is just a one-element set.
// Pure, set-returning, unit-tested — the cascade lives in one place, not inline.

/** Is `dir` under any selected subtree — itself or a selected ancestor (prefix
 *  walk)? Root ('') is under no folder, and an empty set selects nothing here, so
 *  both return false; the "no filter ⇒ show all" short-circuit is `folderShown`. */
export const dirSelected = (selected: ReadonlySet<string>, dir: string): boolean => {
  if (!dir || selected.size === 0) {
    return false
  }
  let acc = ''

  for (const part of dir.split('/')) {
    acc = acc ? `${acc}/${part}` : part
    if (selected.has(acc)) {
      return true
    }
  }

  return false
}

/** Is a note in `dir` shown under the folder filter? An empty selection is no
 *  constraint (everything shows); otherwise the note must sit under a selected
 *  subtree. The predicate both the Feed (SSE relevance) and Graph (mask) read. */
export const folderShown = (selected: ReadonlySet<string>, dir: string): boolean =>
  selected.size === 0 || dirSelected(selected, dir)

/** Toggle a folder in/out of the selected set, returning a NEW set (a click adds
 *  it to the filter, another removes it). Selecting a child while its parent is
 *  already selected is harmless — the child is covered by the parent's subtree. */
export const toggleFolder = (selected: ReadonlySet<string>, path: string): Set<string> => {
  const next = new Set(selected)

  if (next.has(path)) {
    next.delete(path)
  } else {
    next.add(path)
  }

  return next
}
