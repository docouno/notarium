import { describe, expect, it } from 'vitest'
import { buildAdjacency, buildPath } from './walk'

const nodes = [
  { id: 'a', degree: 3 },
  { id: 'b', degree: 1 },
  { id: 'c', degree: 1 },
  { id: 'd', degree: 1 },
]
const links = [
  { source: 'a', target: 'b' },
  { source: 'a', target: 'c' },
  { source: { id: 'a' }, target: { id: 'd' } }, // hydrated by the force engine
]

describe('buildAdjacency', () => {
  it('indexes both directions and accepts hydrated endpoints', () => {
    const adj = buildAdjacency(links)
    expect(adj.get('a')).toEqual(['b', 'c', 'd'])
    expect(adj.get('b')).toEqual(['a'])
    expect(adj.get('d')).toEqual(['a'])
  })

  it('is empty for a graph with no edges', () => {
    expect(buildAdjacency([]).size).toBe(0)
  })
})

describe('buildPath', () => {
  it('starts at the biggest hub and yields exactly one node per note', () => {
    const path = buildPath(nodes, buildAdjacency(links), 10)
    expect(path).toHaveLength(10)
    expect(path[0]).toBe('a')
    expect(path.every((id) => typeof id === 'string')).toBe(true)
  })

  it('walks real edges, teleporting only out of dead ends', () => {
    // The light is supposed to travel the graph, not hop at random: every step is
    // a neighbour of the last, EXCEPT where the only way on is back the way it came
    // (a leaf), which is the one case the walk is allowed to jump.
    const adj = buildAdjacency(links)
    const path = buildPath(nodes, adj, 30)

    for (let i = 1; i < path.length; i++) {
      const from = path[i - 1]!
      const cameFrom = i >= 2 ? path[i - 2] : null
      const onwards = (adj.get(from) || []).filter((id) => id !== cameFrom)
      const stepped = onwards.includes(path[i]!)
      expect(stepped || onwards.length === 0).toBe(true)
    }
  })

  it('keeps going on a graph with no edges at all (teleports instead of stalling)', () => {
    const path = buildPath(nodes, new Map(), 5)
    expect(path).toHaveLength(5)
    expect(path.every((id) => nodes.some((n) => n.id === id))).toBe(true)
  })

  it('handles a single node and an empty graph', () => {
    expect(buildPath([{ id: 'solo' }], new Map(), 3)).toEqual(['solo', 'solo', 'solo'])
    expect(buildPath([], new Map(), 3)).toEqual([])
  })
})
