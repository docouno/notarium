import {
  promises as fsPromises,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CachedStore,
  encodeWikilinkIdentity,
  idToSlug,
  InMemoryRevisionPersistence,
  type KnowledgeStore,
  type MoveInput,
  type NoteContent,
  RevisionJournal,
  type StoreDelta,
  type StoreEvent,
  type WriteInput,
} from '@notarium/core'
import { createNotariumStore } from '@notarium/engine'
import { InMemoryStore } from '@notarium/engine-memory'
import { InMemoryIdentity } from '../fake-server/identity'

type Harness = {
  inner: KnowledgeStore
  revisions: InMemoryRevisionPersistence
  store: CachedStore
  /** The engine's on-disk root — only a filesystem-backed leg has one, and only a
   *  test that plants a file behind the index needs it. */
  notesDir?: string
  close: () => Promise<void>
}

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const gateWrite = (inner: KnowledgeStore, match: (input: WriteInput) => boolean) => {
  const entered = deferred()
  const release = deferred()
  const write = inner.write.bind(inner)
  let armed = true

  inner.write = async (input) => {
    if (armed && match(input)) {
      armed = false
      entered.resolve()
      await release.promise
    }

    return write(input)
  }

  return { entered: entered.promise, release: release.resolve }
}

const gateMove = (inner: KnowledgeStore, match: (input: MoveInput) => boolean) => {
  const entered = deferred()
  const release = deferred()
  const move = inner.move.bind(inner)
  let armed = true

  inner.move = async (input) => {
    if (armed && match(input)) {
      armed = false
      entered.resolve()
      await release.promise
    }

    return move(input)
  }

  return { entered: entered.promise, release: release.resolve }
}

const gateRemoveDir = (inner: KnowledgeStore) => {
  const entered = deferred()
  const release = deferred()
  const removeDir = inner.removeDir!.bind(inner)
  let armed = true

  inner.removeDir = async (path, opts) => {
    if (armed) {
      armed = false
      entered.resolve()
      await release.promise
    }

    return removeDir(path, opts)
  }

  return { entered: entered.promise, release: release.resolve }
}

const gateRemove = (inner: KnowledgeStore, match: (id: string) => boolean) => {
  const entered = deferred()
  const release = deferred()
  const remove = inner.remove.bind(inner)
  let armed = true

  inner.remove = async (id, opts) => {
    if (armed && match(id)) {
      armed = false
      entered.resolve()
      await release.promise
    }

    return remove(id, opts)
  }

  return { entered: entered.promise, release: release.resolve }
}

const gateChanges = (inner: KnowledgeStore) => {
  const entered = deferred()
  const release = deferred()
  const changes = inner.changes.bind(inner)
  const order: string[] = []
  let armed = true

  inner.changes = async (cursor) => {
    if (armed) {
      armed = false
      order.push('inventory:start')
      entered.resolve()
      await release.promise
      order.push('inventory:end')
    }

    return changes(cursor)
  }

  return { entered: entered.promise, release: release.resolve, order }
}

const gatePurge = (revisions: InMemoryRevisionPersistence) => {
  const entered = deferred()
  const release = deferred()
  const purge = revisions.purgeNotes.bind(revisions)
  let armed = true

  revisions.purgeNotes = async (space, ids, expectedLatest) => {
    if (armed) {
      armed = false
      entered.resolve()
      await release.promise
    }

    return purge(space, ids, expectedLatest)
  }

  return { entered: entered.promise, release: release.resolve }
}

const gateTrashPage = (revisions: InMemoryRevisionPersistence) => {
  const entered = deferred()
  const release = deferred()
  const listTrashed = revisions.listTrashed.bind(revisions)
  let armed = true

  revisions.listTrashed = async (space, opts, excludeClasses) => {
    if (armed) {
      armed = false
      entered.resolve()
      await release.promise
    }

    return listTrashed(space, opts, excludeClasses)
  }

  return { entered: entered.promise, release: release.resolve }
}

const gateDeleteRevision = (revisions: InMemoryRevisionPersistence) => {
  const entered = deferred()
  const release = deferred()
  const append = revisions.append.bind(revisions)
  let armed = true

  revisions.append = async (input, content) => {
    if (armed && input.kind === 'delete') {
      armed = false
      entered.resolve()
      await release.promise
    }

    return append(input, content)
  }

  return { entered: entered.promise, release: release.resolve }
}

const gateWriteRevision = (revisions: InMemoryRevisionPersistence) => {
  const entered = deferred()
  const release = deferred()
  const append = revisions.append.bind(revisions)
  let armed = true

  revisions.append = async (input, content) => {
    if (armed && input.kind === 'write') {
      armed = false
      entered.resolve()
      await release.promise
    }

    return append(input, content)
  }

  return { entered: entered.promise, release: release.resolve }
}

const gateExternalRevision = (revisions: InMemoryRevisionPersistence) => {
  const entered = deferred()
  const release = deferred()
  const append = revisions.append.bind(revisions)
  let armed = true

  revisions.append = async (input, content) => {
    if (armed && input.kind === 'external') {
      armed = false
      entered.resolve()
      await release.promise
    }

    return append(input, content)
  }

  return { entered: entered.promise, release: release.resolve }
}

const gateRevisionGet = (revisions: InMemoryRevisionPersistence) => {
  const entered = deferred()
  const release = deferred()
  const get = revisions.get.bind(revisions)
  let armed = true

  revisions.get = async (space, revisionId) => {
    if (armed) {
      armed = false
      entered.resolve()
      await release.promise
    }

    return get(space, revisionId)
  }

  return { entered: entered.promise, release: release.resolve }
}

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const stageExternalUpsert = async (
  inner: KnowledgeStore,
  noteId: string,
  content: string,
): Promise<void> => {
  const changes = inner.changes.bind(inner)
  const inventory = await inner.list()
  const meta = inventory.find((note) => note.id === noteId)

  if (!meta) {
    throw new Error(`missing staged external note ${noteId}`)
  }
  let next: StoreDelta | null = {
    cursor: `external-${noteId}`,
    inventory,
    upserts: [{ meta, content }],
  }

  inner.changes = async (cursor) => {
    if (next) {
      const delta = next

      next = null
      return delta
    }

    return changes(cursor)
  }
}

const createMemoryHarness = async (): Promise<Harness> => {
  const inner = new InMemoryStore({
    space: 'main',
    now: '2026-07-22T12:00:00.000Z',
    notes: [],
  })
  const revisions = new InMemoryRevisionPersistence()
  const store = new CachedStore({ inner, revisionPersistence: revisions, pollIntervalMs: 0 })
  await store.start()

  return {
    inner,
    revisions,
    store,
    close: async () => {
      store.stop()
      await store.settle()
    },
  }
}

const createNotariumHarness = async (): Promise<Harness> => {
  const notesDir = mkdtempSync(join(tmpdir(), 'notarium-mutation-fence-'))
  const inner = createNotariumStore({
    mounts: [{ class: 'user-doc', dir: notesDir, prefix: '' }],
  })
  const revisions = new InMemoryRevisionPersistence()
  const store = new CachedStore({ inner, revisionPersistence: revisions, pollIntervalMs: 0 })
  await store.start()

  return {
    inner,
    revisions,
    store,
    notesDir,
    close: async () => {
      store.stop()
      await store.settle()
      rmSync(notesDir, { recursive: true, force: true })
    },
  }
}

const variants = [
  ['identity-capable fake', createMemoryHarness],
  ['production Notarium engine', createNotariumHarness],
] as const

describe('CachedStore mutation capability honesty', () => {
  it('does not advertise directory mutations absent from the inner engine', () => {
    const inner: KnowledgeStore = new InMemoryStore({ space: 'main', notes: [] })

    inner.makeDir = undefined
    inner.removeDir = undefined
    const store = new CachedStore({ inner, pollIntervalMs: 0 })

    expect(store.makeDir).toBeUndefined()
    expect(store.removeDir).toBeUndefined()
  })
})

describe('CachedStore deferred legacy graph repair', () => {
  const createOutsideGraphDebt = async () => {
    const now = '2026-07-22T12:00:00.000Z'
    const inner = new InMemoryStore({
      space: 'main',
      now,
      notes: [
        {
          id: 'source-note',
          title: 'Source',
          filePath: 'source.md',
          content: '[[aza-stan-zhospary]] [[later-victim]]',
        },
        {
          id: 'later-victim',
          title: 'Later victim',
          filePath: 'later-victim.md',
          content: 'victim body',
        },
        {
          id: 'victim-source',
          title: 'Victim source',
          filePath: 'victim-source.md',
          content: '[[later-victim]]',
        },
      ],
    })
    const store = new CachedStore({
      inner,
      pollIntervalMs: 0,
      now: () => new Date(now),
    })
    const changed: StoreEvent[] = []

    store.subscribe((event) => {
      if (event.type === 'changed') {
        changed.push(event)
      }
    })
    await store.start()
    changed.length = 0
    const read = inner.read.bind(inner)
    const graph = inner.graph.bind(inner)

    inner.read = async (id, opts) => {
      if (id.includes('source-note')) {
        throw new Error('outside source read failed')
      }

      return read(id, opts)
    }
    inner.graph = async () => {
      throw new Error('outside graph failed')
    }
    try {
      await expect(
        store.write({
          title: 'Қазақстан жоспары',
          fileName: 'aza-stan-zhospary',
          content: 'target',
        }),
      ).rejects.toThrow('outside graph failed')
    } finally {
      inner.read = read
      inner.graph = graph
    }
    const target = (await store.list()).find(({ filePath }) =>
      filePath.endsWith('aza-stan-zhospary.md'),
    )

    if (!target?.id) {
      throw new Error('committed target is missing after graph repair failure')
    }

    return { inner, store, changed, targetId: target.id }
  }

  it('keeps a causal identity repair inside pending graph debt', async () => {
    const now = '2026-07-22T12:00:00.000Z'
    const provisionalId = 'causal-provisional'
    const durableId = 'causal-durable'
    const inner = new InMemoryStore({
      space: 'main',
      now,
      notes: [
        {
          id: 'source-note',
          title: 'Source',
          filePath: 'source.md',
          content: '[[aza-stan-zhospary]]',
        },
        {
          id: provisionalId,
          title: 'Restored',
          filePath: 'restored.md',
          content: 'restored body',
        },
      ],
    })
    const identity = new InMemoryIdentity([
      {
        id: provisionalId,
        legacyNameAliases: [],
        addressRevision: 1,
        filePath: 'restored.md',
        space: 'main',
        createdAt: now,
        materialized: true,
        deletedAt: null,
      },
    ])
    const store = new CachedStore({
      inner,
      identityPersistence: identity,
      space: 'main',
      pollIntervalMs: 0,
      now: () => new Date(now),
    })
    const changed: StoreEvent[] = []

    store.subscribe((event) => {
      if (event.type === 'changed') {
        changed.push(event)
      }
    })
    await store.start()
    changed.length = 0
    const read = inner.read.bind(inner)
    const graph = inner.graph.bind(inner)

    inner.read = async (id, opts) => {
      if (id.includes('source-note')) {
        throw new Error('outside source read failed')
      }

      return read(id, opts)
    }
    inner.graph = async () => {
      throw new Error('outside graph failed')
    }
    try {
      await expect(
        store.write({
          title: 'Қазақстан жоспары',
          fileName: 'aza-stan-zhospary',
          content: 'target',
        }),
      ).rejects.toThrow('outside graph failed')
    } finally {
      inner.read = read
      inner.graph = graph
    }
    const targetId = (await store.list()).find(({ filePath }) =>
      filePath.endsWith('aza-stan-zhospary.md'),
    )?.id
    const provisional = identity.rows.get(provisionalId)

    if (!targetId || !provisional) {
      throw new Error('graph-debt or causal identity fixture did not initialize')
    }
    identity.rows.set(provisionalId, {
      ...provisional,
      addressRevision: 2,
      deletedAt: now,
    })
    identity.rows.set(durableId, {
      ...provisional,
      id: durableId,
      addressRevision: 2,
      deletedAt: null,
    })

    try {
      await store.adoptCausalIdentity(durableId)

      expect(await store.list()).toContainEqual(
        expect.objectContaining({ id: durableId, filePath: 'restored.md' }),
      )
      expect(changed).toEqual([])

      await store.graph()
      expect(changed).toEqual([
        expect.objectContaining({
          type: 'changed',
          upserts: expect.arrayContaining([targetId, durableId]),
          removed: expect.arrayContaining([provisionalId]),
        }),
      ])
      await store.graph()
      expect(changed).toHaveLength(1)
    } finally {
      await store.stop()
    }
  })

  it.each([
    ['ordinary', false],
    ['bulk', true],
  ] as const)('repairs an ambiguous legacy ghost after %s claimant deletion', async (_, bulk) => {
    const inner = new InMemoryStore({
      space: 'main',
      notes: [
        {
          id: 'source-note',
          title: 'Source',
          filePath: 'source.md',
          content: '[[historic-name]]',
        },
        {
          id: 'legacy-one',
          title: 'First',
          filePath: 'first.md',
          content: 'first',
          legacyNameAliases: ['historic-name'],
        },
        {
          id: 'legacy-two',
          title: 'Second',
          filePath: 'second.md',
          content: 'second',
          legacyNameAliases: ['historic-name'],
        },
      ],
    })
    const store = new CachedStore({ inner, pollIntervalMs: 0 })

    await store.start()
    try {
      expect((await store.graph()).links).not.toContainEqual(
        expect.objectContaining({ source: 'source-note', target: 'legacy-one' }),
      )
      if (bulk) {
        store.beginBulk()
      }
      await store.remove('legacy-two')
      if (bulk) {
        await store.endBulk()
      }

      await expect(store.resolveWikilink('historic-name')).resolves.toMatchObject({
        id: 'legacy-one',
      })
      expect((await store.graph()).links).toContainEqual(
        expect.objectContaining({ source: 'source-note', target: 'legacy-one' }),
      )
    } finally {
      store.stop()
      await store.settle()
    }
  })

  it('retains ordinary repair debt and blocks graph readers until retry succeeds', async () => {
    const inner = new InMemoryStore({
      space: 'main',
      notes: [
        {
          id: 'source-note',
          title: 'Source',
          filePath: 'source.md',
          content: '[[aza-stan-zhospary]]',
        },
      ],
    })
    const store = new CachedStore({ inner, pollIntervalMs: 0 })
    const changed: StoreEvent[] = []

    store.subscribe((event) => {
      if (event.type === 'changed') {
        changed.push(event)
      }
    })
    await store.start()
    changed.length = 0

    try {
      const read = inner.read.bind(inner)
      const graph = inner.graph.bind(inner)

      inner.read = async (id, opts) => {
        if (id.includes('source-note')) {
          throw new Error('ordinary source read failed')
        }

        return read(id, opts)
      }
      inner.graph = async () => {
        throw new Error('ordinary graph failed')
      }
      await expect(
        store.write({
          title: 'Қазақстан жоспары',
          fileName: 'aza-stan-zhospary',
          content: 'target',
        }),
      ).rejects.toThrow('ordinary graph failed')
      expect(changed).toEqual([])
      expect(
        (store as unknown as { bulkGraphContextSources: Set<string> }).bulkGraphContextSources,
      ).toContain('source-note')

      inner.read = read
      inner.graph = graph
      const repaired = await store.graph()
      const target = (await store.list()).find(({ filePath }) =>
        filePath.endsWith('aza-stan-zhospary.md'),
      )

      expect(target?.id).toBeDefined()
      expect(repaired.links).toContainEqual(
        expect.objectContaining({ source: 'source-note', target: target?.id }),
      )
      expect(changed).toEqual([
        expect.objectContaining({
          type: 'changed',
          upserts: [target?.id],
          removed: [],
        }),
      ])
      await store.graph()
      await nextTurn()
      expect(changed).toHaveLength(1)
      expect(
        (store as unknown as { bulkGraphContextSources: Set<string> }).bulkGraphContextSources.size,
      ).toBe(0)
    } finally {
      store.stop()
      await store.settle()
    }
  })

  it('nets deferred publication into a subsequent ordinary removal', async () => {
    const { store, changed, targetId } = await createOutsideGraphDebt()

    try {
      await store.remove(targetId)

      expect(changed).toEqual([
        expect.objectContaining({ type: 'changed', upserts: [], removed: [targetId] }),
      ])
      await store.graph()
      await nextTurn()
      expect(changed).toHaveLength(1)
    } finally {
      store.stop()
      await store.settle()
    }
  })

  it('nets outside publication debt into one final bulk removal', async () => {
    const { store, changed, targetId } = await createOutsideGraphDebt()

    try {
      store.beginBulk()
      await store.remove(targetId)
      await store.endBulk()

      expect(changed).toEqual([
        expect.objectContaining({ type: 'changed', upserts: [], removed: [targetId] }),
      ])
      await store.graph()
      await nextTurn()
      expect(changed).toHaveLength(1)
    } finally {
      store.stop()
      await store.settle()
    }
  })

  it('publishes an external reconcile together with the graph debt it repairs', async () => {
    const { inner, store, changed, targetId } = await createOutsideGraphDebt()

    try {
      const debt = store as unknown as {
        graphContextChangedPending: boolean
        graphContextChangedUpserts: Set<string>
      }

      expect(changed).toEqual([])
      expect(debt.graphContextChangedPending).toBe(true)
      expect(debt.graphContextChangedUpserts).toContain(targetId)
      const changes = inner.changes.bind(inner)

      await inner.remove('later-victim')
      const inventory = await inner.list()
      let staged = true

      inner.changes = async (cursor) => {
        if (staged) {
          staged = false
          return { cursor: 'external-removal', inventory, upserts: [] }
        }

        return changes(cursor)
      }
      await store.reconcile()

      expect((await store.list()).map(({ id }) => id)).toContain(targetId)
      expect((await store.list()).map(({ id }) => id)).not.toContain('later-victim')
      await nextTurn()

      expect(changed).toEqual([
        expect.objectContaining({
          type: 'changed',
          upserts: expect.arrayContaining([targetId]),
          removed: ['later-victim'],
        }),
      ])
      expect((await store.graph()).links).toContainEqual(
        expect.objectContaining({ source: 'source-note', target: targetId }),
      )
      expect((await store.graph()).links).not.toContainEqual(
        expect.objectContaining({ source: 'source-note', target: 'later-victim' }),
      )
      await nextTurn()
      expect(changed).toHaveLength(1)
    } finally {
      store.stop()
      await store.settle()
    }
  })

  it('keeps post-restore historical alias publication inside pending graph debt', async () => {
    const restoredId = 'restorable-note'
    const revisions = new InMemoryRevisionPersistence()
    const journal = new RevisionJournal({ persistence: revisions, space: 'main' })

    await journal.record({
      noteId: restoredId,
      kind: 'external',
      principal: null,
      content: 'restorable',
      title: 'Former title',
      class: 'user-doc',
      tags: [],
      slug: null,
    })
    const inner = new InMemoryStore({
      space: 'main',
      notes: [
        {
          id: 'source-note',
          title: 'Source',
          filePath: 'source.md',
          content: '[[aza-stan-zhospary]] [[Former title]]',
        },
        {
          id: restoredId,
          title: 'Current title',
          filePath: 'current-title.md',
          content: 'restorable',
        },
      ],
    })
    const store = new CachedStore({
      inner,
      revisionPersistence: revisions,
      pollIntervalMs: 0,
    })
    const changed: StoreEvent[] = []

    store.subscribe((event) => {
      if (event.type === 'changed') {
        changed.push(event)
      }
    })
    await store.start()

    try {
      await store.remove(restoredId)
      changed.length = 0
      const read = inner.read.bind(inner)
      const graph = inner.graph.bind(inner)

      inner.read = async (id, opts) => {
        if (id.includes('source-note')) {
          throw new Error('restore source read failed')
        }

        return read(id, opts)
      }
      inner.graph = async () => {
        throw new Error('restore graph failed')
      }
      try {
        await expect(
          store.write({
            title: 'Қазақстан жоспары',
            fileName: 'aza-stan-zhospary',
            content: 'target',
          }),
        ).rejects.toThrow('restore graph failed')
      } finally {
        inner.read = read
        inner.graph = graph
      }
      const target = (await store.list()).find(({ filePath }) =>
        filePath.endsWith('aza-stan-zhospary.md'),
      )

      await store.restoreFromTrash(restoredId)
      await nextTurn()
      expect(changed).toEqual([])

      expect((await store.graph()).links).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'source-note', target: target?.id }),
          expect.objectContaining({ source: 'source-note', target: restoredId }),
        ]),
      )
      await nextTurn()
      expect(changed).toEqual([
        expect.objectContaining({
          type: 'changed',
          upserts: expect.arrayContaining([target?.id, restoredId]),
          removed: [],
        }),
      ])
    } finally {
      store.stop()
      await store.settle()
    }
  })

  it('repairs claimant deletion through the production fallback graph', async () => {
    const { inner, store, close } = await createNotariumHarness()

    try {
      await store.makeDir?.('one')
      await store.makeDir?.('two')
      const source = await store.write({ title: 'Source', content: '[[aza-stan-zhospary]]' })

      const createClaimant = async (directory: string, title: string) => {
        const created = await store.write({
          title: 'Қазақстан жоспары',
          directory,
          fileName: 'aza-stan-zhospary',
          content: title,
        })
        const live = await store.read(created.id!)

        return store.write({
          originalId: created.id,
          title: `${title} current`,
          directory,
          content: title,
          versionToken: live.versionToken,
        })
      }
      const first = await createClaimant('one', 'First')
      const second = await createClaimant('two', 'Second')

      expect((await store.graph()).links).not.toContainEqual(
        expect.objectContaining({ source: source.id, target: first.id }),
      )
      const read = inner.read.bind(inner)

      inner.read = async (id, opts) => {
        if (id === 'source.md') {
          throw new Error('production source read failed')
        }

        return read(id, opts)
      }
      await store.remove(second.id!)
      inner.read = read

      await expect(store.resolveWikilink('aza-stan-zhospary')).resolves.toMatchObject({
        id: first.id,
      })
      expect((await store.graph()).links).toContainEqual(
        expect.objectContaining({ source: source.id, target: first.id }),
      )
    } finally {
      await close()
    }
  })

  it('keeps the graph barrier and changed batch retryable after final bulk repair fails', async () => {
    const inner = new InMemoryStore({
      space: 'main',
      notes: [
        {
          id: 'source-note',
          title: 'Source',
          filePath: 'source.md',
          content: '[[aza-stan-zhospary]]',
        },
      ],
    })
    const store = new CachedStore({ inner, pollIntervalMs: 0 })
    const changed: StoreEvent[] = []

    store.subscribe((event) => {
      if (event.type === 'changed') {
        changed.push(event)
      }
    })
    await store.start()
    changed.length = 0

    try {
      store.beginBulk()
      const target = await store.write({
        title: 'Қазақстан жоспары',
        fileName: 'aza-stan-zhospary',
        content: 'target',
      })
      const read = inner.read.bind(inner)
      const graph = inner.graph.bind(inner)

      inner.read = async () => {
        throw new Error('deferred source read failed')
      }
      inner.graph = async () => {
        throw new Error('deferred graph failed')
      }
      await expect(store.endBulk()).rejects.toThrow('deferred graph failed')
      expect(changed).toEqual([])
      expect(
        (store as unknown as { bulkGraphContextSources: Set<string> }).bulkGraphContextSources,
      ).toContain('source-note')

      let graphSettled = false
      const waitingGraph = store.graph().then((value) => {
        graphSettled = true
        return value
      })

      await nextTurn()
      expect(graphSettled).toBe(false)

      inner.read = read
      inner.graph = graph
      await store.endBulk()
      expect(
        (store as unknown as { bulkGraphContextSources: Set<string> }).bulkGraphContextSources.size,
      ).toBe(0)
      expect(
        (
          store as unknown as {
            snap: { edgesBySource: Map<string, Array<{ source: string; target: string }>> }
          }
        ).snap.edgesBySource.get('source-note'),
      ).toContainEqual(expect.objectContaining({ target: target.id }))
      const repaired = await waitingGraph

      expect(changed).toHaveLength(1)
      expect((await store.list()).find(({ id }) => id === target.id)?.legacyNameAliases).toEqual([
        'aza-stan-zhospary',
      ])
      expect((await store.read('aza-stan-zhospary')).id).toBe(target.id)
      expect(repaired.links).toContainEqual(
        expect.objectContaining({ source: 'source-note', target: target.id }),
      )
    } finally {
      store.stop()
      await store.settle()
    }
  })
})

describe('CachedStore write ingress', () => {
  it('carries the exact identity-engine incarnation from its pre-write read', async () => {
    const h = await createMemoryHarness()

    try {
      const created = await h.store.write({ title: 'Note', content: 'body' })
      const before = await h.store.read(created.id!)
      const gate = gateWrite(h.inner, (input) => input.originalId != null)
      const writing = h.store.write({
        originalId: created.id,
        title: 'Note',
        content: 'changed',
        versionToken: before.versionToken,
      })

      await gate.entered
      const replacement = await h.inner.write({
        originalId: created.id,
        identityOnly: true,
        title: 'Note',
        content: 'body',
        versionToken: before.versionToken,
      })

      expect(replacement.versionToken).toBe(before.versionToken)
      gate.release()
      await expect(writing).rejects.toThrow('note changed during conditional effect')
      await expect(h.store.read(created.id!)).resolves.toMatchObject({ content: 'body' })
    } finally {
      await h.close()
    }
  })

  it('rejects invalid carried frontmatter before it reaches the inner engine', async () => {
    const h = await createMemoryHarness()

    try {
      const innerWrite = vi.spyOn(h.inner, 'write')

      await expect(
        h.store.write({
          title: 'Poisoned import',
          content: 'body',
          frontmatter: [{ key: 'author', lines: ['author: safe\0poison'] }],
        }),
      ).rejects.toThrow('frontmatter contains invalid raw lines')
      await expect(
        h.store.write({
          title: 'Document marker import',
          content: 'body',
          frontmatter: [{ key: null, lines: ['...'] }],
        }),
      ).rejects.toThrow('frontmatter contains invalid raw lines')
      expect(innerWrite).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })
})

describe.each(variants)('CachedStore atomic tag delta — %s', (_name, createHarness) => {
  it('normalises scalar tags, changes only the exact tag, and skips a no-op write', async () => {
    const h = await createHarness()

    try {
      const created = await h.store.write({
        title: 'Overview',
        content: 'body',
        tags: 'guide, always-load, always-load',
        frontmatter: [{ key: 'plugin', lines: ['plugin: keep-me'] }],
      })
      const noteId = created.id!
      const write = vi.spyOn(h.inner, 'write')

      await expect(h.store.mutateTags({ id: noteId, add: ['always-load'] })).resolves.toEqual({
        changed: true,
        tags: ['guide', 'always-load'],
      })
      expect(write).toHaveBeenCalledTimes(1)
      const after = await h.store.read(noteId)
      expect(after.frontmatter.tags).toEqual(['guide', 'always-load'])
      expect(after.frontmatter.plugin).toBe('keep-me')

      await expect(h.store.mutateTags({ id: noteId, add: ['always-load'] })).resolves.toEqual({
        changed: false,
        tags: ['guide', 'always-load'],
      })
      expect(write).toHaveBeenCalledTimes(1)
    } finally {
      await h.close()
    }
  })

  it('reads live tags after an earlier whole-note write releases the same note fence', async () => {
    const h = await createHarness()

    try {
      const created = await h.store.write({ title: 'Race', content: 'before', tags: ['old'] })
      const noteId = created.id!
      const before = await h.store.read(noteId)
      const gate = gateWrite(
        h.inner,
        (input) => input.originalId != null && input.tags?.includes('new') === true,
      )
      const fullWrite = h.store.write({
        title: 'Race',
        content: 'after',
        originalId: noteId,
        versionToken: before.versionToken,
        tags: ['new'],
      })
      await gate.entered
      const delta = h.store.mutateTags({ id: noteId, add: ['always-load'] })

      gate.release()
      await Promise.all([fullWrite, delta])
      const after = await h.store.read(noteId)
      expect(after.content).toBe('after')
      expect(after.frontmatter.tags).toEqual(['new', 'always-load'])
    } finally {
      await h.close()
    }
  })
})

describe('CachedStore lifecycle quiescence', () => {
  it('checkpoint joins an active poll and drains the external journal tail it creates', async () => {
    const inner = new InMemoryStore({ space: 'main', notes: [] })
    const revisions = new InMemoryRevisionPersistence()
    const store = new CachedStore({ inner, revisionPersistence: revisions, pollIntervalMs: 0 })

    await store.start()
    const activeExternal = await inner.write({
      id: 'external-checkpoint',
      title: 'External checkpoint',
      content: 'body',
    })
    await stageExternalUpsert(inner, activeExternal.id!, 'body')
    const changesGate = gateChanges(inner)
    const revisionGate = gateExternalRevision(revisions)
    const reconcile = store.reconcile()

    await changesGate.entered
    // The active poll has already captured the first staged delta. Queue a
    // second edit through the CURRENT changes method: only checkpoint's own
    // post-join delta cut can observe and journal it.
    const checkpointExternal = await inner.write({
      id: 'checkpoint-own-delta',
      title: 'Checkpoint own delta',
      content: 'after active poll',
    })
    await stageExternalUpsert(inner, checkpointExternal.id!, 'after active poll')
    let checkpointed = false
    const checkpoint = store.checkpoint().then(() => {
      checkpointed = true
    })

    await nextTurn()
    expect(checkpointed).toBe(false)
    changesGate.release()
    await revisionGate.entered
    await nextTurn()
    expect(checkpointed).toBe(false)

    revisionGate.release()
    await Promise.all([reconcile, checkpoint])
    expect(checkpointed).toBe(true)
    expect(
      (await store.revisions(checkpointExternal.id!, { offset: 0, limit: 10 })).items.map(
        (revision) => revision.kind,
      ),
    ).toContain('external')
    store.stop()
    await store.settle()
  })

  it('checkpoint rejects when its required delta reconciliation fails', async () => {
    const inner = new InMemoryStore({ space: 'main', notes: [] })
    const store = new CachedStore({ inner, pollIntervalMs: 0 })

    await store.start()
    vi.spyOn(inner, 'changes').mockRejectedValueOnce(new Error('delta unavailable'))

    await expect(store.checkpoint()).rejects.toThrow('delta unavailable')
    store.stop()
    await store.settle()
  })

  it('checkpoint rejects when the store stops during its required delta cut', async () => {
    const inner = new InMemoryStore({ space: 'main', notes: [] })
    const store = new CachedStore({ inner, pollIntervalMs: 0 })

    await store.start()
    const changesGate = gateChanges(inner)
    const checkpoint = store.checkpoint()

    await changesGate.entered
    store.stop()
    changesGate.release()
    await expect(checkpoint).rejects.toThrow('cannot checkpoint a stopped store')
    await store.settle()
  })

  it('checkpoint reconciles external edits despite a persistent derived-graph failure', async () => {
    const inner = new InMemoryStore({ space: 'main', notes: [] })
    const revisions = new InMemoryRevisionPersistence()

    vi.spyOn(inner, 'graph').mockRejectedValue(new Error('persistent graph failure'))
    const store = new CachedStore({ inner, revisionPersistence: revisions, pollIntervalMs: 0 })

    await store.start()
    expect((await store.syncStatus()).scan.phase).toBe('error')
    const external = await inner.write({
      id: 'external-under-graph-failure',
      title: 'External under graph failure',
      content: 'body',
    })
    await stageExternalUpsert(inner, external.id!, 'body')

    await expect(store.checkpoint()).resolves.toBeUndefined()
    expect(
      (await store.revisions(external.id!, { offset: 0, limit: 10 })).items.map(
        (revision) => revision.kind,
      ),
    ).toContain('external')
    store.stop()
    await store.settle()
  })

  it('fails a mutation waiting on poll admission before stopping the inner engine', async () => {
    const inner = new InMemoryStore({ space: 'main', notes: [] })
    const store = new CachedStore({ inner, pollIntervalMs: 0 })

    await store.start()
    const entered = deferred()
    const release = deferred()
    const changes = inner.changes.bind(inner)
    let gated = true

    inner.changes = async (cursor) => {
      if (gated && cursor !== null) {
        gated = false
        entered.resolve()
        await release.promise
      }

      return changes(cursor)
    }
    let innerStopped = false
    const stoppable = inner as InMemoryStore & { stop: () => void }

    stoppable.stop = () => {
      innerStopped = true
    }
    const write = vi.spyOn(inner, 'write')
    const reconcile = store.reconcile()

    await entered.promise
    const pendingWrite = store.write({ title: 'Too late', content: 'body' })

    store.stop()
    release.resolve()
    await reconcile
    await expect(pendingWrite).rejects.toMatchObject({ reason: 'engine_unavailable' })
    await store.settle()
    expect(write).not.toHaveBeenCalled()
    expect(innerStopped).toBe(true)
  })

  it('wakes cold read and mutation waiters and skips the graph before stopping', async () => {
    const inner = new InMemoryStore({ space: 'main', notes: [] })
    const entered = deferred()
    const release = deferred()
    const changes = inner.changes.bind(inner)

    inner.changes = async (cursor) => {
      entered.resolve()
      await release.promise
      return changes(cursor)
    }
    const graph = vi.spyOn(inner, 'graph')
    const write = vi.spyOn(inner, 'write')
    let innerStopped = false
    const stoppable = inner as InMemoryStore & { stop: () => void }

    stoppable.stop = () => {
      innerStopped = true
    }
    const store = new CachedStore({ inner, pollIntervalMs: 0 })
    const boot = store.start()

    await entered.promise
    const listing = store.list()
    const pendingWrite = store.write({ title: 'Too late', content: 'body' })

    store.stop()
    await expect(listing).resolves.toEqual([])
    release.resolve()
    await boot
    await expect(pendingWrite).rejects.toMatchObject({ reason: 'engine_unavailable' })
    await store.settle()
    expect(write).not.toHaveBeenCalled()
    expect(graph).not.toHaveBeenCalled()
    expect(innerStopped).toBe(true)
  })

  it('settle waits for a reconcile already blocked in the engine', async () => {
    const inner = new InMemoryStore({ space: 'main', notes: [] })
    const store = new CachedStore({ inner, pollIntervalMs: 0 })

    await store.start()
    const entered = deferred()
    const release = deferred()
    const changes = inner.changes.bind(inner)

    inner.changes = async (cursor) => {
      if (cursor !== null) {
        entered.resolve()
        await release.promise
      }

      return changes(cursor)
    }
    const reconcile = store.reconcile()

    await entered.promise
    let settled = false
    const settling = store.settle().then(() => {
      settled = true
    })

    await nextTurn()
    expect(settled).toBe(false)
    release.resolve()
    await reconcile
    await settling
  })

  it('stop waits for an already-running graph stage before closing the inner engine', async () => {
    const inner = new InMemoryStore({ space: 'main', notes: [] })
    const entered = deferred()
    const release = deferred()
    const graph = inner.graph.bind(inner)

    inner.graph = async () => {
      entered.resolve()
      await release.promise
      return graph()
    }
    let innerStopped = false
    const stoppable = inner as InMemoryStore & { stop: () => void }

    stoppable.stop = () => {
      innerStopped = true
    }
    const store = new CachedStore({ inner, pollIntervalMs: 0 })
    const boot = store.start()

    await entered.promise
    store.stop()
    await nextTurn()
    expect(innerStopped).toBe(false)

    release.resolve()
    await boot
    await store.settle()
    expect(innerStopped).toBe(true)
  })

  it('drains journal work enqueued by an admitted write before shutdown completes', async () => {
    const inner = new InMemoryStore({ space: 'main', notes: [] })
    const revisions = new InMemoryRevisionPersistence()
    const store = new CachedStore({ inner, revisionPersistence: revisions, pollIntervalMs: 0 })

    await store.start()
    const writeGate = gateWrite(inner, (input) => input.title === 'Late journal')
    const revisionGate = gateWriteRevision(revisions)
    const writing = store.write({ title: 'Late journal', content: 'body' })

    await writeGate.entered
    store.stop()
    let settled = false
    const settling = store.settle().then(() => {
      settled = true
    })

    writeGate.release()
    await writing
    await revisionGate.entered
    await nextTurn()
    expect(settled).toBe(false)

    revisionGate.release()
    await settling
    expect(settled).toBe(true)
  })
})

describe('CachedStore mutation boot checkpoint', () => {
  it('does not let an older boot publish readiness through a failing rescan', async () => {
    const inner = new InMemoryStore({ space: 'main', notes: [] })
    const changes = inner.changes.bind(inner)
    const firstEntered = deferred()
    const releaseFirst = deferred()
    let calls = 0

    inner.changes = async (cursor) => {
      calls += 1
      if (calls === 1) {
        const delta = await changes(cursor)

        firstEntered.resolve()
        await releaseFirst.promise
        return delta
      }
      if (calls === 2) {
        throw new Error('authoritative rescan unavailable')
      }

      return changes(cursor)
    }
    const store = new CachedStore({ inner, pollIntervalMs: 0 })
    const boot = store.start()

    await firstEntered.promise
    const rescan = store.rescan()
    const write = vi.spyOn(inner, 'write')
    const pendingWrite = store.write({ title: 'Must not land', content: 'no inventory' })

    await nextTurn()
    releaseFirst.resolve()
    await boot
    await rescan
    await expect(pendingWrite).rejects.toMatchObject({
      reason: 'engine_unavailable',
      isUnavailable: true,
    })
    expect(write).not.toHaveBeenCalled()
    expect((await store.syncStatus()).scan.phase).toBe('error')
    store.stop()
    await store.settle()
  })

  it('waits for the full-list merge and durable frontmatter id sweep before deleting', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-mutation-boot-'))
    const inner = createNotariumStore({
      mounts: [{ class: 'user-doc', dir: notesDir, prefix: '' }],
    })
    const durableId = 'durable-legacy-id'
    const revisions = new InMemoryRevisionPersistence()
    let store: CachedStore | undefined

    try {
      await inner.write({
        id: durableId,
        title: 'Legacy',
        content: 'legacy body',
      })
      const listEntered = deferred()
      const releaseList = deferred()
      const list = inner.list.bind(inner)
      let gated = true

      inner.list = async () => {
        const result = await list()

        if (gated) {
          gated = false
          listEntered.resolve()
          await releaseList.promise
        }

        return result
      }
      store = new CachedStore({
        inner,
        revisionPersistence: revisions,
        pollIntervalMs: 0,
        readBody: (filePath) => readFile(join(notesDir, filePath), 'utf8'),
      })
      const boot = store.start()
      await listEntered.promise
      const phaseOneId = (await store.list()).find((note) => note.filePath === 'legacy.md')?.id
      const remove = vi.spyOn(inner, 'remove')

      if (!phaseOneId) {
        throw new Error('phase-1 note must be visible')
      }
      // This is the id an actual phase-1 client knows. Admission waits for the
      // sweep, then resolves its superseded-id alias to the durable claim.
      const deletion = store.remove(phaseOneId, { principal: 'test' })

      await nextTurn()
      expect(remove).not.toHaveBeenCalled()
      releaseList.resolve()
      await boot
      await deletion

      expect(phaseOneId).not.toBe(durableId)
      expect(await store.list()).toEqual([])
      const trashed = await store.listTrashed({ offset: 0, limit: 10 })
      expect(trashed.items.map((item) => item.noteId)).toEqual([durableId])
      expect(trashed.items.some((item) => item.noteId === phaseOneId)).toBe(false)
    } finally {
      store?.stop()
      await store?.settle()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })

  it('publishes idless link identities before releasing a queued phase-1 read', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-phase-read-'))
    writeFileSync(join(notesDir, 'external.md'), '---\ntitle: External\n---\n\nidless body')
    const inner = createNotariumStore({
      mounts: [{ class: 'user-doc', dir: notesDir, prefix: '' }],
    })
    let store: CachedStore | undefined

    try {
      const listEntered = deferred()
      const releaseList = deferred()
      const list = inner.list.bind(inner)
      let gated = true

      inner.list = async () => {
        const result = await list()

        if (gated) {
          gated = false
          listEntered.resolve()
          await releaseList.promise
        }

        return result
      }
      store = new CachedStore({
        inner,
        pollIntervalMs: 0,
        readBody: (filePath) => readFile(join(notesDir, filePath), 'utf8'),
      })
      const boot = store.start()

      await listEntered.promise
      const phaseOneId = (await store.list()).find((note) => note.filePath === 'external.md')?.id

      if (!phaseOneId) {
        throw new Error('phase-1 note must be visible')
      }
      const reading = store.read(phaseOneId)

      await nextTurn()
      releaseList.resolve()
      await boot
      await expect(reading).resolves.toMatchObject({
        id: phaseOneId,
        filePath: 'external.md',
        content: 'idless body',
      })
    } finally {
      store?.stop()
      await store?.settle()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })

  it('reads empty-folder truth from the engine until the directory cache is seeded', async () => {
    const inner = new InMemoryStore({ space: 'main', notes: [] })
    const revisions = new InMemoryRevisionPersistence()
    const entered = deferred()
    const release = deferred()
    const latestTimestamps = revisions.latestTimestamps.bind(revisions)

    await inner.makeDir!('empty-project')
    revisions.latestTimestamps = async (space) => {
      entered.resolve()
      await release.promise
      return latestTimestamps(space)
    }
    const store = new CachedStore({ inner, revisionPersistence: revisions, pollIntervalMs: 0 })
    const boot = store.start()

    await entered.promise
    expect(await store.listDirs()).toContain('empty-project')
    release.resolve()
    await boot
    expect(await store.listDirs()).toContain('empty-project')
    store.stop()
    await store.settle()
  })

  it('reconciles external creation and deletion of an empty folder', async () => {
    const inner = new InMemoryStore({ space: 'main', notes: [] })
    const store = new CachedStore({ inner, pollIntervalMs: 0 })

    await store.start()
    expect(await store.listDirs()).toEqual([])

    await inner.makeDir!('external-empty')
    await store.reconcile()
    expect(await store.listDirs()).toContain('external-empty')

    await inner.removeDir!('external-empty')
    await store.reconcile()
    expect(await store.listDirs()).not.toContain('external-empty')

    store.stop()
    await store.settle()
  })

  it('drops a production path binding deleted between an early boot failure and retry', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-mutation-retry-'))
    const inner = createNotariumStore({
      mounts: [{ class: 'user-doc', dir: notesDir, prefix: '' }],
    })
    const revisions = new InMemoryRevisionPersistence()
    const listEntered = deferred()
    const releaseList = deferred()
    const list = inner.list.bind(inner)
    let failFirstList = true

    inner.list = async () => {
      if (failFirstList) {
        failFirstList = false
        listEntered.resolve()
        await releaseList.promise
        throw new Error('full list unavailable')
      }

      return list()
    }
    await inner.write({ id: 'durable-retry-id', title: 'Transient', content: 'body' })
    const store = new CachedStore({
      inner,
      revisionPersistence: revisions,
      pollIntervalMs: 0,
      readBody: (filePath) => readFile(join(notesDir, filePath), 'utf8'),
    })

    try {
      const boot = store.start()

      await listEntered.promise
      const phaseOneId = (await store.list()).find((note) => note.filePath === 'transient.md')?.id

      if (!phaseOneId) {
        throw new Error('phase-1 note must be visible')
      }
      await inner.remove('transient.md')
      releaseList.resolve()
      await boot
      await store.reconcile()

      expect(await store.list()).toEqual([])
      await expect(store.remove(phaseOneId, { principal: 'test' })).rejects.toMatchObject({
        reason: 'note_not_found',
      })
      expect((await store.listTrashed({ offset: 0, limit: 10 })).total).toBe(0)
    } finally {
      releaseList.resolve()
      store.stop()
      await store.settle()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })

  it('does not merge a stale directory seed over a queued folder deletion', async () => {
    const inner = new InMemoryStore({ space: 'main', notes: [] })

    await inner.makeDir!('docs')
    const entered = deferred()
    const release = deferred()
    const listDirs = inner.listDirs!.bind(inner)
    let gated = true

    inner.listDirs = async () => {
      const captured = await listDirs()

      if (gated) {
        gated = false
        entered.resolve()
        await release.promise
      }

      return captured
    }
    const store = new CachedStore({ inner, pollIntervalMs: 0 })
    const boot = store.start()
    await entered.promise
    const removeDir = vi.spyOn(inner, 'removeDir')
    const deletion = store.removeDir!('docs')

    await nextTurn()
    expect(removeDir).not.toHaveBeenCalled()
    release.resolve()
    await boot
    await deletion
    expect(await store.listDirs()).not.toContain('docs')
    store.stop()
    await store.settle()
  })
})

describe('CachedStore external identity checkpoint', () => {
  it('adopts the id returned by a production bare-engine read into the registry', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-read-id-adoption-'))
    const inner = createNotariumStore({
      mounts: [{ class: 'user-doc', dir: notesDir, prefix: '' }],
    })
    const durableId = 'durable-read-id'
    const store = new CachedStore({ inner, pollIntervalMs: 0 })

    try {
      await inner.write({ id: durableId, title: 'Claimed', content: 'body' })
      await store.start()
      const temporaryId = (await store.list())[0].id!

      expect(temporaryId).not.toBe(durableId)
      await expect(store.read(temporaryId)).resolves.toMatchObject({
        id: durableId,
        content: 'body',
      })
      expect(await store.list()).toMatchObject([{ id: durableId, filePath: 'claimed.md' }])
      await store.remove(durableId, { principal: 'test' })
      expect(await store.list()).toEqual([])
    } finally {
      store.stop()
      await store.settle()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })

  it('journals a production-engine external move only after rekeying to its durable id', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-external-id-'))
    const inner = createNotariumStore({
      mounts: [{ class: 'user-doc', dir: notesDir, prefix: '' }],
    })
    const durableId = 'durable-moved-id'
    const revisions = new InMemoryRevisionPersistence()
    const sweepEntered = deferred()
    const releaseSweep = deferred()
    let gateMovedSweep = false
    const store = new CachedStore({
      inner,
      revisionPersistence: revisions,
      pollIntervalMs: 0,
      readBody: async (filePath) => {
        if (gateMovedSweep && filePath === 'moved/note.md') {
          gateMovedSweep = false
          sweepEntered.resolve()
          await releaseSweep.promise
        }

        return readFile(join(notesDir, filePath), 'utf8')
      },
    })

    try {
      await inner.write({
        id: durableId,
        title: 'Moved note',
        directory: 'old',
        fileName: 'note',
        content: 'external body',
      })
      await store.start()
      gateMovedSweep = true
      await inner.move({ id: 'old/note.md', destinationPath: 'moved/note.md' })
      const reconcile = store.reconcile()

      await sweepEntered.promise
      const provisionalId = (await store.list()).find(
        (note) => note.filePath === 'moved/note.md',
      )?.id
      expect(provisionalId).toBeTruthy()
      expect(provisionalId).not.toBe(durableId)
      releaseSweep.resolve()
      await reconcile
      await store.settle()

      expect((await store.list()).find((note) => note.filePath === 'moved/note.md')?.id).toBe(
        durableId,
      )
      expect(
        (await store.revisions(durableId, { offset: 0, limit: 10 })).items.map(
          (revision) => revision.kind,
        ),
      ).toEqual(['external'])
      expect((await store.revisions(provisionalId!, { offset: 0, limit: 10 })).items).toEqual([])
    } finally {
      releaseSweep.resolve()
      store.stop()
      await store.settle()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })

  it('canonicalizes a mutation admitted during an external-id sweep only after the sweep', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-external-mutation-id-'))
    const inner = createNotariumStore({
      mounts: [{ class: 'user-doc', dir: notesDir, prefix: '' }],
    })
    const durableId = 'durable-mutation-id'
    const revisions = new InMemoryRevisionPersistence()
    const sweepEntered = deferred()
    const releaseSweep = deferred()
    let gateMovedSweep = false
    const store = new CachedStore({
      inner,
      revisionPersistence: revisions,
      pollIntervalMs: 0,
      readBody: async (filePath) => {
        if (gateMovedSweep && filePath === 'moved/note.md') {
          gateMovedSweep = false
          sweepEntered.resolve()
          await releaseSweep.promise
        }

        return readFile(join(notesDir, filePath), 'utf8')
      },
    })

    try {
      await inner.write({
        id: durableId,
        title: 'Moved note',
        directory: 'old',
        fileName: 'note',
        content: 'external body',
      })
      await store.start()
      gateMovedSweep = true
      await inner.move({ id: 'old/note.md', destinationPath: 'moved/note.md' })
      const reconcile = store.reconcile()

      await sweepEntered.promise
      const provisionalId = (await store.list()).find(
        (note) => note.filePath === 'moved/note.md',
      )?.id

      if (!provisionalId) {
        throw new Error('provisional note must be visible during the sweep')
      }
      const remove = vi.spyOn(inner, 'remove')
      const deletion = store.remove(provisionalId, { principal: 'test' })

      await nextTurn()
      expect(remove).not.toHaveBeenCalled()
      releaseSweep.resolve()
      await reconcile
      await deletion

      expect(await store.list()).toEqual([])
      expect((await store.listTrashed({ offset: 0, limit: 10 })).items[0]?.noteId).toBe(durableId)
    } finally {
      releaseSweep.resolve()
      store.stop()
      await store.settle()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })

  it('revalidates an older external delete after a later id sweep completes', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-external-readd-'))
    const inner = createNotariumStore({
      mounts: [{ class: 'user-doc', dir: notesDir, prefix: '' }],
    })
    const durableId = 'durable-readded-id'
    const revisions = new InMemoryRevisionPersistence()
    const sweepEntered = deferred()
    const releaseSweep = deferred()
    let gateReaddSweep = false
    const store = new CachedStore({
      inner,
      revisionPersistence: revisions,
      pollIntervalMs: 0,
      readBody: async (filePath) => {
        if (gateReaddSweep && filePath === 'moved/note.md') {
          gateReaddSweep = false
          sweepEntered.resolve()
          await releaseSweep.promise
        }

        return readFile(join(notesDir, filePath), 'utf8')
      },
    })

    try {
      await inner.write({
        id: durableId,
        title: 'Readded note',
        directory: 'old',
        fileName: 'note',
        content: 'old body',
      })
      await store.start()
      const trashGate = gateTrashPage(revisions)
      const blocker = store.purgeTrash({ all: true })

      await trashGate.entered
      await inner.remove('old/note.md')
      await store.reconcile()
      await inner.write({
        id: durableId,
        title: 'Readded note',
        directory: 'moved',
        fileName: 'note',
        content: 'new body',
      })
      gateReaddSweep = true
      const reconcile = store.reconcile()

      await sweepEntered.promise
      trashGate.release()
      await blocker
      await nextTurn()
      expect(
        (await store.revisions(durableId, { offset: 0, limit: 10 })).items.some(
          (revision) => revision.kind === 'delete',
        ),
      ).toBe(false)

      releaseSweep.resolve()
      await reconcile
      await store.settle()

      expect((await store.list()).find((note) => note.id === durableId)?.filePath).toBe(
        'moved/note.md',
      )
      expect(
        (await store.revisions(durableId, { offset: 0, limit: 10 })).items.some(
          (revision) => revision.kind === 'delete',
        ),
      ).toBe(false)
      expect((await store.listTrashed({ offset: 0, limit: 10 })).total).toBe(0)
    } finally {
      releaseSweep.resolve()
      store.stop()
      await store.settle()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })
})

describe('CachedStore reconcile ordering', () => {
  it('re-derives folder-history winners on every local directory-context mutation', async () => {
    const inner = new InMemoryStore({ space: 'main', notes: [] })
    const store = new CachedStore({
      inner,
      pollIntervalMs: 0,
      folderAliases: async () => [{ current: 'A', alias: 'Old' }],
    })

    await store.start()

    try {
      const target = await store.write({ title: 'Note', directory: 'A', content: 'target' })
      const decoy = await store.write({ title: 'Note', directory: '0', content: 'decoy' })
      const source = await store.write({ title: 'Source', content: '[[Old/Note]]' })
      const targetOfSource = async () =>
        (await store.graph()).links.find((link) => link.source === source.id)?.target

      expect(await targetOfSource()).toBe(target.id)
      await store.makeDir!('Old')
      expect(await targetOfSource()).toBe(decoy.id)
      await store.removeDir!('Old')
      expect(await targetOfSource()).toBe(target.id)

      await store.write({ title: 'Keep', directory: 'Old', content: 'body' })
      expect(await targetOfSource()).toBe(decoy.id)
    } finally {
      store.stop()
      await store.settle()
    }
  })

  it('refreshes folder history before publishing an empty-folder move ghost', async () => {
    const inner = new InMemoryStore({ space: 'main', notes: [] })
    let aliases: Array<{ current: string; alias: string }> = []
    await inner.makeDir!('old')
    const store = new CachedStore({
      inner,
      pollIntervalMs: 0,
      folderAliases: async () => aliases,
    })

    await store.start()

    try {
      await store.write({ title: 'Source', content: '[[old/Future]]' })
      expect((await store.graph()).nodes).toContainEqual(
        expect.objectContaining({ ghost: true, prefillDirectory: 'old' }),
      )

      await store.move(
        { id: 'old', destinationPath: 'new', isDirectory: true },
        {
          finalize: async () => {
            aliases = [{ current: 'new', alias: 'old' }]
          },
        },
      )
      expect((await store.graph()).nodes).toContainEqual(
        expect.objectContaining({ ghost: true, prefillDirectory: 'new' }),
      )
    } finally {
      store.stop()
      await store.settle()
    }
  })

  it('re-derives folder-history links when an external empty folder appears or vanishes', async () => {
    const inner = new InMemoryStore({ space: 'main', notes: [] })
    const store = new CachedStore({
      inner,
      pollIntervalMs: 0,
      folderAliases: async () => [{ current: 'A', alias: 'Old' }],
    })

    await store.start()

    try {
      const target = await store.write({ title: 'Note', directory: 'A', content: 'target' })
      const decoy = await store.write({ title: 'Note', directory: '0', content: 'decoy' })
      const source = await store.write({ title: 'Source', content: '[[Old/Note]]' })
      expect((await store.graph()).links).toContainEqual(
        expect.objectContaining({ source: source.id, target: target.id }),
      )

      await inner.makeDir!('Old')
      await store.reconcile()
      const shadowed = await store.graph()
      expect(shadowed.links).not.toContainEqual(
        expect.objectContaining({ source: source.id, target: target.id }),
      )
      expect(shadowed.links).toContainEqual(
        expect.objectContaining({ source: source.id, target: decoy.id }),
      )

      await inner.removeDir!('Old')
      await store.reconcile()
      expect((await store.graph()).links).toContainEqual(
        expect.objectContaining({ source: source.id, target: target.id }),
      )
    } finally {
      store.stop()
      await store.settle()
    }
  })

  it('refreshes folder aliases only after an older folder finalizer releases its claim', async () => {
    const inner = new InMemoryStore({ space: 'main', notes: [] })
    let aliases: Array<{ current: string; alias: string }> = []
    let aliasReads = 0
    const store = new CachedStore({
      inner,
      pollIntervalMs: 0,
      folderAliases: async () => {
        aliasReads += 1
        return aliases
      },
    })

    await store.start()
    const finalizeEntered = deferred()
    const releaseFinalize = deferred()
    let moving: Promise<unknown> | undefined
    let reconcile: Promise<void> | undefined

    try {
      await store.write({ title: 'Alpha', directory: 'from', content: 'body' })
      aliasReads = 0
      moving = store.move(
        { id: 'from', destinationPath: 'archive', isDirectory: true },
        {
          finalize: async () => {
            aliases = [{ current: 'archive', alias: 'from' }]
            finalizeEntered.resolve()
            await releaseFinalize.promise
          },
        },
      )

      await finalizeEntered.promise
      reconcile = store.reconcile()

      await nextTurn()
      expect(aliasReads).toBe(0)
      releaseFinalize.resolve()
      await Promise.all([moving, reconcile])
      expect(aliasReads).toBeGreaterThanOrEqual(1)
    } finally {
      releaseFinalize.resolve()
      await Promise.allSettled([moving, reconcile].filter((task) => task !== undefined))
      store.stop()
      await store.settle()
    }
  })
})

describe('CachedStore graph transition publication', () => {
  it('keeps graphHealth behind a production write until its stable source id is published', async () => {
    const harness = await createNotariumHarness()

    try {
      const committed = deferred()
      const release = deferred()
      const write = harness.inner.write.bind(harness.inner)

      harness.inner.write = async (input) => {
        const result = await write(input)

        if (input.id === 'stable-graph-source') {
          committed.resolve()
          await release.promise
        }

        return result
      }
      const writing = harness.store.write({
        id: 'stable-graph-source',
        title: 'Graph Source',
        content: '[[Missing Graph Target]]',
      })

      await committed.promise
      let settled = false
      const health = harness.store.graphHealth().then((result) => {
        settled = true
        return result
      })

      await nextTurn()
      expect(settled).toBe(false)
      release.resolve()
      await writing
      expect((await health).ghosts).toContainEqual(
        expect.objectContaining({
          target: 'missing-graph-target',
          sources: [expect.objectContaining({ id: 'stable-graph-source' })],
        }),
      )
    } finally {
      await harness.close()
    }
  })

  it('keeps graphHealth behind a production delete until its stable tombstone is coherent', async () => {
    const harness = await createNotariumHarness()

    try {
      const target = await harness.store.write({ title: 'Graph Victim', content: 'target' })
      const address = encodeWikilinkIdentity(target.id!)

      await harness.store.write({
        title: 'Graph Source',
        content: `[[${address}|Graph Victim]]`,
      })
      const gate = gateDeleteRevision(harness.revisions)
      const deletion = harness.store.remove(target.id!, { principal: 'test' })

      // inner.remove has completed; the awaited tombstone append is now gated.
      // Neither fresh-graph surface may derive against that physical post-state
      // while the snapshot/identity projection still describes the pre-state.
      await gate.entered
      let settled = false
      const health = harness.store.graphHealth().then((result) => {
        settled = true
        return result
      })

      await nextTurn()
      expect(settled).toBe(false)
      gate.release()
      await deletion
      expect((await health).ghosts).toContainEqual(expect.objectContaining({ target: address }))
    } finally {
      await harness.close()
    }
  })
})

for (const [name, createHarness] of variants) {
  describe(`CachedStore mutation fence — ${name}`, () => {
    let harness: Harness | undefined

    afterEach(async () => {
      await harness?.close()
      harness = undefined
    })

    const setup = async () => {
      harness = await createHarness()
      const alpha = await harness.store.write({
        title: 'Alpha',
        directory: 'from',
        content: 'alpha-v1',
      })
      const beta = await harness.store.write({
        title: 'Beta',
        directory: 'other',
        content: 'beta-v1',
      })

      return { ...harness, alpha: alpha.id!, beta: beta.id! }
    }

    it('holds one exact note scope while unrelated notes stay readable', async () => {
      const { store, alpha, beta } = await setup()
      const alphaBefore = await store.read(alpha)
      const entered = deferred()
      const release = deferred()
      let sameReadSettled = false
      let sameWriteSettled = false
      const scope = store.withExactNoteClaim(alpha, async (current) => {
        expect(current).toMatchObject({ id: alpha, filePath: 'from/alpha.md' })
        entered.resolve()
        await release.promise
        return current.versionToken
      })

      let sameRead: Promise<unknown> | undefined
      let sameWrite: Promise<unknown> | undefined

      try {
        await entered.promise
        sameRead = store.read(alpha).then((value) => {
          sameReadSettled = true
          return value
        })
        const before = await store.read(beta)
        sameWrite = store
          .write({
            originalId: alpha,
            title: 'Alpha',
            content: 'alpha-v2',
            versionToken: alphaBefore.versionToken,
          })
          .then((value) => {
            sameWriteSettled = true
            return value
          })

        await nextTurn()
        expect(before.id).toBe(beta)
        expect(sameReadSettled).toBe(false)
        expect(sameWriteSettled).toBe(false)

        release.resolve()
        const token = await scope
        await Promise.all([sameRead, sameWrite])
        expect(token).toBeTruthy()
        expect(sameWriteSettled).toBe(true)
        await expect(store.read(alpha)).resolves.toMatchObject({ content: 'alpha-v2' })
      } finally {
        release.resolve()
        await Promise.allSettled([scope, sameRead, sameWrite].filter((task) => task !== undefined))
      }
    })

    it('reuses a covered nested exact scope and rejects expansion before enqueue', async () => {
      const { store, alpha, beta } = await setup()

      await expect(
        store.withExactNoteClaim(alpha, async (outer) => {
          await expect(
            store.withExactNoteClaim(alpha, async (inner) => inner.filePath),
          ).resolves.toBe(outer.filePath)
          await expect(store.withExactNoteClaim(beta, async () => undefined)).rejects.toThrow(
            /not covered/i,
          )
          // An UNKNOWN nested target has no current path to compare against a
          // held claim at all: it must be refused as missing, never widened into
          // a coarser claim that the held one happens to cover.
          await expect(
            store.withExactNoteClaim('missing-note', async () => undefined),
          ).rejects.toThrow(/note not found: missing-note/i)
          await expect(store.read(beta)).resolves.toMatchObject({ id: beta })
          return outer.id
        }),
      ).resolves.toBe(alpha)
    })

    it('retains the exact lease until a detached covered child finishes', async () => {
      const { store, alpha, beta } = await setup()
      const childEntered = deferred()
      const releaseChild = deferred()
      const order: string[] = []
      let child!: Promise<string>
      let contenderEntered = false

      const outer = store.withExactNoteClaim(alpha, async () => {
        child = store.withExactNoteClaim(alpha, async () => {
          order.push('child:start')
          childEntered.resolve()
          await releaseChild.promise
          order.push('child:end')
          return 'child-finished'
        })
        await childEntered.promise
        order.push('outer:return')
      })

      await childEntered.promise
      const contender = store.withExactNoteClaim(alpha, async () => {
        contenderEntered = true
        order.push('contender')
      })

      try {
        await nextTurn()
        expect(contenderEntered).toBe(false)
        await expect(store.read(beta)).resolves.toMatchObject({ id: beta })

        releaseChild.resolve()
        await expect(child).resolves.toBe('child-finished')
        await Promise.all([outer, contender])
        expect(order).toEqual(['child:start', 'outer:return', 'child:end', 'contender'])
      } finally {
        releaseChild.resolve()
        await Promise.allSettled([outer, child, contender])
      }
    })

    it('releases a retained exact lease after a detached child rejects', async () => {
      const { store, alpha, beta } = await setup()
      const childEntered = deferred()
      const rejectChild = deferred()
      let child!: Promise<void>
      let contenderEntered = false

      const outer = store.withExactNoteClaim(alpha, async () => {
        child = store.withExactNoteClaim(alpha, async () => {
          childEntered.resolve()
          await rejectChild.promise
          throw new Error('detached child failure')
        })
        void child.catch(() => undefined)
        await childEntered.promise
      })

      await childEntered.promise
      const contender = store.withExactNoteClaim(alpha, async () => {
        contenderEntered = true
      })

      try {
        await nextTurn()
        expect(contenderEntered).toBe(false)

        rejectChild.resolve()
        await expect(child).rejects.toThrow('detached child failure')
        await expect(outer).resolves.toBeUndefined()
        await expect(contender).resolves.toBeUndefined()
        await expect(store.read(alpha)).resolves.toMatchObject({ id: alpha })
        await expect(store.read(beta)).resolves.toMatchObject({ id: beta })
      } finally {
        rejectChild.resolve()
        await Promise.allSettled([outer, child, contender])
      }
    })

    it('rejects an expired inherited exact scope instead of reacquiring after a move', async () => {
      const { store, alpha, beta } = await setup()
      const continueDetached = deferred()

      const detach = (id: string) => async () => {
        await continueDetached.promise
        return store.withExactNoteClaim(id, async (current) => current.filePath)
      }
      let movedTarget!: Promise<string | undefined>
      let goneTarget!: Promise<string | undefined>

      await store.withExactNoteClaim(alpha, async () => {
        movedTarget = detach(alpha)()
        goneTarget = detach(beta)()
      })
      void movedTarget.catch(() => undefined)
      void goneTarget.catch(() => undefined)

      await store.move({ id: alpha, destinationPath: 'moved/alpha.md' })
      await store.remove(beta)
      continueDetached.resolve()

      // The dead context is refused BEFORE the target is derived from the
      // read-model. A descendant of a finished lease is a caller error whatever
      // became of its note meanwhile — never a "note not found" the host would
      // read as "somebody deleted it".
      await expect(goneTarget).rejects.toThrow(/claim context has expired/i)
      await expect(movedTarget).rejects.toThrow(/claim context has expired/i)
      await expect(
        store.withExactNoteClaim(alpha, async (current) => current.filePath),
      ).resolves.toBe('moved/alpha.md')
    })

    it('re-derives the exact path after waiting behind a move', async () => {
      const { inner, store, alpha } = await setup()
      const gate = gateMove(inner, (input) => input.destinationPath === 'moved/alpha.md')
      const moving = store.move({ id: alpha, destinationPath: 'moved/alpha.md' })

      await gate.entered
      let entered = false
      const scope = store.withExactNoteClaim(alpha, async (current) => {
        entered = true
        // Re-deriving the target is not the claim. The lease was queued on
        // 'from/alpha.md' and must now HOLD the path the move produced: a nested
        // scope is admitted by COVERAGE alone, so it is refused whenever the
        // retained claim is still the stale one this waiter arrived with.
        await expect(
          store.withExactNoteClaim(alpha, async (nested) => nested.filePath),
        ).resolves.toBe(current.filePath)
        return current.filePath
      })

      try {
        await nextTurn()
        expect(entered).toBe(false)
        gate.release()
        await moving
        await expect(scope).resolves.toBe('moved/alpha.md')
      } finally {
        gate.release()
        await Promise.allSettled([moving, scope])
      }
    })

    // The PATH axis of the compound observation. `runExactNoteTask` deliberately
    // re-checks only the id and names this refusal as the reason it needs no
    // second path test of its own — so the refusal itself has to be held down.
    it('refuses a compound observation answered off the claimed path', async () => {
      const { inner, store, alpha, beta } = await setup()
      const alphaPath = (await store.read(alpha)).filePath
      const betaPath = (await store.read(beta)).filePath
      const read = inner.read.bind(inner)
      let reached = false

      inner.read = async (id, opts) => {
        const detail = await read(id, opts)

        // A degraded resolver that answers the claimed address with the NEIGHBOUR's
        // file. Its id channel still says alpha, so only the path comparison can
        // keep beta's body from being handed to the task under alpha's claim.
        return detail.filePath === alphaPath ? { ...detail, filePath: betaPath } : detail
      }

      await expect(
        store.withExactNoteClaim(alpha, async () => {
          reached = true
        }),
      ).rejects.toThrow(/note not found/i)
      expect(reached).toBe(false)
    })

    // The compound's own observation is read INSIDE its claim, so it must not go
    // back for identity admission. A restore keeps that admission for its whole
    // lease, and a claimed read queued behind it would be waiting on a mutation
    // that is free to be waiting on this very claim.
    it('reads its exact observation without re-entering identity admission', async () => {
      const { revisions, store, alpha, beta } = await setup()
      await store.remove(beta, { principal: 'test' })
      const gate = gateRevisionGet(revisions)
      const restore = store.restoreFromTrash(beta, { principal: 'test' })

      await gate.entered
      let entered = false
      const scope = store.withExactNoteClaim(alpha, async (current) => {
        entered = true
        return current.filePath
      })

      try {
        for (let turn = 0; turn < 5; turn += 1) {
          await nextTurn()
        }
        expect(entered).toBe(true)
        await expect(scope).resolves.toBe('from/alpha.md')
      } finally {
        gate.release()
        await Promise.allSettled([restore, scope])
      }
    })

    it('releases the exact scope after callback failure', async () => {
      const { store, alpha, beta } = await setup()

      await expect(
        store.withExactNoteClaim(alpha, async () => {
          throw new Error('compound failure')
        }),
      ).rejects.toThrow('compound failure')
      await expect(store.read(alpha)).resolves.toMatchObject({ id: alpha })
      await expect(store.read(beta)).resolves.toMatchObject({ id: beta })
    })

    it('fails closed on an exact target with no current path, before it claims', async () => {
      const { inner, store, alpha, beta } = await setup()
      const alphaToken = (await store.read(alpha)).versionToken
      const read = inner.read.bind(inner)
      let innerReadReached = false

      inner.read = async (id, opts) => {
        if (id.includes('missing-note')) {
          innerReadReached = true
        }

        return read(id, opts)
      }
      // Park an unrelated mutation inside the engine: it holds its own claim for
      // as long as the gate is shut. A refusal that first took a claim — the
      // Space-wide one an empty target degrades into, or any other — would queue
      // behind this and could not answer while it is parked.
      const gate = gateWrite(
        inner,
        (input) =>
          input.originalId === alpha ||
          input.originalId === encodeWikilinkIdentity(alpha) ||
          input.id === alpha,
      )
      const parked = store.write({
        title: 'Alpha',
        content: 'alpha-v2',
        originalId: alpha,
        versionToken: alphaToken,
      })
      let parkedSettled = false

      void parked.then(
        () => {
          parkedSettled = true
        },
        () => {
          parkedSettled = true
        },
      )

      try {
        await gate.entered

        let refusalSettled = false
        const refusal = store.withExactNoteClaim('missing-note', async () => undefined)

        void refusal.then(
          () => {
            refusalSettled = true
          },
          () => {
            refusalSettled = true
          },
        )
        for (let turn = 0; turn < 10; turn += 1) {
          await nextTurn()
        }

        expect(refusalSettled).toBe(true)
        expect(parkedSettled).toBe(false)
        expect(innerReadReached).toBe(false)
        await expect(refusal).rejects.toThrow(/note not found: missing-note/i)
      } finally {
        gate.release()
        await Promise.allSettled([parked])
      }
      await expect(store.read(beta)).resolves.toMatchObject({ id: beta })
    })

    it('does not dispatch an alternate-spelling folder source to the engine', async () => {
      const { inner, store } = await setup()
      const move = vi.spyOn(inner, 'move')
      const removeDir = vi.spyOn(inner, 'removeDir')

      await expect(
        store.move({ id: 'FROM', destinationPath: 'moved', isDirectory: true }),
      ).rejects.toThrow(/source spelling/i)
      await store.removeDir!('FROM')

      expect(move).not.toHaveBeenCalled()
      expect(removeDir).not.toHaveBeenCalled()
      expect(await store.listDirs!()).toContain('from')
    })

    it('orders a gated save before delete, so two successes cannot resurrect the note', async () => {
      const { inner, store, alpha } = await setup()
      const token = (await store.read(alpha)).versionToken
      const gate = gateWrite(
        inner,
        (input) =>
          input.originalId === alpha ||
          input.originalId === encodeWikilinkIdentity(alpha) ||
          input.id === alpha,
      )
      const save = store.write({
        title: 'Alpha',
        content: 'alpha-v2',
        originalId: alpha,
        versionToken: token,
      })
      await gate.entered
      const deletion = store.remove(alpha, { principal: 'test' })

      gate.release()
      await Promise.all([save, deletion])

      expect((await store.list()).some((note) => note.id === alpha)).toBe(false)
      expect((await store.listTrashed({ offset: 0, limit: 10 })).items[0]?.noteId).toBe(alpha)
      const restored = await store.restoreFromTrash(alpha, { principal: 'test' })
      expect(restored.id).toBe(alpha)
      expect(restored.filePath).toBe('from/alpha.md')
      expect((await store.read(alpha)).content).toBe('alpha-v2')
    })

    it('orders a gated save before a note move and leaves one path with the saved body', async () => {
      const { inner, store, alpha } = await setup()
      const token = (await store.read(alpha)).versionToken
      const gate = gateWrite(
        inner,
        (input) =>
          input.originalId === alpha ||
          input.originalId === encodeWikilinkIdentity(alpha) ||
          input.id === alpha,
      )
      const save = store.write({
        title: 'Alpha',
        content: 'alpha-v2',
        originalId: alpha,
        versionToken: token,
      })
      await gate.entered
      const relocation = store.move({ id: alpha, destinationPath: 'moved/alpha.md' })

      gate.release()
      await Promise.all([save, relocation])

      const listed = (await store.list()).filter((note) => note.id === alpha)
      expect(listed).toHaveLength(1)
      expect(listed[0].filePath).toBe('moved/alpha.md')
      expect((await store.read(alpha)).content).toBe('alpha-v2')
    })

    it('holds a child save behind a folder move source prefix', async () => {
      const { inner, store, alpha } = await setup()
      const token = (await store.read(alpha)).versionToken
      const gate = gateMove(inner, (input) => input.isDirectory === true)
      const folderMove = store.move({
        id: 'from',
        destinationPath: 'moved',
        isDirectory: true,
      })
      await gate.entered
      const save = store.write({
        title: 'Alpha',
        content: 'alpha-after-move',
        originalId: alpha,
        versionToken: token,
      })

      gate.release()
      await Promise.all([folderMove, save])

      expect((await store.list()).find((note) => note.id === alpha)?.filePath).toBe(
        'moved/alpha.md',
      )
      expect((await store.read(alpha)).content).toBe('alpha-after-move')
    })

    it('holds a nested directory create behind a folder prefix mutation', async () => {
      const { inner, store } = await setup()
      const gate = gateMove(inner, (input) => input.isDirectory === true)
      const folderMove = store.move({ id: 'from', destinationPath: 'moved', isDirectory: true })
      await gate.entered
      const createDir = store.makeDir!('from/new-child')

      gate.release()
      await Promise.all([folderMove, createDir])
      expect(await store.listDirs!()).toEqual(expect.arrayContaining(['moved', 'from/new-child']))
    })

    it('revalidates a queued save claim after a folder move before admitting a contender', async () => {
      const { inner, store, alpha } = await setup()
      const token = (await store.read(alpha)).versionToken
      const moveGate = gateMove(inner, (input) => input.isDirectory === true)
      const folderMove = store.move({ id: 'from', destinationPath: 'moved', isDirectory: true })
      await moveGate.entered
      const firstWriteGate = gateWrite(inner, (input) => input.title === 'Alpha')
      const write = vi.spyOn(inner, 'write')
      const save = store.write({
        title: 'Alpha',
        content: 'alpha-after-move',
        originalId: alpha,
        versionToken: token,
      })
      const contender = store.write({
        title: 'Alpha',
        directory: 'moved',
        content: 'contender-after-save',
      })
      // Settled up front, not at the assertion: the contender now REJECTS, and it may
      // do so several awaits before we look — an unhandled-rejection report in between
      // would fail the run for a rejection the test is about to inspect.
      const outcomes = Promise.allSettled([save, contender])

      moveGate.release()
      await folderMove
      await firstWriteGate.entered
      await nextTurn()
      expect(write).toHaveBeenCalledOnce()
      firstWriteGate.release()
      const [saveResult, contenderResult] = await outcomes
      // Revalidation is what makes the contender see the POST-move world: it finds Alpha
      // already at the destination and refuses, instead of being admitted against the
      // stale pre-move claim and inheriting Alpha's file.
      expect(contenderResult.status).toBe('rejected')
      if (contenderResult.status === 'rejected') {
        expect(contenderResult.reason).toMatchObject({ reason: 'note_already_exists' })
      }
      if (saveResult.status === 'rejected') {
        expect(saveResult.reason).toMatchObject({ reason: 'version_conflict' })
      }

      const atDestination = (await store.list()).filter(
        (note) => note.filePath === 'moved/alpha.md',
      )
      expect(atDestination).toHaveLength(1)
      expect((await store.read(atDestination[0].id!)).content).toBe(
        saveResult.status === 'fulfilled' ? 'alpha-after-move' : 'alpha-v1',
      )
    })

    it('claims a folder page edit by its structural index.md destination', async () => {
      const { inner, store } = await setup()
      const page = await store.write({
        title: 'Folder cover',
        directory: 'page-source',
        fileName: 'index',
        content: 'page-v1',
      })
      const token = (await store.read(page.id!)).versionToken
      const gate = gateWrite(
        inner,
        (input) =>
          input.originalId === page.id ||
          input.originalId === encodeWikilinkIdentity(page.id!) ||
          input.id === page.id,
      )
      const pageMove = store.write({
        title: 'Renamed cover',
        directory: 'page-destination',
        fileName: 'wrong-fixed-name',
        content: 'page-v2',
        originalId: page.id,
        versionToken: token,
      })
      await gate.entered
      const contender = store.write({
        title: 'Contender',
        directory: 'page-destination',
        fileName: 'index',
        content: 'must-not-clobber',
        ifExists: 'fail',
      })

      gate.release()
      await pageMove
      await expect(contender).rejects.toMatchObject({ reason: 'note_already_exists' })
      expect(
        (await store.list()).filter((n) => n.filePath === 'page-destination/index.md'),
      ).toHaveLength(1)
      expect((await store.read(page.id!)).content).toBe('page-v2')
    })

    it('holds the folder prefix until host-owned derived metadata finalization settles', async () => {
      const { store, alpha } = await setup()
      const token = (await store.read(alpha)).versionToken
      const entered = deferred()
      const release = deferred()
      const order: string[] = []
      const folderMove = store.move(
        { id: 'from', destinationPath: 'moved', isDirectory: true },
        {
          finalize: async () => {
            order.push('finalize:start')
            entered.resolve()
            await release.promise
            order.push('finalize:end')
          },
        },
      )
      await entered.promise
      const save = store.write(
        {
          title: 'Alpha',
          content: 'after-derived-finalize',
          originalId: alpha,
          versionToken: token,
        },
        {
          prepare: () => {
            order.push('save:prepare')
          },
        },
      )

      release.resolve()
      await Promise.all([folderMove, save])
      expect(order).toEqual(['finalize:start', 'finalize:end', 'save:prepare'])
      expect((await store.read(alpha)).content).toBe('after-derived-finalize')
    })

    it('fences the whole folder delete, so a stale child save conflicts after deletion', async () => {
      const { inner, store, alpha } = await setup()
      const token = (await store.read(alpha)).versionToken
      const gate = gateRemoveDir(inner)
      const deletion = store.removeDir!('from', { principal: 'test' })
      await gate.entered
      const save = store.write({
        title: 'Alpha',
        content: 'must-not-resurrect',
        originalId: alpha,
        versionToken: token,
      })

      gate.release()
      await deletion
      await expect(save).rejects.toMatchObject({ reason: 'note_not_found' })
      expect((await store.list()).some((note) => note.id === alpha)).toBe(false)
      expect((await store.listTrashed({ offset: 0, limit: 10 })).items[0]?.noteId).toBe(alpha)
    })

    it('waits for an earlier child create, re-enumerates it, and tombstones it with the folder', async () => {
      const { inner, store, alpha } = await setup()
      const gate = gateWrite(inner, (input) => input.title === 'Late child')
      const create = store.write({
        title: 'Late child',
        directory: 'from/nested',
        content: 'created before delete',
      })
      await gate.entered
      const deletion = store.removeDir!('from', { principal: 'test' })

      gate.release()
      const late = await create
      await deletion

      expect((await store.list()).some((note) => note.id === alpha || note.id === late.id)).toBe(
        false,
      )
      const trashed = await store.listTrashed({ offset: 0, limit: 10 })
      expect(new Set(trashed.items.map((item) => item.noteId))).toEqual(new Set([alpha, late.id]))
    })

    it('fences the destination prefix and rechecks a create collision after folder move', async () => {
      const { inner, store } = await setup()
      const gate = gateMove(inner, (input) => input.isDirectory === true)
      const folderMove = store.move({
        id: 'from',
        destinationPath: 'moved',
        isDirectory: true,
      })
      await gate.entered
      const create = store.write({
        title: 'Alpha',
        directory: 'moved',
        content: 'must-not-clobber',
        ifExists: 'fail',
      })

      gate.release()
      await folderMove
      await expect(create).rejects.toMatchObject({ reason: 'note_already_exists' })
      expect(
        (await store.list()).filter((note) => note.filePath === 'moved/alpha.md'),
      ).toHaveLength(1)
    })

    it('checks restore collision inside the write fence without reviving the tombstoned id', async () => {
      const { store, alpha } = await setup()
      await store.remove(alpha, { principal: 'test' })
      const occupant = await store.write({
        id: 'occupant-id',
        title: 'Alpha',
        directory: 'from',
        content: 'occupied',
      })

      await expect(store.restoreFromTrash(alpha, { principal: 'test' })).rejects.toMatchObject({
        reason: 'note_already_exists',
      })
      expect((await store.read(occupant.id!)).content).toBe('occupied')
      expect((await store.listTrashed({ offset: 0, limit: 10 })).items[0]?.noteId).toBe(alpha)
    })

    it('lets an in-flight restore finish before purge revalidates the tombstone', async () => {
      const { inner, store, alpha } = await setup()
      await store.remove(alpha, { principal: 'test' })
      const gate = gateWrite(inner, (input) => input.id === alpha && !input.originalId)
      const restore = store.restoreFromTrash(alpha, { principal: 'test' })
      await gate.entered
      const purge = store.purgeTrash({ ids: [alpha] })

      gate.release()
      const [restored, purged] = await Promise.all([restore, purge])
      expect(restored.id).toBe(alpha)
      expect(purged).toEqual({ purged: 0 })
      expect((await store.read(alpha)).content).toBe('alpha-v1')
    })

    it('lets an in-flight purge finish before a stale restore reads the tombstone', async () => {
      const { revisions, store, alpha } = await setup()
      await store.remove(alpha, { principal: 'test' })
      const gate = gatePurge(revisions)
      const purge = store.purgeTrash({ ids: [alpha] })
      await gate.entered
      const restore = store.restoreFromTrash(alpha, { principal: 'test' })

      gate.release()
      await expect(purge).resolves.toEqual({ purged: 1 })
      await expect(restore).rejects.toMatchObject({ reason: 'note_not_in_trash' })
      expect((await store.list()).some((note) => note.id === alpha)).toBe(false)
    })

    it('lets an in-flight delete publish its tombstone before purge validates it', async () => {
      const { revisions, store, alpha } = await setup()
      const gate = gateDeleteRevision(revisions)
      const deletion = store.remove(alpha, { principal: 'test' })
      await gate.entered
      const purge = store.purgeTrash({ ids: [alpha] })

      gate.release()
      await deletion
      await expect(purge).resolves.toEqual({ purged: 1 })
      await expect(store.restoreFromTrash(alpha)).rejects.toMatchObject({
        reason: 'note_not_in_trash',
      })
      expect((await store.listTrashed({ offset: 0, limit: 10 })).total).toBe(0)
    })

    it('lets an in-flight purge finish before a stale repeated delete is admitted', async () => {
      const { revisions, store, alpha } = await setup()
      await store.remove(alpha, { principal: 'test' })
      const gate = gatePurge(revisions)
      const purge = store.purgeTrash({ ids: [alpha] })
      await gate.entered
      const repeatedDelete = store.remove(alpha, { principal: 'test' })

      gate.release()
      await expect(purge).resolves.toEqual({ purged: 1 })
      await expect(repeatedDelete).rejects.toMatchObject({ reason: 'note_not_found' })
      expect((await store.listTrashed({ offset: 0, limit: 10 })).total).toBe(0)
    })

    it('lets an in-flight delete finish before restore reads its tombstone', async () => {
      const { revisions, store, alpha } = await setup()
      const gate = gateDeleteRevision(revisions)
      const deletion = store.remove(alpha, { principal: 'test' })
      await gate.entered
      const restore = store.restoreFromTrash(alpha, { principal: 'test' })

      gate.release()
      await deletion
      await expect(restore).resolves.toMatchObject({ id: alpha })
      expect((await store.read(alpha)).content).toBe('alpha-v1')
      expect((await store.listTrashed({ offset: 0, limit: 10 })).total).toBe(0)
    })

    it('lets an in-flight restore finish before a following delete removes it again', async () => {
      const { inner, store, alpha } = await setup()
      await store.remove(alpha, { principal: 'test' })
      const gate = gateWrite(inner, (input) => input.id === alpha && !input.originalId)
      const restore = store.restoreFromTrash(alpha, { principal: 'test' })
      await gate.entered
      const deletion = store.remove(alpha, { principal: 'test' })

      gate.release()
      await expect(restore).resolves.toMatchObject({ id: alpha })
      await deletion
      expect((await store.list()).some((note) => note.id === alpha)).toBe(false)
      expect((await store.listTrashed({ offset: 0, limit: 10 })).items[0]?.noteId).toBe(alpha)
    })

    it('lets a restore holding the trash lease reach its write before rescan closes admission', async () => {
      const { revisions, store, alpha } = await setup()
      await store.remove(alpha, { principal: 'test' })
      const gate = gateRevisionGet(revisions)
      const restore = store.restoreFromTrash(alpha, { principal: 'test' })
      await gate.entered
      let rescanned = false
      const rescan = store.rescan().then(() => {
        rescanned = true
      })

      await nextTurn()
      expect(rescanned).toBe(false)
      gate.release()
      await expect(restore).resolves.toMatchObject({ id: alpha })
      await rescan
      expect((await store.list()).find((note) => note.id === alpha)?.filePath).toBe('from/alpha.md')
    })

    it('orders a same-tick write before rescan rebuilds path uniqueness', async () => {
      const { store } = await setup()

      await store.write({ title: 'First', slug: 'same', content: 'first' })
      const rescan = store.rescan()
      const write = store.write({ title: 'Second', slug: 'same', content: 'second' })
      await Promise.all([rescan, write])

      expect(
        (await store.list())
          .filter((note) => note.slug?.startsWith('same'))
          .map((note) => note.slug)
          .sort(),
      ).toEqual(['same', 'same-2'])
    })

    it('waits for cold phase-1 inventory before a destructive folder mutation', async () => {
      const { inner, notesDir } = await setup()
      const gate = gateChanges(inner)
      const coldRevisions = new InMemoryRevisionPersistence()
      const cold = new CachedStore({
        inner,
        identityPersistence: new InMemoryIdentity(),
        revisionPersistence: coldRevisions,
        pollIntervalMs: 0,
        ...(notesDir
          ? { readBody: (filePath: string) => readFile(join(notesDir, filePath), 'utf8') }
          : {}),
      })
      const boot = cold.start()
      await gate.entered
      const removeDir = inner.removeDir!.bind(inner)

      inner.removeDir = async (path, opts) => {
        gate.order.push('removeDir')
        return removeDir(path, opts)
      }
      const deletion = cold.removeDir!('from', {
        principal: 'test',
        prepare: () => {
          gate.order.push('mutation:prepare')
        },
      })

      gate.release()
      await boot
      await deletion
      expect(gate.order).toEqual([
        'inventory:start',
        'inventory:end',
        'mutation:prepare',
        'removeDir',
      ])
      expect((await cold.listTrashed({ offset: 0, limit: 10 })).total).toBe(1)
      cold.stop()
      await cold.settle()
    })

    it('keeps mutations available after a late graph-stage boot degradation', async () => {
      const { inner } = await setup()
      const lateRevisions = new InMemoryRevisionPersistence()
      const late = new CachedStore({
        inner,
        revisionPersistence: lateRevisions,
        pollIntervalMs: 0,
      })
      const graph = vi.spyOn(inner, 'graph').mockRejectedValueOnce(new Error('late graph failure'))
      await late.start()
      const gate = gateWrite(inner, (input) => input.title === 'After late failure')
      const write = late.write({
        title: 'After late failure',
        directory: 'safe',
        content: 'still writable',
      })
      await gate.entered
      const retry = late.reconcile()

      await nextTurn()
      expect(graph).toHaveBeenCalledTimes(1)
      gate.release()
      await expect(write).resolves.toMatchObject({ filePath: 'safe/after-late-failure.md' })
      await retry
      // Exactly the failed boot call plus the reconcile's retry. The recovered
      // boot ends with a fire-and-forget `void this.graph()`, but a store back in
      // the ready phase shapes the graph from its own snapshot instead of asking
      // the engine — so that refresh adds no call here, whenever it lands. The
      // upper bound is half the point: re-deriving the engine graph more than
      // once per recovery is exactly the cost this pins.
      expect(graph).toHaveBeenCalledTimes(2)
      expect(
        (await late.list()).some((note) => note.filePath === 'safe/after-late-failure.md'),
      ).toBe(true)
      late.stop()
      await late.settle()
    })

    it('fails mutations closed when phase-1 inventory itself is unavailable', async () => {
      const { inner } = await setup()
      const unavailable = new CachedStore({ inner, pollIntervalMs: 0 })
      vi.spyOn(inner, 'changes').mockRejectedValueOnce(new Error('inventory unavailable'))
      const write = vi.spyOn(inner, 'write')
      await unavailable.start()

      await expect(
        unavailable.write({ title: 'Must not land', content: 'no inventory' }),
      ).rejects.toMatchObject({ reason: 'engine_unavailable', isUnavailable: true })
      expect(write).not.toHaveBeenCalled()
      unavailable.stop()
      await unavailable.settle()
    })

    it('does not serialize independent notes', async () => {
      const { inner, store, alpha, beta } = await setup()
      const alphaToken = (await store.read(alpha)).versionToken
      const betaToken = (await store.read(beta)).versionToken
      const gate = gateWrite(
        inner,
        (input) =>
          input.originalId === alpha ||
          input.originalId === encodeWikilinkIdentity(alpha) ||
          input.id === alpha,
      )
      const write = vi.spyOn(inner, 'write')
      const alphaSave = store.write({
        title: 'Alpha',
        content: 'alpha-blocked',
        originalId: alpha,
        versionToken: alphaToken,
      })
      await gate.entered
      write.mockClear()
      const betaSave = store.write({
        title: 'Beta',
        content: 'beta-free',
        originalId: beta,
        versionToken: betaToken,
      })

      await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
      await betaSave
      expect((await store.read(beta)).content).toBe('beta-free')
      gate.release()
      await alphaSave
    })

    it('does not serialize independent note deletions through the trash fence', async () => {
      const { inner, store, alpha, beta } = await setup()
      const gate = gateRemove(
        inner,
        (id) => id === alpha || id === 'from/alpha.md' || id === encodeWikilinkIdentity(alpha),
      )
      const alphaDelete = store.remove(alpha, { principal: 'test' })
      await gate.entered
      const betaDelete = store.remove(beta, { principal: 'test' })

      await betaDelete
      expect((await store.list()).some((note) => note.id === beta)).toBe(false)
      gate.release()
      await alphaDelete
    })
  })
}

describe('CachedStore exact-note owner expansion', () => {
  it('rejects a body-disclosed owner outside the claim before read side effects', async () => {
    const harness = await createNotariumHarness()

    try {
      const alpha = await harness.store.write({ title: 'Alpha', content: 'alpha' })
      const beta = await harness.store.write({ title: 'Beta', content: 'beta' })
      const alphaBefore = await harness.store.read(alpha.id!)
      const listBefore = await harness.store.list()
      // finalizeRead stamps preview/facts/edges under the CLAIMED id, not under
      // the id the body discloses. So the claimed note is the surface a guard
      // that ran too late corrupts — assert it, not only the disclosed one.
      const claimedPreviewBefore = await harness.store.preview(alpha.id!)
      const claimedFactsBefore = await harness.store.noteFacts!([alpha.id!])
      const previewBefore = await harness.store.preview(beta.id!)
      const factsBefore = await harness.store.noteFacts!([beta.id!])
      const graphBefore = await harness.store.graph()
      const events: StoreEvent[] = []

      harness.store.subscribe((event) => {
        if (event.type === 'changed' || event.type === 'graph') {
          events.push(event)
        }
      })
      const read = harness.inner.read.bind(harness.inner)

      harness.inner.read = async (id, opts) => {
        const current = await read(id, opts)

        return current.filePath === alphaBefore.filePath
          ? {
              ...current,
              id: beta.id,
              // Links OUT of the claimed note: patching these edges is a
              // snapshot change, so a late guard also leaks a `changed` event.
              content: 'foreign preview [[Beta]]',
              frontmatter: { ...current.frontmatter, 'notarium-id': beta.id },
            }
          : current
      }

      await expect(
        harness.store.withExactNoteClaim(alpha.id!, async () => undefined),
      ).rejects.toThrow(/claim expansion/i)
      expect(await harness.store.list()).toEqual(listBefore)
      expect(harness.store.previewPeek(alpha.id!)).toEqual(claimedPreviewBefore)
      await expect(harness.store.noteFacts!([alpha.id!])).resolves.toEqual(claimedFactsBefore)
      expect(harness.store.previewPeek(beta.id!)).toEqual(previewBefore)
      await expect(harness.store.noteFacts!([beta.id!])).resolves.toEqual(factsBefore)
      await expect(harness.store.graph()).resolves.toEqual(graphBefore)
      expect(events).toEqual([])
      await expect(harness.store.read(beta.id!)).resolves.toMatchObject({
        id: beta.id,
        filePath: 'beta.md',
      })
    } finally {
      await harness.close()
    }
  })

  // An identity-capable engine owns an id channel of its own, so it discloses a
  // foreign owner through two independent axes. Both must expand the claim; the
  // fake below is the only harness here whose `capabilities.identity` is true.
  for (const [axis, disclose] of [
    [
      'the engine id channel',
      (detail: NoteContent, foreignId: string): NoteContent => ({ ...detail, id: foreignId }),
    ],
    [
      'a body claim',
      (detail: NoteContent, foreignId: string): NoteContent => ({
        ...detail,
        frontmatter: { ...detail.frontmatter, 'notarium-id': foreignId },
      }),
    ],
  ] as const) {
    it(`rejects an owner disclosed through ${axis} on an identity-capable engine`, async () => {
      const harness = await createMemoryHarness()

      try {
        const alpha = await harness.store.write({ title: 'Alpha', content: 'alpha' })
        const beta = await harness.store.write({ title: 'Beta', content: 'beta' })
        const alphaBefore = await harness.store.read(alpha.id!)
        const listBefore = await harness.store.list()
        const previewBefore = await harness.store.preview(beta.id!)
        const factsBefore = await harness.store.noteFacts!([beta.id!])
        const graphBefore = await harness.store.graph()
        const events: StoreEvent[] = []

        harness.store.subscribe((event) => {
          if (event.type === 'changed' || event.type === 'graph') {
            events.push(event)
          }
        })
        const read = harness.inner.read.bind(harness.inner)

        harness.inner.read = async (id, opts) => {
          const current = await read(id, opts)

          return current.filePath === alphaBefore.filePath
            ? disclose({ ...current, content: 'foreign preview [[Alpha]]' }, beta.id!)
            : current
        }

        await expect(
          harness.store.withExactNoteClaim(alpha.id!, async () => undefined),
        ).rejects.toThrow(/claim expansion/i)
        expect(await harness.store.list()).toEqual(listBefore)
        expect(harness.store.previewPeek(beta.id!)).toEqual(previewBefore)
        await expect(harness.store.noteFacts!([beta.id!])).resolves.toEqual(factsBefore)
        await expect(harness.store.graph()).resolves.toEqual(graphBefore)
        expect(events).toEqual([])
        await expect(harness.store.read(beta.id!)).resolves.toMatchObject({
          id: beta.id,
          filePath: 'beta.md',
        })
      } finally {
        await harness.close()
      }
    })
  }
})

// The production engine has no identity channel, so every public read in this
// Space takes the SAME PhaseGate the compound claim takes — the read cohort
// against the mutation cohort. A mutation intent stranded between admission and
// the queued claim therefore does not fail one caller: it freezes the Space.
describe('CachedStore exact-note admission', () => {
  it('hands back mutation admission when the exact claim fails before it is queued', async () => {
    const harness = await createNotariumHarness()

    try {
      const alpha = await harness.store.write({ title: 'Alpha', content: 'alpha' })

      // Stopping is the cheap way to fail `ensureMutationReady()`; a refused
      // identity flush reaches the same place. Either way the throw lands after
      // admission was taken and before the claim reaches the coordinator.
      harness.store.stop()
      await expect(
        harness.store.withExactNoteClaim(alpha.id!, async () => undefined),
      ).rejects.toThrow(/store is stopping/i)

      let readSettled = false
      const read = harness.store.read(alpha.id!).then(
        () => {
          readSettled = true
        },
        () => {
          readSettled = true
        },
      )

      for (let turn = 0; turn < 10; turn += 1) {
        await nextTurn()
      }
      expect(readSettled).toBe(true)
      await read
    } finally {
      // `close()` waits for that same gate to drain, so bound it: a stranded
      // intent has to surface as the assertion above, not as a teardown timeout
      // that hides which check caught the leak.
      await Promise.race([harness.close(), new Promise((resolve) => setTimeout(resolve, 500))])
    }
  })
})

describe('CachedStore exact-note claim identity', () => {
  it('takes the exact claim on the durable id behind a superseded spelling', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-exact-superseded-'))
    const inner = createNotariumStore({
      mounts: [{ class: 'user-doc', dir: notesDir, prefix: '' }],
    })
    const durableId = 'durable-exact-claim-id'
    let store: CachedStore | undefined

    try {
      await inner.write({ id: durableId, title: 'Legacy', content: 'legacy body' })
      const listEntered = deferred()
      const releaseList = deferred()
      const list = inner.list.bind(inner)
      let gated = true

      inner.list = async () => {
        const result = await list()

        if (gated) {
          gated = false
          listEntered.resolve()
          await releaseList.promise
        }

        return result
      }
      store = new CachedStore({
        inner,
        pollIntervalMs: 0,
        readBody: (filePath) => readFile(join(notesDir, filePath), 'utf8'),
      })
      const boot = store.start()

      await listEntered.promise
      const phaseOneId = (await store.list()).find((note) => note.filePath === 'legacy.md')?.id

      if (!phaseOneId) {
        throw new Error('phase-1 note must be visible')
      }
      releaseList.resolve()
      await boot
      expect(phaseOneId).not.toBe(durableId)

      // A phase-1 client keeps addressing the note by the id it was handed. The
      // compound claim is a resource claim: it has to name the id the sweep
      // settled on, or it fences a spelling nothing else in the queue uses.
      await expect(
        store.withExactNoteClaim(phaseOneId, async (current) => current.id),
      ).resolves.toBe(durableId)
    } finally {
      store?.stop()
      await store?.settle()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })

  it('refuses to hand a compound task an observation outside its claim', async () => {
    const harness = await createMemoryHarness()

    try {
      const alpha = await harness.store.write({ title: 'Alpha', content: 'alpha' })
      const alphaBefore = await harness.store.read(alpha.id!)
      const read = harness.inner.read.bind(harness.inner)
      let observed: string | undefined

      // An identity-capable engine that answers the claimed path with no id of
      // its own. The decorator then has to mint one from its own registry, and
      // that minted id is nothing the held claim names.
      harness.inner.read = async (id, opts) => {
        const current = await read(id, opts)

        return current.filePath === alphaBefore.filePath
          ? ({ ...current, id: undefined } as unknown as NoteContent)
          : current
      }

      await expect(
        harness.store.withExactNoteClaim(alpha.id!, async (current) => {
          observed = current.id
        }),
      ).rejects.toThrow(/escaped the held mutation claim/i)
      expect(observed).toBeUndefined()
    } finally {
      await harness.close()
    }
  })
})

// canon: docs/note-model.md#create-collisions
for (const [name, createHarness] of variants) {
  describe(`CachedStore create collisions — ${name}`, () => {
    let harness: Harness | undefined

    afterEach(async () => {
      await harness?.close()
      harness = undefined
    })

    const setup = async () => {
      harness = await createHarness()
      const plans = await harness.store.write({
        title: 'Plans',
        directory: 'work',
        content: 'the body that must survive',
      })

      return { ...harness, plans: plans.id! }
    }

    it('refuses by default and names the occupant so the caller can open it', async () => {
      const { store, plans } = await setup()

      await expect(
        store.write({ title: 'Plans', directory: 'work', content: 'intruder' }),
      ).rejects.toMatchObject({
        reason: 'note_already_exists',
        existing: { id: plans, title: 'Plans', filePath: 'work/plans.md' },
      })
      expect((await store.read(plans)).content).toBe('the body that must survive')
    })

    it('uniquify counts up past every taken name and answers the title it got', async () => {
      const { store, plans } = await setup()
      const second = await store.write({
        title: 'Plans',
        directory: 'work',
        content: 'b',
        ifExists: 'uniquify',
      })
      const third = await store.write({
        title: 'Plans',
        directory: 'work',
        content: 'c',
        ifExists: 'uniquify',
      })

      expect([second.title, third.title]).toEqual(['Plans 2', 'Plans 3'])
      expect([second.filePath, third.filePath]).toEqual(['work/plans-2.md', 'work/plans-3.md'])
      expect(new Set([plans, second.id, third.id]).size).toBe(3)
      expect((await store.read(plans)).content).toBe('the body that must survive')
    })

    it('uniquify counts the PINNED basename, not the title, when a fileName was given', async () => {
      const { store } = await setup()
      await store.write({ title: 'Fixed', directory: 'work', content: 'a', fileName: 'pinned' })
      const second = await store.write({
        title: 'Fixed',
        directory: 'work',
        content: 'b',
        fileName: 'pinned',
        ifExists: 'uniquify',
      })

      // Counting the title would have re-derived the same pinned path forever.
      expect(second.filePath).toBe('work/pinned-2.md')
      expect(second.title).toBe('Fixed')
    })

    it('an exhausted name series still names the occupant, and stops offering a free name', async () => {
      const { store, plans } = await setup()

      // Fill the whole series the counter walks, so uniquify has nowhere left to land.
      for (let n = 2; n <= 50; n++) {
        await store.write({ title: `Plans ${n}`, directory: 'work', content: 'x' })
      }

      // The plain refusal keeps naming the occupant but has no free name to preview —
      // that pair is how a caller learns a retry cannot help.
      const refusal = await store
        .write({ title: 'Plans', directory: 'work', content: 'mine' })
        .catch((e) => e)
      expect(refusal).toMatchObject({ reason: 'note_already_exists', existing: { id: plans } })
      expect(refusal.suggestedTitle).toBeUndefined()

      // And the retry that ignores that hint fails the same way rather than silently
      // landing somewhere unexpected — still naming the note the caller can open.
      const exhausted = await store
        .write({ title: 'Plans', directory: 'work', content: 'mine', ifExists: 'uniquify' })
        .catch((e) => e)
      expect(exhausted).toMatchObject({ reason: 'note_already_exists', existing: { id: plans } })
      expect((await store.read(plans)).content).toBe('the body that must survive')
    })

    it('concurrent uniquify creates of one title never share a destination', async () => {
      const { store } = await setup()
      const results = await Promise.all(
        ['b', 'c', 'd'].map((body) =>
          store.write({ title: 'Plans', directory: 'work', content: body, ifExists: 'uniquify' }),
        ),
      )

      expect(new Set(results.map((r) => r.filePath)).size).toBe(3)
      expect(new Set(results.map((r) => r.id)).size).toBe(3)
      expect((await store.list()).filter((n) => n.filePath.startsWith('work/plans')).length).toBe(4)
    })

    // #296 — two titles in a script we cannot romanise used to aim at ONE path
    // (`work/.md`), so the second create was refused as a duplicate of a note whose
    // title was visibly different, and `uniquify` "worked" onto the meaningless
    // `work/2.md` (an ASCII counter digit was all that survived the slug).
    it('two different non-Latin titles are two notes, not a collision', async () => {
      const { store } = await setup()
      const cjk = await store.write({ title: '第三季度规划', directory: 'work', content: 'q3' })
      const heb = await store.write({ title: 'תוכניות לרבעון', directory: 'work', content: 'hb' })

      expect(cjk.filePath).toBe('work/第三季度规划.md')
      expect(heb.filePath).toBe('work/תוכניות-לרבעון.md')
      expect((await store.read(cjk.id!)).content).toBe('q3')
      expect((await store.read(heb.id!)).content).toBe('hb')
    })

    it('refuses a real non-Latin duplicate, and uniquify lands on a readable name', async () => {
      const { store } = await setup()
      const first = await store.write({ title: '第三季度规划', directory: 'work', content: 'q3' })

      await expect(
        store.write({ title: '第三季度规划', directory: 'work', content: 'intruder' }),
      ).rejects.toMatchObject({
        reason: 'note_already_exists',
        existing: { id: first.id, title: '第三季度规划' },
      })
      const second = await store.write({
        title: '第三季度规划',
        directory: 'work',
        content: 'b',
        ifExists: 'uniquify',
      })

      expect(second.filePath).toBe('work/第三季度规划-2.md')
      expect(second.title).toBe('第三季度规划 2')
      expect((await store.read(first.id!)).content).toBe('q3')
    })

    it('names a file after the note when the title has no letters, and keeps two apart', async () => {
      const { store } = await setup()
      const a = await store.write({ title: '🎉🎉', directory: 'work', content: 'party' })
      const b = await store.write({ title: '✨✨', directory: 'work', content: 'sparkle' })

      // The id rung: `<id>.md`, never the dot-file `.md` the empty slug used to write.
      // Through `idToSlug`, not the raw id — an id may open on a dash, and a slug does
      // not (this assertion was flaky until an id actually did).
      expect(a.filePath).toBe(`work/${idToSlug(a.id!)}.md`)
      expect(b.filePath).not.toBe(a.filePath)
      expect((await store.read(a.id!)).content).toBe('party')
      expect((await store.read(b.id!)).content).toBe('sparkle')
    })

    it('an emoji-titled create does not inherit the id of a note titled "Note"', async () => {
      // The id rung must be settled BEFORE the path is predicted. Predicting `note.md`
      // first would look the path up in the identity registry and hand the newcomer
      // the occupant's id — the identity theft #274 closed, through a new door.
      const { store } = await setup()
      const note = await store.write({ title: 'Note', directory: 'work', content: 'the real one' })
      const emoji = await store.write({ title: '🎉', directory: 'work', content: 'party' })

      expect(emoji.id).not.toBe(note.id)
      expect(emoji.filePath).not.toBe(note.filePath)
      expect((await store.read(note.id!)).content).toBe('the real one')
      expect((await store.read(emoji.id!)).content).toBe('party')
    })
  })
}

// A create that displaced a note and then FAILED still owes subscribers the
// displacement: the read-model already dropped the occupant, so a client that never
// hears about it keeps a note under an id nothing answers to. The frame is built
// from a reconstructed "before" set, and the reconstruction earns its keep only if
// the displaced id is actually in it.
describe('CachedStore identity repair frame', () => {
  let harness: Harness | undefined

  afterEach(async () => {
    await harness?.close()
    harness = undefined
  })

  it('announces the note a failed create displaced', async () => {
    // A path-keyed engine, because the read-model owns identity only there — on an
    // identity-capable engine the displacement is the engine's to report.
    harness = await createNotariumHarness()
    const { store, inner } = harness
    const displaced = await store.write({
      title: 'Plan',
      directory: 'docs',
      content: 'the note that was standing here',
    })
    const events: StoreEvent[] = []

    store.subscribe((event) => events.push(event))
    // Fail the write AFTER it published — the post-write read is the first thing it
    // does once the snapshot patch (and the displacement in it) has landed.
    const read = inner.read.bind(inner)
    let failNextRead = true

    inner.read = async (key, opts) => {
      if (failNextRead) {
        failNextRead = false
        throw new Error('post-write read failed')
      }

      return read(key, opts)
    }

    await expect(
      store.write({
        title: 'Plan',
        directory: 'docs',
        fileName: 'plan',
        id: 'PlannedRepairAA',
        ifExists: 'overwrite',
        content: 'the newcomer',
      }),
    ).rejects.toThrow()
    expect(failNextRead).toBe(false)
    // The next durable identity flush is what publishes the pending repair.
    await store.write({ title: 'Unrelated', directory: 'docs', content: 'x' })

    expect(
      events.some(
        (event) => event.type === 'changed' && event.removed.includes(displaced.id as string),
      ),
    ).toBe(true)
  })
})

describe('CachedStore create collisions — files the index has not seen', () => {
  let harness: Harness | undefined

  afterEach(async () => {
    await harness?.close()
    harness = undefined
  })

  it('refuses on disk truth alone (no occupant to name), and uniquify steps past it', async () => {
    harness = await createNotariumHarness()
    const { store, notesDir } = harness
    // A file that exists on disk but not in the read-model — the case only the
    // engine can see, and the reason its refusal is the arbiter rather than a belt.
    mkdirSync(join(notesDir!, 'work'), { recursive: true })
    writeFileSync(join(notesDir!, 'work', 'plans.md'), '# Plans\n\nunindexed body\n')

    await expect(
      store.write({ title: 'Plans', directory: 'work', content: 'intruder' }),
    ).rejects.toMatchObject({ reason: 'note_already_exists', existing: undefined })
    expect(await readFile(join(notesDir!, 'work', 'plans.md'), 'utf8')).toContain('unindexed body')

    const beside = await store.write({
      title: 'Plans',
      directory: 'work',
      content: 'mine',
      ifExists: 'uniquify',
    })
    expect(beside.filePath).toBe('work/plans-2.md')
  })

  it('does not replace a dangling symlink that occupies the destination', async () => {
    harness = await createNotariumHarness()
    const { store, notesDir } = harness
    const claimed = join(notesDir!, 'claimed.md')

    symlinkSync('missing.md', claimed)
    const readFileSpy = vi.spyOn(fsPromises, 'readFile')

    await expect(store.write({ title: 'Claimed', content: 'intruder' })).rejects.toMatchObject({
      reason: 'note_already_exists',
    })
    expect(readFileSpy).not.toHaveBeenCalledWith(claimed, 'utf8')
    readFileSpy.mockRestore()
    expect(lstatSync(claimed).isSymbolicLink()).toBe(true)
  })
})

// A bulk import defers the per-note ghost pass for the whole bracket and runs it
// ONCE on close (#302) — otherwise every imported note re-resolves the whole
// ghost registry and the import is quadratic again. What that trade owes back is
// coherence AT the closing bracket: `endBulk()` returns a read-model an /api/graph
// or /api/search reader can trust, not one that heals on the next poll.
describe.each(variants)('CachedStore bulk ghost re-resolve — %s', (_name, createHarness) => {
  /** Freeze the delta feed. The catch-up poll `endBulk()` fires would repair the
   *  registry too, so without this the test cannot tell the bracket's own pass
   *  from a poll that happened to win the race. */
  const suspendDeltas = (inner: KnowledgeStore) => {
    const changes = inner.changes.bind(inner)
    const release = deferred()

    inner.changes = async (cursor) => {
      await release.promise

      return changes(cursor)
    }

    return release.resolve
  }

  it('heals the deferred ghosts by the closing bracket when no folder appeared', async () => {
    const h = await createHarness()
    let resumeDeltas: (() => void) | undefined

    try {
      const source = await h.store.write({
        title: 'Source',
        directory: 'docs',
        content: 'see [[Target]]',
      })

      expect((await h.store.graph()).nodes.some((node) => node.ghost)).toBe(true)
      resumeDeltas = suspendDeltas(h.inner)
      h.store.beginBulk()
      // Into a folder that ALREADY exists — the import shape that leaves the
      // bracket with no graph-context sources to rebuild. The corpus pass would
      // have re-resolved the registry as a side effect; here nothing does but the
      // deferred pass itself.
      const target = await h.store.write({
        title: 'Target',
        directory: 'docs',
        content: 'the note the link was waiting for',
      })

      await h.store.endBulk()

      const graph = await h.store.graph()

      expect(graph.nodes.some((node) => node.ghost)).toBe(false)
      expect(graph.links).toContainEqual(
        expect.objectContaining({ source: source.id, target: target.id }),
      )
    } finally {
      resumeDeltas?.()
      await h.close()
    }
  })

  it('settles a name the bracket handed from one live note to another', async () => {
    // The other half of what the batch table costs, and the half a ghost pass can
    // never see: the link RESOLVED — to a live note that no longer holds the name.
    // A note renamed away leaves its old title behind as an alias, and the resolver
    // ranks a current title strictly above any note's alias, so a note created in
    // the bracket under that title TAKES the name. Until the close the bracket's
    // own table still hands it to the note holding only the alias, and nothing in
    // the graph looks broken — the edge points at a real note, the wrong one.
    const h = await createHarness()
    let resumeDeltas: (() => void) | undefined

    try {
      const planned = await h.store.write({
        title: 'Plan',
        directory: 'docs',
        content: 'the plan as it was',
      })
      const renamed = await h.store.write({
        originalId: planned.id,
        versionToken: (await h.store.read(planned.id!)).versionToken,
        title: 'Retired Plan',
        directory: 'docs',
        content: 'the plan as it was',
      })
      // Written BEFORE the bracket, and right at the time it was written: the only
      // note answering to `[[Plan]]` is the renamed one, through its alias.
      const before = await h.store.write({
        title: 'Before',
        directory: 'docs',
        content: 'see [[Plan]]',
      })

      expect((await h.store.graph()).links).toContainEqual(
        expect.objectContaining({ source: before.id, target: renamed.id }),
      )
      resumeDeltas = suspendDeltas(h.inner)
      h.store.beginBulk()
      // Into the folder the notes above already created — no directory change, so
      // nothing but the rule under test schedules the repair.
      const fresh = await h.store.write({
        title: 'Plan',
        directory: 'docs',
        fileName: 'fresh-plan',
        content: 'the plan as it is now',
      })
      const during = await h.store.write({
        title: 'During',
        directory: 'docs',
        content: 'see [[Plan]]',
      })

      await h.store.endBulk()

      const graph = await h.store.graph()

      // Both sources — the one written before the bracket and the one written
      // inside it — end on the note that now bears the name.
      expect(graph.links).toContainEqual(
        expect.objectContaining({ source: before.id, target: fresh.id }),
      )
      expect(graph.links).toContainEqual(
        expect.objectContaining({ source: during.id, target: fresh.id }),
      )
      expect(graph.links).not.toContainEqual(
        expect.objectContaining({ source: during.id, target: renamed.id }),
      )
    } finally {
      resumeDeltas?.()
      await h.close()
    }
  })

  it('heals a link between two notes the bracket itself created', async () => {
    // The import's own shape, and what the write path's batch table costs: the
    // bracket builds ONE resolve table, so a link to a note the bracket added after
    // it ghosts on the way in — in both directions, since the table predates both
    // notes. Nothing in the bracket resolves them; the single pass at the close is
    // what does, and that is exactly what buys the write path an O(1) table.
    const h = await createHarness()
    let resumeDeltas: (() => void) | undefined

    try {
      // Into an EXISTING folder, so no directory change schedules a corpus-wide
      // repair that would heal the graph for reasons of its own.
      await h.store.write({ title: 'Seed', directory: 'docs', content: 'no links here' })
      resumeDeltas = suspendDeltas(h.inner)
      h.store.beginBulk()
      const first = await h.store.write({
        title: 'First',
        directory: 'docs',
        content: 'forward to [[Second]]',
      })
      const second = await h.store.write({
        title: 'Second',
        directory: 'docs',
        content: 'back to [[First]]',
      })

      await h.store.endBulk()

      const graph = await h.store.graph()

      expect(graph.nodes.some((node) => node.ghost)).toBe(false)
      expect(graph.links).toContainEqual(
        expect.objectContaining({ source: first.id, target: second.id }),
      )
      expect(graph.links).toContainEqual(
        expect.objectContaining({ source: second.id, target: first.id }),
      )
    } finally {
      resumeDeltas?.()
      await h.close()
    }
  })
})
