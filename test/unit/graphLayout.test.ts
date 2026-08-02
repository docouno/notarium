// The server-side graph enrichment (#62): communities + force layout on the
// snapshot. What matters and is pinned here: every node leaves with a position;
// the result is deterministic (same graph → same layout, across "restarts");
// a warm start keeps the existing map still while seeding new nodes near their
// neighbours; and the cache layer (CachedStore) serves one enriched object per
// snapshot revision, dropping it when the snapshot moves.

import { describe, expect, it, vi } from 'vitest'
import type { Graph } from '@notarium/core'
import { CachedStore, enrichGraph, layoutGraph } from '@notarium/core'
import { InMemoryStore, type StoreSnapshot } from '@notarium/engine-memory'

const node = (id: string, degree = 1) => ({
  id,
  title: id,
  filePath: `${id}.md`,
  folder: '',
  ghost: false as const,
  degree,
})

const link = (source: string, target: string) => ({ source, target, type: 'links_to' })

const allPositioned = (g: Graph): boolean =>
  g.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))

/** Two triangles bridged by one edge — two clear Louvain communities. */
const twoCliques = (): Graph => ({
  nodes: ['a1', 'a2', 'a3', 'b1', 'b2', 'b3'].map((id) => node(id, 2)),
  links: [
    link('a1', 'a2'),
    link('a2', 'a3'),
    link('a3', 'a1'),
    link('b1', 'b2'),
    link('b2', 'b3'),
    link('b3', 'b1'),
    link('a1', 'b1'),
  ],
})

describe('layoutGraph', () => {
  it('gives every node a finite position', async () => {
    const g = twoCliques()
    await layoutGraph(g, { yieldEvery: 0 })
    for (const n of g.nodes) {
      expect(Number.isFinite(n.x)).toBe(true)
      expect(Number.isFinite(n.y)).toBe(true)
    }
  })

  it('is deterministic: the same graph lays out identically twice', async () => {
    const g1 = twoCliques()
    const g2 = twoCliques()
    await layoutGraph(g1, { yieldEvery: 0 })
    await layoutGraph(g2, { yieldEvery: 0 })
    for (let i = 0; i < g1.nodes.length; i++) {
      expect(g1.nodes[i].x).toBe(g2.nodes[i].x)
      expect(g1.nodes[i].y).toBe(g2.nodes[i].y)
    }
  })

  it('warm start holds existing nodes near their spots and seeds a new node by its neighbours', async () => {
    const g = twoCliques()
    const positions = await layoutGraph(g, { yieldEvery: 0 })

    const grown: Graph = {
      nodes: [...twoCliques().nodes, node('a4', 1)],
      links: [...twoCliques().links, link('a4', 'a1')],
    }
    await layoutGraph(grown, { positions, yieldEvery: 0 })

    // Existing nodes relax, not re-anneal: they stay in the neighbourhood of
    // where they were (well under the cold layout's typical travel).
    for (const n of grown.nodes) {
      const prev = positions.get(n.id)

      if (!prev) {
        continue
      }
      const dist = Math.hypot(n.x! - prev.x, n.y! - prev.y)
      expect(dist).toBeLessThan(150)
    }
    // The new node lands near the note it links to, not at the world origin's
    // phyllotaxis spiral.
    const a1 = grown.nodes.find((n) => n.id === 'a1')!
    const a4 = grown.nodes.find((n) => n.id === 'a4')!
    expect(Math.hypot(a4.x! - a1.x!, a4.y! - a1.y!)).toBeLessThan(400)
  })
})

describe('enrichGraph', () => {
  it('ships communities on real nodes and positions on everything, ghosts included', async () => {
    const g: Graph = {
      nodes: [
        ...twoCliques().nodes,
        {
          id: 'ghost:missing',
          title: 'missing',
          ghost: true,
          folder: '',
          degree: 1,
          target: 'missing',
          prefillTitle: 'missing',
        },
      ],
      links: [...twoCliques().links, link('a1', 'ghost:missing')],
    }
    await enrichGraph(g, { yieldEvery: 0 })
    const communities = new Set<number>()

    for (const n of g.nodes) {
      expect(Number.isFinite(n.x)).toBe(true)
      expect(Number.isFinite(n.y)).toBe(true)
      if (!n.ghost && n.community != null) {
        communities.add(n.community)
      }
      if (n.ghost) {
        expect('community' in n && (n as { community?: number }).community).toBeFalsy()
      }
    }
    expect(communities.size).toBe(2) // the two cliques
  })
})

describe('CachedStore graph enrichment cache', () => {
  const FIXTURE: StoreSnapshot = {
    space: 'main',
    now: '2026-06-10T12:00:00.000Z',
    notes: [
      {
        title: 'Alpha',
        filePath: 'demo/alpha.md',
        content: 'links [[Beta]]',
        modifiedAt: '2026-06-01T00:00:00.000Z',
        createdAt: null,
      },
      {
        title: 'Beta',
        filePath: 'demo/beta.md',
        content: 'plain',
        modifiedAt: '2026-06-02T00:00:00.000Z',
        createdAt: null,
      },
    ],
  }

  const make = async () => {
    const store = new CachedStore({
      inner: new InMemoryStore(FIXTURE),
      pollIntervalMs: 0,
      relationType: 'links_to',
      now: () => new Date('2026-06-11T12:00:00Z'),
    })
    await store.start()
    return store
  }

  const waitForPositionedGraph = async (store: CachedStore): Promise<Graph> => {
    let graph = await store.graph()
    await vi.waitFor(async () => {
      graph = await store.graph()
      expect(allPositioned(graph)).toBe(true)
    })
    return graph
  }

  it('serves positioned nodes and reuses the enriched graph until the snapshot changes', async () => {
    const store = await make()
    const g1 = await waitForPositionedGraph(store)
    // Unchanged snapshot → the SAME object (no recompute per request).
    expect(await store.graph()).toBe(g1)

    await store.write({ title: 'Gamma', directory: 'demo', content: 'see [[Alpha]]' })
    const g2 = await store.graph()
    expect(g2).not.toBe(g1)
    // Graph node ids are note-ids since #51 — InMemoryStore mints fake-* ones.
    const gamma = g2.nodes.find((n) => n.id === 'fake-demo-gamma')
    expect(gamma).toBeTruthy()
    expect(Number.isFinite(gamma!.x)).toBe(true)
    // Warm start: the pre-existing notes kept (about) their places.
    const before = new Map(g1.nodes.map((n) => [n.id, n]))

    for (const n of g2.nodes) {
      const prev = before.get(n.id)

      if (!prev) {
        continue
      }
      expect(Math.hypot(n.x! - prev.x!, n.y! - prev.y!)).toBeLessThan(150)
    }
  })
})
