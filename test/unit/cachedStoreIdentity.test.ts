// CachedStore over a BARE engine (capabilities.identity: false — the Basic
// Memory shape): here the decorator's own IdentityRegistry is the id
// authority (#51). Pinned: the boot frontmatter sweep adopts `notarium-id`
// claims from files (re-keying the snapshot); write settles the id BEFORE the
// engine call and hands it down for materialization; an external move
// (inventory remove+add whose new file carries the old claim) re-attaches the
// tombstoned id — the note's identity survives a move we never saw.

import { describe, expect, it, vi } from 'vitest'
import type { StoreEvent } from '@notarium/contract'
import {
  CachedStore,
  frontmatterValue,
  type IdentityPersistence,
  type IdentityRecord,
  InMemoryRevisionPersistence,
  type KnowledgeStore,
  liveSyncStatus,
  NOTE_ID_FRONTMATTER_KEY,
  type NoteMeta,
  slugify,
  upsertFrontmatterKey,
  type WriteInput,
} from '@notarium/core'

const permalinkOf = (fp: string) => `main/${fp.replace(/\.md$/, '')}`
const NOTE_ID_RE = /^[A-Za-z0-9_-]{12}$/

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** A minimal bare engine over a path→raw-file map. No ids anywhere — exactly
 *  what the identity-equipped CachedStore must compensate for. */
const makeBareEngine = (files: Map<string, string>) => {
  const writes: WriteInput[] = []
  let cursor = 0
  const metaOf = (filePath: string): NoteMeta => ({
    title: filePath.split('/').pop()!.replace(/\.md$/, ''),
    filePath,
    modifiedAt: '2026-06-11T00:00:00.000Z',
    createdAt: null,
  })
  const engine: KnowledgeStore = {
    capabilities: {
      fts: false,
      vector: false,
      hybrid: false,
      graphExpand: false,
      identity: false,
      cas: false,
      revisions: false,
      trash: false,
      visibility: false,
      watch: false,
    },
    list: async () => [...files.keys()].map(metaOf),
    read: async (id) => {
      const path = [...files.keys()].find((p) => p === id || permalinkOf(p) === id)

      if (!path) {
        return { content: '', frontmatter: {} }
      }
      const raw = files.get(path)!
      const claim = frontmatterValue(raw, NOTE_ID_FRONTMATTER_KEY)
      return {
        title: metaOf(path).title,
        permalink: permalinkOf(path),
        filePath: path,
        content: raw.replace(/^---\n[\s\S]*?\n---\n/, ''),
        frontmatter: claim ? { [NOTE_ID_FRONTMATTER_KEY]: claim } : {},
      }
    },
    preview: async () => ({ snippet: '', image: null, tags: [], words: 0, tokens: 0 }),
    previews: async () => ({}),
    previewPeek: () => null,
    search: async () => [],
    graph: async () => ({ nodes: [], links: [] }),
    write: async (input) => {
      writes.push(input)
      const dir = (input.directory || '').replace(/^\/+|\/+$/g, '')
      const filePath = (dir ? `${dir}/` : '') + `${slugify(input.title)}.md`
      const old = typeof input.originalId === 'string' ? input.originalId : null

      if (old && files.has(old) && old !== filePath) {
        files.delete(old)
      }
      let raw = input.content ?? ''

      // The materialization contract: an engine that controls frontmatter
      // writes the handed-down id into the file.
      if (input.id) {
        raw = upsertFrontmatterKey(raw, NOTE_ID_FRONTMATTER_KEY, input.id)
      }
      files.set(filePath, raw)
      return { filePath, permalink: permalinkOf(filePath), result: {} }
    },
    move: async ({ id, destinationPath }) => {
      const raw = files.get(id)

      if (raw === undefined) {
        throw new Error('not found')
      }
      files.delete(id)
      files.set(destinationPath, raw)
    },
    remove: async (id) => {
      files.delete(id)
    },
    changes: async () => ({
      cursor: String(++cursor),
      upserts: [],
      inventory: [...files.keys()].map(metaOf),
    }),
    syncStatus: async () => liveSyncStatus(),
  }
  return { engine, writes, files }
}

const make = async (files: Map<string, string>) => {
  const bare = makeBareEngine(files)
  const store = new CachedStore({
    inner: bare.engine,
    pollIntervalMs: 0,
    relationType: 'links_to',
    readBody: async (fp) => files.get(fp) ?? null,
    now: () => new Date('2026-06-11T12:00:00Z'),
  })
  await store.start()
  return { ...bare, store }
}

/** A persistence that only ever holds what was explicitly flushed to it — the
 *  meta-DB's stand-in. `findById` reads THIS durable map, exactly like
 *  SpaceManager.resolveNote reads the DB and not the in-memory registry. */
const makeIdentityPersistence = () => {
  const durable = new Map<string, IdentityRecord>()
  const persistence: IdentityPersistence = {
    init: async () => {},
    loadAll: async () => [],
    upsertMany: async (records) => {
      for (const r of records) {
        durable.set(r.id, { ...r })
      }
    },
    findById: async (id) => durable.get(id) ?? null,
    close: async () => {},
  }
  return { persistence, durable }
}

describe('CachedStore + bare engine — identity (#51)', () => {
  it('the boot sweep adopts notarium-id claims from files; unclaimed notes get minted ids', async () => {
    const { store } = await make(
      new Map([
        ['demo/a.md', `---\n${NOTE_ID_FRONTMATTER_KEY}: durable-id-a1\n---\n# a\n\nbody`],
        ['demo/b.md', '# b\n\nno claim here'],
      ]),
    )
    const notes = await store.list()
    const a = notes.find((n) => n.filePath === 'demo/a.md')
    const b = notes.find((n) => n.filePath === 'demo/b.md')
    expect(a?.id).toBe('durable-id-a1') // the file's claim IS the id
    expect(b?.id).toMatch(NOTE_ID_RE) // minted by the registry
    expect(b?.id).not.toBe(a?.id)
  })

  it('write settles the id first and hands it to the engine for materialization', async () => {
    const { store, writes, files } = await make(new Map())
    const res = await store.write({ title: 'New Note', content: 'hi' })
    expect(res.id).toMatch(NOTE_ID_RE)
    // the engine received the very id the store reports back
    expect(writes[0].id).toBe(res.id)
    expect(frontmatterValue(files.get('new-note.md')!, NOTE_ID_FRONTMATTER_KEY)).toBe(res.id)
    expect((await store.list()).find((n) => n.filePath === 'new-note.md')?.id).toBe(res.id)
  })

  it('a create flushes its id to persistence before answering — no create→read 404 race (#21/#69)', async () => {
    const files = new Map<string, string>()
    const bare = makeBareEngine(files)
    const { persistence, durable } = makeIdentityPersistence()
    const store = new CachedStore({
      inner: bare.engine,
      identityPersistence: persistence,
      pollIntervalMs: 0,
      relationType: 'links_to',
      readBody: async (fp) => files.get(fp) ?? null,
      now: () => new Date('2026-06-11T12:00:00Z'),
    })
    await store.start()

    const res = await store.write({ title: 'Agent Note', content: 'written then read' })
    // The id the create returned is durably resolvable RIGHT NOW — no timer
    // advanced, no flush awaited by the caller. This is the exact moment an
    // agent's next request (SpaceManager.resolveNote → findById) would fire.
    expect(res.id).toMatch(NOTE_ID_RE)
    expect(durable.has(res.id!)).toBe(true)
    expect(await persistence.findById!(res.id!)).toMatchObject({
      id: res.id,
      filePath: 'agent-note.md',
    })
  })

  it('rename via originalId keeps the id; the engine is spoken to in storage keys', async () => {
    const { store, writes } = await make(new Map())
    const res = await store.write({ title: 'New Note', content: 'hi' })

    const events: StoreEvent[] = []
    store.subscribe((e) => events.push(e))
    // Updates are optimistic (#50): echo the token the read answered.
    const { versionToken } = await store.read(res.id!)
    const renamed = await store.write({
      title: 'Renamed',
      content: 'hi',
      originalId: res.id!,
      versionToken,
    })
    expect(renamed.id).toBe(res.id) // P7: the id survives the rename
    // the engine knows nothing of note-ids — it got the storage path to move
    expect(writes[1].originalId).toBe('new-note.md')
    expect(writes[1].id).toBe(res.id)
    expect(events).toContainEqual({
      type: 'changed',
      upserts: [res.id],
      removed: [],
      folders: [''],
    })

    const notes = await store.list()
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ id: res.id, filePath: 'renamed.md' })
  })

  // ── CAS over a bare engine (#50): here the DECORATOR is the arbiter — the
  //    inner engine is a bare last-write-wins store, so the verify-read, the
  //    conflict and the fresh token all come from this layer. This exercises the
  //    CachedStore decorator's own CAS over a non-CAS inner engine.
  describe('optimistic write — the decorator as CAS arbiter (#50)', () => {
    it('tokenless update is rejected before the engine is ever written', async () => {
      const { store, writes } = await make(new Map())
      const res = await store.write({ title: 'Note', content: 'hi' })
      const engineWrites = writes.length
      await expect(
        store.write({ title: 'Note', content: 'sneaky', originalId: res.id! }),
      ).rejects.toMatchObject({ isToolError: true, reason: 'version_token_required' })
      expect(writes.length).toBe(engineWrites) // nothing reached the engine
    })

    it('an external file change between read and save → conflict with the live body + fresh token', async () => {
      const files = new Map<string, string>()
      const { store, writes } = await make(files)
      const res = await store.write({ title: 'Note', content: 'mine v1' })
      const mine = await store.read(res.id!)
      // The file changes underneath us — an agent or an external sync wrote it.
      files.set('note.md', files.get('note.md')!.replace('mine v1', 'theirs'))
      const engineWrites = writes.length
      let conflict: unknown

      try {
        await store.write({
          title: 'Note',
          content: 'mine v2',
          originalId: res.id!,
          versionToken: mine.versionToken,
        })
      } catch (err) {
        conflict = err
      }
      expect(conflict).toMatchObject({ isConflict: true, reason: 'version_conflict' })
      const current = (
        conflict as { current?: { id: string; content: string; versionToken: string } }
      ).current
      expect(current?.content).toContain('theirs')
      expect(current?.id).toBe(res.id)
      expect(writes.length).toBe(engineWrites) // the losing write never landed
      // The conflict's token asserts "I saw the live version" — it goes through.
      const overwritten = await store.write({
        title: 'Note',
        content: 'mine v2, deliberately',
        originalId: res.id!,
        versionToken: current!.versionToken,
      })
      expect(overwritten.versionToken).toBe((await store.read(res.id!)).versionToken)
    })

    it('the save answers the token of what the engine actually stored (frontmatter merge included)', async () => {
      const { store, files } = await make(new Map())
      const res = await store.write({ title: 'Note', content: 'plain body' })
      // The engine mutated the bytes (id materialized into frontmatter), but
      // the token must hash the READER's view — fm stripped, body as served.
      expect(files.get('note.md')).toContain(NOTE_ID_FRONTMATTER_KEY)
      expect(res.versionToken).toBe((await store.read(res.id!)).versionToken)
    })
  })

  it('an external move (delta remove+add, claim in the new file) resurrects the tombstoned id', async () => {
    const raw = `---\n${NOTE_ID_FRONTMATTER_KEY}: durable-id-a1\n---\n# a\n\nbody`
    const files = new Map([['demo/a.md', raw]])
    const { store } = await make(files)
    expect((await store.list())[0].id).toBe('durable-id-a1')

    // Someone moves the file on disk: the inventory diff sees remove+add, but
    // the new file still carries the claim.
    files.delete('demo/a.md')
    files.set('moved/a.md', raw)

    const events: StoreEvent[] = []
    store.subscribe((e) => events.push(e))
    await store.reconcile()

    const notes = await store.list()
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ id: 'durable-id-a1', filePath: 'moved/a.md' })

    // Publication happens only after the sweep: consumers never observe the
    // provisional identity or a false remove+add for the durable note.
    const changed = events.filter((e) => e.type === 'changed')
    expect(changed).toEqual([
      {
        type: 'changed',
        upserts: ['durable-id-a1'],
        removed: [],
        folders: ['moved'],
      },
    ])
  })

  it.each([
    ['contentless', false],
    ['contentful', true],
  ])(
    'adopts a %s external move before journaling when raw-body reads are unavailable',
    async (_name, withContent) => {
      const durableId = 'durable-id-a1'
      const raw = `---\n${NOTE_ID_FRONTMATTER_KEY}: ${durableId}\n---\n# a\n\nbody`
      const files = new Map([['demo/a.md', raw]])
      const bare = makeBareEngine(files)
      const changes = bare.engine.changes.bind(bare.engine)

      bare.engine.changes = async (cursor) => {
        const delta = await changes(cursor)

        return cursor === null
          ? delta
          : {
              ...delta,
              upserts: delta.inventory.map((meta) => ({
                meta,
                content: withContent ? '# a\n\nbody' : undefined,
              })),
            }
      }
      const revisions = new InMemoryRevisionPersistence()
      const store = new CachedStore({
        inner: bare.engine,
        revisionPersistence: revisions,
        pollIntervalMs: 0,
        relationType: 'links_to',
        now: () => new Date('2026-06-11T12:00:00Z'),
      })
      await store.start()
      const temporaryId = (await store.list())[0].id!

      await store.read(temporaryId)
      expect((await store.list())[0].id).toBe(durableId)
      files.delete('demo/a.md')
      files.set('moved/a.md', raw)
      const events: StoreEvent[] = []
      const unsubscribe = store.subscribe((event) => events.push(event))

      await store.reconcile()
      await store.settle()
      unsubscribe()

      expect(await store.list()).toMatchObject([{ id: durableId, filePath: 'moved/a.md' }])
      const page = await store.revisions(durableId, { offset: 0, limit: 10 })

      expect(page.items.map((revision) => revision.kind)).toEqual(['external'])
      expect((await store.revision(durableId, page.items[0].id))?.content).toBe('# a\n\nbody')
      expect((await store.listTrashed({ offset: 0, limit: 10 })).total).toBe(0)
      expect(
        events
          .filter((event) => event.type === 'changed')
          .every((event) => event.removed.length === 0),
      ).toBe(true)
    },
  )

  it('resolves delete identity after a transient no-raw-body read failure', async () => {
    const durableId = 'durable-id-a1'
    const raw = `---\n${NOTE_ID_FRONTMATTER_KEY}: ${durableId}\n---\n# a\n\nbody`
    const files = new Map([['demo/a.md', raw]])
    const bare = makeBareEngine(files)
    const changes = bare.engine.changes.bind(bare.engine)

    bare.engine.changes = async (cursor) => {
      const delta = await changes(cursor)

      return cursor === null
        ? delta
        : { ...delta, upserts: delta.inventory.map((meta) => ({ meta })) }
    }
    const revisions = new InMemoryRevisionPersistence()
    const store = new CachedStore({
      inner: bare.engine,
      revisionPersistence: revisions,
      pollIntervalMs: 0,
      relationType: 'links_to',
      now: () => new Date('2026-06-11T12:00:00Z'),
    })
    await store.start()
    await store.read((await store.list())[0].id!)
    files.delete('demo/a.md')
    files.set('moved/a.md', raw)
    const read = bare.engine.read.bind(bare.engine)
    let failOnce = true

    bare.engine.read = async (id, opts) => {
      if (failOnce) {
        failOnce = false
        throw new Error('transient read failure')
      }

      return read(id, opts)
    }

    await store.reconcile()
    await store.settle()

    expect(await store.list()).toMatchObject([{ id: durableId, filePath: 'moved/a.md' }])
    expect(
      (await store.revisions(durableId, { offset: 0, limit: 10 })).items.map(
        (revision) => revision.kind,
      ),
    ).toEqual(['external'])
    expect((await store.listTrashed({ offset: 0, limit: 10 })).total).toBe(0)
  })

  it('revalidates a same-day materialized id change when the raw-body sweep fails', async () => {
    const oldId = 'durable-old1'
    const newId = 'durable-new1'
    const oldRaw = `---\n${NOTE_ID_FRONTMATTER_KEY}: ${oldId}\n---\n# a\n\nold body`
    const files = new Map([['demo/a.md', oldRaw]])
    const bare = makeBareEngine(files)
    const changes = bare.engine.changes.bind(bare.engine)

    bare.engine.changes = async (cursor) => {
      const delta = await changes(cursor)

      return cursor === null
        ? delta
        : {
            ...delta,
            upserts: delta.inventory.map((meta) => ({
              meta,
              content: '# a\n\nnew body',
            })),
          }
    }
    let failSweep = false
    const revisions = new InMemoryRevisionPersistence()
    const store = new CachedStore({
      inner: bare.engine,
      revisionPersistence: revisions,
      pollIntervalMs: 0,
      relationType: 'links_to',
      readBody: async (filePath) => {
        if (failSweep) {
          failSweep = false
          throw new Error('transient raw-body failure')
        }

        return files.get(filePath) ?? null
      },
      now: () => new Date('2026-06-11T12:00:00Z'),
    })

    await store.start()
    expect(await store.list()).toMatchObject([{ id: oldId, filePath: 'demo/a.md' }])
    files.set('demo/a.md', `---\n${NOTE_ID_FRONTMATTER_KEY}: ${newId}\n---\n# a\n\nnew body`)
    failSweep = true
    await store.reconcile()
    await store.settle()

    expect(await store.list()).toMatchObject([{ id: newId, filePath: 'demo/a.md' }])
    expect(
      (await store.revisions(newId, { offset: 0, limit: 10 })).items.map(
        (revision) => revision.kind,
      ),
    ).toEqual(['external'])
    expect((await store.revisions(oldId, { offset: 0, limit: 10 })).items).toEqual([])
  })

  it('publishes both sides of a same-day identity-only raw-sweep rekey', async () => {
    const oldId = 'durable-old1'
    const newId = 'durable-new1'
    const body = '# a\n\nbody'
    const files = new Map([
      ['demo/a.md', `---\n${NOTE_ID_FRONTMATTER_KEY}: ${oldId}\n---\n${body}`],
    ])
    const bare = makeBareEngine(files)
    const changes = bare.engine.changes.bind(bare.engine)

    bare.engine.changes = async (cursor) => {
      const delta = await changes(cursor)

      return cursor === null
        ? delta
        : {
            ...delta,
            upserts: delta.inventory.map((meta) => ({ meta, content: body })),
          }
    }
    const store = new CachedStore({
      inner: bare.engine,
      pollIntervalMs: 0,
      relationType: 'links_to',
      readBody: async (filePath) => files.get(filePath) ?? null,
      now: () => new Date('2026-06-11T12:00:00Z'),
    })

    await store.start()
    const events: StoreEvent[] = []
    const unsubscribe = store.subscribe((event) => events.push(event))

    files.set('demo/a.md', `---\n${NOTE_ID_FRONTMATTER_KEY}: ${newId}\n---\n${body}`)
    await store.reconcile()
    await store.settle()
    unsubscribe()

    expect(await store.list()).toMatchObject([{ id: newId, filePath: 'demo/a.md' }])
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'changed', upserts: [newId], removed: [oldId] }),
    )
    expect((await store.syncStatus()).delta.lastChangeAt).toBe('2026-06-11T12:00:00.000Z')
  })

  it('holds mutation admission through a retried external identity read', async () => {
    const durableId = 'durable-id-a1'
    const raw = `---\n${NOTE_ID_FRONTMATTER_KEY}: ${durableId}\n---\n# a\n\nbody`
    const files = new Map([['demo/a.md', raw]])
    const bare = makeBareEngine(files)
    const changes = bare.engine.changes.bind(bare.engine)

    bare.engine.changes = async (cursor) => {
      const delta = await changes(cursor)

      return cursor === null
        ? delta
        : { ...delta, upserts: delta.inventory.map((meta) => ({ meta })) }
    }
    const revisions = new InMemoryRevisionPersistence()
    const store = new CachedStore({
      inner: bare.engine,
      revisionPersistence: revisions,
      pollIntervalMs: 0,
      relationType: 'links_to',
      now: () => new Date('2026-06-11T12:00:00Z'),
    })
    await store.start()
    await store.read((await store.list())[0].id!)
    files.delete('demo/a.md')
    files.set('moved/a.md', raw)
    const retryEntered = deferred()
    const releaseRetry = deferred()
    const read = bare.engine.read.bind(bare.engine)
    let attempt = 0

    bare.engine.read = async (id, opts) => {
      attempt++
      if (attempt === 1) {
        throw new Error('transient read failure')
      }
      const detail = await read(id, opts)

      retryEntered.resolve()
      await releaseRetry.promise
      return detail
    }
    const reconciling = store.reconcile()

    await retryEntered.promise
    const provisionalId = (await store.list()).find((note) => note.filePath === 'moved/a.md')?.id

    if (!provisionalId) {
      throw new Error('provisional note must be visible during identity resolution')
    }
    const remove = vi.spyOn(bare.engine, 'remove')
    const deletion = store.remove(provisionalId, { principal: 'test' })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(remove).not.toHaveBeenCalled()
    releaseRetry.resolve()
    await reconciling
    await deletion
    await store.settle()

    expect(await store.list()).toEqual([])
    expect((await store.listTrashed({ offset: 0, limit: 10 })).items[0]?.noteId).toBe(durableId)
  })

  it('fairly hands admission from a read to a mutation and back before a later mutation', async () => {
    const durableId = 'durable-id-a1'
    const raw = `---\n${NOTE_ID_FRONTMATTER_KEY}: ${durableId}\n---\nold body`
    const { engine, store } = await make(new Map([['demo/a.md', raw]]))
    const current = await store.read(durableId)
    const firstReadEntered = deferred()
    const releaseFirstRead = deferred()
    const read = engine.read.bind(engine)
    const writeInner = engine.write.bind(engine)
    let engineReads = 0
    let engineWrites = 0

    engine.read = async (id, opts) => {
      engineReads += 1
      if (engineReads === 1) {
        firstReadEntered.resolve()
        await releaseFirstRead.promise
      }

      return read(id, opts)
    }
    engine.write = async (input, opts) => {
      engineWrites += 1
      return writeInner(input, opts)
    }
    const firstRead = store.read(durableId)

    await firstReadEntered.promise
    const write = store.write({
      title: 'a',
      content: 'new body',
      originalId: durableId,
      versionToken: current.versionToken,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const laterRead = store.read(durableId)
    const laterWrite = store.write({ title: 'later', content: 'independent' })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(engineReads).toBe(1)
    expect(engineWrites).toBe(0)
    releaseFirstRead.resolve()
    await firstRead
    await write
    await expect(laterRead).resolves.toMatchObject({ content: 'new body' })
    await laterWrite
    expect(engineWrites).toBe(2)
  })

  it('does not let a bare read queued behind mutation admission reach a stopped engine', async () => {
    const durableId = 'durable-id-a1'
    const raw = `---\n${NOTE_ID_FRONTMATTER_KEY}: ${durableId}\n---\nold body`
    const { engine, store } = await make(new Map([['demo/a.md', raw]]))
    const current = await store.read(durableId)
    const firstReadEntered = deferred()
    const releaseFirstRead = deferred()
    const read = engine.read.bind(engine)
    let engineReads = 0

    engine.read = async (id, opts) => {
      engineReads += 1
      if (engineReads === 1) {
        firstReadEntered.resolve()
        await releaseFirstRead.promise
      }

      return read(id, opts)
    }
    const firstRead = store.read(durableId)

    await firstReadEntered.promise
    const pendingWrite = store.write({
      title: 'a',
      content: 'new body',
      originalId: durableId,
      versionToken: current.versionToken,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const lateRead = store.read(durableId)

    store.stop()
    releaseFirstRead.resolve()
    await firstRead
    await expect(pendingWrite).rejects.toMatchObject({ reason: 'engine_unavailable' })
    await expect(lateRead).rejects.toMatchObject({ reason: 'engine_unavailable' })
    await store.settle()
    expect(engineReads).toBe(1)
  })

  it('finishes a trash restore before admitting a contentless external body chase', async () => {
    const restoredId = 'durable-id-a1'
    const externalId = 'durable-id-b1'
    const files = new Map([
      ['demo/a.md', `---\n${NOTE_ID_FRONTMATTER_KEY}: ${restoredId}\n---\nrestored body`],
      ['demo/b.md', `---\n${NOTE_ID_FRONTMATTER_KEY}: ${externalId}\n---\nexternal body`],
    ])
    const bare = makeBareEngine(files)
    const changes = bare.engine.changes.bind(bare.engine)
    let deltaCalls = 0

    bare.engine.changes = async (cursor) => {
      const delta = await changes(cursor)

      if (cursor === null) {
        return delta
      }
      deltaCalls += 1
      return {
        ...delta,
        upserts: delta.inventory
          .filter((meta) => meta.filePath === 'demo/b.md')
          .map((meta) => ({ meta })),
      }
    }
    const revisions = new InMemoryRevisionPersistence()
    const store = new CachedStore({
      inner: bare.engine,
      revisionPersistence: revisions,
      pollIntervalMs: 0,
      relationType: 'links_to',
      readBody: async (filePath) => files.get(filePath) ?? null,
      now: () => new Date('2026-06-11T12:00:00Z'),
    })

    await store.start()
    await store.read(restoredId)
    await store.read(externalId)
    await store.remove(restoredId, { principal: 'test' })
    await store.settle()

    const restoreEntered = deferred()
    const releaseRestore = deferred()
    const revisionGet = revisions.get.bind(revisions)
    let gateRestore = true

    revisions.get = async (revisionId) => {
      if (gateRestore) {
        gateRestore = false
        restoreEntered.resolve()
        await releaseRestore.promise
      }

      return revisionGet(revisionId)
    }
    const read = bare.engine.read.bind(bare.engine)
    let failInlineExternalRead = true

    bare.engine.read = async (id, opts) => {
      if (
        failInlineExternalRead &&
        (id === externalId || id === 'demo/b.md' || id === permalinkOf('demo/b.md'))
      ) {
        failInlineExternalRead = false
        throw new Error('transient inline external read failure')
      }

      return read(id, opts)
    }
    const restore = store.restoreFromTrash(restoredId, { principal: 'test' })

    await restoreEntered.promise
    const reconcile = store.reconcile()

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(deltaCalls).toBe(0)
    releaseRestore.resolve()
    await expect(restore).resolves.toMatchObject({ id: restoredId })
    await reconcile
    await store.settle()

    expect((await store.read(restoredId)).content).toBe('restored body')
    expect(
      (await store.revisions(externalId, { offset: 0, limit: 10 })).items.map(
        (revision) => revision.kind,
      ),
    ).toEqual(['external'])
  })

  it('journals a queued external body chase after a user read rekeys its identity', async () => {
    const durableId = 'durable-id-a1'
    const raw = `---\n${NOTE_ID_FRONTMATTER_KEY}: ${durableId}\n---\n# a\n\nbody`
    const files = new Map([['demo/a.md', raw]])
    const bare = makeBareEngine(files)
    const changes = bare.engine.changes.bind(bare.engine)

    bare.engine.changes = async (cursor) => {
      const delta = await changes(cursor)

      return cursor === null
        ? delta
        : { ...delta, upserts: delta.inventory.map((meta) => ({ meta })) }
    }
    const revisions = new InMemoryRevisionPersistence()
    const store = new CachedStore({
      inner: bare.engine,
      revisionPersistence: revisions,
      pollIntervalMs: 0,
      relationType: 'links_to',
      now: () => new Date('2026-06-11T12:00:00Z'),
    })

    await store.start()
    await store.read((await store.list())[0].id!)
    files.delete('demo/a.md')
    files.set('moved/a.md', raw)
    const inlineEntered = deferred()
    const releaseInline = deferred()
    const read = bare.engine.read.bind(bare.engine)
    let failInline = true

    bare.engine.read = async (id, opts) => {
      if (failInline) {
        failInline = false
        inlineEntered.resolve()
        await releaseInline.promise
        throw new Error('transient inline read failure')
      }

      return read(id, opts)
    }
    const reconciling = store.reconcile()

    await inlineEntered.promise
    const provisionalId = (await store.list()).find((note) => note.filePath === 'moved/a.md')?.id

    if (!provisionalId) {
      throw new Error('provisional note must be visible during identity resolution')
    }
    const userRead = store.read(provisionalId)

    releaseInline.resolve()
    await expect(userRead).resolves.toMatchObject({ id: durableId, content: '# a\n\nbody' })
    await reconciling
    await store.settle()

    expect(
      (await store.revisions(durableId, { offset: 0, limit: 10 })).items.map(
        (revision) => revision.kind,
      ),
    ).toEqual(['external'])
    expect((await store.revisions(provisionalId, { offset: 0, limit: 10 })).items).toEqual([])
  })

  it('does not let a delayed lazy-id read resurrect a note deleted underneath it', async () => {
    const durableId = 'durable-id-a1'
    const raw = `---\n${NOTE_ID_FRONTMATTER_KEY}: ${durableId}\n---\n# a\n\nbody`
    const bare = makeBareEngine(new Map([['demo/a.md', raw]]))
    const revisions = new InMemoryRevisionPersistence()
    const store = new CachedStore({
      inner: bare.engine,
      revisionPersistence: revisions,
      pollIntervalMs: 0,
      relationType: 'links_to',
      now: () => new Date('2026-06-11T12:00:00Z'),
    })
    await store.start()
    const temporaryId = (await store.list())[0].id!
    const entered = new Promise<void>((resolve) => {
      const read = bare.engine.read.bind(bare.engine)

      bare.engine.read = async (id, opts) => {
        const detail = await read(id, opts)

        resolve()
        await release.promise
        return detail
      }
    })
    let releaseRead!: () => void
    const release = {
      promise: new Promise<void>((resolve) => {
        releaseRead = resolve
      }),
    }
    const reading = store.read(temporaryId)

    await entered
    const deletion = store.remove(temporaryId, { principal: 'test' })

    releaseRead()
    await reading
    await deletion
    await store.settle()

    expect(await store.list()).toEqual([])
    expect(
      (await store.listTrashed({ offset: 0, limit: 10 })).items.map((item) => item.noteId),
    ).toEqual([durableId])
    await expect(store.remove(durableId, { principal: 'test' })).rejects.toMatchObject({
      reason: 'note_not_found',
    })
    expect((await store.listTrashed({ offset: 0, limit: 10 })).total).toBe(1)
  })

  it('holds mutation admission when a materialized bare read discovers a new id', async () => {
    const oldId = 'durable-old1'
    const newId = 'durable-new1'
    const oldRaw = `---\n${NOTE_ID_FRONTMATTER_KEY}: ${oldId}\n---\n# a\n\nold body`
    const files = new Map([['demo/a.md', oldRaw]])
    const bare = makeBareEngine(files)
    const revisions = new InMemoryRevisionPersistence()
    const store = new CachedStore({
      inner: bare.engine,
      revisionPersistence: revisions,
      pollIntervalMs: 0,
      relationType: 'links_to',
      now: () => new Date('2026-06-11T12:00:00Z'),
    })

    await store.start()
    await store.read((await store.list())[0].id!)
    files.set('demo/a.md', `---\n${NOTE_ID_FRONTMATTER_KEY}: ${newId}\n---\n# a\n\nnew body`)
    const readEntered = deferred()
    const releaseRead = deferred()
    const read = bare.engine.read.bind(bare.engine)
    let gateRead = true

    bare.engine.read = async (id, opts) => {
      const detail = await read(id, opts)

      if (gateRead) {
        gateRead = false
        readEntered.resolve()
        await releaseRead.promise
      }

      return detail
    }
    const reading = store.read(oldId)

    await readEntered.promise
    const remove = vi.spyOn(bare.engine, 'remove')
    const deletion = store.remove(oldId, { principal: 'test' })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(remove).not.toHaveBeenCalled()
    releaseRead.resolve()
    await expect(reading).resolves.toMatchObject({ id: newId, content: '# a\n\nnew body' })
    await deletion
    await store.settle()

    expect(await store.list()).toEqual([])
    expect((await store.listTrashed({ offset: 0, limit: 10 })).items[0]?.noteId).toBe(newId)
  })

  it('expands the stable claim before adopting a bare-engine frontmatter id', async () => {
    const durableId = 'durable-id-a1'
    const raw = `---\n${NOTE_ID_FRONTMATTER_KEY}: ${durableId}\n---\n# a\n\nold body`
    const files = new Map([['a.md', raw]])
    const bare = makeBareEngine(files)
    const store = new CachedStore({
      inner: bare.engine,
      pollIntervalMs: 0,
      relationType: 'links_to',
      now: () => new Date('2026-06-11T12:00:00Z'),
    })

    await store.start()
    const temporaryId = (await store.list())[0].id!
    const writeEntered = deferred()
    const releaseWrite = deferred()
    const write = bare.engine.write.bind(bare.engine)

    bare.engine.write = async (input) => {
      if (input.id === durableId && input.directory === 'other') {
        writeEntered.resolve()
        await releaseWrite.promise
      }

      return write(input)
    }
    const forcedWrite = store.write({
      id: durableId,
      title: 'b',
      directory: 'other',
      content: 'forced body',
    })

    await writeEntered.promise
    let readSettled = false
    const lazyRead = store.read(temporaryId).then((detail) => {
      readSettled = true
      return detail
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(readSettled).toBe(false)
    releaseWrite.resolve()
    await forcedWrite
    expect(await lazyRead).toMatchObject({ id: temporaryId, content: '# a\n\nold body' })
    expect(await store.list()).toMatchObject([
      { id: temporaryId, filePath: 'a.md' },
      { id: durableId, filePath: 'other/b.md' },
    ])
  })

  it('adopts a bare-engine frontmatter id even when read also returns it as detail.id', async () => {
    const durableId = 'durable-id-a1'
    const raw = `---\n${NOTE_ID_FRONTMATTER_KEY}: ${durableId}\n---\n# a\n\nbody`
    const files = new Map([['a.md', raw]])
    const bare = makeBareEngine(files)
    const read = bare.engine.read.bind(bare.engine)

    bare.engine.read = async (id, opts) => {
      const detail = await read(id, opts)
      const claim = detail.frontmatter[NOTE_ID_FRONTMATTER_KEY]

      return { ...detail, id: typeof claim === 'string' ? claim : undefined }
    }
    const store = new CachedStore({
      inner: bare.engine,
      pollIntervalMs: 0,
      relationType: 'links_to',
      now: () => new Date('2026-06-11T12:00:00Z'),
    })

    await store.start()
    const temporaryId = (await store.list())[0].id!

    await expect(store.read(temporaryId)).resolves.toMatchObject({
      id: durableId,
      content: '# a\n\nbody',
    })
    expect(await store.list()).toMatchObject([{ id: durableId, filePath: 'a.md' }])
    await store.remove(durableId, { principal: 'test' })
    expect(await store.list()).toEqual([])
  })

  it.each([
    ['note id', false],
    ['storage path', true],
  ])('serializes a %s read with delete and same-path replacement', async (_name, byPath) => {
    const oldId = 'durable-old1'
    const newId = 'durable-new1'
    const oldRaw = `---\n${NOTE_ID_FRONTMATTER_KEY}: ${oldId}\n---\n# a\n\nold body`
    const files = new Map([['demo/a.md', oldRaw]])
    const bare = makeBareEngine(files)
    const revisions = new InMemoryRevisionPersistence()
    const store = new CachedStore({
      inner: bare.engine,
      revisionPersistence: revisions,
      pollIntervalMs: 0,
      relationType: 'links_to',
      now: () => new Date('2026-06-11T12:00:00Z'),
    })
    await store.start()
    const temporaryId = (await store.list())[0].id!
    expect(await store.read(temporaryId)).toMatchObject({ id: oldId, content: '# a\n\nold body' })
    const removeEntered = deferred()
    const releaseRemove = deferred()
    const remove = bare.engine.remove.bind(bare.engine)

    bare.engine.remove = async (id, opts) => {
      removeEntered.resolve()
      await releaseRemove.promise
      return remove(id, opts)
    }
    const deletion = store.remove(oldId, { principal: 'test' })

    await removeEntered.promise
    const replacement = store.write({
      id: newId,
      title: 'a',
      directory: 'demo',
      content: 'new body',
    })
    const concurrentRead = store.read(byPath ? 'demo/a.md' : oldId)
    const observed = concurrentRead.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )

    releaseRemove.resolve()
    await deletion
    await replacement
    const readResult = await observed

    if (byPath) {
      expect(readResult).toMatchObject({ value: { id: newId, content: 'new body' } })
    } else {
      expect(readResult).toMatchObject({ error: { reason: 'note_not_found' } })
    }
    expect(await store.list()).toMatchObject([{ id: newId, filePath: 'demo/a.md' }])
    expect(frontmatterValue(files.get('demo/a.md')!, NOTE_ID_FRONTMATTER_KEY)).toBe(newId)
  })

  it('does not pass a deleted stable id through the bare-engine resolver', async () => {
    const durableId = 'durable-old1'
    const raw = `---\n${NOTE_ID_FRONTMATTER_KEY}: ${durableId}\n---\n# old\n\nold body`
    const files = new Map([['demo/old.md', raw]])
    const bare = makeBareEngine(files)
    const store = new CachedStore({
      inner: bare.engine,
      pollIntervalMs: 0,
      relationType: 'links_to',
      now: () => new Date('2026-06-11T12:00:00Z'),
    })

    await store.start()
    const temporaryId = (await store.list())[0].id!

    await store.read(temporaryId)
    await store.remove(durableId, { principal: 'test' })
    files.set(durableId, '# unrelated\n\nother body')

    await expect(store.read(durableId)).rejects.toMatchObject({ reason: 'note_not_found' })
    await expect(store.read(durableId, { deletedView: true })).resolves.toMatchObject({
      id: durableId,
      content: '# old\n\nold body',
    })
    expect(await store.list()).toEqual([])
  })
})
