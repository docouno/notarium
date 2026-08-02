// Snapshot enrichment: communities + layout in one pass, shared by every
// store that serves /api/graph (the read-model cache and the e2e in-memory
// fake). Mutates the graph in place; returns the positions for the caller to
// warm-start the next rebuild with.
// canon: docs/core.md#graph-derivation

import type { Graph } from '../knowledgeStore'
import { computeCommunities } from './communities'
import { layoutGraph } from './layout'
import type { EnrichOptions, LayoutPositions } from './types'

export const enrichGraph = async (
  graph: Graph,
  opts: EnrichOptions = {},
): Promise<LayoutPositions> => {
  const communities = computeCommunities(graph.nodes, graph.links)

  for (const node of graph.nodes) {
    if (node.ghost) {
      continue
    }
    const c = communities.get(node.id)

    if (c != null) {
      node.community = c
    }
  }

  return layoutGraph(graph, {
    ...opts,
    // Anchor the layout by community — matching the client's default "Group by
    // clusters" view, so its live simulation agrees with these positions and
    // the first drag doesn't yank the map.
    groupOf: (id) => {
      const c = communities.get(id)
      return c == null ? null : String(c)
    },
  })
}
