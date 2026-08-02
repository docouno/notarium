import type { GraphLink, GraphNodeView as GraphNode } from '../../wire'
import { idOf } from '../graphId'

// One link-community, labelled by its most-referenced member (its hub).
export type Cluster = { id: number; size: number; repDeg: number; label: string }
// A cluster with the palette colour its notes carry on the canvas (undefined when
// no colour is assigned to that community).
export type ClusterWithColor = Cluster & { color: string | undefined }

// In-degree (how referenced) per node, over the full graph — drives the hubs
// filter and is the same signal the canvas sizes nodes by.
export const computeInDegree = (links: GraphLink[]): Map<string, number> => {
  const m = new Map<string, number>()

  for (const l of links) {
    const t = idOf(l.target)
    m.set(t, (m.get(t) || 0) + 1)
  }

  return m
}

// In-degree distribution over real notes (bucket d = how many notes have exactly
// d incoming links) — the histogram behind the "Min links in" slider. Callers pass
// the already-computed maxInDeg so the array is sized in one place.
export const inDegHistogram = (
  nodes: GraphNode[],
  inDeg: Map<string, number>,
  maxInDeg: number,
): number[] => {
  const arr = new Array(maxInDeg + 1).fill(0)

  for (const n of nodes) {
    if (!n.ghost) {
      arr[inDeg.get(n.id) || 0]++
    }
  }

  return arr
}

// Link-communities (Louvain) re-indexed from each node's `community` (computed
// server-side since #62) into the map the filters/colours read.
export const computeCommunityMap = (nodes: GraphNode[]): Map<string, number> => {
  const m = new Map<string, number>()

  for (const n of nodes) {
    if (!n.ghost && n.community != null) {
      m.set(n.id, n.community)
    }
  }

  return m
}

// Cluster list — each cluster labelled by its most-referenced member (its hub), so
// "cluster around Roadmap 2026" reads instead of "community 3". Drives BOTH the
// canvas colour legend (when grouping by clusters) and the aside cluster filter.
export const buildClusterList = (
  nodes: GraphNode[],
  communityMap: Map<string, number>,
  inDeg: Map<string, number>,
  communityColors: Map<number, string>,
): ClusterWithColor[] => {
  const byCom = new Map<number, Cluster>()

  for (const n of nodes) {
    const c = communityMap.get(n.id)

    if (c === undefined) {
      continue
    }
    const deg = inDeg.get(n.id) || 0
    const cur = byCom.get(c)

    if (!cur) {
      byCom.set(c, { id: c, size: 1, repDeg: deg, label: n.title || n.id })
    } else {
      cur.size++
      if (deg > cur.repDeg) {
        cur.repDeg = deg
        cur.label = n.title || n.id
      }
    }
  }

  return [...byCom.values()]
    .sort((a, b) => a.id - b.id)
    .map((c) => ({ ...c, color: communityColors.get(c.id) }))
}

// Notes that point at a ghost — the "only with unresolved" subset.
export const computeLinksToGhost = (nodes: GraphNode[], links: GraphLink[]): Set<string> => {
  const set = new Set<string>()
  const ghostIds = new Set(nodes.filter((n) => n.ghost).map((n) => n.id))

  for (const l of links) {
    if (ghostIds.has(idOf(l.target))) {
      set.add(idOf(l.source))
    }
  }

  return set
}

// The focal node's real links over the whole graph, resolved to their nodes and
// title-sorted — the textual companion to the canvas "star".
export const computeFocusNeighbors = (
  nodes: GraphNode[],
  links: GraphLink[],
  focusId: string,
): GraphNode[] => {
  const ids = new Set<string>()

  for (const l of links) {
    const s = idOf(l.source),
      t = idOf(l.target)

    if (s === focusId) {
      ids.add(t)
    } else if (t === focusId) {
      ids.add(s)
    }
  }
  const byId = new Map(nodes.map((n) => [n.id, n]))
  return [...ids]
    .map((id) => byId.get(id))
    .filter((n): n is GraphNode => n != null)
    .sort((a, b) => (a.title || a.id).localeCompare(b.title || b.id))
}
