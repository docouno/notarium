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
  FRONTMATTER_BYTE_CAP,
  frontmatterValue,
  InMemoryRevisionPersistence,
  type KnowledgeStore,
  liveSyncStatus,
  NOTE_ID_FRONTMATTER_KEY,
  type NoteMeta,
  slugify,
  upsertFrontmatterKey,
  type WriteInput,
} from '@notarium/core'

import { InMemoryIdentity } from '../fake-server/identity'

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
  const persistence = new InMemoryIdentity()
  return { persistence, durable: persistence.rows }
}

/** Wrap a twin so one identity write can be held open or made to fail. Both
 *  channels are covered on purpose: a minted id becomes durable through
 *  claimMany, an observed frontmatter claim through settleFileClaim. */
const gateIdentity = (
  persistence: InMemoryIdentity,
  gate: (ids: readonly string[]) => Promise<void>,
): InMemoryIdentity => {
  const claimMany = persistence.claimMany.bind(persistence)
  const settleFileClaim = persistence.settleFileClaim.bind(persistence)

  persistence.claimMany = async (records) => {
    await gate(records.map((record) => record.id))
    return claimMany(records)
  }
  persistence.settleFileClaim = async (claim) => {
    await gate([claim.observedId])
    return settleFileClaim(claim)
  }

  return persistence
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

  it('isolates an oversized raw identity claim without blocking boot or unrelated writes', async () => {
    const oversizedClaim = 'AAAAAAAAAAAA'
    const { store } = await make(
      new Map([
        [
          'demo/oversized.md',
          `---\n${NOTE_ID_FRONTMATTER_KEY}: ${oversizedClaim}\nopaque: ${'x'.repeat(FRONTMATTER_BYTE_CAP)}\n---\nbody`,
        ],
        ['demo/healthy.md', '# healthy\n\nbody'],
      ]),
    )

    expect((await store.syncStatus()).scan.phase).toBe('ready')
    expect((await store.list()).find((note) => note.filePath === 'demo/oversized.md')?.id).not.toBe(
      oversizedClaim,
    )

    const created = await store.write({ title: 'Independent', content: 'body' })

    expect(created.id).toMatch(NOTE_ID_RE)
    expect((await store.list()).some((note) => note.filePath === 'independent.md')).toBe(true)
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

  it('publishes an ordinary create only after its global identity route is durable', async () => {
    const files = new Map<string, string>()
    const bare = makeBareEngine(files)
    const persistence = new InMemoryIdentity()
    const durable = persistence.rows
    const flushEntered = deferred()
    const releaseFlush = deferred()

    gateIdentity(persistence, async () => {
      flushEntered.resolve()
      await releaseFlush.promise
    })
    const store = new CachedStore({
      inner: bare.engine,
      identityPersistence: persistence,
      pollIntervalMs: 0,
      relationType: 'links_to',
      readBody: async (fp) => files.get(fp) ?? null,
      now: () => new Date('2026-06-11T12:00:00Z'),
    })
    await store.start()
    const published: Array<{ id: string; durable: boolean }> = []

    store.subscribe((event) => {
      if (event.type === 'changed') {
        for (const id of event.upserts) {
          published.push({ id, durable: durable.has(id) })
        }
      }
    })
    const writing = store.write({ title: 'Ordered Create', content: 'body' })

    await flushEntered.promise
    expect(published).toEqual([])
    releaseFlush.resolve()
    const result = await writing

    expect(published).toEqual([{ id: result.id!, durable: true }])
    store.stop()
    await store.settle()
  })

  it('does not publish an ordinary create when identity durability fails', async () => {
    const files = new Map<string, string>()
    const bare = makeBareEngine(files)
    const persistence = gateIdentity(new InMemoryIdentity(), async () => {
      throw new Error('meta db unavailable')
    })
    const store = new CachedStore({
      inner: bare.engine,
      identityPersistence: persistence,
      pollIntervalMs: 0,
      relationType: 'links_to',
      readBody: async (fp) => files.get(fp) ?? null,
      now: () => new Date('2026-06-11T12:00:00Z'),
    })
    await store.start()
    const events: StoreEvent[] = []

    store.subscribe((event) => events.push(event))
    await expect(store.write({ title: 'Unpublished Create', content: 'body' })).rejects.toThrow(
      'meta db unavailable',
    )

    expect(events.filter((event) => event.type === 'changed')).toEqual([])
    store.stop()
    await store.settle()
  })

  it('blocks concurrent list and search from a create until its route is durable', async () => {
    const files = new Map<string, string>()
    const bare = makeBareEngine(files)
    bare.engine.search = async () =>
      [...files.keys()].map((filePath) => ({ filePath, title: 'Ordered Create', snippet: 'body' }))
    const persistence = new InMemoryIdentity()
    const durable = persistence.rows
    const flushEntered = deferred()
    const releaseFlush = deferred()
    let gate = false
    const claimMany = persistence.claimMany.bind(persistence)

    persistence.claimMany = async (records) => {
      if (gate && records.some((record) => record.filePath === 'ordered-create.md')) {
        gate = false
        flushEntered.resolve()
        await releaseFlush.promise
      }

      return claimMany(records)
    }
    const store = new CachedStore({
      inner: bare.engine,
      identityPersistence: persistence,
      pollIntervalMs: 0,
    })

    await store.start()
    gate = true
    const writing = store.write({ title: 'Ordered Create', content: 'body' })

    await flushEntered.promise
    let listSettled = false
    let searchSettled = false
    let previewSettled = false
    let historySettled = false
    const pendingId = frontmatterValue(files.get('ordered-create.md')!, NOTE_ID_FRONTMATTER_KEY)!
    const listing = store.list().then((notes) => {
      listSettled = true
      return notes
    })
    const searching = store.search('ordered').then((hits) => {
      searchSettled = true
      return hits
    })
    const previewing = store.preview(pendingId).then((preview) => {
      previewSettled = true
      return preview
    })
    const history = store.revisionsSince(null, 10).then((result) => {
      historySettled = true
      return result
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(listSettled).toBe(false)
    expect(searchSettled).toBe(false)
    expect(previewSettled).toBe(false)
    expect(historySettled).toBe(false)
    expect(durable.size).toBe(0)
    releaseFlush.resolve()
    const created = await writing

    expect(await listing).toContainEqual(expect.objectContaining({ id: created.id }))
    expect(await searching).toContainEqual(expect.objectContaining({ id: created.id }))
    expect(await previewing).toMatchObject({ snippet: 'body' })
    await history
    expect(historySettled).toBe(true)
    expect(durable.has(created.id!)).toBe(true)
    store.stop()
    await store.settle()
  })

  it('blocks the poll listDirs window until its provisional id is durable', async () => {
    const files = new Map<string, string>()
    const bare = makeBareEngine(files)
    const persistence = new InMemoryIdentity()
    const durable = persistence.rows
    const store = new CachedStore({
      inner: bare.engine,
      identityPersistence: persistence,
      pollIntervalMs: 0,
    })

    await store.start()
    files.set('external.md', '# external')
    const dirsEntered = deferred()
    const releaseDirs = deferred()

    bare.engine.listDirs = async () => {
      dirsEntered.resolve()
      await releaseDirs.promise
      return []
    }
    const reconciling = store.reconcile()

    await dirsEntered.promise
    let settled = false
    const listing = store.list().then((notes) => {
      settled = true
      return notes
    })

    await Promise.resolve()
    expect(settled).toBe(false)
    expect(durable.size).toBe(0)
    releaseDirs.resolve()
    await reconciling
    const external = (await listing).find((note) => note.filePath === 'external.md')

    expect(external?.id).toBeTruthy()
    expect(durable.has(external!.id!)).toBe(true)
    store.stop()
    await store.settle()
  })

  it('keeps a bulk-created id off list until an interactive durability flush completes', async () => {
    const files = new Map<string, string>()
    const bare = makeBareEngine(files)
    const persistence = new InMemoryIdentity()
    const durable = persistence.rows
    const flushEntered = deferred()
    const releaseFlush = deferred()
    let gate = false

    gateIdentity(persistence, async () => {
      if (gate) {
        gate = false
        flushEntered.resolve()
        await releaseFlush.promise
      }
    })
    const store = new CachedStore({
      inner: bare.engine,
      identityPersistence: persistence,
      pollIntervalMs: 0,
    })

    await store.start()
    store.beginBulk()
    gate = true
    const created = await store.write({ title: 'Bulk Pending', content: 'body' })
    let settled = false
    const listing = store.list().then((notes) => {
      settled = true
      return notes
    })

    await flushEntered.promise
    expect(settled).toBe(false)
    expect(durable.has(created.id!)).toBe(false)
    releaseFlush.resolve()
    expect(await listing).toContainEqual(expect.objectContaining({ id: created.id }))
    expect(durable.has(created.id!)).toBe(true)
    await store.endBulk()
    store.stop()
    await store.settle()
  })

  it('auto-retry publishes a repair for a create whose first durability flush failed', async () => {
    const files = new Map<string, string>()
    const bare = makeBareEngine(files)
    const persistence = new InMemoryIdentity()
    const durable = persistence.rows
    let healthy = false

    gateIdentity(persistence, async () => {
      if (!healthy) {
        throw new Error('meta down')
      }
    })
    const store = new CachedStore({
      inner: bare.engine,
      identityPersistence: persistence,
      pollIntervalMs: 0,
    })

    await store.start()
    const changed: StoreEvent[] = []

    store.subscribe((event) => {
      if (event.type === 'changed') {
        changed.push(event)
      }
    })
    await expect(store.write({ title: 'Repair Create', content: 'body' })).rejects.toThrow(
      'meta down',
    )
    const id = frontmatterValue(files.get('repair-create.md')!, NOTE_ID_FRONTMATTER_KEY)!

    expect(changed).toEqual([])
    healthy = true
    await vi.waitFor(() => expect(durable.has(id)).toBe(true), { timeout: 2_000 })
    await vi.waitFor(
      () =>
        expect(changed).toContainEqual(
          expect.objectContaining({ type: 'changed', upserts: expect.arrayContaining([id]) }),
        ),
      { timeout: 2_000 },
    )
    store.stop()
    await store.settle()
  })

  it('a failed lazy claim settlement changes nothing; the next read adopts (#327)', async () => {
    const durableId = 'durable-id-a1'
    const raw = `---\n${NOTE_ID_FRONTMATTER_KEY}: ${durableId}\n---\n# a\n\nbody`
    const files = new Map([['a.md', raw]])
    const bare = makeBareEngine(files)
    const persistence = new InMemoryIdentity()
    const durable = persistence.rows
    const settleFileClaim = persistence.settleFileClaim.bind(persistence)
    let rejectDurable = false

    persistence.settleFileClaim = async (claim) => {
      if (rejectDurable && claim.observedId === durableId) {
        throw new Error('meta down')
      }

      return settleFileClaim(claim)
    }
    const store = new CachedStore({
      inner: bare.engine,
      identityPersistence: persistence,
      pollIntervalMs: 0,
      // No readBody: force the P→D adoption through the lazy read path.
    })

    await store.start()
    const provisionalId = (await store.list())[0].id!
    const changed: StoreEvent[] = []

    store.subscribe((event) => {
      if (event.type === 'changed') {
        changed.push(event)
      }
    })
    rejectDurable = true
    // Arbitration precedes every map mutation, so a refused settlement leaves
    // NOTHING half-adopted — no snapshot rekey to repair, no event to withhold.
    await expect(store.read(provisionalId)).rejects.toThrow('meta down')
    expect(changed).toEqual([])
    expect(durable.has(durableId)).toBe(false)
    // The fence stays shut while the claim is unanswered: a surface would
    // otherwise serve a provisional id whose durable owner is still unknown.
    await expect(store.list()).rejects.toThrow('meta down')

    rejectDurable = false
    await expect(store.read(provisionalId)).resolves.toMatchObject({
      id: durableId,
      filePath: 'a.md',
    })
    expect(durable.has(durableId)).toBe(true)
    expect(changed).toContainEqual(
      expect.objectContaining({
        type: 'changed',
        upserts: expect.arrayContaining([durableId]),
        removed: expect.arrayContaining([provisionalId]),
      }),
    )
    store.stop()
    await store.settle()
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

    revisions.get = async (space, revisionId) => {
      if (gateRestore) {
        gateRestore = false
        restoreEntered.resolve()
        await releaseRestore.promise
      }

      return revisionGet(space, revisionId)
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

  it('retires the refused spelling to subscribers when a minted id turns out to be foreign', async () => {
    // The registry re-mints an id another space durably owns and hands the read-model
    // both spellings. The old one was already published, so the event that announces
    // the new id must retire it — otherwise a client keeps a note under an id that
    // resolves to nothing, and only a reload clears it.
    const files = new Map<string, string>()
    const bare = makeBareEngine(files)
    const persistence = new InMemoryIdentity()
    const claimMany = persistence.claimMany.bind(persistence)
    let refuseNext = false

    const refused: string[] = []

    persistence.claimMany = async (records) => {
      if (!refuseNext) {
        return claimMany(records)
      }
      refuseNext = false
      refused.push(...records.map((r) => r.id))

      return records.map((r) => ({
        id: r.id,
        status: 'foreign-owner' as const,
        owner: { ...r, space: 'other' },
      }))
    }
    const store = new CachedStore({
      inner: bare.engine,
      identityPersistence: persistence,
      pollIntervalMs: 0,
      relationType: 'links_to',
      readBody: async (fp) => files.get(fp) ?? null,
      now: () => new Date('2026-06-11T12:00:00Z'),
    })

    await store.start()
    const events: StoreEvent[] = []

    store.subscribe((event) => events.push(event))
    // The flush that claims this note's freshly minted id is the one that learns the
    // id is another space's.
    refuseNext = true
    files.set('a.md', '# a\n\nbody')
    await store.checkpoint()

    const reminted = (await store.list())[0].id!

    // The read-model followed the registry: the note is published under the id that
    // survived, the refused spelling never reached a subscriber, and it still resolves
    // to the note rather than 404ing a client that raced the repair.
    expect(refused).toHaveLength(1)
    expect(refused[0]).not.toBe(reminted)
    expect(await store.read(refused[0])).toMatchObject({ id: reminted })
    expect(
      events.some((event) => event.type === 'changed' && event.upserts.includes(reminted)),
    ).toBe(true)
    expect(
      events.every((event) => event.type !== 'changed' || !event.upserts.includes(refused[0])),
    ).toBe(true)
  })

  it('drains an unsettled claim under the mutation claim, whichever side reaches it (#327)', async () => {
    // The drain re-keys the snapshot and can rewrite a file, so it belongs under the
    // global mutation claim — and it takes that claim ITSELF rather than trusting each
    // entry point to remember. This pins the unclaimed side: a read surface recovers
    // identity here, and while it does, no mutation may start alongside it.
    const durableId = 'durable-id-d1'
    const raw = `---\n${NOTE_ID_FRONTMATTER_KEY}: ${durableId}\n---\n# d\n\nbody`
    const files = new Map([['d.md', raw]])
    const bare = makeBareEngine(files)
    let failSettlement = false
    let held: ReturnType<typeof deferred> | null = null
    let announceEntry: (() => void) | null = null
    const persistence = gateIdentity(new InMemoryIdentity(), async (ids) => {
      if (!ids.includes(durableId)) {
        return
      }
      if (failSettlement) {
        throw new Error('meta down')
      }
      if (held) {
        announceEntry?.()
        await held.promise
      }
    })
    const store = new CachedStore({
      inner: bare.engine,
      identityPersistence: persistence,
      pollIntervalMs: 0,
    })

    await store.start()
    const provisionalId = (await store.list())[0].id!

    failSettlement = true
    await expect(store.read(provisionalId)).rejects.toThrow('meta down')
    failSettlement = false

    held = deferred()
    const entered = new Promise<void>((resolve) => {
      announceEntry = resolve
    })
    const recovering = store.list()

    await entered
    const writing = store.write({ title: 'other', content: 'x' })

    await new Promise((tick) => setTimeout(tick, 20))
    expect(bare.writes).toEqual([])

    held.resolve()
    await recovering
    await writing
    expect(bare.writes).toHaveLength(1)
    store.stop()
    await store.settle()
  })

  it('re-enters the drain from a caller already holding the claim (#327)', async () => {
    // The other side of the same rule. The claim is NOT re-entrant and its queue is
    // fair, so a drain that took it unconditionally would queue behind the very
    // caller that reached it and never return. The read below is that caller: it
    // adopts a frontmatter id under its own claim, and the assertion is simply that
    // it finishes.
    const durableId = 'durable-id-e1'
    const raw = `---\n${NOTE_ID_FRONTMATTER_KEY}: ${durableId}\n---\n# e\n\nbody`
    const files = new Map([['e.md', raw]])
    const bare = makeBareEngine(files)
    let failSettlement = false
    const persistence = gateIdentity(new InMemoryIdentity(), async (ids) => {
      if (failSettlement && ids.includes(durableId)) {
        throw new Error('meta down')
      }
    })
    const store = new CachedStore({
      inner: bare.engine,
      identityPersistence: persistence,
      pollIntervalMs: 0,
    })

    await store.start()
    const provisionalId = (await store.list())[0].id!

    failSettlement = true
    await expect(store.read(provisionalId)).rejects.toThrow('meta down')
    failSettlement = false

    // A deadline, not a hang: the failure mode this guards against is waiting
    // forever, and a suite that hangs reports nothing.
    await expect(
      Promise.race([
        store.read(provisionalId),
        new Promise((_, fail) =>
          setTimeout(() => fail(new Error('the drain queued behind its own caller')), 2_000),
        ),
      ]),
    ).resolves.toMatchObject({ id: durableId, filePath: 'e.md' })
    store.stop()
    await store.settle()
  })

  it('settles the queue of the id it is about to retire, not only the observed claim', async () => {
    // The settlement transaction re-keys the note's journal chain onto the winning
    // id. An append still queued under the id it retires would land AFTER that
    // move — stranded on a tombstone, invisible to the note it belongs to. Draining
    // the observed claim alone does not reach it: that queue is keyed by the id the
    // path carries NOW.
    const durableId = 'durable-id-a1'
    const body = (text: string) => `# a\n\n${text}`
    const files = new Map([['a.md', body('body')]])
    const bare = makeBareEngine(files)
    const changes = bare.engine.changes.bind(bare.engine)

    // The fake engine reports no upserts of its own; every poll after boot hands
    // the inventory over so an external edit is seen.
    bare.engine.changes = async (cursor) => {
      const delta = await changes(cursor)

      return cursor === null
        ? delta
        : { ...delta, upserts: delta.inventory.map((meta) => ({ meta })) }
    }
    const { persistence } = makeIdentityPersistence()
    const revisions = new InMemoryRevisionPersistence()
    const store = new CachedStore({
      inner: bare.engine,
      identityPersistence: persistence,
      revisionPersistence: revisions,
      pollIntervalMs: 0,
      relationType: 'links_to',
      readBody: async (fp) => files.get(fp) ?? null,
      now: () => new Date('2026-06-11T12:00:00Z'),
    })

    await store.start()
    const autoId = (await store.list())[0].id!

    // Hold the note's queued append open …
    const order: string[] = []
    const appendEntered = deferred()
    const releaseAppend = deferred()
    const append = revisions.append.bind(revisions)

    revisions.append = async (rev, content) => {
      appendEntered.resolve()
      await releaseAppend.promise
      const stored = await append(rev, content)

      order.push(`append:${rev.noteId}`)
      return stored
    }
    // A save through us: it journals fire-and-forget and releases the note's
    // mutation claim, so nothing but the drain stands between that queue and the
    // settlement.
    await store.write({ id: autoId, title: 'a', content: body('edited here') })
    await appendEntered.promise

    // … and only then let the file claim an id, which retires the one that queue
    // belongs to.
    const settleFileClaim = persistence.settleFileClaim.bind(persistence)

    persistence.settleFileClaim = async (claim) => {
      order.push(`settle:${claim.observedId}`)
      return settleFileClaim(claim)
    }
    files.set('a.md', `---\n${NOTE_ID_FRONTMATTER_KEY}: ${durableId}\n---\n${body('edited here')}`)
    const reconciling = store.reconcile()

    await new Promise((tick) => setTimeout(tick, 20))
    expect(order).toEqual([])

    releaseAppend.resolve()
    await reconciling
    await store.settle()

    // The append is on the RETIRED id's chain, so it has to land before the
    // transaction that moves that chain — after it, the row is stranded on a
    // tombstone. (The state journaled under the winning id afterwards is the
    // ordinary external append, and it follows.)
    expect(order.lastIndexOf(`append:${autoId}`)).toBeLessThan(order.indexOf(`settle:${durableId}`))
    expect(order.slice(0, 2)).toEqual([`append:${autoId}`, `settle:${durableId}`])
    expect((await store.list())[0].id).toBe(durableId)
  })

  it('announces a lazy provisional-id rekey only after its global route is durable', async () => {
    const durableId = 'durable-id-a1'
    const raw = `---\n${NOTE_ID_FRONTMATTER_KEY}: ${durableId}\n---\n# a\n\nbody`
    const files = new Map([['a.md', raw]])
    const bare = makeBareEngine(files)
    const { persistence, durable } = makeIdentityPersistence()
    const settleFileClaim = persistence.settleFileClaim.bind(persistence)
    let rejectDurable = false

    persistence.settleFileClaim = async (claim) => {
      if (rejectDurable && claim.observedId === durableId) {
        throw new Error('meta db unavailable')
      }

      return settleFileClaim(claim)
    }
    const store = new CachedStore({
      inner: bare.engine,
      identityPersistence: persistence,
      pollIntervalMs: 0,
      relationType: 'links_to',
      // No raw-body capability: the frontmatter id is discovered lazily by read().
      now: () => new Date('2026-06-11T12:00:00Z'),
    })

    await store.start()
    const provisionalId = (await store.list())[0].id!
    const changed: StoreEvent[] = []

    store.subscribe((event) => {
      if (event.type === 'changed') {
        // The callback itself is the publication boundary: the global route must
        // already answer by the time any client can observe the new id.
        expect(durable.has(durableId)).toBe(true)
        changed.push(event)
      }
    })
    rejectDurable = true
    await expect(store.read(provisionalId)).rejects.toThrow('meta db unavailable')
    expect(durable.has(durableId)).toBe(false)
    expect(changed).toEqual([])

    rejectDurable = false
    await expect(store.read(provisionalId)).resolves.toMatchObject({
      id: durableId,
      filePath: 'a.md',
    })
    expect(changed).toContainEqual(
      expect.objectContaining({ type: 'changed', upserts: [durableId], removed: [provisionalId] }),
    )
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
