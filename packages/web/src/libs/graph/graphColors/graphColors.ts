// The minimum a node needs to be coloured: whether it's a ghost and where it
// lives. Loose on purpose so the real GraphNode and the canvas's hydrated nodes
// both fit without importing the full shape.
type GraphNodeLike = { ghost?: boolean; filePath?: string | null }

// Folder-based colouring for the knowledge graph. Notes are grouped by their
// folder so the graph reads as coloured clusters (Obsidian-style "groups") instead
// of one uniform blob — the single biggest structure cue for a dense graph. The
// grouping + palette live here so the canvas renderer and the legend derive
// identical colours from the same node set (pure, deterministic — no prop drilling).

// Group key for a node: the first two path segments of its directory
// ("demo/projects/2024/x.md" → "demo/projects"), so sibling sub-trees share a
// colour. A top-level file ("demo/x.md") groups by its single folder; ghosts and
// pathless nodes have no group.
export const groupKey = (node: GraphNodeLike | null | undefined): string | null => {
  if (!node || node.ghost) {
    return null
  }
  const segs = String(node.filePath || '')
    .split('/')
    .filter(Boolean)
  segs.pop() // drop the filename → directory path
  return groupKeyOfPath(segs.join('/'))
}

// Same grouping rule, but from a directory path instead of a node. Lets the folder
// tree colour each row by the cluster its notes belong to: a folder at/below the
// group depth maps to its own colour; a deeper folder inherits its ancestor
// group's colour (e.g. "demo/archive/2024" → the "demo/archive" hue).
export const groupKeyOfPath = (dir: string): string => {
  const segs = String(dir || '')
    .split('/')
    .filter(Boolean)

  if (segs.length === 0) {
    return 'root'
  }

  return segs.slice(0, 2).join('/')
}

// Map an ordered list of group keys to evenly-spaced hues — the generic palette
// behind every grouping axis (folder, community, …). Hue is assigned by position,
// so the caller controls colour order by how it orders `keys` (folders sorted
// alphabetically; communities by size). Saturation/lightness are tuned per theme
// for legible-but-calm nodes on either background. Returns Map(key -> css colour).
export const buildPalette = <K>(keys: readonly K[], dark: boolean): Map<K, string> => {
  const sat = dark ? 60 : 58
  const light = dark ? 64 : 46
  const map = new Map<K, string>()
  keys.forEach((k, i) => {
    const hue = Math.round((i * 360) / Math.max(1, keys.length))
    map.set(k, `hsl(${hue}, ${sat}%, ${light}%)`)
  })
  return map
}

// Folder palette: the distinct folder groups, sorted so colours stay stable across
// renders (and so a folder keeps its hue when others are filtered out).
export const buildGroupColors = (
  nodes: readonly GraphNodeLike[] | null | undefined,
  dark: boolean,
): Map<string, string> => {
  const keys = [
    ...new Set((nodes || []).map(groupKey).filter((k): k is string => k != null)),
  ].sort()
  return buildPalette(keys, dark)
}
