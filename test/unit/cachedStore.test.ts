// Behaviour of the read-model decorator over the reference engine: the inner
// store is a real InMemoryStore (occasionally subclassed to script its delta
// feed or slow its graph sweep), so what these tests pin is the decorator's
// own logic — phased boot, write-through, read-refresh, delta reconcile,
// events — not a mock's idea of an engine.

import { describe, expect, it, vi } from 'vitest'
import type { StoreEvent } from '@notarium/contract'
import {
  CachedStore,
  IF_EXISTS,
  InMemoryRevisionPersistence,
  type StoreDelta,
} from '@notarium/core'
import { InMemoryStore, type StoreSnapshot } from '@notarium/engine-memory'

const FIXTURE: StoreSnapshot = {
  space: 'main',
  now: '2026-06-10T12:00:00.000Z',
  notes: [
    {
      title: 'Titanium',
      filePath: 'demo/titanium.md',
      content: 'links to [[Carbon]]',
      modifiedAt: '2026-06-01T00:00:00.000Z',
      createdAt: '2026-06-01T10:00:00Z',
    },
    {
      title: 'Carbon',
      filePath: 'demo/carbon.md',
      content: 'plain',
      modifiedAt: '2026-06-02T00:00:00.000Z',
      createdAt: '2026-06-02T10:00:00Z',
    },
  ],
}

const largeFixture = (count = 80): StoreSnapshot => ({
  space: 'main',
  now: '2026-06-10T12:00:00.000Z',
  notes: Array.from({ length: count }, (_, i) => ({
    title: `Perf Node ${i}`,
    filePath: `perf/perf-node-${i}.md`,
    content: `links to [[Perf Node ${(i + 1) % count}]]`,
    modifiedAt: '2026-06-01T00:00:00.000Z',
    createdAt: '2026-06-01T10:00:00Z',
  })),
})

// The inner store is identity-capable (#51): every note carries a note-id,
// deterministically derived from the seeded path (`fake-<slugged-path>`), and
// the CachedStore passes those ids through. Snapshot keys, graph node ids,
// event payloads and preview keys are all note-ids now — NOT permalinks.
const TITANIUM = 'fake-demo-titanium'
const CARBON = 'fake-demo-carbon'

// InMemoryStore derives graph edges as `links_to`; patches must match so the
// two kinds of edges stay one population.
const make = async (
  inner: InMemoryStore = new InMemoryStore(FIXTURE),
  opts: { graphDebounceMs?: number } = {},
) => {
  const store = new CachedStore({
    inner,
    pollIntervalMs: 0,
    relationType: 'links_to',
    now: () => new Date('2026-06-11T12:00:00Z'),
    ...opts,
  })
  await store.start()
  return { inner, store }
}

const allPositioned = (g: Awaited<ReturnType<CachedStore['graph']>>): boolean =>
  g.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))

const waitForPositionedGraph = async (
  store: CachedStore,
): Promise<Awaited<ReturnType<CachedStore['graph']>>> => {
  let graph = await store.graph()
  await vi.waitFor(async () => {
    graph = await store.graph()
    expect(allPositioned(graph)).toBe(true)
  })
  return graph
}

describe('CachedStore — boot & serving', () => {
  it('serves list/graph from the snapshot after boot', async () => {
    const { store } = await make()
    const notes = await store.list()
    expect(notes.map((n) => n.filePath).sort()).toEqual(['demo/carbon.md', 'demo/titanium.md'])
    const notesById = new Map(notes.map((n) => [n.id, n]))
    expect(notesById.get(TITANIUM)?.filePath).toBe('demo/titanium.md')
    const g = await store.graph()
    expect(g.links.some((l) => l.source === TITANIUM && l.target === CARBON)).toBe(true)
    const status = await store.syncStatus()
    expect(status.scan.phase).toBe('ready')
    expect(status.counts).toEqual({ notes: 2, links: 1 })
  })

  it('answers list (and a partial graph) while the edge sweep is still running', async () => {
    // gate the engine's graph sweep so the test can observe the 'notes' phase
    const inner = new InMemoryStore(FIXTURE)
    let open!: () => void
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const sweep = inner.graph.bind(inner)

    inner.graph = async () => {
      await gate
      return sweep()
    }
    const store = new CachedStore({ inner, pollIntervalMs: 0 })
    const boot = store.start()

    expect((await store.list()).length).toBe(2) // phase 1+2 done, sweep pending
    expect((await store.graph()).links).toHaveLength(0)
    expect((await store.syncStatus()).scan.phase).toBe('notes')

    open()
    await boot
    expect((await store.graph()).links).toHaveLength(1)
    expect((await store.syncStatus()).scan.phase).toBe('ready')
  })

  it('a failed boot falls back to engine passthrough and recovers on reconcile', async () => {
    const inner = new InMemoryStore(FIXTURE)
    let fail = true
    const feed = inner.changes.bind(inner)

    inner.changes = async (cursor) => {
      if (fail) {
        throw new Error('engine down')
      }

      return feed(cursor)
    }
    const store = new CachedStore({ inner, pollIntervalMs: 0 })
    await store.start()

    expect((await store.syncStatus()).scan.phase).toBe('error')
    expect((await store.list()).length).toBe(2) // passthrough keeps serving

    fail = false
    await store.reconcile() // retries the boot scan
    expect((await store.syncStatus()).scan.phase).toBe('ready')
  })

  it('rebuilds an early failed boot from the authoritative retry inventory', async () => {
    const inner = new InMemoryStore(FIXTURE)
    const list = inner.list.bind(inner)
    let lists = 0

    inner.list = async () => {
      lists += 1
      if (lists === 2) {
        throw new Error('full metadata unavailable')
      }

      return list()
    }
    const store = new CachedStore({ inner, pollIntervalMs: 0 })

    await store.start()
    await inner.remove(TITANIUM)
    await store.reconcile()

    expect((await inner.list()).some((note) => note.id === TITANIUM)).toBe(false)
    expect((await store.list()).some((note) => note.id === TITANIUM)).toBe(false)
    expect((await store.syncStatus()).scan.phase).toBe('ready')
  })
})

describe('CachedStore — write-through', () => {
  it('a created note is visible in list and graph within the same call', async () => {
    const { store } = await make()
    const res = await store.write({
      title: 'New Idea',
      directory: 'demo',
      content: 'builds on [[Titanium]]',
    })
    expect(res.id).toBe('fake-demo-new-idea') // the save reports the minted note-id

    const notes = await store.list()
    const created = notes.find((n) => n.filePath === 'demo/new-idea.md')
    expect(created).toBeTruthy()
    expect(created!.id).toBe(res.id)
    expect(created!.createdAt).toBe('2026-06-11T12:00:00.000Z')

    const g = await store.graph()
    expect(g.links.some((l) => l.source === res.id && l.target === TITANIUM)).toBe(true)
  })

  // #100 phase 1: a custom slug is softened to a space-unique one (-2/-3) so the
  // public /n/<id>/<slug> URL stays clean — the id resolves regardless, this is
  // tidiness only. The note being edited is excluded from the rival scan.
  it('softens a colliding custom slug, but a re-save keeps its own', async () => {
    const { store } = await make()
    await store.write({ title: 'First Doc', directory: 'demo', content: 'a', slug: 'shared' })
    const res = await store.write({
      title: 'Second Doc',
      directory: 'demo',
      content: 'b',
      slug: 'shared',
    })
    const listed = await store.list()
    expect(listed.find((n) => n.filePath === 'demo/first-doc.md')!.slug).toBe('shared')
    expect(listed.find((n) => n.filePath === 'demo/second-doc.md')!.slug).toBe('shared-2')
    // Re-saving the second note with its own slug is NOT a self-collision.
    const { versionToken } = await store.read(res.id!)
    await store.write({
      title: 'Second Doc',
      directory: 'demo',
      content: 'b2',
      slug: 'shared-2',
      originalId: res.id,
      versionToken,
    })
    expect((await store.list()).find((n) => n.id === res.id)!.slug).toBe('shared-2')
  })

  // #186: the authored createdAt edit pins the date into the optimistic snapshot
  // (and the registry). The read-model NORMALISES it first (normAuthoredDate), so a
  // lax-channel garbage value can't poison the Feed/registry while the engine rejects
  // it, and an offset form collapses to the UTC instant the engine indexes.
  it('authored createdAt edit: pins a valid date, normalises an offset, rejects garbage (#186)', async () => {
    const { store } = await make()
    const body = 'links to [[Carbon]]'

    const editDate = async (createdAt: string) => {
      const { versionToken } = await store.read(TITANIUM)
      await store.write({
        title: 'Titanium',
        content: body,
        originalId: TITANIUM,
        versionToken,
        createdAt,
      })
      return (await store.list()).find((n) => n.id === TITANIUM)!.createdAt
    }
    // A valid instant is pinned verbatim.
    expect(await editDate('2019-03-14T00:00:00.000Z')).toBe('2019-03-14T00:00:00.000Z')
    // An offset form normalises to the canonical UTC instant (mirrors the engine).
    expect(await editDate('2018-06-15T00:00:00+03:00')).toBe('2018-06-14T21:00:00.000Z')
    // Garbage is rejected — the snapshot keeps the prior (normalised) date, no poison.
    expect(await editDate('not-a-date')).toBe('2018-06-14T21:00:00.000Z')
  })

  it('a new note resolves ghosts that were waiting for it', async () => {
    const { store } = await make()
    await store.write({ title: 'Draft', directory: 'demo', content: 'see [[Future Note]]' })
    let g = await store.graph()
    expect(g.nodes.some((n) => n.id === 'ghost:future-note')).toBe(true)

    await store.write({ title: 'Future Note', directory: 'demo', content: 'arrived' })
    g = await store.graph()
    expect(g.nodes.some((n) => n.id === 'ghost:future-note')).toBe(false)
    expect(
      g.links.some((l) => l.source === 'fake-demo-draft' && l.target === 'fake-demo-future-note'),
    ).toBe(true)
  })

  // #51 / P7: a rename is NOT an identity change anymore — the note-id stays,
  // only the storage view (filePath/permalink) moves. The 'changed' event
  // therefore carries an EMPTY removed: nothing ceased to exist.
  it('rename via originalId keeps the note-id; storage view moves, removed stays empty', async () => {
    const { store } = await make()
    // Updates are optimistic (#50): echo the token the read answered.
    const { versionToken } = await store.read(CARBON)
    const events: StoreEvent[] = []
    store.subscribe((e) => events.push(e))
    const res = await store.write({
      title: 'Carbon Fiber',
      directory: 'demo',
      content: 'plain',
      originalId: CARBON,
      versionToken,
    })
    expect(res.id).toBe(CARBON) // stable across the rename

    const notes = await store.list()
    const renamed = notes.find((n) => n.id === CARBON)
    expect(renamed?.filePath).toBe('demo/carbon-fiber.md')
    expect(notes.some((n) => n.filePath === 'demo/carbon.md')).toBe(false)

    // Titanium's inbound edge needs no remap — the target id never changed.
    const g = await store.graph()
    expect(g.links.some((l) => l.source === TITANIUM && l.target === CARBON)).toBe(true)
    const node = g.nodes.find((n) => n.id === CARBON)
    expect(!node?.ghost && node?.filePath).toBe('demo/carbon-fiber.md')

    const changed = events.find((e) => e.type === 'changed')
    // folders = the upserted note's current folder (server truth) — #94.
    expect(changed).toEqual({ type: 'changed', upserts: [CARBON], removed: [], folders: ['demo'] })
  })

  it('move keeps the note-id; the snapshot patch is metadata-only', async () => {
    const { store } = await make()
    const events: StoreEvent[] = []
    store.subscribe((e) => events.push(e))
    await store.move({ id: CARBON, destinationPath: 'archive/carbon.md' })

    const notes = await store.list()
    const moved = notes.find((n) => n.id === CARBON)
    expect(moved?.filePath).toBe('archive/carbon.md')

    // Both edge directions survive untouched — the id is the edge key.
    const g = await store.graph()
    expect(g.links.some((l) => l.source === TITANIUM && l.target === CARBON)).toBe(true)
    expect(events).toContainEqual({
      type: 'changed',
      upserts: [CARBON],
      removed: [],
      folders: ['archive'],
    })
  })

  it('remove drops the note; inbound links degrade to a ghost', async () => {
    const { store } = await make()
    const events: StoreEvent[] = []
    store.subscribe((e) => events.push(e))
    await store.remove(CARBON)
    expect((await store.list()).some((n) => n.id === CARBON)).toBe(false)
    const g = await store.graph()
    const ghost = g.nodes.find((n) => n.id === CARBON)
    expect(ghost?.ghost).toBe(true)
    expect(events).toContainEqual({ type: 'changed', upserts: [], removed: [CARBON], folders: [] })
  })
})

describe('CachedStore — read-refresh (#35 slice)', () => {
  it('reading a note re-derives its edges from the live body', async () => {
    const { inner, store } = await make()
    // The body changes behind the cache's back (external edit simulated by
    // re-seeding the engine); the stale snapshot still has Titanium→Carbon.
    // Pin the ids on the re-seed: load() derives fresh ids against the OLD
    // population (so they'd drift to fake-...-2), but this scenario simulates
    // an external EDIT — the notes' identity must stay put.
    inner.load({
      ...FIXTURE,
      notes: [
        { ...FIXTURE.notes[0], id: TITANIUM, content: 'now links [[Nowhere Else]]' },
        { ...FIXTURE.notes[1], id: CARBON },
      ],
    })
    expect((await store.graph()).links[0].target).toBe(CARBON)

    const events: StoreEvent[] = []
    store.subscribe((e) => events.push(e))
    // Read by storage path — the wiki-resolve channel still works; the patch
    // and the event key on the note-id the engine reports back.
    const detail = await store.read('demo/titanium')
    expect(detail.id).toBe(TITANIUM)

    const g = await store.graph()
    expect(g.links).toEqual([{ source: TITANIUM, target: 'ghost:nowhere-else', type: 'links_to' }])
    expect(events).toContainEqual({
      type: 'changed',
      upserts: [TITANIUM],
      removed: [],
      folders: ['demo'],
    })
  })
})

describe('CachedStore — delta reconcile', () => {
  /** An InMemoryStore whose next delta can be scripted (simulated externals). */
  const makeScripted = () => {
    const inner = new InMemoryStore(FIXTURE)
    const script: { nextDelta: StoreDelta | null } = { nextDelta: null }
    const feed = inner.changes.bind(inner)
    inner.changes = async (cursor) => script.nextDelta ?? feed(cursor)
    return { inner, script }
  }

  it('applies upserts with content and removals from the inventory diff', async () => {
    const { inner, script } = makeScripted()
    const { store } = await make(inner)

    const inventory = [
      {
        // The identity-capable engine reports the stable note-id with every
        // meta — that id, not the path, is what the snapshot diff keys on.
        id: TITANIUM,
        title: 'Titanium Mk2', // externally renamed
        filePath: 'demo/titanium.md',
        modifiedAt: '2026-06-11T00:00:00.000Z',
        createdAt: null,
      },
      // Carbon is gone from the inventory → external delete
    ]
    script.nextDelta = {
      cursor: 'c2',
      inventory,
      upserts: [{ meta: inventory[0], content: 'rewired to [[Brand New]]' }],
    }
    const events: StoreEvent[] = []
    store.subscribe((e) => events.push(e))
    await store.reconcile()

    const notes = await store.list()
    expect(notes).toHaveLength(1)
    expect(notes[0].title).toBe('Titanium Mk2')
    // first-seen createdAt survives the engine's reindex bump
    expect(notes[0].createdAt).toBe('2026-06-01T10:00:00Z')

    const g = await store.graph()
    expect(g.links).toEqual([{ source: TITANIUM, target: 'ghost:brand-new', type: 'links_to' }])
    const changed = events.find((e) => e.type === 'changed')
    expect(changed && changed.type === 'changed' && changed.removed).toEqual([CARBON])
    expect((await store.syncStatus()).delta.cursor).toBe('c2')
  })

  it('a quiet delta emits no changed event', async () => {
    const { store } = await make()
    const events: StoreEvent[] = []
    store.subscribe((e) => events.push(e))
    await store.reconcile()
    expect(events.filter((e) => e.type === 'changed')).toHaveLength(0)
  })
})

describe('CachedStore — graph SWR (#60)', () => {
  it('serves cold topology immediately, then announces the first enriched layout (#195)', async () => {
    vi.useFakeTimers()
    try {
      const inner = new InMemoryStore(largeFixture())
      const store = new CachedStore({
        inner,
        pollIntervalMs: 0,
        relationType: 'links_to',
        now: () => new Date('2026-06-11T12:00:00Z'),
      })
      const events: StoreEvent[] = []
      store.subscribe((e) => events.push(e))
      await store.start()

      const cold = await store.graph()
      expect(
        cold.links.some(
          (l) => l.source === 'fake-perf-perf-node-0' && l.target === 'fake-perf-perf-node-1',
        ),
      ).toBe(true)
      expect(cold.nodes.some((n) => n.id === 'fake-perf-perf-node-0')).toBe(true)
      expect(cold.nodes.every((n) => n.x == null && n.y == null)).toBe(true)
      expect(events.filter((e) => e.type === 'graph')).toHaveLength(0)

      await vi.advanceTimersToNextTimerAsync()
      expect(events.filter((e) => e.type === 'graph')).toHaveLength(0)
      let whileInFlight: Awaited<ReturnType<CachedStore['graph']>> | null = null
      void store.graph().then((graph) => {
        whileInFlight = graph
      })
      await Promise.resolve()
      await Promise.resolve()
      expect(whileInFlight).not.toBeNull()
      expect(whileInFlight!.nodes.every((n) => n.x == null && n.y == null)).toBe(true)

      await vi.runAllTimersAsync()
      expect(events.filter((e) => e.type === 'graph')).toHaveLength(1)
      const settled = await store.graph()
      expect(settled).not.toBe(cold)
      expect(allPositioned(settled)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('serves fresh topology with carried enrichment instantly after a change, then announces the recomputed map', async () => {
    const { store } = await make(undefined, { graphDebounceMs: 1 })
    const warm = await waitForPositionedGraph(store) // the settled (enriched) map
    const warmTi = warm.nodes.find((n) => n.id === TITANIUM)!
    expect(Number.isFinite(warmTi.x)).toBe(true)

    const events: StoreEvent[] = []
    store.subscribe((e) => events.push(e))
    await store.write({ title: 'New Idea', directory: 'demo', content: 'builds on [[Titanium]]' })

    // The very next graph() shows the write (fresh topology) without paying
    // the enrichment: existing nodes keep their positions, the newcomer is
    // seeded next to its neighbour — every node positioned, so the client can
    // adopt the layout.
    const swr = await store.graph()
    expect(swr.links.some((l) => l.source === 'fake-demo-new-idea' && l.target === TITANIUM)).toBe(
      true,
    )
    expect(events.filter((e) => e.type === 'graph')).toHaveLength(0)
    const ti = swr.nodes.find((n) => n.id === TITANIUM)!
    expect(ti.x).toBe(warmTi.x)
    expect(ti.y).toBe(warmTi.y)
    for (const n of swr.nodes) {
      expect(Number.isFinite(n.x)).toBe(true)
    }

    // The background recompute lands and announces itself.
    let settled = await store.graph()
    await vi.waitFor(async () => {
      expect(events.filter((e) => e.type === 'graph')).toHaveLength(1)
      settled = await store.graph()
      expect(settled).not.toBe(swr)
      expect(allPositioned(settled)).toBe(true)
    })
    expect(settled.nodes.some((n) => n.id === 'fake-demo-new-idea')).toBe(true)
  })

  it('repeated reads of one stale revision recompute the enrichment exactly once', async () => {
    const { store } = await make(undefined, { graphDebounceMs: 1 })
    await waitForPositionedGraph(store)
    const events: StoreEvent[] = []
    store.subscribe((e) => events.push(e))
    await store.write({ title: 'Echo', directory: 'demo', content: 'plain' })
    const a = await store.graph()
    const b = await store.graph()
    expect(a.nodes.some((n) => n.id === 'fake-demo-echo')).toBe(true)
    expect(b.nodes.some((n) => n.id === 'fake-demo-echo')).toBe(true)
    expect(b).toBe(a)
    await vi.waitFor(() => expect(events.some((e) => e.type === 'graph')).toBe(true))
    // One revision → one background pass (the debounce + in-flight guard
    // coalesce the request-path kicks), announced once.
    expect(events.filter((e) => e.type === 'graph')).toHaveLength(1)
  })
})

describe('CachedStore — engine activity (#60 variant-A heuristic)', () => {
  it('reports the engine unknown before the first poll, idle after a quiet one', async () => {
    const { store } = await make()
    // No poll yet → nothing to infer from; defer to the engine's own answer.
    expect((await store.syncStatus()).engine.indexing).toBe('unknown')
    await store.reconcile()
    expect((await store.syncStatus()).engine.indexing).toBe('idle')
  })

  it('a delta poll that brings changes reads as busy; driver counters ride along', async () => {
    const inner = new InMemoryStore(FIXTURE)
    const feed = inner.changes.bind(inner)
    const meta = {
      title: 'Imported',
      filePath: 'demo/imported.md',
      modifiedAt: '2026-06-11T00:00:00.000Z',
      createdAt: '2026-06-11T11:59:30Z',
    }
    let next: StoreDelta | null = null
    inner.changes = async (cursor) => next ?? feed(cursor)
    // The driver-supplied engine block (index population + last reindex
    // moment) must pass through untouched — only the indexing verdict is ours.
    const baseStatus = inner.syncStatus.bind(inner)

    inner.syncStatus = async () => {
      const s = await baseStatus()
      s.engine.indexed = 42
      s.engine.lastIndexedAt = '2026-06-11T11:59:30Z'
      return s
    }
    const { store } = await make(inner)

    next = {
      cursor: 'c2',
      inventory: [...(await feed(null)).inventory, meta],
      upserts: [{ meta, content: 'fresh import' }],
    }
    await store.reconcile()

    const status = await store.syncStatus()
    expect(status.engine.indexing).toBe('busy')
    expect(status.engine.indexed).toBe(42)
    expect(status.engine.lastIndexedAt).toBe('2026-06-11T11:59:30Z')
  })
})

describe('CachedStore — preview cache (#64)', () => {
  it('read-through: the first preview pays one engine read, the second is served from memory', async () => {
    const { inner, store } = await make()
    // The LRU paths under test model an engine with no warm peek.
    vi.spyOn(inner, 'previewPeek').mockReturnValue(null)
    const read = vi.spyOn(inner, 'read')
    // The preview cache keys on the note-id (#51) — ask by id to hit it.
    const first = await store.preview(TITANIUM)
    expect(first.snippet).toContain('links to Carbon')
    expect(read).toHaveBeenCalledTimes(1)
    expect(await store.preview(TITANIUM)).toEqual(first)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('write-through warms the preview — no engine read on the next preview', async () => {
    const { inner, store } = await make()
    const res = await store.write({
      title: 'Fresh',
      directory: 'demo',
      content: 'fresh body',
      tags: ['t1'],
    })
    const read = vi.spyOn(inner, 'read')
    const s = await store.preview(res.id!)
    expect(s.snippet).toBe('fresh body')
    expect(s.tags).toEqual(['t1'])
    expect(read).not.toHaveBeenCalled()
  })

  it('an external upsert invalidates the entry; the next view recomputes lazily', async () => {
    const inner = new InMemoryStore(FIXTURE)
    const feed = inner.changes.bind(inner)
    let next: StoreDelta | null = null
    inner.changes = async (cursor) => next ?? feed(cursor)
    const { store } = await make(inner)

    expect((await store.preview('demo/carbon')).snippet).toBe('plain')
    // the body changes behind our back (delta reports it, with or without content).
    // `overwrite` is how an out-of-band rewrite is spelled at the engine port — a
    // create that names no policy refuses an occupied path.
    await inner.write({
      title: 'Carbon',
      directory: 'demo',
      content: 'rewritten',
      ifExists: IF_EXISTS.overwrite,
    })
    const meta = (await inner.list()).find((n) => n.filePath === 'demo/carbon.md')!
    next = {
      cursor: 'c2',
      inventory: await inner.list(),
      upserts: [{ meta, content: 'rewritten' }],
    }
    await store.reconcile()

    expect((await store.preview('demo/carbon')).snippet).toBe('rewritten')
  })

  it('a move keeps the preview under the same note-id; a remove drops it', async () => {
    const { inner, store } = await make()
    await store.preview(CARBON) // warm
    await store.move({ id: CARBON, destinationPath: 'archive/carbon.md' })
    const read = vi.spyOn(inner, 'read')
    // The id IS the cache key (#51), and a move doesn't change it — warm stays warm.
    expect((await store.preview(CARBON)).snippet).toBe('plain')
    expect(read).not.toHaveBeenCalled()
    await store.remove(CARBON)
    // the warm entry is dropped with the note; the cold path then honestly
    // reports the miss (#65 — engines throw on a real not-found)
    expect(store.previewPeek(CARBON)).toBeNull()
    await expect(store.preview(CARBON)).rejects.toThrow(/note not found/)
  })

  it('previewPeek never pays an engine read: null when cold over a bare engine, warm after a read', async () => {
    const { inner, store } = await make()
    vi.spyOn(inner, 'previewPeek').mockReturnValue(null)
    const read = vi.spyOn(inner, 'read')
    expect(store.previewPeek(CARBON)).toBeNull()
    expect(read).not.toHaveBeenCalled()
    await store.preview(CARBON)
    expect(store.previewPeek(CARBON)?.snippet).toBe('plain')
  })

  it("previewPeek lets a warm inner's peek through — the e2e fake's composition stays warm", async () => {
    const { inner, store } = await make()
    const read = vi.spyOn(inner, 'read')
    // InMemoryStore derives from memory — its peek is always warm, and the
    // decorator must not hide that (inline ?preview=1 windows rely on it).
    expect(store.previewPeek(CARBON)?.snippet).toBe('plain')
    expect(read).not.toHaveBeenCalled()
  })

  it('previews resolves a batch sequentially and stops at an aborted signal', async () => {
    const { inner, store } = await make()
    vi.spyOn(inner, 'previewPeek').mockReturnValue(null)
    const abort = new AbortController()
    const read = vi.spyOn(inner, 'read').mockImplementation(async (id: string) => {
      // the first cold read aborts the request mid-batch
      abort.abort()
      return { title: id, filePath: 'demo/titanium.md', content: 'body', frontmatter: {} }
    })
    const out = await store.previews(['demo/titanium', 'demo/carbon'], { signal: abort.signal })
    expect(Object.keys(out)).toEqual(['demo/titanium'])
    expect(read).toHaveBeenCalledTimes(1) // carbon was never derived
  })

  it('readBody capability: a cold preview derives from the raw file, not the engine', async () => {
    const inner = new InMemoryStore(FIXTURE)
    const files: Record<string, string> = {
      'demo/carbon.md': '---\ntags:\n  - fs-tag\n---\n# Carbon\n\nbody from disk',
    }
    const store = new CachedStore({
      inner,
      pollIntervalMs: 0,
      relationType: 'links_to',
      readBody: async (fp: string) => files[fp] ?? null,
      now: () => new Date('2026-06-11T12:00:00Z'),
    })
    await store.start()
    vi.spyOn(inner, 'previewPeek').mockReturnValue(null)
    const read = vi.spyOn(inner, 'read')
    const p = await store.preview(CARBON)
    expect(p.snippet).toBe('body from disk') // frontmatter + title heading stripped
    expect(p.tags).toEqual(['fs-tag'])
    expect(read).not.toHaveBeenCalled()
    // a file the reader can't serve falls back to the engine
    expect((await store.preview(TITANIUM)).snippet).toContain('links to Carbon')
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('does not let a delayed raw preview overwrite a newer write-through value', async () => {
    const inner = new InMemoryStore(FIXTURE)
    let releaseRaw!: () => void
    let rawEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      rawEntered = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseRaw = resolve
    })
    let blockRawRead = false
    const store = new CachedStore({
      inner,
      pollIntervalMs: 0,
      relationType: 'links_to',
      readBody: async () => {
        const captured = '# Carbon\n\nold body'

        if (!blockRawRead) {
          return captured
        }
        rawEntered()
        await release
        return captured
      },
      now: () => new Date('2026-06-11T12:00:00Z'),
    })

    await store.start()
    blockRawRead = true
    vi.spyOn(inner, 'previewPeek').mockReturnValue(null)
    const current = await inner.read(CARBON)
    const stalePreview = store.preview(CARBON)

    await entered
    let writeSettled = false
    const write = store
      .write({
        title: 'Carbon',
        content: 'new body',
        originalId: CARBON,
        versionToken: current.versionToken,
      })
      .then((result) => {
        writeSettled = true
        return result
      })

    await new Promise((resolve) => setTimeout(resolve, 0))
    try {
      expect(writeSettled).toBe(false)
    } finally {
      releaseRaw()
    }
    expect((await stalePreview).snippet).toBe('old body')
    await write
    expect(store.previewPeek(CARBON)?.snippet).toBe('new body')
  })
})

describe('CachedStore — alias backfill from the journal (#100)', () => {
  it('heals a pre-#100 broken inbound link using a past title in the journal', async () => {
    // The note was renamed 'Королёв' → 'Гагарин' BEFORE the alias channel existed:
    // its FILE carries no `aliases:` (the engine boot graph leaves [[Королёв]] a
    // ghost), but the journal still holds the old title. The backfill seeds the
    // snapshot alias and the boot re-resolves the ghost onto the real note.
    const GAGARIN = 'fake-demo-gagarin'
    const inner = new InMemoryStore({
      space: 'main',
      now: '2026-06-10T12:00:00.000Z',
      notes: [
        // No `aliases` on the file — the pre-#100 state.
        { title: 'Гагарин', filePath: 'demo/gagarin.md', content: 'target body' },
        { title: 'Linker', filePath: 'demo/linker.md', content: 'see [[Королёв]]' },
      ],
    })
    const persistence = new InMemoryRevisionPersistence()
    // A prior revision under the OLD title — what the journal would hold.
    await persistence.append(
      {
        noteId: GAGARIN,
        space: 'main',
        baseRevisionId: null,
        theirRevisionId: null,
        sourceRevisionId: null,
        kind: 'write',
        principal: 'ui',
        contentHash: null,
        title: 'Королёв',
        class: 'user-doc',
        slug: null,
        tags: [],
        createdAt: '2026-06-09T00:00:00.000Z',
        charsAdded: null,
        charsRemoved: null,
      },
      null,
    )
    const store = new CachedStore({
      inner,
      revisionPersistence: persistence,
      pollIntervalMs: 0,
      relationType: 'links_to',
      now: () => new Date('2026-06-11T12:00:00Z'),
    })
    await store.start()

    // The snapshot note carries the backfilled alias (→ on the wire for the client).
    const meta = (await store.list()).find((n) => n.id === GAGARIN)
    expect(meta?.aliases).toContain('Королёв')
    // And the GRAPH healed: the linker's [[Королёв]] is a REAL edge, not a ghost.
    const linker = (await store.list()).find((n) => n.filePath === 'demo/linker.md')!
    const g = await store.graph()
    expect(g.links.some((l) => l.source === linker.id && l.target === GAGARIN)).toBe(true)
    expect(g.nodes.find((n) => n.id === GAGARIN)?.ghost).toBeFalsy()

    // SURVIVES A POLL: the engine's inventory meta omits `aliases` (the file has
    // none — it's a journal-only heal), so a bare `{ ...meta }` reconcile would
    // wipe the backfill and re-ghost the link. aliasesFor re-unions it every poll.
    await store.reconcile()
    expect((await store.list()).find((n) => n.id === GAGARIN)?.aliases).toContain('Королёв')
    const g2 = await store.graph()
    expect(g2.links.some((l) => l.source === linker.id && l.target === GAGARIN)).toBe(true)
    expect(g2.nodes.find((n) => n.id === GAGARIN)?.ghost).toBeFalsy()
  })

  it('a POST-#100 rename keeps its alias across a poll (file-truth, not backfill)', async () => {
    // Distinct from the backfill case: here the rename happens THROUGH us, so the
    // engine writes the alias to its own state synchronously inside write() — the
    // alias rides the inventory meta on every poll, no journal backfill involved.
    // Guards against the read-model wiping the engine's file-truth alias on poll.
    const inner = new InMemoryStore({
      space: 'main',
      now: '2026-06-10T12:00:00.000Z',
      notes: [{ title: 'Old Title', filePath: 'demo/old-title.md', content: 'body' }],
    })
    const { store } = await make(inner)
    const id = (await store.list())[0].id!
    const token = (await store.read(id)).versionToken
    await store.write({ title: 'New Title', content: 'body', originalId: id, versionToken: token })

    const seen = async () => (await store.list()).find((n) => n.id === id)
    expect((await seen())?.title).toBe('New Title')
    expect((await seen())?.aliases).toEqual(['Old Title']) // optimistic snapshot
    await store.reconcile() // poll: inventory meta carries the engine's file-truth alias
    expect((await seen())?.aliases).toEqual(['Old Title']) // survives — not wiped
    // Old name still resolves through the engine (the resolver channel).
    expect((await store.read('Old Title')).id).toBe(id)
  })
})

// Bulk-write mode (#192): a streaming import brackets its run with beginBulk/
// endBulk so background work cooperatively yields to interactive requests. These
// pin the observable contract — coalesced events, paused background, re-entrancy —
// so a future refactor of emit/poll/scheduleGraphRefresh can't silently undo it.
describe('CachedStore — bulk-write mode (#192)', () => {
  // An engine that records the host-side background-pause duck calls (#192).
  class SpyEngine extends InMemoryStore {
    suspendCalls = 0
    resumeCalls = 0
    suspendBackground(): void {
      this.suspendCalls++
    }
    resumeBackground(): void {
      this.resumeCalls++
    }
  }

  it('coalesces per-note `changed` into ONE merged event on endBulk', async () => {
    const { store } = await make()
    const changed: StoreEvent[] = []
    store.subscribe((e) => {
      if (e.type === 'changed') {
        changed.push(e)
      }
    })

    store.beginBulk()
    await store.write({ title: 'Alpha', directory: 'demo', content: 'a' })
    await store.write({ title: 'Beta', directory: 'demo', content: 'b' })
    // Buffered, not fanned out per note — the whole point (no broadcast storm).
    expect(changed).toHaveLength(0)

    await store.endBulk()
    // Exactly one merged event carrying both new ids.
    expect(changed).toHaveLength(1)
    const ev = changed[0] as Extract<StoreEvent, { type: 'changed' }>
    expect(new Set(ev.upserts)).toEqual(new Set(['fake-demo-alpha', 'fake-demo-beta']))
  })

  it('pauses the engine background while bulk, resumes on the last endBulk (re-entrant)', async () => {
    const inner = new SpyEngine(FIXTURE)
    const { store } = await make(inner)

    store.beginBulk()
    expect(inner.suspendCalls).toBe(1)
    // Nested bracket: suspend stays at one (only the 0→1 transition pauses).
    store.beginBulk()
    expect(inner.suspendCalls).toBe(1)

    await store.endBulk() // depth 2→1: still in bulk, NOT resumed.
    expect(inner.resumeCalls).toBe(0)
    await store.endBulk() // depth 1→0: now resume.
    expect(inner.resumeCalls).toBe(1)
  })

  it('a write outside bulk still fans out immediately (no coalescing left armed)', async () => {
    const { store } = await make()
    const changed: Array<Extract<StoreEvent, { type: 'changed' }>> = []
    store.subscribe((e) => {
      if (e.type === 'changed') {
        changed.push(e)
      }
    })
    store.beginBulk()
    await store.write({ title: 'Gamma', directory: 'demo', content: 'g' })
    await store.endBulk()
    // A normal write after bulk is dispatched right away — were coalescing still
    // armed, Delta would be buffered and no event would carry its id. (Robust to
    // the endBulk catch-up poll, which only ever re-echoes the bulk notes.)
    await store.write({ title: 'Delta', directory: 'demo', content: 'd' })
    expect(changed.some((e) => e.upserts.includes('fake-demo-delta'))).toBe(true)
  })
})
