// Link-communities via Louvain modularity — the "graph-native" grouping:
// clusters that emerge from how notes actually link, independent of how they
// are filed in folders. Computed once per read-model rebuild and shipped
// on the wire (GraphNode.community), so every client agrees on the clustering
// and nobody re-derives it per page load.
// canon: docs/core.md#graph-derivation

import Graph from 'graphology'
import louvain from 'graphology-communities-louvain'

// A node as the community pass reads it: only identity and ghost-ness matter
// (ghosts are excluded from membership).
type CommunityNode = { id: string; ghost?: boolean }
// A link as the community pass reads it: only its endpoints matter. Either may
// be a hydrated node object (the force-graph runtime rewrites them in place),
// so resolve both shapes.
type EndpointRef = string | { id: string }
type CommunityLink = { source: EndpointRef; target: EndpointRef }

const endpointId = (ref: EndpointRef): string => (typeof ref === 'object' ? ref.id : ref)

// Seeded PRNG (mulberry32). Louvain shuffles node order via an RNG that
// defaults to Math.random, so the partition — and thus cluster ids/colours/
// labels — would drift on every rebuild. A fixed seed makes the clustering
// reproducible: the same graph always yields the same clusters, which a
// stable "lens" needs.
const mulberry32 =
  (a: number): (() => number) =>
  () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

// Singletons (isolated notes, or a note Louvain leaves alone) are dropped —
// they'd each claim a hue and blow up the palette/legend for no signal. A
// dropped node has no map entry and falls back to the neutral colour.
//
// Community ids are remapped to a compact, size-descending order (0 = largest
// cluster), so hues are stable across renders and the legend lists the biggest
// clusters first.
//
// Returns Map(nodeId -> communityId:number).
export const computeCommunities = (
  nodes: readonly CommunityNode[] | null | undefined,
  links: readonly CommunityLink[] | null | undefined,
): Map<string, number> => {
  const g = new Graph({ type: 'undirected' })
  const real = new Set<string>()

  for (const n of nodes || []) {
    if (!n.ghost) {
      g.addNode(n.id)
      real.add(n.id)
    }
  }
  for (const l of links || []) {
    const s = endpointId(l.source)
    const t = endpointId(l.target)

    if (s !== t && real.has(s) && real.has(t) && !g.hasEdge(s, t)) {
      g.addEdge(s, t)
    }
  }
  if (g.order === 0) {
    return new Map()
  }

  const raw = louvain(g, { rng: mulberry32(0x1a2b3c4d) }) // { nodeId: communityIndex }

  // Bucket members per raw community, drop singletons, order by size (desc),
  // then by first member id for a deterministic tie-break.
  const buckets = new Map<number, string[]>()

  for (const [id, c] of Object.entries(raw)) {
    if (!buckets.has(c)) {
      buckets.set(c, [])
    }
    buckets.get(c)!.push(id)
  }
  const ordered = [...buckets.values()]
    .filter((m) => m.length > 1)
    .sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1))

  const out = new Map<string, number>()
  ordered.forEach((members, i) => {
    for (const id of members) {
      out.set(id, i)
    }
  })
  return out
}
