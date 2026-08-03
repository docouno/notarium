import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CachedStore,
  InMemoryRevisionPersistence,
  type KnowledgeStore,
  type MoveInput,
  type StoreDelta,
  type WriteInput,
} from '@notarium/core'
import { createNotariumStore } from '@notarium/engine'
import { InMemoryStore } from '@notarium/engine-memory'

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

  revisions.purgeNotes = async (ids) => {
    if (armed) {
      armed = false
      entered.resolve()
      await release.promise
    }

    return purge(ids)
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

  revisions.get = async (revisionId) => {
    if (armed) {
      armed = false
      entered.resolve()
      await release.promise
    }

    return get(revisionId)
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
    let moving: Promise<void> | undefined
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
      expect(aliasReads).toBe(1)
    } finally {
      releaseFinalize.resolve()
      await Promise.allSettled([moving, reconcile].filter((task) => task !== undefined))
      store.stop()
      await store.settle()
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

    it('orders a gated save before delete, so two successes cannot resurrect the note', async () => {
      const { inner, store, alpha } = await setup()
      const token = (await store.read(alpha)).versionToken
      const gate = gateWrite(inner, (input) => input.originalId === alpha || input.id === alpha)
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
      const gate = gateWrite(inner, (input) => input.originalId === alpha || input.id === alpha)
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
      const gate = gateWrite(inner, (input) => input.originalId === page.id || input.id === page.id)
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
      const { inner } = await setup()
      const gate = gateChanges(inner)
      const coldRevisions = new InMemoryRevisionPersistence()
      const cold = new CachedStore({
        inner,
        revisionPersistence: coldRevisions,
        pollIntervalMs: 0,
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
      const gate = gateWrite(inner, (input) => input.originalId === alpha || input.id === alpha)
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
      const gate = gateRemove(inner, (id) => id === alpha || id === 'from/alpha.md')
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
  })
}

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
})
