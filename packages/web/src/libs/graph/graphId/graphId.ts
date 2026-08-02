import type { GraphNodeView as GraphNode } from '../../wire'

// A graph link endpoint: a node id on the wire, which react-force-graph hydrates
// into the node object reference in place. The renderer also exposes ids as
// `string | number`, so accept the full set and normalise to a string id.
export type GraphRef = string | number | GraphNode | { id?: string | number } | null | undefined

// Normalise a link endpoint to its node id, whether it is still the raw id from
// the wire or the hydrated node object the force layout swapped in.
export const idOf = (x: GraphRef): string =>
  x != null && typeof x === 'object' ? String(x.id) : String(x)
