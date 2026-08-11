/** Add first-load roots without mutating `prev`; preserve its identity on a no-op.
 *  @see docs/drag-and-drop.md#5-reveal-expand-the-tree-to-the-active-item */
export const seedTopLevel = (prev: Set<string>, topLevelPaths: readonly string[]): Set<string> => {
  const next = new Set(prev)
  let changed = false

  for (const path of topLevelPaths) {
    if (!next.has(path)) {
      next.add(path)
      changed = true
    }
  }

  return changed ? next : prev
}
