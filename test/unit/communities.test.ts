import { describe, expect, it } from 'vitest'
import { computeCommunities } from '@notarium/core'

// computeCommunities runs Louvain over the real notes of the graph (#25). The
// contract that matters for a stable colour "lens": same input → same output
// (seeded RNG), singletons dropped, community ids ordered by size descending.

type N = { id: string; ghost?: boolean }
type L = { source: string; target: string }

// Two disjoint cliques of different sizes: {a,b,c,d} (4) and {e,f,g} (3).
const clique = (ids: string[]): L[] => {
  const links: L[] = []

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      links.push({ source: ids[i], target: ids[j] })
    }
  }

  return links
}

const NODES: N[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => ({ id }))
const LINKS: L[] = [...clique(['a', 'b', 'c', 'd']), ...clique(['e', 'f', 'g'])]

describe('computeCommunities', () => {
  it('splits the two cliques into two communities', () => {
    const m = computeCommunities(NODES, LINKS)

    // every member resolved
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      expect(m.has(id)).toBe(true)
    }
    // a/b/c/d share one id, e/f/g share another, and the two differ
    expect(new Set(['a', 'b', 'c', 'd'].map((x) => m.get(x))).size).toBe(1)
    expect(new Set(['e', 'f', 'g'].map((x) => m.get(x))).size).toBe(1)
    expect(m.get('a')).not.toBe(m.get('e'))
  })

  it('orders community ids by size: 0 = the largest cluster', () => {
    const m = computeCommunities(NODES, LINKS)
    expect(m.get('a')).toBe(0) // the 4-node clique
    expect(m.get('e')).toBe(1) // the 3-node clique
  })

  it('is deterministic across runs (seeded RNG, no Math.random drift)', () => {
    const a = computeCommunities(NODES, LINKS)
    const b = computeCommunities(NODES, LINKS)
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort())
  })

  it('drops singletons — an isolated note has no entry', () => {
    const nodes = [...NODES, { id: 'lonely' }]
    const m = computeCommunities(nodes, LINKS)
    expect(m.has('lonely')).toBe(false)
  })

  it('excludes ghost nodes from membership', () => {
    const nodes = [...NODES, { id: 'ghost:x', ghost: true }]
    const links = [...LINKS, { source: 'a', target: 'ghost:x' }]
    const m = computeCommunities(nodes, links)
    expect(m.has('ghost:x')).toBe(false)
  })

  it('returns an empty map for an empty graph', () => {
    expect(computeCommunities([], []).size).toBe(0)
  })
})
