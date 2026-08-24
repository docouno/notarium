// SpaceManager (#16/#99): slug → live store, lazily; per-space SSE refs guard
// eviction; the global id resolver prefers the meta-DB and falls back to
// asking live stores. There is no host-global default space (#99): the host
// may serve zero spaces (a fresh password host before its first user), and a
// user's personal space is the one removal refuses.

import { describe, expect, it, vi } from 'vitest'
import {
  InMemoryRestoreOperationPersistence,
  InMemorySpaceLifecyclePersistence,
  type KnowledgeStore,
  SPACE_LIFECYCLE_PHASE,
  type SyncStatus,
} from '@notarium/core'

import type { SpaceRecord } from '../../packages/server/src/services/metaDb'
import { SpaceManager } from '../../packages/server/src/services/spaces'
import type { SpaceManagerOptions, SpaceStore } from '../../packages/server/src/services/spaces'

// A minimal meta-DB that models only what SpaceManager touches in init/create:
// the spaces registry (list + upsert, createdAt preserved) and the legacy-row
// adopter. The fresh-provision detection (#97) reads spaces.list().
const fakeMetaDb = () => {
  const rows = new Map<string, SpaceRecord>() // keyed by the opaque id (#100 phase 4)
  const spaceLifecycle = new InMemorySpaceLifecyclePersistence()
  const restoreOperations = new InMemoryRestoreOperationPersistence(spaceLifecycle)
  return {
    adoptLegacyRows: async () => {},
    // Permanent purge (#110): the real driver wipes every child table + the spaces row
    // transactionally; the fake only needs to drop the registry row.
    purgeSpace: async (id: string) => {
      const blocker = (await restoreOperations.listRecoverable(id))[0]

      if (blocker) {
        throw new Error(`space purge blocked by restore operation: ${blocker.id}`)
      }
      rows.delete(id)
      const transitioned = await spaceLifecycle.transition({
        space: id,
        expectedPhases: [SPACE_LIFECYCLE_PHASE.purgeIntent],
        phase: SPACE_LIFECYCLE_PHASE.metadataCleaned,
        changedAt: 'purged',
      })

      if (transitioned.status !== 'transitioned') {
        throw new Error(`fake purge lifecycle mismatch: ${id}`)
      }
    },
    restoreOperations,
    spaceLifecycle,
    jobs: {
      list: async () => [],
      cancel: async () => true,
    },
    spaces: {
      list: async () => [...rows.values()],
      getById: async (id: string) => rows.get(id) ?? null,
      getBySlug: async (slug: string) => [...rows.values()].find((r) => r.slug === slug) ?? null,
      upsert: async (rec: SpaceRecord) => {
        rows.set(rec.id, { ...rec })
        await spaceLifecycle.ensure(
          rec.id,
          rec.archivedAt ? SPACE_LIFECYCLE_PHASE.archived : SPACE_LIFECYCLE_PHASE.active,
          rec.archivedAt ?? rec.createdAt,
        )
      },
    },
  } as unknown as SpaceManagerOptions['metaDb']
}

const READY: SyncStatus = {
  scan: { phase: 'ready', startedAt: null, readyAt: null, error: null },
  delta: { cursor: null, lastPollAt: null, lastChangeAt: null, intervalMs: 0 },
  engine: { indexing: 'unknown' },
  counts: null,
}

const stubStore = (notes: Array<{ id: string }> = []): SpaceStore =>
  ({
    list: async () =>
      notes.map((n) => ({ ...n, title: 't', filePath: 'f.md', modifiedAt: null, createdAt: null })),
    syncStatus: async () => READY,
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    settle: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
    capabilities: {
      fts: true,
      vector: false,
      hybrid: false,
      graphExpand: false,
      identity: true,
      cas: true,
      revisions: false,
      trash: false,
      visibility: false,
      watch: false,
    },
  }) as unknown as SpaceStore

describe('SpaceManager', () => {
  it('boots a store lazily, once, and starts it', async () => {
    const created: string[] = []
    const stores = new Map<string, SpaceStore>()
    const manager = new SpaceManager({
      spaces: [
        { slug: 'a', displayName: 'A' },
        { slug: 'b', displayName: 'B' },
      ],
      createStore: (rec) => {
        created.push(rec.slug)
        const store = stubStore()
        stores.set(rec.slug, store)
        return store
      },
    })
    expect(created).toEqual([]) // nothing boots before first touch
    const [s1, s2] = await Promise.all([manager.store('b'), manager.store('b')])
    expect(s1).toBe(s2)
    expect(created).toEqual(['b']) // concurrent first touches share one boot
    expect(stores.get('b')!.start).toHaveBeenCalledTimes(1)
  })

  it('keeps a causal publication store resident until its projection lease releases', async () => {
    vi.useFakeTimers()
    try {
      const releaseStore = vi.fn()
      const store = {
        ...stubStore(),
        beginCausalPublication: vi.fn(async () => releaseStore),
      } as SpaceStore
      const manager = new SpaceManager({
        spaces: [{ slug: 'a', displayName: 'A' }],
        createStore: () => store,
        idleEvictMs: 1,
      })
      await manager.init()
      const release = await manager.beginCausalPublication('a')

      await vi.advanceTimersByTimeAsync(60_000)
      expect(store.stop).not.toHaveBeenCalled()

      release()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(releaseStore).toHaveBeenCalledTimes(1)
      expect(store.stop).toHaveBeenCalledTimes(1)
      await manager.stopAll()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects an unknown slug with a typed not-found', async () => {
    const manager = new SpaceManager({
      spaces: [{ slug: 'a', displayName: 'A' }],
      createStore: () => stubStore(),
    })
    await expect(manager.store('nope')).rejects.toMatchObject({ isNotFound: true })
  })

  it('tolerates zero spaces (a fresh password host before its first user; #99)', async () => {
    const minted: string[] = []
    const manager = new SpaceManager({
      spaces: [],
      createStore: () => stubStore(),
      createSpace: async ({ slug }) => {
        minted.push(slug)
      },
    })
    expect(manager.list()).toEqual([]) // no host-global default, no imposed 'main'
    await manager.init() // boots clean with no spaces to warm
    // The first space arrives at runtime (the owner's personal space at setup).
    await manager.create({ slug: 'owner', displayName: 'Personal' })
    expect(minted).toEqual(['owner'])
    expect(manager.list().map((s) => s.slug)).toEqual(['owner'])
  })

  it('a failed boot does not wedge the space — the next access retries', async () => {
    let attempts = 0
    const manager = new SpaceManager({
      spaces: [{ slug: 'a', displayName: 'A' }],
      createStore: () => {
        attempts++
        if (attempts === 1) {
          throw new Error('engine down')
        }

        return stubStore()
      },
    })
    await expect(manager.store('a')).rejects.toThrow('engine down')
    await expect(manager.store('a')).resolves.toBeTruthy()
  })

  it('resolveNote falls back to scanning live stores without a meta-DB', async () => {
    const manager = new SpaceManager({
      spaces: [
        { slug: 'a', displayName: 'A' },
        { slug: 'b', displayName: 'B' },
      ],
      createStore: (rec) => stubStore(rec.slug === 'b' ? [{ id: 'note-in-b' }] : []),
    })
    expect(await manager.resolveNote('note-in-b')).toEqual({ space: 'b', deletedAt: null })
    expect(await manager.resolveNote('ghost')).toBeNull()
  })

  it('resolves an archived identity without booting its unavailable store', async () => {
    const archived: SpaceRecord = {
      id: 'archived-space',
      slug: 'archive',
      displayName: 'Archive',
      notesDir: 'archive',
      aliases: [],
      createdAt: '2026-06-11T00:00:00.000Z',
      archivedAt: '2026-06-12T00:00:00.000Z',
      archivedBy: 'user:tester',
    }
    const createStore = vi.fn(() => stubStore())
    const spaceLifecycle = new InMemorySpaceLifecyclePersistence()
    const restoreOperations = new InMemoryRestoreOperationPersistence(spaceLifecycle)
    const metaDb = {
      adoptLegacyRows: async () => {},
      restoreOperations,
      spaceLifecycle,
      spaces: {
        list: async () => [{ ...archived }],
        getById: async (id: string) => (id === archived.id ? { ...archived } : null),
        getBySlug: async (slug: string) => (slug === archived.slug ? { ...archived } : null),
        upsert: async () => {},
      },
      identity: {
        findById: async (id: string) =>
          id === 'archived-note'
            ? {
                id,
                filePath: 'note.md',
                space: archived.id,
                createdAt: null,
                materialized: true,
                deletedAt: null,
              }
            : null,
      },
    } as unknown as SpaceManagerOptions['metaDb']
    const manager = new SpaceManager({ spaces: [], createStore, metaDb })

    await manager.init()
    await expect(manager.resolveNote('archived-note')).resolves.toEqual({
      space: archived.id,
      deletedAt: null,
    })
    expect(createStore).not.toHaveBeenCalled()
  })

  it('capability spaceCreate reflects the wiring; create registers the space', async () => {
    const withoutCreate = new SpaceManager({
      spaces: [{ slug: 'a', displayName: 'A' }],
      createStore: () => stubStore(),
    })
    expect(withoutCreate.capabilities.spaceCreate).toBe(false)

    const minted: string[] = []
    const manager = new SpaceManager({
      spaces: [{ slug: 'a', displayName: 'A' }],
      createStore: () => stubStore(),
      createSpace: async ({ slug }) => {
        minted.push(slug)
      },
    })
    expect(manager.capabilities.spaceCreate).toBe(true)
    await manager.create({ slug: 'fresh', displayName: 'Fresh' })
    expect(minted).toEqual(['fresh'])
    expect(manager.list().map((s) => s.slug)).toEqual(['a', 'fresh'])
    await expect(manager.create({ slug: 'fresh', displayName: 'Dup' })).rejects.toMatchObject({
      reason: 'space_exists',
    })
  })

  it('remove evicts the store but refuses a personal space (#99)', async () => {
    const store = stubStore()
    const manager = new SpaceManager({
      spaces: [
        { slug: 'a', displayName: 'A' },
        { slug: 'mine', displayName: 'Personal' },
      ],
      createStore: () => store,
      // 'mine' is a user's personal space — auth owns this answer in production.
      isPersonalSpace: async (slug) => slug === 'mine',
    })
    await manager.store('a')
    await manager.remove('a')
    expect(store.stop).toHaveBeenCalled()
    expect(manager.has('a')).toBe(false)
    await expect(manager.remove('mine')).rejects.toThrow(/personal/)
    expect(manager.has('mine')).toBe(true)
  })

  it('archive evicts + hides the space; restore brings it back (#110)', async () => {
    const metaDb = fakeMetaDb()
    const store = stubStore()
    const manager = new SpaceManager({
      spaces: [],
      createStore: () => store,
      createSpace: async () => {},
      metaDb,
    })
    await manager.init()
    const rec = await manager.create({ slug: 'work', displayName: 'Work' })
    await manager.store(rec.id) // boot it
    await manager.archive(rec.id, 'user:tester')
    // Evicted, hidden from the served list, present in the archived list, slug held,
    // and the actor recorded (#110 — for the "deleted by" line).
    expect(store.stop).toHaveBeenCalled()
    expect(manager.list().map((s) => s.slug)).toEqual([])
    expect(manager.listArchived().map((s) => s.slug)).toEqual(['work'])
    expect(manager.listArchived()[0].archivedBy).toBe('user:tester')
    expect(manager.resolveId('work')).toBe(rec.id) // slug reserved
    await expect(manager.store(rec.id)).rejects.toMatchObject({ isNotFound: true }) // not served
    // A new "work" can't recover the held slug (create refuses an archived row).
    await expect(manager.create({ slug: 'work', displayName: 'W2' })).rejects.toMatchObject({
      reason: 'space_exists',
    })
    // Restore → served again.
    await manager.restore(rec.id)
    expect(manager.list().map((s) => s.slug)).toEqual(['work'])
    expect(manager.listArchived()).toEqual([])
    await expect(manager.store(rec.id)).resolves.toBeTruthy()
  })

  it('keeps a timed-out archive durably closing and resumes the drain', async () => {
    const metaDb = fakeMetaDb()
    const store = stubStore()
    let busy = true
    const reopened: string[] = []
    const manager = new SpaceManager({
      spaces: [],
      createStore: () => store,
      createSpace: async () => {},
      metaDb,
      lifecycleDrainMs: 5,
      closeResourceAdmission: async () => {
        if (busy) {
          throw Object.assign(new Error('active lease deadline exceeded'), { code: 'DEADLINE' })
        }
      },
      reopenResourceAdmission: (space) => reopened.push(space),
    })
    await manager.init()
    const rec = await manager.create({ slug: 'work', displayName: 'Work' })
    await manager.store(rec.id)

    await expect(manager.archive(rec.id, 'user:tester')).rejects.toMatchObject({
      reason: 'space_busy',
    })
    expect(await metaDb!.spaceLifecycle.get(rec.id)).toMatchObject({ phase: 'closing' })
    expect(manager.list()).toEqual([])
    await expect(manager.store(rec.id)).rejects.toMatchObject({ isNotFound: true })

    busy = false
    await expect(manager.archive(rec.id, 'user:other')).resolves.toMatchObject({
      archivedBy: 'user:tester',
    })
    expect(store.stop).toHaveBeenCalled()
    expect(store.settle).toHaveBeenCalled()
    await manager.restore(rec.id)
    expect(reopened).toEqual([rec.id])
  })

  it('retains a stopped store when settlement fails so closing can retry it', async () => {
    const metaDb = fakeMetaDb()
    const store = stubStore()
    let attempt = 0

    store.settle = vi.fn(async () => {
      if (attempt++ === 0) {
        throw new Error('journal flush unavailable')
      }
    })
    const manager = new SpaceManager({
      spaces: [],
      createStore: () => store,
      createSpace: async () => {},
      metaDb,
    })
    await manager.init()
    const rec = await manager.create({ slug: 'work', displayName: 'Work' })
    await manager.store(rec.id)

    await expect(manager.archive(rec.id)).rejects.toThrow('journal flush unavailable')
    expect(await metaDb!.spaceLifecycle.get(rec.id)).toMatchObject({ phase: 'closing' })
    await expect(manager.archive(rec.id)).resolves.toMatchObject({ id: rec.id })
    expect(store.settle).toHaveBeenCalledTimes(2)
  })

  it('keeps closing pinned until an accepted restore operation is terminal', async () => {
    const metaDb = fakeMetaDb()
    const manager = new SpaceManager({
      spaces: [],
      createStore: () => stubStore(),
      createSpace: async () => {},
      metaDb,
    })
    await manager.init()
    const rec = await manager.create({ slug: 'work', displayName: 'Work' })
    await metaDb!.restoreOperations.accept({
      id: 'restore-a',
      space: rec.id,
      noteId: 'note-a',
      endpoint: 'history-restore',
      actorDigest: 'actor-a',
      idempotencyDigest: 'key-a',
      requestFingerprint: 'request-a',
      stageBinding: 'stage-a',
      sourceRevisionId: 'revision-a',
      targetPath: 'note.md',
      preparedEvidence: '{"kind":"accepted"}',
      createdAt: '2026-08-11T00:00:00.000Z',
    })

    await expect(manager.archive(rec.id)).rejects.toMatchObject({ reason: 'space_busy' })
    await metaDb!.restoreOperations.transition({
      id: 'restore-a',
      expectedPhases: ['staged'],
      phase: 'rejected',
      updatedAt: '2026-08-11T00:01:00.000Z',
      failureCode: 'archive-won',
    })
    await manager.resumeLifecycle(rec.id)

    expect(manager.listArchived()).toEqual([expect.objectContaining({ id: rec.id })])
    expect(await metaDb!.spaceLifecycle.get(rec.id)).toMatchObject({ phase: 'archived' })
  })

  it('admits only the preaccepted causal operation through lifecycle closing', async () => {
    const metaDb = fakeMetaDb()
    const releaseStore = vi.fn()
    const store = {
      ...stubStore(),
      beginCausalPublication: vi.fn(async () => releaseStore),
    } as SpaceStore
    const manager = new SpaceManager({
      spaces: [],
      createStore: () => store,
      createSpace: async () => {},
      metaDb,
    })
    await manager.init()
    const rec = await manager.create({ slug: 'work', displayName: 'Work' })
    await metaDb!.restoreOperations.accept({
      id: 'restore-accepted',
      space: rec.id,
      noteId: 'note-a',
      endpoint: 'history-restore',
      actorDigest: 'actor-a',
      idempotencyDigest: 'key-a',
      requestFingerprint: 'request-a',
      stageBinding: 'stage-a',
      sourceRevisionId: 'revision-a',
      targetPath: 'note.md',
      preparedEvidence: '{"kind":"accepted"}',
      createdAt: '2026-08-11T00:00:00.000Z',
    })

    await expect(manager.archive(rec.id)).rejects.toMatchObject({ reason: 'space_busy' })
    await expect(manager.beginCausalPublication(rec.id)).rejects.toMatchObject({ isNotFound: true })
    await expect(
      manager.beginCausalPublication(rec.id, {
        kind: 'restore',
        operationId: 'not-accepted',
      }),
    ).rejects.toMatchObject({ isNotFound: true })
    await expect(
      metaDb!.restoreOperations.accept({
        id: 'restore-fresh',
        space: rec.id,
        noteId: 'note-b',
        endpoint: 'history-restore',
        actorDigest: 'actor-b',
        idempotencyDigest: 'key-b',
        requestFingerprint: 'request-b',
        stageBinding: 'stage-b',
        sourceRevisionId: 'revision-b',
        targetPath: 'other.md',
        preparedEvidence: '{"kind":"accepted"}',
        createdAt: '2026-08-11T00:01:00.000Z',
      }),
    ).rejects.toThrow(/lifecycle/i)

    const release = await manager.beginCausalPublication(rec.id, {
      kind: 'restore',
      operationId: 'restore-accepted',
    })
    expect(store.beginCausalPublication).toHaveBeenCalledTimes(1)
    release()
    expect(releaseStore).toHaveBeenCalledTimes(1)
  })

  it('archive refuses a personal and a config-pinned space (#110)', async () => {
    const metaDb = fakeMetaDb()
    const manager: SpaceManager = new SpaceManager({
      spaces: [{ slug: 'pinned', displayName: 'Pinned' }], // config-pinned (slug from env)
      createStore: () => stubStore(),
      createSpace: async () => {},
      metaDb,
      isPersonalSpace: async (id) => id === manager.resolveId('mine'),
    })
    await manager.init()
    await manager.create({ slug: 'mine', displayName: 'Personal' })
    await expect(manager.archive(manager.resolveId('mine')!)).rejects.toThrow(/personal/)
    await expect(manager.archive(manager.resolveId('pinned')!)).rejects.toThrow(/config-pinned/)
  })

  it('purge wipes meta-DB + on-disk, but refuses a live or personal space (#110)', async () => {
    const metaDb = fakeMetaDb()
    const purgedDisk: string[] = []
    const manager: SpaceManager = new SpaceManager({
      spaces: [],
      createStore: () => stubStore(),
      createSpace: async () => {},
      metaDb,
      onPurge: async (rec) => {
        purgedDisk.push(rec.slug)
      },
      isPersonalSpace: async (id) => id === manager.resolveId('mine'),
    })
    await manager.init()
    await manager.create({ slug: 'mine', displayName: 'Personal' })
    const rec = await manager.create({ slug: 'old', displayName: 'Old' })
    // A personal space is never purgeable (even once archived — guarded first).
    await expect(manager.purge(manager.resolveId('mine')!)).rejects.toThrow(/personal/)
    // A live (un-archived) space can't be purged — archive is the mandatory safety stop.
    await expect(manager.purge(rec.id)).rejects.toMatchObject({ reason: 'not_archived' })
    await manager.archive(rec.id)
    await manager.purge(rec.id)
    expect(purgedDisk).toEqual(['old']) // on-disk cleanup ran
    expect(manager.has(rec.id)).toBe(false) // entry dropped
    expect(manager.listArchived()).toEqual([])
    expect(manager.resolveId('old')).toBeNull() // slug freed
    expect(await metaDb!.spaces.getById(rec.id)).toBeNull() // registry row gone
  })

  it('resumes physical purge from its manifest before disk discovery on restart', async () => {
    const metaDb = fakeMetaDb()
    let cleanupAttempts = 0
    const first = new SpaceManager({
      spaces: [],
      createStore: () => stubStore(),
      createSpace: async () => {},
      metaDb,
      onPurge: async () => {
        cleanupAttempts++
        throw new Error('filesystem unavailable')
      },
    })
    await first.init()
    const rec = await first.create({ slug: 'old', displayName: 'Old' })
    await first.archive(rec.id, 'user:tester')

    await expect(first.purge(rec.id)).rejects.toThrow('filesystem unavailable')
    expect(await metaDb!.spaces.getById(rec.id)).toBeNull()
    expect(await metaDb!.spaceLifecycle.get(rec.id)).toMatchObject({
      phase: 'metadata-cleaned',
      cleanupManifest: expect.stringContaining(rec.notesDir),
    })

    const discovered = vi.fn(async () => [
      {
        id: rec.id,
        slug: rec.slug,
        aliases: rec.aliases,
        notesDir: rec.notesDir,
        displayName: rec.displayName,
      },
    ])
    const restarted = new SpaceManager({
      spaces: [],
      createStore: () => stubStore(),
      metaDb,
      discoverDiskSpaces: discovered,
      onPurge: async (manifestRecord) => {
        cleanupAttempts++
        expect(manifestRecord).toMatchObject({ id: rec.id, notesDir: rec.notesDir })
      },
    })
    await restarted.init()

    expect(discovered).toHaveBeenCalledTimes(1)
    expect(restarted.resolveId(rec.slug)).toBeNull()
    expect(await metaDb!.spaceLifecycle.get(rec.id)).toMatchObject({ phase: 'purged' })
    expect(cleanupAttempts).toBe(2)
  })

  it('onProvision fires once for a config space on its FIRST boot, never again (#97 auto-mark root)', async () => {
    const provisioned: string[] = []
    const metaDb = fakeMetaDb()
    const make = () =>
      new SpaceManager({
        spaces: [
          { slug: 'a', displayName: 'A' },
          { slug: 'b', displayName: 'B' },
        ],
        createStore: () => stubStore(),
        metaDb,
        onProvision: async (rec) => {
          provisioned.push(rec.slug)
        },
      })
    await make().init()
    expect(provisioned.sort()).toEqual(['a', 'b']) // both fresh on the first-ever boot
    provisioned.length = 0
    // A restart (rows already recorded) re-provisions NOTHING — so a root a user
    // unmarked stays unmarked.
    await make().init()
    expect(provisioned).toEqual([])
  })

  it('create provisions a genuinely new space, but a restart re-mint (row kept) does not (#97)', async () => {
    const provisioned: string[] = []
    const metaDb = fakeMetaDb()
    const manager = new SpaceManager({
      spaces: [{ slug: 'a', displayName: 'A' }],
      createStore: () => stubStore(),
      createSpace: async () => {},
      metaDb,
      onProvision: async (rec) => {
        provisioned.push(rec.slug)
      },
    })
    await manager.init() // provisions 'a'
    provisioned.length = 0
    await manager.create({ slug: 'fresh', displayName: 'Fresh' })
    expect(provisioned).toEqual(['fresh']) // first mint → provisioned
    // Simulate a restart: the entry is forgotten but the meta-DB row survives
    // (remove() does not delete it). Re-minting must NOT re-provision. With a
    // meta-DB the id is opaque (≠ slug), so resolve it for remove (#100 phase 4).
    await manager.remove(manager.resolveId('fresh')!)
    provisioned.length = 0
    await manager.create({ slug: 'fresh', displayName: 'Fresh' })
    expect(provisioned).toEqual([])
  })

  it('stopAll settles every live store (journal flushes land before close)', async () => {
    const stores: SpaceStore[] = []
    const manager = new SpaceManager({
      spaces: [
        { slug: 'a', displayName: 'A' },
        { slug: 'b', displayName: 'B' },
      ],
      createStore: () => {
        const s = stubStore()
        stores.push(s)
        return s
      },
    })
    await manager.store('a')
    await manager.store('b')
    await manager.stopAll()
    for (const s of stores) {
      expect(s.stop).toHaveBeenCalled()
      expect(s.settle).toHaveBeenCalled()
    }
  })

  // ── #126 cross-host space_id continuity (re-clone into an empty meta-DB) ──────

  it('adopts a re-cloned RUNTIME space folder by its marker id, alias-resolving its slug (#126)', async () => {
    const metaDb = fakeMetaDb()
    const manager = new SpaceManager({
      spaces: [],
      createStore: () => stubStore(),
      metaDb,
      // The disk walk found a space folder carrying a `space` facet.
      discoverDiskSpaces: async () => [
        {
          id: 'origSpaceAA1',
          slug: 'work',
          aliases: ['oldwork'],
          notesDir: 'work',
          displayName: 'Work',
        },
      ],
    })
    await manager.init()
    // The marker-borne id is adopted (NOT a fresh local one) — cross-host continuity.
    expect(manager.resolveId('work')).toBe('origSpaceAA1')
    expect(manager.recOf('origSpaceAA1')?.notesDir).toBe('work')
    // Its past slug still resolves (alias history travelled in the marker).
    expect(manager.resolveId('oldwork')).toBe('origSpaceAA1')
  })

  it('a restart re-discovers the SAME folder without churning the id or aliases (#126 idempotent)', async () => {
    const metaDb = fakeMetaDb()
    const discoverDiskSpaces = async () => [
      {
        id: 'stableSpace1',
        slug: 'work',
        aliases: ['oldwork'],
        notesDir: 'work',
        displayName: 'Work',
      },
    ]
    const make = () =>
      new SpaceManager({ spaces: [], createStore: () => stubStore(), metaDb, discoverDiskSpaces })
    await make().init()
    const first = (await metaDb!.spaces.getBySlug('work'))!.id
    await make().init() // restart
    const row = (await metaDb!.spaces.getBySlug('work'))!
    expect(row.id).toBe(first)
    expect(row.aliases).toEqual(['oldwork']) // alias history survives the restart
    expect((await metaDb!.spaces.list()).filter((s) => s.notesDir === 'work')).toHaveLength(1)
  })

  it('fails closed on an alias shared by config and runtime spaces regardless of load order', async () => {
    const metaDb = fakeMetaDb()
    await metaDb!.spaces.upsert({
      id: 'olderRuntime1',
      slug: 'runtime',
      displayName: 'Runtime',
      notesDir: 'runtime',
      aliases: ['retired'],
      createdAt: '2026-01-01T00:00:00.000Z',
      archivedAt: null,
      archivedBy: null,
    })
    await metaDb!.spaces.upsert({
      id: 'newerConfig1',
      slug: 'config',
      displayName: 'Config',
      notesDir: 'config',
      aliases: ['retired'],
      createdAt: '2026-02-01T00:00:00.000Z',
      archivedAt: null,
      archivedBy: null,
    })
    const manager = new SpaceManager({
      spaces: [{ slug: 'config', displayName: 'Config' }],
      createStore: () => stubStore(),
      metaDb,
    })

    await manager.init()
    expect(manager.resolveId('config')).toBe('newerConfig1')
    expect(manager.resolveId('runtime')).toBe('olderRuntime1')
    expect(manager.resolveId('retired')).toBeNull()
    expect(manager.resolvableAliasesOf('newerConfig1')).toEqual([])
    expect(manager.resolvableAliasesOf('olderRuntime1')).toEqual([])
  })

  it('a registry row for the folder wins over a divergent marker id — no duplicate (#126)', async () => {
    const metaDb = fakeMetaDb()
    // The folder already has a row under id A — e.g. a prior collision-mint whose marker
    // heal never landed, so the on-disk marker still claims a different id B. Idempotency
    // keys on the folder (notes_dir), so the host row wins and nothing is re-seeded.
    await metaDb!.spaces.upsert({
      id: 'localIdAAAA1',
      slug: 'work',
      displayName: 'Work',
      notesDir: 'work',
      aliases: [],
      createdAt: 'x',
      archivedAt: null,
      archivedBy: null,
    })
    const manager = new SpaceManager({
      spaces: [],
      createStore: () => stubStore(),
      metaDb,
      discoverDiskSpaces: async () => [
        { id: 'markerIdBBB2', slug: 'work', aliases: [], notesDir: 'work', displayName: 'Work' },
      ],
    })
    await manager.init()
    const rows = (await metaDb!.spaces.list()).filter((s) => s.notesDir === 'work')
    expect(rows).toHaveLength(1) // not duplicated boot-over-boot
    expect(rows[0].id).toBe('localIdAAAA1') // registry id kept; marker id ignored
  })

  it('a cross-host id collision (same marker id, different folder) mints fresh for the newcomer (#126)', async () => {
    const metaDb = fakeMetaDb()
    const manager = new SpaceManager({
      spaces: [],
      createStore: () => stubStore(),
      metaDb,
      discoverDiskSpaces: async () => [
        { id: 'clashId00001', slug: 'alpha', aliases: [], notesDir: 'alpha', displayName: 'Alpha' },
        { id: 'clashId00001', slug: 'beta', aliases: [], notesDir: 'beta', displayName: 'Beta' },
      ],
    })
    await manager.init()
    const alpha = manager.resolveId('alpha')
    const beta = manager.resolveId('beta')
    expect(alpha).toBe('clashId00001') // first wins the id
    expect(beta).toBeTruthy()
    expect(beta).not.toBe('clashId00001') // second got a fresh local id
  })

  it('a discovered slug already taken is suffixed, the marker slug retiring to an alias (#126)', async () => {
    const metaDb = fakeMetaDb()
    const manager = new SpaceManager({
      spaces: [],
      createStore: () => stubStore(),
      metaDb,
      discoverDiskSpaces: async () => [
        { id: 'firstDocs001', slug: 'docs', aliases: [], notesDir: 'docs', displayName: 'Docs' },
        {
          id: 'secondDocs02',
          slug: 'docs',
          aliases: [],
          notesDir: 'docs-clone',
          displayName: 'Docs Clone',
        },
      ],
    })
    await manager.init()
    expect(manager.resolveId('docs')).toBe('firstDocs001') // current wins
    expect(manager.recOf('secondDocs02')?.slug).toBe('docs-2') // suffixed
    expect(manager.recOf('secondDocs02')?.aliases).toContain('docs') // old slug kept as alias
  })

  it('adopts a re-cloned CONFIG space id via its root marker facet (#126)', async () => {
    const provisioned: string[] = []
    const metaDb = fakeMetaDb()
    const manager = new SpaceManager({
      spaces: [{ slug: 'main', displayName: 'Home' }],
      createStore: () => stubStore(),
      metaDb,
      onProvision: async (rec) => {
        provisioned.push(rec.slug)
      },
      // The config space's folder was re-cloned with its space facet.
      readSpaceFacet: async (def) =>
        def.slug === 'main' ? { id: 'mainSpaceX01', slug: 'main' } : undefined,
    })
    await manager.init()
    expect(manager.resolveId('main')).toBe('mainSpaceX01') // adopted, not freshly minted
    expect(provisioned).toEqual(['main']) // still a first-ever boot on this host
  })

  it('adopts pre-#16 legacy rows only when a target is configured (#99)', async () => {
    const adopted: string[] = []
    const spaceLifecycle = new InMemorySpaceLifecyclePersistence()
    const restoreOperations = new InMemoryRestoreOperationPersistence(spaceLifecycle)
    const metaDb = {
      adoptLegacyRows: async (slug: string) => {
        adopted.push(slug)
      },
      restoreOperations,
      spaceLifecycle,
      spaces: {
        list: async () => [],
        getById: async () => null,
        getBySlug: async () => null,
        upsert: async () => {},
      },
    } as unknown as SpaceManagerOptions['metaDb']
    // No adoptLegacyInto (zero-config / explicit) → never adopts.
    await new SpaceManager({
      spaces: [{ slug: 'a', displayName: 'A' }],
      createStore: () => stubStore(),
      metaDb,
    }).init()
    expect(adopted).toEqual([])
    // Legacy single-space path sets it → adopts into that one space.
    await new SpaceManager({
      spaces: [{ slug: 'legacy', displayName: 'Legacy' }],
      adoptLegacyInto: 'legacy',
      createStore: () => stubStore(),
      metaDb,
    }).init()
    expect(adopted).toEqual(['legacy'])
  })
})

// KnowledgeStore import is used only for type-level compatibility of the stub.
void (0 as unknown as KnowledgeStore | undefined)
