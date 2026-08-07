import { describe, expect, it } from 'vitest'

import {
  type Graph,
  type KnowledgeStore,
  liveSyncStatus,
  type NoteMeta,
  type StoreDelta,
} from '../knowledgeStore'
import { CachedStore } from './cachedStore'

// Two invariants the cachedStore.graphHealth() comment DECLARES but no test pinned —
// and the first is the seam we caught live (the engine keys its graph by storage
// PATH, every other surface by note-id), so a regression would sail past CI and only
// surface as a card linking to /n/<path> → 404. Exercise the read-model directly.

const meta = (filePath: string, title: string, extra: Partial<NoteMeta> = {}): NoteMeta => ({
  filePath,
  title,
  modifiedAt: null,
  createdAt: null,
  ...extra,
})

const caps = (identity: boolean): KnowledgeStore['capabilities'] => ({
  fts: true,
  vector: false,
  hybrid: false,
  graphExpand: false,
  identity,
  cas: false,
  revisions: false,
  trash: false,
  visibility: false,
  watch: false,
})

/** A bare-engine stub: a fixed inventory + a path-keyed graph (the shape's
 *  identity-agnostic engine actually serves). `identity:false` makes the cachedStore
 *  the registry, so it mints note-ids for the paths — the remap under test. */
const makeEngine = (metas: NoteMeta[], graph: Graph, identity = false): KnowledgeStore => {
  const inner: Partial<KnowledgeStore> = {
    capabilities: caps(identity),
    changes: async (): Promise<StoreDelta> => ({ cursor: '0', upserts: [], inventory: metas }),
    list: async () => metas,
    graph: async () => structuredClone(graph),
    search: async () => [],
    syncStatus: async () => liveSyncStatus(),
  }
  return inner as KnowledgeStore
}

describe('CachedStore.graphHealth path→id remap (#100)', () => {
  it('remaps storage-path node ids to note-ids; synthetic ghost ids pass through', async () => {
    const metas = [meta('hub.md', 'Hub'), meta('gagarin.md', 'Гагарин', { aliases: ['Королёв'] })]
    // Path-keyed graph, exactly as the bare engine derives it: an inbound link
    // resolved through a FORMER name + a dangling link to a ghost.
    const graph: Graph = {
      nodes: [
        { id: 'hub.md', title: 'Hub', filePath: 'hub.md', folder: '', ghost: false, degree: 2 },
        {
          id: 'gagarin.md',
          title: 'Гагарин',
          filePath: 'gagarin.md',
          folder: '',
          ghost: false,
          degree: 1,
        },
        {
          id: 'ghost:nowhere',
          title: 'Nowhere',
          ghost: true,
          folder: '',
          degree: 1,
          target: 'nowhere',
          prefillTitle: 'Nowhere',
          creatable: true,
          sources: [{ id: 'hub.md', title: 'Hub', folder: '' }],
        },
      ],
      links: [
        { source: 'hub.md', target: 'gagarin.md', type: 'links-to', resolvedVia: 'note-alias' },
        { source: 'hub.md', target: 'ghost:nowhere', type: 'links-to' },
      ],
    }
    const cs = new CachedStore({
      inner: makeEngine(metas, graph),
      space: 't',
      pollIntervalMs: 1_000_000,
    })

    try {
      await cs.start()
      const health = await cs.graphHealth()

      // The stale edge survived with its axis…
      expect(health.via).toEqual({ slug: 0, noteAlias: 1, folderAlias: 0 })
      expect(health.staleNamed).toBe(1)
      const edge = health.edges[0]
      expect(edge.via).toBe('note-alias')
      // …but its ids are note-ids now, NOT the storage paths (the regression).
      expect(edge.source.id).not.toBe('hub.md')
      expect(edge.target.id).not.toBe('gagarin.md')
      expect(edge.source.title).toBe('Hub')
      expect(edge.target.title).toBe('Гагарин')

      // Ghost: synthetic id passes through untouched; its source is remapped, and
      // consistently to the SAME id the edge's source got (one note → one id).
      const ghost = health.ghosts[0]
      expect(ghost.id).toBe('ghost:nowhere')
      expect(ghost.target).toBe('nowhere')
      expect(ghost.refCount).toBe(1)
      expect(ghost.sources[0].id).toBe(edge.source.id)
    } finally {
      cs.stop()
    }
  })

  it('leaves an already-note-id-keyed graph (identity engine / e2e fake) untouched', async () => {
    const metas = [
      meta('hub.md', 'Hub', { id: 'n-hub' }),
      meta('gag.md', 'Гагарин', { id: 'n-gag' }),
    ]
    const graph: Graph = {
      nodes: [
        { id: 'n-hub', title: 'Hub', filePath: 'hub.md', folder: '', ghost: false, degree: 1 },
        { id: 'n-gag', title: 'Гагарин', filePath: 'gag.md', folder: '', ghost: false, degree: 1 },
      ],
      links: [{ source: 'n-hub', target: 'n-gag', type: 'links-to', resolvedVia: 'note-alias' }],
    }
    const cs = new CachedStore({
      inner: makeEngine(metas, graph, true),
      space: 't',
      pollIntervalMs: 1_000_000,
    })

    try {
      await cs.start()
      const health = await cs.graphHealth()
      // idFor has no path to match an opaque note-id → the id passes through verbatim.
      expect(health.edges[0].source.id).toBe('n-hub')
      expect(health.edges[0].target.id).toBe('n-gag')
    } finally {
      cs.stop()
    }
  })

  it('never leaks agent-memory link-text into the metric or the ghost list (#78)', async () => {
    const metas = [
      meta('pub.md', 'Public'),
      meta('gagarin.md', 'Гагарин', { aliases: ['Королёв'] }),
      meta('.notarium/memory/secret.md', 'Secret', { class: 'agent-memory' }),
    ]
    // A visible note links a renamed note (counts), and a HIDDEN agent-memory note
    // links a private codename (a ghost). The codename must not reach the user graph.
    const graph: Graph = {
      nodes: [
        {
          id: 'pub.md',
          title: 'Public',
          filePath: 'pub.md',
          folder: '',
          ghost: false,
          degree: 1,
          class: 'user-doc',
        },
        {
          id: 'gagarin.md',
          title: 'Гагарин',
          filePath: 'gagarin.md',
          folder: '',
          ghost: false,
          degree: 1,
          class: 'user-doc',
        },
        {
          id: '.notarium/memory/secret.md',
          title: 'Secret',
          filePath: '.notarium/memory/secret.md',
          folder: '.notarium',
          ghost: false,
          degree: 1,
          class: 'agent-memory',
        },
        {
          id: 'ghost:secret-codename',
          title: 'Secret Codename',
          ghost: true,
          folder: '',
          degree: 1,
          target: 'secret-codename',
          prefillTitle: 'Secret Codename',
          creatable: true,
          sources: [{ id: '.notarium/memory/secret.md', title: 'Secret', folder: '.notarium' }],
        },
      ],
      links: [
        { source: 'pub.md', target: 'gagarin.md', type: 'links-to', resolvedVia: 'note-alias' },
        { source: '.notarium/memory/secret.md', target: 'ghost:secret-codename', type: 'links-to' },
      ],
    }
    const cs = new CachedStore({
      inner: makeEngine(metas, graph),
      space: 't',
      pollIntervalMs: 1_000_000,
    })

    try {
      await cs.start()
      const health = await cs.graphHealth()
      // Only the visible link counts; the hidden note's edge is gone…
      expect(health.staleNamed).toBe(1)
      expect(health.totalLinks).toBe(1)
      expect(health.edges).toHaveLength(1)
      expect(health.edges[0].target.title).toBe('Гагарин')
      // …and the orphaned ghost carrying the agent's private link-text is dropped.
      expect(health.ghosts.some((g) => g.target === 'secret-codename')).toBe(false)
      expect(health.ghosts).toHaveLength(0)
    } finally {
      cs.stop()
    }
  })

  it('scrubs a hidden source off a MIXED ghost (reached from both a hidden and a visible note) (#78)', async () => {
    const metas = [
      meta('pub.md', 'Public'),
      meta('.notarium/memory/secret.md', 'Secret', { class: 'agent-memory' }),
    ]
    // Both a visible note and a hidden agent-memory note dangle at the same ghost.
    // The visible edge keeps the ghost alive — but the hidden note must NOT appear
    // in its backlink sources (that would leak the agent note's id/title).
    const graph: Graph = {
      nodes: [
        {
          id: 'pub.md',
          title: 'Public',
          filePath: 'pub.md',
          folder: '',
          ghost: false,
          degree: 1,
          class: 'user-doc',
        },
        {
          id: '.notarium/memory/secret.md',
          title: 'Secret',
          filePath: '.notarium/memory/secret.md',
          folder: '.notarium',
          ghost: false,
          degree: 1,
          class: 'agent-memory',
        },
        {
          id: 'ghost:shared',
          title: 'Shared',
          ghost: true,
          folder: '',
          degree: 2,
          target: 'shared',
          prefillTitle: 'Shared',
          creatable: true,
          sources: [
            { id: 'pub.md', title: 'Public', folder: '' },
            { id: '.notarium/memory/secret.md', title: 'Secret', folder: '.notarium' },
          ],
        },
      ],
      links: [
        { source: 'pub.md', target: 'ghost:shared', type: 'links-to' },
        { source: '.notarium/memory/secret.md', target: 'ghost:shared', type: 'links-to' },
      ],
    }
    const cs = new CachedStore({
      inner: makeEngine(metas, graph),
      space: 't',
      pollIntervalMs: 1_000_000,
    })

    try {
      await cs.start()
      const health = await cs.graphHealth()
      const ghost = health.ghosts.find((g) => g.target === 'shared')
      expect(ghost).toBeTruthy() // survives — a visible note still points at it
      expect(ghost!.refCount).toBe(1)
      expect(ghost!.sources).toHaveLength(1)
      expect(ghost!.sources[0].title).toBe('Public')
      expect(ghost!.sources.some((s) => s.title === 'Secret')).toBe(false)
    } finally {
      cs.stop()
    }
  })
})
