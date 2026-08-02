// Server-side force layout: replay the client's exact force model over
// the snapshot graph so /api/graph ships settled positions and the client
// renders a still map instead of boiling 2k+ nodes in the browser's main
// thread. Pure d3-force, no DOM; deterministic (d3's phyllotaxis initial
// placement + seeded jiggle, no Math.random), so the same graph always lays
// out the same — and a warm start from the previous run's positions keeps the
// map stable across snapshot rebuilds (delta polls move only what changed).
// canon: docs/core.md#graph-derivation

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationNodeDatum,
} from 'd3-force'
import type { Graph } from '../knowledgeStore'
import {
  CHARGE_DISTANCE_MAX,
  chargeStrength,
  CLUSTER_STRENGTH,
  clusterAngles,
  clusterRingRadius,
  COLLIDE_PAD,
  DEFAULT_SPACING,
  LINK_GAP,
  LINK_STRENGTH,
  MIN_CLUSTER_GROUPS,
  radiusFor,
  VELOCITY_DECAY,
} from '../libs/forceModel'
import type { LayoutOptions, LayoutPositions } from './types'

type SimNode = SimulationNodeDatum & { id: string; degree: number; group: string | null }

const COLD_ALPHA = 1
const COLD_DECAY = 0.0228 // d3's default — ~300 ticks to alphaMin
const WARM_ALPHA = 0.15
const WARM_DECAY = 0.05 // ~100 ticks — relax, don't re-anneal
const ALPHA_MIN = 0.001
const MAX_TICKS = 400
/** Warm-start coverage below which we treat the graph as new and re-anneal. */
const WARM_FRACTION = 0.5

/** Lay the graph out in place (writes x/y onto its nodes) and return the
 *  positions keyed by node id, to warm-start the next rebuild. */
export const layoutGraph = async (
  graph: Graph,
  opts: LayoutOptions = {},
): Promise<LayoutPositions> => {
  const { positions, groupOf, yieldEvery = 25 } = opts

  if (!graph.nodes.length) {
    return new Map()
  }

  let warm = 0
  const simNodes: SimNode[] = graph.nodes.map((n) => {
    const prev = positions?.get(n.id)

    if (prev) {
      warm++
    }

    return {
      id: n.id,
      degree: n.degree,
      group: groupOf ? groupOf(n.id) : null,
      x: prev?.x,
      y: prev?.y,
    }
  })
  const byId = new Map(simNodes.map((n) => [n.id, n]))

  // Seed each NEW node at the centroid of its already-placed neighbours: a
  // note added by the delta poll pops up next to what it links to instead of
  // flying in from the phyllotaxis spiral at the world origin.
  if (warm > 0 && warm < simNodes.length) {
    seedAtPlacedNeighbours(simNodes, graph.links)
  }

  const spacing = DEFAULT_SPACING
  let maxDegree = 0

  for (const n of simNodes) {
    if (n.degree > maxDegree) {
      maxDegree = n.degree
    }
  }
  const radiusOf = (n: SimNode) => radiusFor(n.degree, maxDegree)

  // The anchor-ring clustering, mirroring the client: engage only past
  // MIN_CLUSTER_GROUPS; ungrouped nodes anchor to the centre (0).
  const groups = simNodes.map((n) => n.group).filter((g): g is string => g != null)
  const doCluster = new Set(groups).size >= MIN_CLUSTER_GROUPS
  const angleOf = clusterAngles(groups)
  const ringR = clusterRingRadius(simNodes.length, spacing)

  const anchor = (n: SimNode, fn: (a: number) => number) => {
    const a = n.group == null ? undefined : angleOf.get(n.group)
    return a == null ? 0 : fn(a) * ringR
  }

  const links = graph.links.map((l) => ({ source: l.source, target: l.target }))
  const sim = forceSimulation<SimNode>(simNodes)
    .force(
      'link',
      forceLink<SimNode, { source: string | SimNode; target: string | SimNode }>(links)
        .id((n) => n.id)
        .distance(
          (l) => radiusOf(l.source as SimNode) + radiusOf(l.target as SimNode) + LINK_GAP * spacing,
        )
        .strength(LINK_STRENGTH),
    )
    .force(
      'charge',
      forceManyBody<SimNode>()
        .strength((n) => chargeStrength(n) * spacing)
        .distanceMax(CHARGE_DISTANCE_MAX),
    )
    .force('center', forceCenter())
    .force(
      'collide',
      forceCollide<SimNode>()
        .radius((n) => radiusOf(n) + COLLIDE_PAD * spacing)
        .iterations(2),
    )
    .force(
      'x',
      forceX<SimNode>((n) => anchor(n, Math.cos)).strength(doCluster ? CLUSTER_STRENGTH : 0),
    )
    .force(
      'y',
      forceY<SimNode>((n) => anchor(n, Math.sin)).strength(doCluster ? CLUSTER_STRENGTH : 0),
    )
    .velocityDecay(VELOCITY_DECAY)
    .alphaMin(ALPHA_MIN)
    .stop()

  const reAnneal = warm / simNodes.length < WARM_FRACTION
  sim.alpha(reAnneal ? COLD_ALPHA : WARM_ALPHA)
  sim.alphaDecay(reAnneal ? COLD_DECAY : WARM_DECAY)

  for (let tick = 0; sim.alpha() > ALPHA_MIN && tick < MAX_TICKS; tick++) {
    sim.tick()
    if (yieldEvery > 0 && tick % yieldEvery === yieldEvery - 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  const out = new Map<string, { x: number; y: number }>()

  for (const node of graph.nodes) {
    const sn = byId.get(node.id)

    if (!sn || !Number.isFinite(sn.x) || !Number.isFinite(sn.y)) {
      continue
    }
    // Round to 0.1px: meaningless precision bloats the wire payload (~14k
    // coordinates) for positions a live simulation will jiggle anyway.
    node.x = Math.round(sn.x! * 10) / 10
    node.y = Math.round(sn.y! * 10) / 10
    out.set(node.id, { x: node.x, y: node.y })
  }

  return out
}

/** Seed every node without a position at the centroid of its placed
 *  neighbours, plus a small deterministic offset so coincident spawns don't
 *  stack. Mutates x/y in place; nodes with no placed neighbour are left
 *  untouched (the caller decides their fallback). Shared by the full layout's
 *  warm start above and the SWR stale-graph path, which places
 *  newcomers without running a single simulation tick. */
export const seedAtPlacedNeighbours = <N extends { id: string; x?: number; y?: number }>(
  nodes: N[],
  links: Array<{ source: string; target: string }>,
): void => {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const sums = new Map<string, { x: number; y: number; n: number }>()

  const add = (id: string, other: N) => {
    if (other.x == null || other.y == null) {
      return
    }
    const s = sums.get(id) ?? { x: 0, y: 0, n: 0 }
    s.x += other.x
    s.y += other.y
    s.n++
    sums.set(id, s)
  }

  for (const l of links) {
    const s = byId.get(l.source)
    const t = byId.get(l.target)

    if (!s || !t) {
      continue
    }
    if (s.x == null) {
      add(s.id, t)
    }
    if (t.x == null) {
      add(t.id, s)
    }
  }
  for (const node of nodes) {
    if (node.x != null) {
      continue
    }
    const s = sums.get(node.id)

    if (!s || !s.n) {
      continue
    }
    const jitter = hash01(node.id) * 2 * Math.PI
    node.x = s.x / s.n + Math.cos(jitter) * 30
    node.y = s.y / s.n + Math.sin(jitter) * 30
  }
}

/** Deterministic [0,1) from a string — the jitter seed (no Math.random). */
export const hash01 = (s: string): number => {
  let h = 2166136261

  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }

  return (h >>> 0) / 4294967296
}
