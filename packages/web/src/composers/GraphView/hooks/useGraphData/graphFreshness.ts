import type { GraphView as Graph } from '../../../../libs/wire'

/** Keep only real nodes accepted by the authoritative seen registry and ghosts
 * still referenced by one of those nodes. */
export const filterObservedGraph = (graph: Graph, acceptedIds: ReadonlySet<string>): Graph => {
  const realIds = new Set(
    graph.nodes.filter((node) => !node.ghost && acceptedIds.has(node.id)).map((node) => node.id),
  )
  const ghostIds = new Set(graph.nodes.filter((node) => node.ghost).map((node) => node.id))
  const links = graph.links.filter(
    (link) => realIds.has(link.source) && (realIds.has(link.target) || ghostIds.has(link.target)),
  )
  const usedGhosts = new Set(
    links.filter((link) => ghostIds.has(link.target)).map((link) => link.target),
  )

  return {
    ...graph,
    links,
    nodes: graph.nodes
      .filter((node) => (node.ghost ? usedGhosts.has(node.id) : realIds.has(node.id)))
      .map((node) =>
        node.ghost
          ? {
              ...node,
              sources: node.sources?.filter((source) => !source.id || realIds.has(source.id)),
            }
          : node,
      ),
  }
}
