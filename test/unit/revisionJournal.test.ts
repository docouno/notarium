// The revision journal (#12) through its stable boundary: the production
// composition CachedStore(engine) + RevisionJournal. Pinned against the spec:
// every save journals a 'write' revision chained by baseRevisionId; the FIRST
// edit of a pre-existing note captures the found state as an 'external'
// baseline (even the first edit has a "before"); no-op saves and the delta
// echoing our own write back produce NO revisions (sha-256 dedup); external
// states, deletes and restores are journaled with their kinds; restore goes
// through the CAS path — a stale token 409s and journals nothing.

import { describe, expect, it, vi } from 'vitest'
import { CachedStore, InMemoryRevisionPersistence, sha256Hex } from '@notarium/core'
import type { Revision, RevisionInput, StoreDelta } from '@notarium/core'
import { InMemoryStore, type StoreSnapshot } from '@notarium/engine-memory'

const FIXTURE: StoreSnapshot = {
  space: 'main',
  now: '2026-06-10T12:00:00.000Z',
  notes: [
    {
      title: 'Titanium',
      filePath: 'demo/titanium.md',
      content: 'original body',
      modifiedAt: '2026-06-01T00:00:00.000Z',
      createdAt: '2026-06-01T10:00:00Z',
      tags: ['metal'],
    },
  ],
}
const TITANIUM = 'fake-demo-titanium'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const gateTrashPage = (persistence: InMemoryRevisionPersistence) => {
  const entered = deferred()
  const release = deferred()
  const listTrashed = persistence.listTrashed.bind(persistence)
  let gated = true

  persistence.listTrashed = async (space, opts, excludeClasses) => {
    if (gated) {
      gated = false
      entered.resolve()
      await release.promise
    }

    return listTrashed(space, opts, excludeClasses)
  }

  return { entered: entered.promise, release: release.resolve }
}

const make = async (inner = new InMemoryStore(FIXTURE)) => {
  const persistence = new InMemoryRevisionPersistence()
  const store = new CachedStore({
    inner,
    revisionPersistence: persistence,
    space: 'main',
    pollIntervalMs: 0,
    relationType: 'links_to',
    now: () => new Date('2026-06-12T12:00:00Z'),
  })
  await store.start()
  return { inner, store, persistence }
}

const timeline = async (store: CachedStore, id: string) =>
  (await store.revisions(id, { offset: 0, limit: 100 })).items

describe('revision journal (#12) — write-through', () => {
  it("the first edit journals the found state as an 'external' baseline, then the write", async () => {
    const { store } = await make()
    const { versionToken } = await store.read(TITANIUM)
    await store.write({
      title: 'Titanium',
      directory: 'demo',
      content: 'edited body',
      tags: ['metal'],
      originalId: TITANIUM,
      versionToken,
      principal: 'ui',
    })
    await store.settle()

    const revs = await timeline(store, TITANIUM)
    expect(revs.map((r) => r.kind)).toEqual(['write', 'external']) // newest first
    const [write, baseline] = revs
    expect(baseline.principal).toBeNull()
    expect(baseline.baseRevisionId).toBeNull()
    expect(baseline.contentHash).toBe(await sha256Hex('original body'))
    expect(write.principal).toBe('ui')
    expect(write.baseRevisionId).toBe(baseline.id) // the chain
    expect(write.title).toBe('Titanium')
    expect(write.tags).toEqual(['metal'])
    // The blob round-trips through the detail surface.
    const detail = await store.revision(TITANIUM, write.id)
    expect(detail?.content).toBe('edited body')
  })

  it('a brand-new note journals one write revision, no baseline', async () => {
    const { store } = await make()
    const res = await store.write({
      title: 'Fresh',
      directory: 'demo',
      content: 'fresh body',
      principal: 'ui',
    })
    await store.settle()
    const revs = await timeline(store, res.id!)
    expect(revs.map((r) => r.kind)).toEqual(['write'])
    expect(revs[0].baseRevisionId).toBeNull()
  })

  it('a no-op save journals nothing; a title-only rename IS a revision', async () => {
    const { store } = await make()
    const first = await store.read(TITANIUM)
    const r1 = await store.write({
      title: 'Titanium',
      directory: 'demo',
      content: 'edited body',
      tags: ['metal'],
      originalId: TITANIUM,
      versionToken: first.versionToken,
    })
    // Save again, identical state — chained on the fresh token (#50 save→save).
    await store.write({
      title: 'Titanium',
      directory: 'demo',
      content: 'edited body',
      tags: ['metal'],
      originalId: TITANIUM,
      versionToken: r1.versionToken,
    })
    await store.settle()
    expect((await timeline(store, TITANIUM)).map((r) => r.kind)).toEqual(['write', 'external'])

    // Same content, new title — the state changed, the journal must say so.
    const r2 = await store.write({
      title: 'Titanium Alloy',
      directory: 'demo',
      content: 'edited body',
      tags: ['metal'],
      originalId: TITANIUM,
      versionToken: r1.versionToken,
    })
    expect(r2.id).toBe(TITANIUM)
    await store.settle()
    const revs = await timeline(store, TITANIUM)
    expect(revs[0].kind).toBe('write')
    expect(revs[0].title).toBe('Titanium Alloy')
  })
})

describe('revision journal (#12) — external states from the delta', () => {
  const withScriptedDelta = async () => {
    const inner = new InMemoryStore(FIXTURE)
    const feed = inner.changes.bind(inner)
    let next: StoreDelta | null = null

    inner.changes = async (cursor) => {
      const d = next ?? (await feed(cursor))
      next = null
      return d
    }
    const made = await make(inner)
    return { ...made, setDelta: (d: StoreDelta) => (next = d) }
  }

  it('an upsert with content journals an external revision; the echo of our own write does not', async () => {
    const { inner, store, setDelta } = await withScriptedDelta()
    // Someone edits behind our back (through the engine directly).
    const live = await inner.read(TITANIUM)
    await inner.write({
      title: 'Titanium',
      directory: 'demo',
      content: 'changed outside',
      tags: ['metal'],
      originalId: TITANIUM,
      versionToken: live.versionToken,
    })
    const meta = (await inner.list()).find((n) => n.id === TITANIUM)!
    setDelta({
      cursor: 'c2',
      inventory: await inner.list(),
      upserts: [{ meta, content: 'changed outside', tags: ['metal'] }],
    })
    await store.reconcile()
    await store.settle()

    const revs = await timeline(store, TITANIUM)
    expect(revs.map((r) => r.kind)).toEqual(['external'])
    expect(revs[0].principal).toBeNull()
    expect(revs[0].contentHash).toBe(await sha256Hex('changed outside'))

    // The next poll re-reports the same state (a reindex echo) — deduped.
    setDelta({
      cursor: 'c3',
      inventory: await inner.list(),
      upserts: [{ meta, content: 'changed outside', tags: ['metal'] }],
    })
    await store.reconcile()
    await store.settle()
    expect(await timeline(store, TITANIUM)).toHaveLength(1)
  })

  it('an upsert without content chases the body in the background; a failed read leaves an honest gap marker', async () => {
    const { inner, store, setDelta } = await withScriptedDelta()
    const meta = (await inner.list()).find((n) => n.id === TITANIUM)!

    // 1) body fetch succeeds → a full external revision.
    setDelta({ cursor: 'c2', inventory: await inner.list(), upserts: [{ meta }] })
    await store.reconcile()
    await vi.waitFor(async () => {
      expect((await timeline(store, TITANIUM)).map((r) => r.kind)).toEqual(['external'])
    })
    expect((await timeline(store, TITANIUM))[0].contentHash).toBe(await sha256Hex('original body'))

    // 2) the engine can't serve the body → the gap is explicit, not silent.
    const realRead = inner.read.bind(inner)

    inner.read = async (id: string) => {
      if (id === TITANIUM || id.includes('titanium')) {
        throw new Error('engine down')
      }

      return realRead(id)
    }
    await inner.write({ title: 'Other', directory: 'demo', content: 'noise' }) // bump nothing relevant
    setDelta({
      cursor: 'c3',
      inventory: await inner.list(),
      upserts: [{ meta: { ...meta, title: 'Titanium' } }],
    })
    await store.reconcile()
    await vi.waitFor(async () => {
      const revs = await timeline(store, TITANIUM)
      expect(revs[0].contentHash).toBeNull()
      expect(revs[0].kind).toBe('external')
    })
  })

  it('a note gone from the inventory journals a delete tombstone carrying the last known hash', async () => {
    const { inner, store, setDelta } = await withScriptedDelta()
    // History exists first (so the tombstone has a hash to carry).
    const meta = (await inner.list()).find((n) => n.id === TITANIUM)!
    setDelta({
      cursor: 'c2',
      inventory: await inner.list(),
      upserts: [{ meta, content: 'original body', tags: ['metal'] }],
    })
    await store.reconcile()
    await store.settle()

    await inner.remove(TITANIUM)
    setDelta({ cursor: 'c3', inventory: await inner.list(), upserts: [] })
    await store.reconcile()
    await store.settle()

    const revs = await timeline(store, TITANIUM)
    expect(revs.map((r) => r.kind)).toEqual(['delete', 'external'])
    expect(revs[0].principal).toBeNull()
    expect(revs[0].contentHash).toBe(await sha256Hex('original body'))
  })

  it('holds an external live transition behind a bulk trash-prefix mutation', async () => {
    const { inner, persistence, store, setDelta } = await withScriptedDelta()
    const gate = gateTrashPage(persistence)
    const blocker = store.purgeTrash({ all: true })
    await gate.entered
    const meta = (await inner.list()).find((note) => note.id === TITANIUM)!

    setDelta({
      cursor: 'c2',
      inventory: await inner.list(),
      upserts: [{ meta, content: 'external while bulk is paging', tags: ['metal'] }],
    })
    await store.reconcile()
    // A quiet inventory-only poll replaces its snapshot metadata object but is
    // not a newer external state transition; the queued observation must live.
    setDelta({ cursor: 'c3', inventory: await inner.list(), upserts: [] })
    await store.reconcile()
    expect(await timeline(store, TITANIUM)).toEqual([])

    gate.release()
    await blocker
    await vi.waitFor(async () => {
      expect((await timeline(store, TITANIUM)).map((revision) => revision.kind)).toEqual([
        'external',
      ])
    })
  })

  it('settle waits for external journal work queued behind the trash coordinator', async () => {
    const { inner, persistence, store, setDelta } = await withScriptedDelta()
    const gate = gateTrashPage(persistence)
    const blocker = store.purgeTrash({ all: true })

    await gate.entered
    const meta = (await inner.list()).find((note) => note.id === TITANIUM)!
    setDelta({
      cursor: 'c2',
      inventory: await inner.list(),
      upserts: [{ meta, content: 'durable external body', tags: ['metal'] }],
    })
    await store.reconcile()
    let settled = false
    const settling = store.settle().then(() => {
      settled = true
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    expect(await timeline(store, TITANIUM)).toEqual([])

    gate.release()
    await blocker
    await settling
    expect((await timeline(store, TITANIUM)).map((revision) => revision.kind)).toEqual(['external'])
  })

  it('does not let a contentless external body chase hide a following local tombstone', async () => {
    const { inner, store, setDelta } = await withScriptedDelta()
    const entered = deferred()
    const release = deferred()
    const read = inner.read.bind(inner)
    let gated = true

    inner.read = async (id) => {
      if (gated && (id === TITANIUM || id.includes('titanium'))) {
        gated = false
        entered.resolve()
        await release.promise
      }

      return read(id)
    }
    const meta = (await inner.list()).find((note) => note.id === TITANIUM)!
    setDelta({ cursor: 'c2', inventory: await inner.list(), upserts: [{ meta }] })
    await store.reconcile()
    await entered.promise
    const deletion = store.remove(TITANIUM, { principal: 'ui' })

    release.resolve()
    await deletion
    await store.settle()

    expect((await timeline(store, TITANIUM)).map((revision) => revision.kind)).toEqual([
      'delete',
      'external',
    ])
    expect((await store.listTrashed({ offset: 0, limit: 10 })).items[0]?.noteId).toBe(TITANIUM)
  })

  it('drops a queued external tombstone when a later reconcile re-adds the note', async () => {
    const { inner, persistence, store, setDelta } = await withScriptedDelta()
    const gate = gateTrashPage(persistence)
    const blocker = store.purgeTrash({ all: true })
    await gate.entered

    setDelta({ cursor: 'c2', inventory: [], upserts: [] })
    await store.reconcile()
    const inventory = await inner.list()
    const meta = inventory.find((note) => note.id === TITANIUM)!
    setDelta({
      cursor: 'c3',
      inventory,
      upserts: [{ meta, content: 're-added outside', tags: ['metal'] }],
    })
    await store.reconcile()

    gate.release()
    await blocker
    await vi.waitFor(async () => {
      expect((await timeline(store, TITANIUM)).map((revision) => revision.kind)).toEqual([
        'external',
      ])
    })
    expect((await store.listTrashed({ offset: 0, limit: 10 })).total).toBe(0)
  })
})

describe('revision journal (#12) — delete and restore', () => {
  it('remove() through us journals an attributed delete', async () => {
    const { store } = await make()
    await store.remove(TITANIUM, { principal: 'ui' })
    await store.settle()
    const revs = await timeline(store, TITANIUM)
    expect(revs.map((r) => r.kind)).toEqual(['delete'])
    expect(revs[0].principal).toBe('ui')
    expect(revs[0].title).toBe('Titanium')
  })

  it('restore writes the revision state back through CAS and journals kind=restore with provenance', async () => {
    const { store } = await make()
    const first = await store.read(TITANIUM)
    await store.write({
      title: 'Titanium v2',
      directory: 'demo',
      content: 'second body',
      tags: ['metal', 'v2'],
      originalId: TITANIUM,
      versionToken: first.versionToken,
      principal: 'ui',
    })
    await store.settle()
    const baseline = (await timeline(store, TITANIUM)).find((r) => r.kind === 'external')!

    const live = await store.read(TITANIUM)
    const res = await store.restore({
      id: TITANIUM,
      revisionId: baseline.id,
      versionToken: live.versionToken!,
      principal: 'ui',
    })
    expect(res.id).toBe(TITANIUM)
    await store.settle()

    const revs = await timeline(store, TITANIUM)
    expect(revs[0].kind).toBe('restore')
    expect(revs[0].sourceRevisionId).toBe(baseline.id)
    expect(revs[0].principal).toBe('ui')
    // The note is genuinely back: original title, body and tags.
    const after = await store.read(TITANIUM)
    expect(after.content).toBe('original body')
    expect(after.title).toBe('Titanium')
    // Content-addressing: the restored state reuses the baseline's blob hash.
    expect(revs[0].contentHash).toBe(baseline.contentHash)
  })

  it('restore with a stale token 409s through the CAS path and journals nothing new', async () => {
    const { store } = await make()
    const first = await store.read(TITANIUM)
    await store.write({
      title: 'Titanium',
      directory: 'demo',
      content: 'second body',
      originalId: TITANIUM,
      versionToken: first.versionToken,
    })
    await store.settle()
    const before = (await timeline(store, TITANIUM)).length
    const baseline = (await timeline(store, TITANIUM)).find((r) => r.kind === 'external')!

    await expect(
      store.restore({
        id: TITANIUM,
        revisionId: baseline.id,
        versionToken: first.versionToken!, // stale — the write above moved the note
      }),
    ).rejects.toMatchObject({ isConflict: true, reason: 'version_conflict' })
    await store.settle()
    expect(await timeline(store, TITANIUM)).toHaveLength(before)
  })

  it("restore of a gap marker (no content) is the caller's error; an alien revision id is not found", async () => {
    const { store, persistence } = await make()
    const marker = await persistence.append(
      {
        noteId: TITANIUM,
        space: 'main',
        baseRevisionId: null,
        theirRevisionId: null,
        sourceRevisionId: null,
        kind: 'external',
        principal: null,
        contentHash: null,
        title: 'Titanium',
        class: null,
        slug: null,
        tags: [],
        createdAt: '2026-06-12T11:00:00Z',
        charsAdded: null,
        charsRemoved: null,
      },
      null,
    )
    await expect(
      store.restore({ id: TITANIUM, revisionId: marker.id, versionToken: 'v1:x' }),
    ).rejects.toMatchObject({ isToolError: true, reason: 'revision_has_no_content' })
    // A revision can only be addressed through its own note.
    await expect(
      store.restore({ id: 'some-other-note', revisionId: marker.id, versionToken: 'v1:x' }),
    ).rejects.toMatchObject({ isNotFound: true, reason: 'revision_not_found' })
    expect(await store.revision('some-other-note', marker.id)).toBeNull()
  })
})

describe('trash (#79) — the journal view + undelete', () => {
  it('a deleted note appears in the trash with its last folder, restorable', async () => {
    const { store } = await make()
    await store.remove(TITANIUM, { principal: 'ui' })
    await store.settle()
    const { items, total, restorableTotal } = await store.listTrashed!({ offset: 0, limit: 50 })
    expect(total).toBe(1)
    expect(restorableTotal).toBe(1)
    expect(items[0]).toMatchObject({
      noteId: TITANIUM,
      title: 'Titanium',
      filePath: 'demo/titanium.md', // last known folder, from the identity tombstone
      principal: 'ui',
    })
    // read-before-delete captured the body → a blob exists → restorable.
    expect(items[0].contentHash).not.toBeNull()
  })

  it('restoreFromTrash resurrects the note with its id, folder and body; it leaves the trash', async () => {
    const { store } = await make()
    await store.remove(TITANIUM, { principal: 'ui' })
    await store.settle()

    const res = await store.restoreFromTrash!(TITANIUM, { principal: 'ui' })
    expect(res.id).toBe(TITANIUM)
    expect(res.filePath).toBe('demo/titanium.md')
    await store.settle()

    // genuinely back: same id, body and folder
    const after = await store.read(TITANIUM)
    expect(after.content).toBe('original body')
    // newest revision is a 'restore' chained off the delete tombstone → out of trash
    expect((await timeline(store, TITANIUM))[0].kind).toBe('restore')
    const { total } = await store.listTrashed!({ offset: 0, limit: 50 })
    expect(total).toBe(0)
  })

  it('restoreTrash is best-effort: restores what it can and reports stale ids per item (#184)', async () => {
    const { store } = await make()
    await store.write({ title: 'Cobalt', directory: 'demo', content: 'c', principal: 'ui' })
    await store.settle()
    await store.remove(TITANIUM, { principal: 'ui' })
    await store.remove('fake-demo-cobalt', { principal: 'ui' })
    await store.settle()

    const batch = await store.restoreTrash!({
      ids: [TITANIUM, 'fake-demo-cobalt', 'no-such-note'],
      principal: 'ui',
    })
    expect(batch.restored.map((r) => r.id).sort()).toEqual(['fake-demo-cobalt', TITANIUM])
    expect(batch.failed).toMatchObject([{ id: 'no-such-note', reason: 'note_not_in_trash' }])
    expect((await store.listTrashed!({ offset: 0, limit: 50 })).total).toBe(0)
  })

  it('restoreTrash supports all+q, mirroring purge and the select-all-N UI (#184)', async () => {
    const { store } = await make()
    await store.write({ title: 'Carbon notes', directory: 'demo', content: 'c', principal: 'ui' })
    await store.write({ title: 'Cobalt log', directory: 'demo', content: 'c', principal: 'ui' })
    await store.settle()
    await store.remove('fake-demo-carbon-notes', { principal: 'ui' })
    await store.remove('fake-demo-cobalt-log', { principal: 'ui' })
    await store.settle()

    const batch = await store.restoreTrash!({
      all: true,
      q: 'carbon',
      onlyRestorable: true,
      principal: 'ui',
    })
    expect(batch.restored.map((r) => r.id)).toEqual(['fake-demo-carbon-notes'])
    expect(batch.failed).toEqual([])
    const trash = await store.listTrashed!({ offset: 0, limit: 50 })
    expect(trash.total).toBe(1)
    expect(trash.items[0].noteId).toBe('fake-demo-cobalt-log')
  })

  it('restoreTrash(all+q+onlyRestorable) skips honest-gap tombstones instead of counting them in the batch', async () => {
    const { store, persistence } = await make()
    const gap = await persistence.append(
      {
        noteId: 'gap-note',
        space: 'main',
        baseRevisionId: null,
        theirRevisionId: null,
        sourceRevisionId: null,
        kind: 'delete',
        principal: null,
        contentHash: null,
        title: 'Gap note',
        class: null,
        slug: null,
        tags: [],
        createdAt: '2026-06-12T11:00:00Z',
        charsAdded: null,
        charsRemoved: null,
      },
      null,
    )
    void gap
    await store.remove(TITANIUM, { principal: 'ui' })
    await store.settle()

    const trash = await store.listTrashed!({ offset: 0, limit: 50, scope: 'all' })
    expect(trash.total).toBe(2)
    expect(trash.restorableTotal).toBe(1)
    const batch = await store.restoreTrash!({
      all: true,
      onlyRestorable: true,
      scope: 'all',
      principal: 'ui',
    })
    expect(batch.restored.map((r) => r.id)).toEqual([TITANIUM])
    expect(batch.failed).toEqual([])
    const after = await store.listTrashed!({ offset: 0, limit: 50, scope: 'all' })
    expect(after.total).toBe(1)
    expect(after.items[0].noteId).toBe('gap-note')
    expect(after.restorableTotal).toBe(0)
  })

  it('restoreTrash(all+onlyRestorable) paginates by scanned rows, not kept ids (#184 regression)', async () => {
    const { store, persistence } = await make()
    const ids: string[] = []

    for (let i = 0; i < 500; i++) {
      const r = await store.write({
        title: `Bulk ${String(i).padStart(3, '0')}`,
        directory: 'demo',
        content: `body ${i}`,
        principal: 'ui',
      })

      if (!r.id) {
        throw new Error('write result must include an id')
      }
      ids.push(r.id)
    }
    await store.settle()
    for (const id of ids) {
      await store.remove(id, { principal: 'ui' })
    }
    await store.settle()
    await persistence.append(
      {
        noteId: 'gap-tail',
        space: 'main',
        baseRevisionId: null,
        theirRevisionId: null,
        sourceRevisionId: null,
        kind: 'delete',
        principal: null,
        contentHash: null,
        title: 'Gap tail',
        class: null,
        slug: null,
        tags: [],
        createdAt: '2026-06-12T11:30:00Z',
        charsAdded: null,
        charsRemoved: null,
      },
      null,
    )

    const trash = await store.listTrashed!({ offset: 0, limit: 50, scope: 'all' })
    expect(trash.total).toBe(501)
    expect(trash.restorableTotal).toBe(500)
    const batch = await store.restoreTrash!({
      all: true,
      onlyRestorable: true,
      scope: 'all',
      principal: 'ui',
    })
    expect(batch.restored).toHaveLength(500)
    expect(batch.failed).toEqual([])
    const after = await store.listTrashed!({ offset: 0, limit: 50, scope: 'all' })
    expect(after.total).toBe(1)
    expect(after.items[0].noteId).toBe('gap-tail')
    expect(after.restorableTotal).toBe(0)
  }, 15_000)

  it('restoring an id that is not trashed is the caller’s error', async () => {
    const { store } = await make()
    await expect(store.restoreFromTrash!(TITANIUM)).rejects.toMatchObject({
      isNotFound: true,
      reason: 'note_not_in_trash',
    })
  })

  it('purge erases the journal rows and GCs the now-orphan blob', async () => {
    const { store, persistence } = await make()
    await store.remove(TITANIUM, { principal: 'ui' })
    await store.settle()
    const tomb = (await store.listTrashed!({ offset: 0, limit: 50 })).items[0]
    expect(await persistence.content(tomb.contentHash!)).not.toBeNull()

    const { purged } = await store.purgeTrash!({ ids: [TITANIUM] })
    expect(purged).toBe(1)
    // gone from the trash AND from history; the orphan blob is collected.
    expect((await store.listTrashed!({ offset: 0, limit: 50 })).total).toBe(0)
    expect(await timeline(store, TITANIUM)).toHaveLength(0)
    expect(await persistence.content(tomb.contentHash!)).toBeNull()
  })

  it('empty trash (no id) purges every trashed note in scope at once', async () => {
    const { store } = await make()
    // create a second note so two land in the trash
    await store.write({ title: 'Cobalt', directory: 'demo', content: 'c', principal: 'ui' })
    await store.settle()
    await store.remove(TITANIUM, { principal: 'ui' })
    await store.remove('fake-demo-cobalt', { principal: 'ui' })
    await store.settle()
    expect((await store.listTrashed!({ offset: 0, limit: 50 })).total).toBe(2)

    const { purged } = await store.purgeTrash!({ all: true })
    expect(purged).toBe(2)
    expect((await store.listTrashed!({ offset: 0, limit: 50 })).total).toBe(0)
  })

  it('listTrashed filters by title (q) — the trash search (#79)', async () => {
    const { store } = await make()
    await store.write({ title: 'Carbon notes', directory: 'demo', content: 'c', principal: 'ui' })
    await store.write({ title: 'Cobalt log', directory: 'demo', content: 'c', principal: 'ui' })
    await store.settle()
    await store.remove('fake-demo-carbon-notes', { principal: 'ui' })
    await store.remove('fake-demo-cobalt-log', { principal: 'ui' })
    await store.settle()
    const all = await store.listTrashed!({ offset: 0, limit: 50 })
    expect(all.total).toBe(2)
    const hit = await store.listTrashed!({ offset: 0, limit: 50, q: 'carbon' })
    expect(hit.total).toBe(1)
    expect(hit.items[0].title).toBe('Carbon notes')
    // case-insensitive, and a literal % is escaped (matches nothing, not all)
    expect((await store.listTrashed!({ offset: 0, limit: 50, q: 'COBALT' })).total).toBe(1)
    expect((await store.listTrashed!({ offset: 0, limit: 50, q: '%' })).total).toBe(0)
  })

  it('read({deletedView}) of a trashed note serves its last state; a plain read misses (#79)', async () => {
    const { store } = await make()
    await store.remove(TITANIUM, { principal: 'ui' })
    await store.settle()
    // The deleted-view is OPT-IN: the note-open path asks for it...
    const view = await store.read(TITANIUM, { deletedView: true })
    expect(view.deleted).toBe(true)
    expect(view.restorable).toBe(true)
    expect(view.content).toBe('original body') // last body, from the CAS
    expect(view.deletedByPrincipal).toBe('ui')
    // ...but a DISCOVERY read (preview/previews) must still miss on a deleted note,
    // not resurrect its snippet onto the Feed/cards.
    await expect(store.read(TITANIUM)).rejects.toBeTruthy()
    // a genuinely-unknown id throws even with the opt-in (no fake deleted view)
    await expect(store.read('no-such-note', { deletedView: true })).rejects.toBeTruthy()
  })

  it('hidden classes never surface in the user trash (#78), but scope:all sees them', async () => {
    const { store } = await make()
    await store.write({
      title: 'Secret',
      content: 'agent note',
      targetClass: 'agent-memory',
      principal: 'ui',
    })
    await store.settle()
    const memId = (await store.list({ scope: 'all' })).find((n) => n.title === 'Secret')!.id!
    await store.remove(memId, { principal: 'ui' })
    await store.remove(TITANIUM, { principal: 'ui' })
    await store.settle()

    // default user scope hides the agent-memory tombstone
    const user = await store.listTrashed!({ offset: 0, limit: 50 })
    expect(user.total).toBe(1)
    expect(user.items[0].noteId).toBe(TITANIUM)
    // scope:all admits it
    const all = await store.listTrashed!({ offset: 0, limit: 50, scope: 'all' })
    expect(all.total).toBe(2)
  })

  it('a principal-less delete (external) is journaled as such — the trash carries no author', async () => {
    const { store } = await make()
    await store.remove(TITANIUM) // no principal
    await store.settle()
    const item = (await store.listTrashed!({ offset: 0, limit: 50 })).items[0]
    expect(item.principal).toBeNull()
  })

  it('restore/purge never cross a space boundary on a SHARED journal (#79 review)', async () => {
    // The meta-DB journal is one table partitioned by `space`; here two spaces
    // share one persistence (production reality). A caller addressing another
    // space's deleted note by raw id must NOT be able to restore or purge it.
    const persistence = new InMemoryRevisionPersistence()
    const mk = (space: string, notes: StoreSnapshot['notes']) =>
      new CachedStore({
        inner: new InMemoryStore({ space, now: FIXTURE.now, notes }),
        revisionPersistence: persistence, // SHARED across spaces
        space,
        pollIntervalMs: 0,
        relationType: 'links_to',
        now: () => new Date('2026-06-12T12:00:00Z'),
      })
    const note = {
      content: 'top secret',
      modifiedAt: FIXTURE.now,
      createdAt: '2026-06-01T10:00:00Z',
      tags: [],
    }
    const a = mk('a', [{ title: 'A note', filePath: 'a.md', ...note }])
    const b = mk('b', [{ title: 'Secret', filePath: 'demo/secret.md', ...note }])
    await Promise.all([a.start(), b.start()])
    await b.remove('fake-demo-secret', { principal: 'ui' })
    await b.settle()

    // it's in B's trash, not A's
    expect((await b.listTrashed!({ offset: 0, limit: 50 })).total).toBe(1)
    expect((await a.listTrashed!({ offset: 0, limit: 50 })).total).toBe(0)
    // restoring B's id via space A is rejected (anti-enumeration: not-in-trash)
    await expect(a.restoreFromTrash!('fake-demo-secret')).rejects.toMatchObject({
      reason: 'note_not_in_trash',
    })
    // purging B's id via space A erases NOTHING — B's tombstone stays recoverable
    expect((await a.purgeTrash!({ ids: ['fake-demo-secret'] })).purged).toBe(0)
    expect((await b.listTrashed!({ offset: 0, limit: 50 })).total).toBe(1)
  })
})

describe('journal slug-fidelity (#124) — a custom slug survives restore', () => {
  it('the slug is journaled on write, carried on the delete tombstone, and re-set on restore', async () => {
    const { store } = await make()
    const first = await store.read(TITANIUM)
    // A custom slug that diverges from slug(title) — the kind that used to be lost.
    await store.write({
      title: 'Titanium',
      directory: 'demo',
      content: 'body with a custom slug',
      slug: 'ti-custom',
      originalId: TITANIUM,
      versionToken: first.versionToken,
      principal: 'ui',
    })
    await store.settle()
    // The write revision carries the slug as a column; the snapshot mirrors it.
    expect((await timeline(store, TITANIUM))[0].slug).toBe('ti-custom')
    expect((await store.list()).find((n) => n.id === TITANIUM)!.slug).toBe('ti-custom')

    await store.remove(TITANIUM, { principal: 'ui' })
    await store.settle()
    // The delete tombstone keeps the slug (so the trash can resurrect it faithfully).
    expect((await timeline(store, TITANIUM))[0].slug).toBe('ti-custom')

    await store.restoreFromTrash!(TITANIUM, { principal: 'ui' })
    await store.settle()
    // Restored with its custom slug — NOT dropped to slug(title) (the #124 regression).
    expect((await store.list()).find((n) => n.id === TITANIUM)!.slug).toBe('ti-custom')
    expect((await timeline(store, TITANIUM))[0].slug).toBe('ti-custom')
  })

  it('an inbound [[custom-slug]] re-resolves after restore re-parses the linker', async () => {
    const inner = new InMemoryStore({
      space: 'main',
      now: '2026-06-10T12:00:00.000Z',
      notes: [
        { title: 'Titanium', filePath: 'demo/titanium.md', content: 'target body' },
        { title: 'Linker', filePath: 'demo/linker.md', content: 'see [[ti-custom]]' },
      ],
    })
    const { store } = await make(inner)
    const TI = 'fake-demo-titanium'
    const LINK = 'fake-demo-linker'
    // Give the target a custom slug → the linker's [[ti-custom]] resolves to it.
    const first = await store.read(TI)
    await store.write({
      title: 'Titanium',
      directory: 'demo',
      content: 'target body',
      slug: 'ti-custom',
      originalId: TI,
      versionToken: first.versionToken,
    })
    await store.settle()
    expect((await store.graph()).links.some((l) => l.source === LINK && l.target === TI)).toBe(true)

    // Delete then restore from the trash.
    await store.remove(TI)
    await store.settle()
    await store.restoreFromTrash!(TI)
    await store.settle()

    // Re-parse the linker (an edit re-derives its edges against the live index): the
    // [[ti-custom]] resolves ONLY because the restored note re-acquired its slug.
    const lk = await store.read(LINK)
    await store.write({
      title: 'Linker',
      directory: 'demo',
      content: 'see [[ti-custom]] still',
      originalId: LINK,
      versionToken: lk.versionToken,
    })
    await store.settle()
    const g = await store.graph()
    expect(g.links.some((l) => l.source === LINK && l.target === TI)).toBe(true)
    expect(g.nodes.find((n) => n.id === TI)?.ghost).toBeFalsy()
  })

  it('a within-session rename→delete→restore re-derives the old title as an alias (phase 0)', async () => {
    const inner = new InMemoryStore({
      space: 'main',
      now: '2026-06-10T12:00:00.000Z',
      notes: [{ title: 'Alpha', filePath: 'demo/alpha.md', content: 'body' }],
    })
    const { store } = await make(inner)
    const id = (await store.list())[0].id!
    // Rename WITHIN this session (the note's old title is in the journal, never in
    // the boot pastNames snapshot — exactly the phase 0 window).
    const first = await store.read(id)
    await store.write({
      title: 'Beta',
      directory: 'demo',
      content: 'body',
      originalId: id,
      versionToken: first.versionToken,
    })
    await store.settle()
    await store.remove(id)
    await store.settle()
    await store.restoreFromTrash!(id)
    await store.settle()
    // The resurrected note re-derived its old title from the journal — no reboot
    // needed (pastNames was reloaded on restore).
    expect((await store.list()).find((n) => n.id === id)?.aliases).toContain('Alpha')
  })

  it('a body-only edit carries the custom slug forward in the journal', async () => {
    const { store } = await make()
    const first = await store.read(TITANIUM)
    const w1 = await store.write({
      title: 'Titanium',
      directory: 'demo',
      content: 'b1',
      slug: 'keep-me',
      originalId: TITANIUM,
      versionToken: first.versionToken,
    })
    await store.settle()
    // Edit the BODY only — the write doesn't address slug (undefined → carry forward).
    await store.write({
      title: 'Titanium',
      directory: 'demo',
      content: 'b2 changed',
      originalId: TITANIUM,
      versionToken: w1.versionToken,
    })
    await store.settle()
    // The latest revision still carries the slug, and the note kept it.
    expect((await timeline(store, TITANIUM))[0].slug).toBe('keep-me')
    expect((await store.list()).find((n) => n.id === TITANIUM)!.slug).toBe('keep-me')
  })

  it('a slug-only change records a revision (slug is in the dedup key)', async () => {
    const { store } = await make()
    const first = await store.read(TITANIUM)
    const w1 = await store.write({
      title: 'Titanium',
      directory: 'demo',
      content: 'same body',
      slug: 'slug-one',
      originalId: TITANIUM,
      versionToken: first.versionToken,
    })
    await store.settle()
    const before = (await timeline(store, TITANIUM)).length
    // Change ONLY the slug — same body, title, tags. Pre-#124 this deduped to a no-op.
    await store.write({
      title: 'Titanium',
      directory: 'demo',
      content: 'same body',
      slug: 'slug-two',
      originalId: TITANIUM,
      versionToken: w1.versionToken,
    })
    await store.settle()
    const after = await timeline(store, TITANIUM)
    expect(after.length).toBe(before + 1)
    expect(after[0].slug).toBe('slug-two')
  })

  it('a history rollback re-sets a recorded slug but never silently clears a live one', async () => {
    const { store } = await make()
    const first = await store.read(TITANIUM)
    // The baseline of the fixture note carries no custom slug (slug null).
    const w1 = await store.write({
      title: 'Titanium',
      directory: 'demo',
      content: 'with slug A',
      slug: 'slug-a',
      originalId: TITANIUM,
      versionToken: first.versionToken,
    })
    await store.settle()
    const revA = (await timeline(store, TITANIUM)).find((r) => r.slug === 'slug-a')!
    // Move to a different slug.
    await store.write({
      title: 'Titanium',
      directory: 'demo',
      content: 'with slug B',
      slug: 'slug-b',
      originalId: TITANIUM,
      versionToken: w1.versionToken,
    })
    await store.settle()
    expect((await store.list()).find((n) => n.id === TITANIUM)!.slug).toBe('slug-b')

    // Roll back to the 'slug-a' revision → the recorded slug is restored.
    const live = await store.read(TITANIUM)
    await store.restore({ id: TITANIUM, revisionId: revA.id, versionToken: live.versionToken! })
    await store.settle()
    expect((await store.list()).find((n) => n.id === TITANIUM)!.slug).toBe('slug-a')

    // Now roll back to the baseline (no recorded slug, null) → the live slug is LEFT
    // untouched (a rollback never silently clears a slug the timeline doesn't show).
    const baseline = (await timeline(store, TITANIUM)).find((r) => r.kind === 'external')!
    expect(baseline.slug).toBeNull()
    const live2 = await store.read(TITANIUM)
    await store.restore({
      id: TITANIUM,
      revisionId: baseline.id,
      versionToken: live2.versionToken!,
    })
    await store.settle()
    expect((await store.list()).find((n) => n.id === TITANIUM)!.slug).toBe('slug-a')
  })
})

describe('revision journal (#12) — the window surface', () => {
  it('revisions() windows newest-first with an honest total', async () => {
    const { store } = await make()
    let token = (await store.read(TITANIUM)).versionToken

    for (let i = 1; i <= 4; i++) {
      const r = await store.write({
        title: 'Titanium',
        directory: 'demo',
        content: `body v${i}`,
        tags: ['metal'],
        originalId: TITANIUM,
        versionToken: token,
      })
      token = r.versionToken
    }
    await store.settle()
    // 4 writes + 1 baseline.
    const page = await store.revisions(TITANIUM, { offset: 1, limit: 2 })
    expect(page.total).toBe(5)
    expect(page.items).toHaveLength(2)
    const detail = await store.revision(TITANIUM, page.items[0].id)
    expect(detail?.content).toBe('body v3')
  })
})

// A journal whose append can be DELAYED — either by a global lag (the append lands
// on a later macrotask, the production reality the hot save path relies on: the row
// settles AFTER the write's 200) or by a per-note manual gate (block one note's
// append indefinitely). Both reproduce the #238 race deterministically, without
// leaning on parallel-file scheduling (how it flakes in the full suite).
class SlowRevisionPersistence extends InMemoryRevisionPersistence {
  private readonly gates = new Map<string, Promise<void>>()
  /** Mutable so a test can settle earlier appends fast, THEN arm the lag to hold
   *  only the next (e.g. the human) append back — reproducing the exact #238 shape
   *  where an EARLIER revision is settled while a LATER one is still queued. */
  lagMs: number
  constructor(lagMs = 0) {
    super()
    this.lagMs = lagMs
  }
  /** Block every append for `noteId` until the returned opener is called. */
  gate(noteId: string): () => void {
    let open!: () => void
    this.gates.set(noteId, new Promise<void>((r) => (open = r)))
    return open
  }
  async append(rev: RevisionInput, content: string | null): Promise<Revision> {
    const g = this.gates.get(rev.noteId)

    if (g) {
      await g
    }
    if (this.lagMs) {
      await new Promise((r) => setTimeout(r, this.lagMs))
    }

    return super.append(rev, content)
  }
}

const makeWith = async (persistence: InMemoryRevisionPersistence) => {
  const store = new CachedStore({
    inner: new InMemoryStore(FIXTURE),
    revisionPersistence: persistence,
    space: 'main',
    pollIntervalMs: 0,
    relationType: 'links_to',
    now: () => new Date('2026-06-12T12:00:00Z'),
  })
  await store.start()
  return store
}

describe('revision journal (#12) — read-after-write on a fire-and-forget append (#238)', () => {
  it('a still-pending human write wins over the SETTLED agent revision — the exact #238 mis-attribution', async () => {
    // The precise #238 shape: an agent creates/edits a note (PAT) and that revision
    // FULLY SETTLES; then a human edits the SAME note through the UI. The human append
    // is fire-and-forget, so its 200 returns before the row lands — while the agent's
    // row is already on disk. A non-draining read of "the latest SETTLED revision"
    // therefore surfaces the AGENT (pat:alice) as the author: the mis-attribution.
    const persistence = new SlowRevisionPersistence()
    const store = await makeWith(persistence)
    const first = await store.read(TITANIUM)
    const agent = await store.write({
      title: 'Titanium',
      directory: 'demo',
      content: 'v1 by the agent',
      tags: ['metal'],
      originalId: TITANIUM,
      versionToken: first.versionToken,
      principal: 'pat:alice:tok',
    })
    await store.settle() // the agent's revision is now the newest SETTLED one on disk
    persistence.lagMs = 30 // from here, only the human's append lands late (the race window)
    await store.write({
      title: 'Titanium',
      directory: 'demo',
      content: 'v2 by the human',
      tags: ['metal'],
      originalId: TITANIUM,
      versionToken: agent.versionToken,
      principal: 'user:alice',
    })
    // NO settle() — mimic the HTTP boundary: the human save returned 200, its append
    // is still queued behind the lag while the agent's is settled. WITHOUT the drain,
    // revisions() reads the settled agent → 'pat:alice'. WITH it, it awaits the human.
    const latest = (await store.revisions(TITANIUM, { offset: 0, limit: 1 })).items[0]
    expect(latest.principal).toBe('user:alice') // the human, not the agent's settled write
    expect(latest.kind).toBe('write')
    await store.settle()
  })

  it('drains only the read note — a stuck append on ANOTHER note never gates the read', async () => {
    // Per-note drain, not global: note A's journal append is blocked indefinitely,
    // yet a read of a DIFFERENT note B resolves at once. A global drain would hang
    // here (and couple every provenance read to the whole journal's backlog).
    const persistence = new SlowRevisionPersistence()
    const store = await makeWith(persistence)
    const openA = persistence.gate(TITANIUM) // freeze A's whole chain (baseline + write)
    const a = await store.read(TITANIUM)
    await store.write({
      title: 'Titanium',
      directory: 'demo',
      content: 'A edit (append stuck)',
      tags: ['metal'],
      originalId: TITANIUM,
      versionToken: a.versionToken,
      principal: 'user:alice',
    })
    // A brand-new, ungated note B.
    const b = await store.write({
      title: 'Beryllium',
      directory: 'demo',
      content: 'B body',
      principal: 'user:bob',
    })
    // Reading B's revisions settles B's queue only — it must NOT block on A's gate.
    const bRev = (await store.revisions(b.id!, { offset: 0, limit: 1 })).items[0]
    expect(bRev.principal).toBe('user:bob')
    // Cleanup: release A and settle so no chain is left dangling.
    openA()
    await store.settle()
    expect((await store.revisions(TITANIUM, { offset: 0, limit: 1 })).items[0].principal).toBe(
      'user:alice',
    )
  })
})
