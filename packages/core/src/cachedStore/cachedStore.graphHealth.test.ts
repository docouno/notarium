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

describe('CachedStore.graphHealth derivation memo', () => {
  // The engine's graph() materializes every note body and re-derives every edge,
  // synchronously. Measured on the live instance this surface was called 681 times in
  // six hours against a 1236-note space (p50 13.9s) and blocked the shared event loop
  // in ~1.09s bursts, queueing every other request behind it. The memo keeps the FRESH
  // derivation the metric needs while charging for it once per snapshot state.
  const countingEngine = (metas: NoteMeta[], graph: Graph) => {
    const engine = makeEngine(metas, graph)
    let derivations = 0
    const graphFn = engine.graph.bind(engine)

    engine.graph = async (...args: Parameters<KnowledgeStore['graph']>) => {
      derivations += 1
      return graphFn(...args)
    }

    return { engine, derivations: () => derivations }
  }

  const oneNote: Graph = {
    nodes: [{ id: 'a.md', title: 'A', filePath: 'a.md', folder: '', ghost: false, degree: 0 }],
    links: [],
  }

  it('derives once for an unchanged corpus and again after the snapshot moves', async () => {
    const { engine, derivations } = countingEngine([meta('a.md', 'A')], oneNote)
    const store = new CachedStore({ inner: engine, pollIntervalMs: 0 })

    await store.start()

    // Boot adopts an edge baseline through the same engine call, so count from here.
    const booted = derivations()
    const first = await store.graphHealth()

    expect(derivations()).toBe(booted + 1)

    // Repeat on the SAME snapshot: the answer must be identical and free.
    await expect(store.graphHealth()).resolves.toEqual(first)
    await expect(store.graphHealth()).resolves.toEqual(first)
    expect(derivations()).toBe(booted + 1)

    // A rebuild must drop it: the metric describes the corpus, and a stale answer here
    // is a wrong grooming number, not a slow one. `rescan()` is the coarsest mover —
    // it ticks the cache epoch, which the token folds in precisely because `reset()`
    // leaves `rev` alone.
    const beforeRescan = derivations()

    await store.rescan()
    await store.graphHealth()
    expect(derivations()).toBeGreaterThan(beforeRescan)

    store.stop()
    await store.settle()
  })

  it('joins concurrent callers onto one whole-corpus derivation', async () => {
    const { engine, derivations } = countingEngine([meta('a.md', 'A')], oneNote)
    const graphFn = engine.graph.bind(engine)
    let release!: () => void
    let markStarted!: () => void
    let hold = false
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })

    engine.graph = async (...args: Parameters<KnowledgeStore['graph']>) => {
      const result = graphFn(...args)

      if (hold) {
        markStarted()
        await gate
      }

      return result
    }
    const store = new CachedStore({ inner: engine, pollIntervalMs: 0 })

    await store.start()
    const booted = derivations()

    hold = true
    const first = store.graphHealth()
    const second = store.graphHealth()

    await started
    expect(derivations()).toBe(booted + 1)

    release()
    const [firstHealth, secondHealth] = await Promise.all([first, second])

    expect(firstHealth).toBe(secondHealth)
    expect(firstHealth.totalLinks).toBe(0)
    expect(derivations()).toBe(booted + 1)

    store.stop()
    await store.settle()
  })

  it('retries a transient rejection on the same graph revision', async () => {
    const engine = makeEngine([meta('a.md', 'A')], oneNote)
    const store = new CachedStore({ inner: engine, pollIntervalMs: 0 })

    await store.start()
    const graphFn = engine.graph.bind(engine)
    let attempts = 0

    engine.graph = async (...args: Parameters<KnowledgeStore['graph']>) => {
      attempts += 1
      if (attempts === 1) {
        throw new Error('transient graph failure')
      }

      return graphFn(...args)
    }

    await expect(store.graphHealth()).rejects.toThrow('transient graph failure')
    await expect(store.graphHealth()).resolves.toMatchObject({ totalLinks: 0 })
    expect(attempts).toBe(2)

    store.stop()
    await store.settle()
  })

  it('skips hidden upserts but invalidates on empty repairs, visible changes and retractions', async () => {
    const metas = [
      meta('a.md', 'A'),
      meta('.notarium/memory/context.md', 'Context', { class: 'agent-memory' }),
    ]
    const { engine, derivations } = countingEngine(metas, oneNote)
    const store = new CachedStore({ inner: engine, pollIntervalMs: 0 })

    await store.start()
    await store.graphHealth()
    const settled = derivations()
    const rows = await store.list({ scope: 'all' })
    const hiddenId = rows.find((row) => row.class === 'agent-memory')!.id!
    const visibleId = rows.find((row) => row.class !== 'agent-memory')!.id!
    const emitChanged = (upserts: string[], removed: string[] = []) =>
      (
        store as unknown as {
          emit: (event: { type: 'changed'; upserts: string[]; removed: string[] }) => void
        }
      ).emit({ type: 'changed', upserts, removed })

    emitChanged([hiddenId])
    await store.graphHealth()
    expect(derivations()).toBe(settled)

    emitChanged([])
    await store.graphHealth()
    expect(derivations()).toBe(settled + 1)

    emitChanged([visibleId])
    await store.graphHealth()
    expect(derivations()).toBe(settled + 2)

    const internal = store as unknown as {
      snap: { notes: Map<string, NoteMeta> }
    }
    const visible = internal.snap.notes.get(visibleId)!

    internal.snap.notes.set(visibleId, { ...visible, class: 'agent-memory' })
    emitChanged([visibleId])
    await store.graphHealth()
    expect(derivations()).toBe(settled + 3)

    store.stop()
    await store.settle()
  })
})
