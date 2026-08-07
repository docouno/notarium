// Stable-id wikilinks through the production composition: the read-model owns
// identity while the bare engine owns files, direct resolution and graph/search
// derivation. This seam is where an idless external file or a copied frontmatter
// claim can otherwise make graph and direct reads disagree.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  CachedStore,
  encodeWikilinkIdentity,
  type IdentityPersistence,
  type IdentityRecord,
} from '@notarium/core'
import { createNotariumStore } from '@notarium/engine'
import type { SpaceRecord } from '../../packages/server/src/services/metaDb'
import { SpaceManager } from '../../packages/server/src/services/spaces'
import type { SpaceManagerOptions } from '../../packages/server/src/services/spaces'

describe('CachedStore(NotariumStore) — authoritative link identities', () => {
  const persistedIdentity = (records: IdentityRecord[]): IdentityPersistence => {
    const rows = new Map(records.map((record) => [record.id, { ...record }]))

    return {
      init: async () => {},
      loadAll: async () => [...rows.values()].map((record) => ({ ...record })),
      upsertMany: async (next) => {
        for (const record of next) {
          rows.set(record.id, { ...record })
        }
      },
      findById: async (id) => rows.get(id) ?? null,
      close: async () => {},
    }
  }

  it('waits for cold identity reconciliation before resolving a plain stable id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-cached-cold-resolve-'))
    writeFileSync(
      join(root, 'target.md'),
      '---\nnotarium-id: durable-id\ntitle: Target\n---\n\ntarget',
    )
    writeFileSync(
      join(root, 'decoy.md'),
      '---\nnotarium-id: decoy-id\ntitle: durable-id\n---\n\ndecoy',
    )
    const inner = createNotariumStore({ notesDir: root })
    const list = inner.list.bind(inner)
    let announceList!: () => void
    let releaseList!: () => void
    const listStarted = new Promise<void>((resolve) => {
      announceList = resolve
    })
    const listRelease = new Promise<void>((resolve) => {
      releaseList = resolve
    })

    inner.list = async (opts) => {
      announceList()
      await listRelease
      return list(opts)
    }
    const identityPersistence = persistedIdentity([])
    const store = new CachedStore({
      inner,
      identityPersistence,
      pollIntervalMs: 0,
      readBody: async (filePath) => readFileSync(join(root, filePath), 'utf8'),
    })

    try {
      const boot = store.start()

      await listStarted
      expect((await store.syncStatus()).scan.phase).toBe('notes')
      const provisionalId = (await store.list()).find((note) => note.filePath === 'target.md')?.id

      if (!provisionalId) {
        throw new Error('phase-1 target must be visible')
      }
      expect(provisionalId).not.toBe('durable-id')
      await expect(identityPersistence.findById!(provisionalId)).resolves.toMatchObject({
        id: provisionalId,
        filePath: 'target.md',
      })
      const openingProvisional = store.read(provisionalId)
      let settled = false
      const resolving = store.resolveWikilink('durable-id').then((detail) => {
        settled = true
        return detail
      })

      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(settled).toBe(false)

      releaseList()
      await boot
      await expect(resolving).resolves.toMatchObject({
        id: 'durable-id',
        content: 'target',
      })
      await expect(openingProvisional).resolves.toMatchObject({
        id: 'durable-id',
        content: 'target',
      })
    } finally {
      releaseList()
      store.stop()
      await store.settle()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('holds the first lazy global-id read until duplicate ownership is authoritative', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-cached-global-owner-'))
    const duplicate = (title: string, body: string) =>
      `---\nnotarium-id: duplicate-id\ntitle: ${title}\n---\n\n${body}`

    writeFileSync(join(root, 'a.md'), duplicate('Wrong Copy', 'wrong body'))
    writeFileSync(join(root, 'z.md'), duplicate('Persisted Owner', 'owner body'))
    let releaseIdentityLoad!: () => void
    const identityLoad = new Promise<void>((resolve) => {
      releaseIdentityLoad = resolve
    })
    const owner: IdentityRecord = {
      id: 'duplicate-id',
      filePath: 'z.md',
      space: 'space-id',
      createdAt: null,
      materialized: true,
      deletedAt: null,
    }
    const identityPersistence: IdentityPersistence = {
      init: async () => {},
      loadAll: async () => {
        await identityLoad
        return [{ ...owner }]
      },
      upsertMany: async () => {},
      findById: async (id) => (id === owner.id ? { ...owner } : null),
      close: async () => {},
    }
    const inner = createNotariumStore({ notesDir: root })
    const innerRead = inner.read.bind(inner)
    let innerReads = 0

    inner.read = async (id, opts) => {
      innerReads++
      return innerRead(id, opts)
    }
    const store = new CachedStore({
      inner,
      identityPersistence,
      space: 'space-id',
      pollIntervalMs: 0,
      readBody: async (filePath) => readFileSync(join(root, filePath), 'utf8'),
    })
    const space: SpaceRecord = {
      id: 'space-id',
      slug: 'main',
      displayName: 'Main',
      notesDir: 'main',
      aliases: [],
      createdAt: '2026-06-11T00:00:00.000Z',
      archivedAt: null,
      archivedBy: null,
    }
    const metaDb = {
      adoptLegacyRows: async () => {},
      spaces: {
        list: async () => [{ ...space }],
        getById: async (id: string) => (id === space.id ? { ...space } : null),
        getBySlug: async (slug: string) => (slug === space.slug ? { ...space } : null),
        upsert: async () => {},
      },
      identity: {
        findById: async (id: string) => (id === owner.id ? { ...owner } : null),
      },
    } as unknown as SpaceManagerOptions['metaDb']
    const spaces = new SpaceManager({
      spaces: [],
      metaDb,
      createStore: () => store,
    })

    try {
      await spaces.init()
      let settled = false
      const reading = spaces.resolveNote(owner.id).then(async (hit) => {
        if (!hit) {
          throw new Error('global identity route disappeared')
        }
        const routed = await spaces.store(hit.space)
        const detail = await routed.read(owner.id)

        settled = true
        return detail
      })

      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(settled).toBe(false)
      expect(innerReads).toBe(0)

      releaseIdentityLoad()
      await expect(reading).resolves.toMatchObject({
        id: owner.id,
        filePath: owner.filePath,
        content: 'owner body',
      })
    } finally {
      releaseIdentityLoad()
      store.stop()
      await store.settle()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails a global-id read closed when duplicate ownership cannot load', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-cached-global-owner-failed-'))
    const duplicate = (title: string, body: string) =>
      `---\nnotarium-id: duplicate-id\ntitle: ${title}\n---\n\n${body}`

    writeFileSync(join(root, 'a.md'), duplicate('Wrong Copy', 'wrong body'))
    writeFileSync(join(root, 'z.md'), duplicate('Persisted Owner', 'owner body'))
    const owner: IdentityRecord = {
      id: 'duplicate-id',
      filePath: 'z.md',
      space: 'space-id',
      createdAt: null,
      materialized: true,
      deletedAt: null,
    }
    const identityPersistence: IdentityPersistence = {
      init: async () => {},
      loadAll: async () => {
        throw new Error('identity registry unavailable')
      },
      upsertMany: async () => {},
      findById: async (id) => (id === owner.id ? { ...owner } : null),
      close: async () => {},
    }
    const inner = createNotariumStore({ notesDir: root })
    const innerRead = inner.read.bind(inner)
    let innerReads = 0

    inner.read = async (id, opts) => {
      innerReads++
      return innerRead(id, opts)
    }
    const store = new CachedStore({
      inner,
      identityPersistence,
      space: 'space-id',
      pollIntervalMs: 0,
      readBody: async (filePath) => readFileSync(join(root, filePath), 'utf8'),
    })
    const space: SpaceRecord = {
      id: 'space-id',
      slug: 'main',
      displayName: 'Main',
      notesDir: 'main',
      aliases: [],
      createdAt: '2026-06-11T00:00:00.000Z',
      archivedAt: null,
      archivedBy: null,
    }
    const metaDb = {
      adoptLegacyRows: async () => {},
      spaces: {
        list: async () => [{ ...space }],
        getById: async (id: string) => (id === space.id ? { ...space } : null),
        getBySlug: async (slug: string) => (slug === space.slug ? { ...space } : null),
        upsert: async () => {},
      },
      identity: {
        findById: async (id: string) => (id === owner.id ? { ...owner } : null),
      },
    } as unknown as SpaceManagerOptions['metaDb']
    const spaces = new SpaceManager({ spaces: [], metaDb, createStore: () => store })

    try {
      await spaces.init()
      const reading = spaces.resolveNote(owner.id).then(async (hit) => {
        if (!hit) {
          throw new Error('global identity route disappeared')
        }
        const routed = await spaces.store(hit.space)

        return routed.read(owner.id)
      })

      await expect(reading).rejects.toMatchObject({
        isUnavailable: true,
        reason: 'engine_unavailable',
      })
      expect(innerReads).toBe(0)
    } finally {
      store.stop()
      await store.settle()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not sweep over a durable duplicate owner and recovers identityReady on retry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-cached-owner-retry-'))
    const duplicate = (title: string) =>
      `---\nnotarium-id: duplicate-id\ntitle: ${title}\n---\n\nbody`

    writeFileSync(join(root, 'a.md'), duplicate('Wrong Copy'))
    writeFileSync(join(root, 'z.md'), duplicate('Persisted Owner'))
    const owner: IdentityRecord = {
      id: 'duplicate-id',
      filePath: 'z.md',
      space: 'space-id',
      createdAt: null,
      materialized: true,
      deletedAt: null,
    }
    const rows = new Map([[owner.id, { ...owner }]])
    let loads = 0
    const identityPersistence: IdentityPersistence = {
      init: async () => {},
      loadAll: async () => {
        loads++
        if (loads === 1) {
          throw new Error('transient select failure')
        }

        return [...rows.values()].map((record) => ({ ...record }))
      },
      upsertMany: async (records) => {
        for (const record of records) {
          rows.set(record.id, { ...record })
        }
      },
      findById: async (id) => rows.get(id) ?? null,
      close: async () => {},
    }
    const store = new CachedStore({
      inner: createNotariumStore({ notesDir: root }),
      identityPersistence,
      space: 'space-id',
      pollIntervalMs: 0,
      readBody: async (filePath) => readFileSync(join(root, filePath), 'utf8'),
    })

    try {
      await store.start()
      expect(rows.get(owner.id)?.filePath).toBe('z.md')
      expect(loads).toBe(1)

      await expect(store.identityReady()).resolves.toBeUndefined()
      expect(loads).toBe(2)
      expect(rows.get(owner.id)?.filePath).toBe('z.md')
      await expect(store.read(owner.id)).resolves.toMatchObject({
        id: owner.id,
        filePath: owner.filePath,
      })
    } finally {
      store.stop()
      await store.settle()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps scoped exact envelope/plain ids unavailable without returning a duplicate copy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-cached-owner-scoped-failed-'))
    const duplicate = (title: string, body: string) =>
      `---\nnotarium-id: duplicate-id\ntitle: ${title}\n---\n\n${body}`

    writeFileSync(join(root, 'a.md'), duplicate('Wrong Copy', 'wrong body'))
    writeFileSync(join(root, 'z.md'), duplicate('Persisted Owner', 'owner body'))
    const owner: IdentityRecord = {
      id: 'duplicate-id',
      filePath: 'z.md',
      space: 'space-id',
      createdAt: null,
      materialized: true,
      deletedAt: null,
    }
    const rows = new Map([[owner.id, { ...owner }]])
    const identityPersistence: IdentityPersistence = {
      init: async () => {},
      loadAll: async () => {
        throw new Error('identity registry unavailable')
      },
      upsertMany: async (records) => {
        for (const record of records) {
          rows.set(record.id, { ...record })
        }
      },
      findById: async (id) => rows.get(id) ?? null,
      close: async () => {},
    }
    const inner = createNotariumStore({ notesDir: root })
    const innerRead = inner.read.bind(inner)
    let innerReads = 0

    inner.read = async (id, opts) => {
      innerReads++
      return innerRead(id, opts)
    }
    const store = new CachedStore({
      inner,
      identityPersistence,
      space: 'space-id',
      pollIntervalMs: 0,
      readBody: async (filePath) => readFileSync(join(root, filePath), 'utf8'),
    })

    try {
      await store.start()
      // Human resolution remains useful only because the point lookup proves
      // the selected path owns the body claim; it installs no ephemeral rows.
      await expect(store.resolveWikilink('Persisted Owner')).resolves.toMatchObject({
        id: owner.id,
        filePath: owner.filePath,
        content: 'owner body',
      })
      const readsAfterHuman = innerReads

      await expect(store.resolveWikilink(encodeWikilinkIdentity(owner.id))).rejects.toMatchObject({
        reason: 'engine_unavailable',
        isUnavailable: true,
      })
      await expect(store.resolveWikilink(owner.id)).rejects.toMatchObject({
        reason: 'engine_unavailable',
        isUnavailable: true,
      })
      await expect(store.read(owner.id)).rejects.toMatchObject({
        reason: 'engine_unavailable',
        isUnavailable: true,
      })
      expect(innerReads).toBe(readsAfterHuman)
      expect(rows.get(owner.id)?.filePath).toBe('z.md')
      expect([...rows.values()].some((record) => record.filePath === 'a.md')).toBe(false)
    } finally {
      store.stop()
      await store.settle()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps an edit CAS read exact when another raw id is shaped like its envelope', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-cached-edit-collision-'))
    const inner = createNotariumStore({ notesDir: root })
    const store = new CachedStore({
      inner,
      pollIntervalMs: 0,
      readBody: async (filePath) => readFileSync(join(root, filePath), 'utf8'),
    })

    try {
      await store.start()
      await store.write({ id: 'foo', title: 'Edit Target', content: 'before' })
      await store.write({
        id: 'notarium-id:foo',
        title: 'Envelope ID Decoy',
        content: 'decoy',
      })
      const before = await store.read('foo')

      await store.write({
        originalId: 'foo',
        title: 'Edit Target',
        content: 'after',
        versionToken: before.versionToken,
      })

      await expect(store.read('foo')).resolves.toMatchObject({ content: 'after' })
      await expect(store.read('notarium-id:foo')).resolves.toMatchObject({ content: 'decoy' })
    } finally {
      store.stop()
      await store.settle()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('publishes exact identities lazily for interactive operations during bulk writes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-cached-link-bulk-'))
    const inner = createNotariumStore({ notesDir: root })
    const store = new CachedStore({
      inner,
      pollIntervalMs: 0,
      readBody: async (filePath) => readFileSync(join(root, filePath), 'utf8'),
    })

    try {
      await store.start()
      store.beginBulk()
      const created = await store.write({ title: 'Bulk New', content: 'first' })
      const first = await store.read(created.id!)

      expect(first.content).toBe('first')
      await store.write({
        originalId: created.id,
        title: 'Bulk New',
        content: 'second',
        versionToken: first.versionToken,
      })
      expect((await store.read(created.id!)).content).toBe('second')
      await store.remove(created.id!)
      await expect(store.read(created.id!)).rejects.toThrow(/not found/i)

      const survivor = await store.write({ title: 'Bulk Survivor', content: 'live' })
      await store.endBulk()
      expect((await store.read(survivor.id!)).content).toBe('live')
      expect((await inner.read(encodeWikilinkIdentity(survivor.id!))).content).toBe('live')
    } finally {
      store.stop()
      await store.settle()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('feeds idless and duplicate-claim ownership into direct graph/health resolution', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-cached-link-id-'))
    writeFileSync(join(root, 'target.md'), '---\ntitle: External Target\n---\n\nexternal body')
    const copied = '---\nnotarium-id: copied-id-01\ntitle: Copied Claim\n---\n\ncopy body'
    writeFileSync(join(root, 'a-copy.md'), copied)
    writeFileSync(join(root, 'b-copy.md'), copied)
    const inner = createNotariumStore({ notesDir: root })
    const store = new CachedStore({
      inner,
      pollIntervalMs: 0,
      readBody: async (filePath) => readFileSync(join(root, filePath), 'utf8'),
    })

    try {
      await store.start()
      const inventory = await store.list()
      const external = inventory.find((n) => n.filePath === 'target.md')!
      const claimants = inventory.filter(
        (n) => n.filePath === 'a-copy.md' || n.filePath === 'b-copy.md',
      )
      const owner = claimants.find((n) => n.id === 'copied-id-01')!
      const copiedSibling = claimants.find((n) => n.id !== 'copied-id-01')!

      expect(external.id).toBeTruthy()
      expect(owner).toBeTruthy()
      expect(copiedSibling.id).toBeTruthy()
      expect(copiedSibling.id).not.toBe('copied-id-01')

      const linker = await store.write({
        title: 'Identity Linker',
        content: [
          `[[${encodeWikilinkIdentity(external.id!)}|External Target]]`,
          `[[${encodeWikilinkIdentity('copied-id-01')}|Copied Claim]]`,
        ].join('\n'),
      })
      const graph = await store.graph()
      const targets = graph.links.filter((l) => l.source === linker.id).map((l) => l.target)

      expect(targets).toContain(external.id)
      expect(targets).toContain(owner.id)
      expect(targets).not.toContain(copiedSibling.id)

      // graph() fed the same authoritative registry into the bare engine's direct
      // resolver; neither a missing frontmatter claim nor the copied claim wins.
      expect((await inner.read(encodeWikilinkIdentity(external.id!))).filePath).toBe(
        external.filePath,
      )
      expect((await inner.read(encodeWikilinkIdentity('copied-id-01'))).filePath).toBe(
        owner.filePath,
      )
      expect((await store.graphHealth()).ghosts).toEqual([])
    } finally {
      store.stop()
      await store.settle()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('chooses a duplicate-claim owner by inventory order, not read completion timing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-cached-duplicate-order-'))
    const copied = '---\nnotarium-id: duplicate-id\ntitle: Copied\n---\n\nbody'
    writeFileSync(join(root, 'a.md'), copied)
    writeFileSync(join(root, 'z.md'), copied)
    const inner = createNotariumStore({ notesDir: root })
    const store = new CachedStore({
      inner,
      pollIntervalMs: 0,
      readBody: async (filePath) => {
        if (filePath === 'a.md') {
          await new Promise((resolve) => setTimeout(resolve, 20))
        }

        return readFileSync(join(root, filePath), 'utf8')
      },
    })

    try {
      await store.start()
      const notes = await store.list()

      expect(notes.find((note) => note.filePath === 'a.md')?.id).toBe('duplicate-id')
      expect(notes.find((note) => note.filePath === 'z.md')?.id).not.toBe('duplicate-id')
    } finally {
      store.stop()
      await store.settle()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not publish a poll rekey until its global identity route is durable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-cached-poll-durability-'))
    const durable = new Map<string, IdentityRecord>()
    let rejectDurableId = false
    const identityPersistence: IdentityPersistence = {
      init: async () => {},
      loadAll: async () => [...durable.values()].map((record) => ({ ...record })),
      upsertMany: async (records) => {
        if (rejectDurableId && records.some((record) => record.id === 'external-durable-id')) {
          throw new Error('meta db unavailable')
        }
        for (const record of records) {
          durable.set(record.id, { ...record })
        }
      },
      findById: async (id) => durable.get(id) ?? null,
      close: async () => {},
    }
    const inner = createNotariumStore({ notesDir: root })
    const store = new CachedStore({
      inner,
      identityPersistence,
      pollIntervalMs: 0,
      readBody: async (filePath) => readFileSync(join(root, filePath), 'utf8'),
    })
    const changed: Array<{ upserts: string[]; removed: string[] }> = []

    try {
      await store.start()
      store.subscribe((event) => {
        if (event.type === 'changed') {
          changed.push({ upserts: event.upserts, removed: event.removed })
        }
      })
      writeFileSync(
        join(root, 'external.md'),
        '---\nnotarium-id: external-durable-id\ntitle: External\n---\n\nbody',
      )
      rejectDurableId = true

      await expect(store.checkpoint()).rejects.toThrow('meta db unavailable')
      expect(durable.has('external-durable-id')).toBe(false)
      expect(changed.some((event) => event.upserts.includes('external-durable-id'))).toBe(false)
      await expect(store.list()).rejects.toThrow('meta db unavailable')

      rejectDurableId = false
      await expect(store.list()).resolves.toEqual([
        expect.objectContaining({ id: 'external-durable-id', filePath: 'external.md' }),
      ])
      expect(durable.get('external-durable-id')).toMatchObject({ filePath: 'external.md' })
      expect(changed.some((event) => event.upserts.includes('external-durable-id'))).toBe(true)
    } finally {
      store.stop()
      await store.settle()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps a hidden production-mount namesake out of boot graph and human resolution', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-cached-hidden-link-'))
    const memory = join(root, '.notarium', 'memory')
    mkdirSync(memory, { recursive: true })
    writeFileSync(join(root, 'source.md'), '# Source\n\n[[notarium-id:secret-memory|Secret]]')
    writeFileSync(
      join(memory, 'secret.md'),
      '---\nnotarium-id: secret-memory\ntitle: Secret\n---\n\nprivate memory',
    )
    const inner = createNotariumStore({
      mounts: [
        { class: 'user-doc', dir: root },
        { class: 'agent-memory', dir: memory, prefix: '.notarium/memory' },
      ],
    })
    const store = new CachedStore({
      inner,
      pollIntervalMs: 0,
      readBody: async (filePath) => readFileSync(join(root, filePath), 'utf8'),
    })

    try {
      await store.start()
      const source = (await store.list()).find((note) => note.filePath === 'source.md')!

      await expect(store.resolveWikilink('Secret')).rejects.toMatchObject({ isNotFound: true })
      await expect(
        store.resolveWikilink(encodeWikilinkIdentity('secret-memory')),
      ).rejects.toMatchObject({ isNotFound: true })
      await expect(store.read(encodeWikilinkIdentity('secret-memory'))).resolves.toMatchObject({
        content: 'private memory',
      })
      const graph = await store.graph()
      const edge = graph.links.find((candidate) => candidate.source === source.id)!

      expect(graph.nodes.find((candidate) => candidate.id === edge.target)).toMatchObject({
        ghost: true,
        target: encodeWikilinkIdentity('secret-memory'),
        creatable: false,
      })
    } finally {
      store.stop()
      await store.settle()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps degraded production resolution live without exposing hidden mounts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-cached-degraded-link-'))
    const memory = join(root, '.notarium', 'memory')
    mkdirSync(memory, { recursive: true })
    writeFileSync(
      join(root, 'target.md'),
      '---\nnotarium-id: visible-id\ntitle: Target\n---\n\nvisible target',
    )
    writeFileSync(
      join(memory, 'target.md'),
      '---\nnotarium-id: hidden-target\ntitle: Target\n---\n\nhidden namesake',
    )
    writeFileSync(
      join(memory, 'secret.md'),
      '---\nnotarium-id: secret-memory\ntitle: Secret\n---\n\nhidden secret',
    )
    const inner = createNotariumStore({
      mounts: [
        { class: 'user-doc', dir: root },
        { class: 'agent-memory', dir: memory, prefix: '.notarium/memory' },
      ],
    })

    inner.changes = async () => {
      throw new Error('injected boot failure')
    }
    const store = new CachedStore({
      inner,
      pollIntervalMs: 0,
      readBody: async (filePath) => readFileSync(join(root, filePath), 'utf8'),
    })

    try {
      await store.start()

      expect((await store.syncStatus()).scan.phase).toBe('error')
      await expect(
        store.resolveWikilink(encodeWikilinkIdentity('visible-id')),
      ).resolves.toMatchObject({ id: 'visible-id', content: 'visible target' })
      await expect(store.resolveWikilink('visible-id')).resolves.toMatchObject({
        id: 'visible-id',
        content: 'visible target',
      })
      await expect(store.resolveWikilink('Target')).resolves.toMatchObject({
        id: 'visible-id',
        content: 'visible target',
      })
      await expect(store.resolveWikilink('Secret')).rejects.toMatchObject({ isNotFound: true })
      await expect(
        store.resolveWikilink(encodeWikilinkIdentity('secret-memory')),
      ).rejects.toMatchObject({ isNotFound: true })
    } finally {
      store.stop()
      await store.settle()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('honours a persisted exact owner over duplicate frontmatter claims in degraded boot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-cached-degraded-owner-'))
    const duplicate = (title: string, body: string) =>
      `---\nnotarium-id: duplicate-id\ntitle: ${title}\n---\n\n${body}`
    writeFileSync(join(root, 'a.md'), duplicate('Wrong Copy', 'wrong body'))
    writeFileSync(join(root, 'z.md'), duplicate('Persisted Owner', 'owner body'))
    const inner = createNotariumStore({ notesDir: root })

    inner.changes = async () => {
      throw new Error('injected boot failure')
    }
    const identityPersistence = persistedIdentity([
      {
        id: 'duplicate-id',
        filePath: 'z.md',
        space: 'main',
        createdAt: null,
        materialized: true,
        deletedAt: null,
      },
    ])
    const store = new CachedStore({
      inner,
      identityPersistence,
      pollIntervalMs: 0,
      readBody: async (filePath) => readFileSync(join(root, filePath), 'utf8'),
    })

    try {
      await store.start()

      await expect(store.read('duplicate-id')).resolves.toMatchObject({
        id: 'duplicate-id',
        filePath: 'z.md',
        content: 'owner body',
      })
      await expect(
        store.resolveWikilink(encodeWikilinkIdentity('duplicate-id')),
      ).resolves.toMatchObject({ filePath: 'z.md', content: 'owner body' })
    } finally {
      store.stop()
      await store.settle()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps degraded search and graph surfaces on the note-id axis', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-cached-degraded-surfaces-'))
    writeFileSync(
      join(root, 'source.md'),
      '---\nnotarium-id: durable-source\ntitle: Source\n---\n\n[[notarium-id:durable-target|Target]]\n[[Missing Target]]',
    )
    writeFileSync(
      join(root, 'target.md'),
      '---\nnotarium-id: durable-target\ntitle: Target\n---\n\nunique-search-marker',
    )
    const inner = createNotariumStore({ notesDir: root })

    inner.changes = async () => {
      throw new Error('injected boot failure')
    }
    const records: IdentityRecord[] = [
      {
        id: 'durable-source',
        filePath: 'source.md',
        space: 'main',
        createdAt: null,
        materialized: true,
        deletedAt: null,
      },
      {
        id: 'durable-target',
        filePath: 'target.md',
        space: 'main',
        createdAt: null,
        materialized: true,
        deletedAt: null,
      },
    ]
    const store = new CachedStore({
      inner,
      identityPersistence: persistedIdentity(records),
      pollIntervalMs: 0,
      readBody: async (filePath) => readFileSync(join(root, filePath), 'utf8'),
    })

    try {
      await store.start()

      await expect(store.search('unique-search-marker')).resolves.toEqual([
        expect.objectContaining({ id: 'durable-target', filePath: 'target.md' }),
      ])
      const graph = await store.graph()

      expect(graph.nodes).toContainEqual(
        expect.objectContaining({ id: 'durable-source', filePath: 'source.md' }),
      )
      expect(graph.nodes).toContainEqual(
        expect.objectContaining({ id: 'durable-target', filePath: 'target.md' }),
      )
      expect(graph.links).toContainEqual(
        expect.objectContaining({ source: 'durable-source', target: 'durable-target' }),
      )
      const health = await store.graphHealth()

      expect(health.ghosts).toContainEqual(
        expect.objectContaining({
          sources: [expect.objectContaining({ id: 'durable-source' })],
        }),
      )
    } finally {
      store.stop()
      await store.settle()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not return a same-path replacement for a stale degraded title decision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-cached-degraded-race-'))
    writeFileSync(
      join(root, 'entry.md'),
      '---\nnotarium-id: durable-id\ntitle: Target\n---\n\noriginal',
    )
    const inner = createNotariumStore({ notesDir: root })

    inner.changes = async () => {
      throw new Error('injected boot failure')
    }
    const store = new CachedStore({
      inner,
      pollIntervalMs: 0,
      readBody: async (filePath) => readFileSync(join(root, filePath), 'utf8'),
    })

    try {
      await store.start()
      const list = inner.list.bind(inner)
      let replaceAfterList = true

      inner.list = async (opts) => {
        const rows = await list(opts)

        if (replaceAfterList) {
          replaceAfterList = false
          writeFileSync(
            join(root, 'entry.md'),
            '---\nnotarium-id: replacement-id\ntitle: Other\n---\n\nreplacement',
          )
        }

        return rows
      }

      await expect(store.resolveWikilink('Target')).rejects.toMatchObject({ isNotFound: true })
      await expect(store.resolveWikilink('entry')).resolves.toMatchObject({
        id: 'replacement-id',
        title: 'Other',
        content: 'replacement',
      })
    } finally {
      store.stop()
      await store.settle()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refreshes identity reads after write and keeps a deleted target non-creatable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-cached-link-live-'))
    const inner = createNotariumStore({ notesDir: root })
    const store = new CachedStore({
      inner,
      pollIntervalMs: 0,
      readBody: async (filePath) => readFileSync(join(root, filePath), 'utf8'),
    })

    try {
      await store.start()
      const target = await store.write({ title: 'Ephemeral Target', content: 'target' })
      const address = encodeWikilinkIdentity(target.id!)

      // No search()/graph() side effect is needed to refresh the inner identity map.
      expect((await store.read(address)).title).toBe('Ephemeral Target')
      expect((await inner.read(address)).title).toBe('Ephemeral Target')

      const source = await store.write({
        title: 'Stable Link Source',
        content: `[[${address}|Ephemeral Target]]`,
      })
      await store.remove(target.id!)
      const graph = await store.graph()
      const ghost = graph.nodes.find((node) => node.ghost && node.target === address)

      expect(graph.links).toContainEqual(
        expect.objectContaining({ source: source.id, target: ghost?.id }),
      )
      expect(ghost).toMatchObject({ ghost: true, target: address, creatable: false })
      expect((await inner.graph()).nodes).toContainEqual(
        expect.objectContaining({ ghost: true, target: address, creatable: false }),
      )
    } finally {
      store.stop()
      await store.settle()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps stable intent when a post-delete source read falls back to the engine graph', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-cached-link-fallback-'))
    const inner = createNotariumStore({ notesDir: root })
    const store = new CachedStore({
      inner,
      pollIntervalMs: 0,
      readBody: async (filePath) => readFileSync(join(root, filePath), 'utf8'),
    })

    try {
      await store.start()
      const target = await store.write({ title: 'Fallback Target', content: 'target' })
      const address = encodeWikilinkIdentity(target.id!)
      const source = await store.write({
        title: 'Fallback Source',
        content: `[[${address}|Fallback Target]]`,
      })
      const read = inner.read.bind(inner)

      inner.read = async (id) => {
        if (id === source.filePath) {
          throw new Error('injected source read failure')
        }

        return read(id)
      }

      await store.remove(target.id!)
      const graph = await store.graph()
      const ghost = graph.nodes.find((node) => node.ghost && node.target === address)

      expect(ghost).toMatchObject({ target: address, creatable: false })
      expect(graph.links).toContainEqual(
        expect.objectContaining({ source: source.id, target: ghost?.id }),
      )
    } finally {
      store.stop()
      await store.settle()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('heals a fallback path ghost after a concurrent create publishes its identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-cached-fallback-create-'))
    const inner = createNotariumStore({ notesDir: root })
    const store = new CachedStore({
      inner,
      pollIntervalMs: 0,
      readBody: async (filePath) => readFileSync(join(root, filePath), 'utf8'),
    })

    try {
      await store.start()
      const doomed = await store.write({ title: 'Doomed', content: 'target' })
      const source = await store.write({
        title: 'Fallback Source',
        content: '[[Doomed]] [[Newcomer]]',
      })
      const read = inner.read.bind(inner)
      const sourceAddress = encodeWikilinkIdentity(source.id!)

      inner.read = async (id) => {
        if (id === sourceAddress) {
          throw new Error('injected source read failure')
        }

        return read(id)
      }

      const write = inner.write.bind(inner)
      let entered!: () => void
      let release!: () => void
      const committed = new Promise<void>((resolve) => {
        entered = resolve
      })
      const resume = new Promise<void>((resolve) => {
        release = resolve
      })

      inner.write = async (input) => {
        const result = await write(input)

        if (input.title === 'Newcomer') {
          entered()
          await resume
        }

        return result
      }

      const creating = store.write({ title: 'Newcomer', content: 'new target' })
      await committed
      await store.remove(doomed.id!)
      release()
      const newcomer = await creating
      const graph = await store.graph()

      expect(graph.links).toContainEqual(
        expect.objectContaining({ source: source.id, target: newcomer.id }),
      )
      expect(graph.nodes.some((node) => node.ghost && node.target === 'newcomer')).toBe(false)
    } finally {
      store.stop()
      await store.settle()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not let stale bare-engine write or move capture a namesake', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-cached-stale-mutation-'))
    const inner = createNotariumStore({ notesDir: root })
    const store = new CachedStore({
      inner,
      pollIntervalMs: 0,
      readBody: async (filePath) => readFileSync(join(root, filePath), 'utf8'),
    })

    try {
      await store.start()
      const victim = await store.write({ title: 'Victim', content: 'same bytes' })
      const decoy = await store.write({
        title: victim.id!,
        fileName: 'decoy',
        content: 'same bytes',
      })
      const stale = await store.read(victim.id!)

      await store.remove(victim.id!)

      await expect(
        store.write({
          originalId: victim.id,
          title: 'Victim',
          content: 'stale overwrite',
          versionToken: stale.versionToken,
        }),
      ).rejects.toMatchObject({ isNotFound: true })
      await expect(
        store.move({ id: victim.id!, destinationPath: 'moved.md' }),
      ).rejects.toMatchObject({ isNotFound: true })
      expect(await store.read(decoy.id!)).toMatchObject({
        id: decoy.id,
        filePath: decoy.filePath,
        content: 'same bytes',
      })
    } finally {
      store.stop()
      await store.settle()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not let a stale bare-engine path read through after an external delete', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-cached-stale-read-'))
    const inner = createNotariumStore({ notesDir: root })
    const store = new CachedStore({
      inner,
      pollIntervalMs: 0,
      readBody: async (filePath) => readFileSync(join(root, filePath), 'utf8'),
    })

    try {
      await store.start()
      const victim = await store.write({ title: 'Human Target', content: 'TARGET' })
      const decoy = await store.write({
        title: 'human-target',
        fileName: 'decoy',
        content: 'DECOY',
      })

      await inner.remove(victim.filePath!)

      await expect(store.read(victim.id!)).rejects.toMatchObject({ isNotFound: true })
      expect(await store.read(decoy.id!)).toMatchObject({
        id: decoy.id,
        filePath: decoy.filePath,
        content: 'DECOY',
      })
    } finally {
      store.stop()
      await store.settle()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('re-adopts and atomically heals a legacy `.md` through LocalFS', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-cached-legacy-name-'))
    const folder = join(root, 'journal')
    mkdirSync(folder)
    writeFileSync(
      join(folder, '.md'),
      '---\nnotarium-id: LEGACYID0001\ntitle: 第三季度规划\n---\n\n# 第三季度规划\n\nlegacy-live-marker',
    )
    const inner = createNotariumStore({ notesDir: root })
    const store = new CachedStore({
      inner,
      pollIntervalMs: 0,
      readBody: async (filePath) => readFileSync(join(root, filePath), 'utf8'),
    })

    try {
      await store.start()
      const note = (await store.list()).find((item) => item.id === 'LEGACYID0001')!
      expect(note.filePath).toBe('journal/第三季度规划.md')
      expect((await store.read('LEGACYID0001')).content).toContain('legacy-live-marker')
      expect((await store.search('legacy-live-marker')).map((hit) => hit.id)).toContain(
        'LEGACYID0001',
      )
      expect((await store.graph()).nodes).toContainEqual(
        expect.objectContaining({ id: 'LEGACYID0001', ghost: false }),
      )

      const current = await store.read('LEGACYID0001')
      const saved = await store.write({
        originalId: 'LEGACYID0001',
        title: '第三季度规划',
        directory: 'journal',
        content: 'edited legacy-live-marker',
        versionToken: current.versionToken,
      })
      expect(saved.filePath).toBe('journal/第三季度规划.md')
    } finally {
      store.stop()
      await store.settle()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
