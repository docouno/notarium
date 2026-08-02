import { idOf } from '../../../graphId'
import type { PulseGraph, PulseNode } from '../../types'

export type Adjacency = Map<string, string[]>

// Undirected neighbour index — the walk follows edges regardless of their direction.
export const buildAdjacency = (links: PulseGraph['links']): Adjacency => {
  const adj: Adjacency = new Map()

  for (const l of links) {
    const s = idOf(l.source)
    const t = idOf(l.target)

    if (!adj.has(s)) {
      adj.set(s, [])
    }

    if (!adj.has(t)) {
      adj.set(t, [])
    }
    adj.get(s)!.push(t)
    adj.get(t)!.push(s)
  }

  return adj
}

// Walk the graph in step with a melody: each note hops to a random neighbour of
// the current node (no immediate backtrack), so the light "plays" the graph along
// real edges; a dead end teleports to a random node. Starts at the biggest hub.
export const buildPath = (
  nodes: readonly PulseNode[],
  adj: Adjacency,
  count: number,
): (string | undefined)[] => {
  if (!nodes.length) {
    return []
  }
  const rnd = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]
  let cur = nodes.reduce((a, b) => ((b.degree || 0) > (a.degree || 0) ? b : a), nodes[0]).id
  let prev: string | null = null
  const path: string[] = []

  for (let i = 0; i < count; i++) {
    path.push(cur)
    const neigh = (adj.get(cur) || []).filter((id) => id !== prev)
    const next = neigh.length ? rnd(neigh) : rnd(nodes).id
    prev = cur
    cur = next
  }

  return path
}
