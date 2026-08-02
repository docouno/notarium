import type { GraphNodeView as GraphNode } from '../../wire'

const nameOf = (n: GraphNode) => n.title || n.id

// Search over the *visible* graph (client-side, no backend) so every match is
// actually focusable. `ids` drives the canvas spotlight (all matches), `list` is the
// ranked result set (title-prefix first, then hubs), and `hidden` counts matches the
// active filters are keeping out of view — surfaced as a hint so a "no result" for a
// note you know exists is explained rather than mysterious.
export const scanGraph = (
  nodes: GraphNode[],
  scanQuery: string,
  visibleIds: Set<string> | null,
): { ids: Set<string> | null; list: GraphNode[]; hidden: number } => {
  const q = scanQuery.trim().toLowerCase()

  if (!q) {
    return { ids: null, list: [], hidden: 0 }
  }
  const ids = new Set<string>()
  const visible: GraphNode[] = []
  let hiddenCount = 0

  for (const n of nodes) {
    if (!nameOf(n).toLowerCase().includes(q)) {
      continue
    }
    if (visibleIds && !visibleIds.has(n.id)) {
      hiddenCount++
      continue
    }
    ids.add(n.id)
    visible.push(n)
  }
  // The whole match set, ranked (title-prefix first, then hubs) — the aside is a
  // dedicated scrolling panel now, so there's no dropdown cap; show them all.
  const list = [...visible].sort((a, b) => {
    const sa = nameOf(a).toLowerCase().startsWith(q) ? 0 : 1
    const sb = nameOf(b).toLowerCase().startsWith(q) ? 0 : 1
    return sa - sb || (b.degree || 0) - (a.degree || 0)
  })
  return { ids, list, hidden: hiddenCount }
}
