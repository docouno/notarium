// The revision journal (#12) through its stable boundary: the production
// composition CachedStore(engine) + RevisionJournal. Pinned against the spec:
// every save journals a 'write' revision chained by baseRevisionId; the FIRST
// edit of a pre-existing note captures the found state as an 'external'
// baseline (even the first edit has a "before"); no-op saves and the delta
// echoing our own write back produce NO revisions (sha-256 dedup); external
// states, deletes and restores are journaled with their kinds; restore goes
// through the CAS path — a stale token 409s and journals nothing.

import { describe, expect, it, vi } from 'vitest'
import {
  analyzeDocumentState,
  bindStorageOwnerProof,
  CachedStore,
  claudeConversationSourceLocator,
  decodeDocumentState,
  encodeDocumentState,
  IMPORT_SOURCE_FRONTMATTER_KEY,
  InMemoryRevisionPersistence,
  logicalNoteState,
  parseFrontmatterLines,
  revisionGapOf,
  RevisionJournal,
  sha256Hex,
} from '@notarium/core'
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
  it('a required restore keeps its provenance over an identical external observer row', async () => {
    const persistence = new InMemoryRevisionPersistence()
    const journal = new RevisionJournal({ persistence, space: 'main' })
    const logicalState = logicalNoteState({ title: 'Observed restore', body: 'same state' })
    const state = {
      noteId: 'observed-restore',
      principal: null,
      content: 'same state',
      logicalState,
      title: 'Observed restore',
      class: 'user-doc',
      tags: [] as string[],
      slug: null,
    }
    const deleted = await journal.record({ ...state, kind: 'delete' })

    await journal.record({ ...state, kind: 'external' })
    const restored = await journal.recordRequired({
      ...state,
      kind: 'restore',
      principal: 'ui',
      sourceRevisionId: deleted!.id,
    })
    const rows = await journal.list('observed-restore', { offset: 0, limit: 10 })

    expect(restored).toMatchObject({
      kind: 'restore',
      principal: 'ui',
      sourceRevisionId: deleted!.id,
    })
    expect(rows.items.map((revision) => revision.kind)).toEqual(['restore', 'external', 'delete'])
  })

  it("refuses a stored blob it can no longer project with the journal's own vocabulary", async () => {
    const persistence = new InMemoryRevisionPersistence()
    const journal = new RevisionJournal({ persistence, space: 'main' })
    // This row is CONSTRUCTED, and it has to be — no path in this tree writes one.
    // Every producer of a proof binds it over the SAME buffer it then analyses
    // (`notariumStore` on write and on read, `restoreCoordinator` twice,
    // `inMemoryStore`), so a blob is self-consistent the moment it is written, and
    // stays so however the file was decoded: the BOM fix moved `raw`, never `source`.
    //
    // What DOES produce one is the single thing one tree cannot hold — two analyzers.
    // The codec proves a stored header against a FRESH reading of that row's own
    // source, so a reader that has since learned to lay those bytes out differently
    // stops reproducing what the writer of the day recorded, and no retry ever will.
    // The claim below is moved off its field to stand in for exactly that, by the
    // narrowest mechanism there is: `validateProof` keeps a claim only on an EXACT
    // field-range match, so a claim that matches none is dropped, the re-derived
    // fingerprint becomes the one of a document with no claims, and it cannot equal
    // the fingerprint stored beside it. The SIZE of the move carries nothing — any
    // offset that misses the field does this — and nothing else about the fixture is
    // load-bearing either.
    //
    // The subject is not the refusal. It is the JOURNAL's answer to a refusal: the
    // vocabulary its readers already handle, rather than the codec's raw throw, which
    // reached the one reader that maps errors to a status as an unclassified fault and
    // turned an ordinary request for an old revision into a 500.
    const source = new TextEncoder().encode('---\nnotarium-id: AbCdefGhij_1\ntitle: A\n---\nbody\n')
    const proof = bindStorageOwnerProof({
      source,
      owners: [{ key: 'notarium-id', ownership: 'value' }],
      evidence: { kind: 'mutation-receipt', id: 'receipt-pre-upgrade' },
    })
    const state = analyzeDocumentState({ source, ownerProof: proof, pathFallbackTitle: 'a' })
    const offField = (range: { start: number; end: number }) => ({
      start: range.start - 1,
      end: range.end - 1,
    })

    // The claim this fixture moves is a real one: without it the blob would be
    // self-consistent and there would be nothing for the journal to answer for.
    expect(state.provenance.claims).toHaveLength(1)
    const preUpgrade = encodeDocumentState({
      ...state,
      provenance: {
        ...state.provenance,
        claims: state.provenance.claims.map((claim) => ({
          ...claim,
          valueRange: offField(claim.valueRange),
          entryRange: offField(claim.entryRange),
        })),
      },
    })

    // The premise, asserted rather than assumed: the codec refuses THIS blob, and for
    // the stated reason — not because the envelope is malformed or truncated. Without
    // it a fixture that quietly stopped drifting would leave the arc below passing on
    // an error the journal never had to translate.
    expect(() => decodeDocumentState(preUpgrade)).toThrowError(/does not match its source/u)
    const appended = await persistence.append(
      {
        noteId: 'drifted-proof-note',
        space: 'main',
        baseRevisionId: null,
        theirRevisionId: null,
        sourceRevisionId: null,
        kind: 'write',
        entryRole: 'origin',
        principal: 'ui',
        contentHash: await sha256Hex(preUpgrade),
        semanticFingerprint: state.semanticFingerprint,
        restoreSafety: state.restoreSafety.status,
        stateFormat: state.format,
        title: 'A',
        class: 'user-doc',
        slug: null,
        tags: [],
        createdAt: '2026-06-12T11:00:00Z',
        charsAdded: null,
        charsRemoved: null,
      },
      preUpgrade,
    )

    await expect(journal.detail('drifted-proof-note', appended.id)).rejects.toMatchObject({
      reason: 'revision_has_no_content',
      isToolError: true,
    })
  })

  it('deduplicates receipt lineage and proven owner-value churn by semantic fingerprint', async () => {
    const persistence = new InMemoryRevisionPersistence()
    const journal = new RevisionJournal({ persistence, space: 'main' })

    const stateOf = (id: string, receipt: string) => {
      const source = new TextEncoder().encode(`---\nnotarium-id: ${id}\ntitle: Stable\n---\nbody`)
      const proof = bindStorageOwnerProof({
        source,
        owners: [{ key: 'notarium-id', ownership: 'value' }],
        evidence: { kind: 'mutation-receipt', id: receipt },
      })
      return analyzeDocumentState({ source, ownerProof: proof, pathFallbackTitle: 'stable' })
    }
    const first = stateOf('one', 'receipt-a')
    const equivalent = stateOf('two', 'receipt-b')
    const input = {
      noteId: 'fingerprint-dedup',
      kind: 'external' as const,
      principal: null,
      content: 'body',
      title: 'Stable',
      class: 'user-doc',
      tags: [] as string[],
      slug: null,
    }

    expect(first.semanticFingerprint).toBe(equivalent.semanticFingerprint)
    expect(await journal.record({ ...input, documentState: first })).not.toBeNull()
    expect(await journal.record({ ...input, documentState: equivalent })).toBeNull()
    expect((await journal.list(input.noteId, { offset: 0, limit: 10 })).total).toBe(1)
  })

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
    const baselineDetail = await store.revision(TITANIUM, baseline.id)
    expect(baseline.stateFormat).toBe('markdown-v2')
    expect(baselineDetail?.logicalState).not.toBeNull()
    expect(baseline.contentHash).toBe(
      await sha256Hex(encodeDocumentState(baselineDetail!.documentState!)),
    )
    expect(write.principal).toBe('ui')
    expect(write.baseRevisionId).toBe(baseline.id) // the chain
    expect(write.title).toBe('Titanium')
    expect(write.tags).toEqual(['metal'])
    // The blob round-trips through the detail surface.
    const detail = await store.revision(TITANIUM, write.id)
    expect(detail?.content).toBe('edited body')
    expect(detail?.logicalState?.markdown).toContain('tags:\n- metal')
  })

  it('does not block an identity-engine edit when optional baseline history is unavailable', async () => {
    const { store, persistence } = await make()
    const before = await store.read(TITANIUM)

    persistence.hasAnyFor = async () => {
      throw new Error('revision history unavailable')
    }

    await expect(
      store.write({
        title: 'Titanium',
        directory: 'demo',
        content: 'edited despite journal outage',
        tags: ['metal'],
        originalId: TITANIUM,
        versionToken: before.versionToken,
        principal: 'ui',
      }),
    ).resolves.toMatchObject({ id: TITANIUM })
    await expect(store.read(TITANIUM)).resolves.toMatchObject({
      content: 'edited despite journal outage',
    })
    await store.settle()
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

  // The role of an entry is decided ONCE, by the writer, and stored on the row. Four
  // consumers used to infer it from `kind='external' AND base_rev IS NULL`, and that
  // shape stopped meaning "first entry" when quarantine arrived (#327).
  describe('entry role — the writer decides, nobody infers', () => {
    it('stamps origin for a note born through us, and change for its next state', async () => {
      const { store, persistence } = await make()
      const res = await store.write({
        title: 'Fresh',
        directory: 'demo',
        content: 'fresh body',
        principal: 'ui',
      })

      await store.settle()
      const created = await store.read(res.id!)

      await store.write({
        title: 'Fresh',
        directory: 'demo',
        content: 'fresher body',
        originalId: res.id!,
        versionToken: created.versionToken,
        principal: 'ui',
      })
      await store.settle()
      const revs = await persistence.listByNote('main', res.id!, { offset: 0, limit: 10 })

      expect(revs.items.map((r) => r.entryRole)).toEqual(['change', 'origin'])
    })

    it('stamps baseline for a first sighting, and for the pre-edit state it captures', async () => {
      const { store, persistence } = await make()
      // A note that already existed: the first journaled write captures what it
      // found (baseline) and then its own state (change).
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

      expect(
        (await persistence.listByNote('main', TITANIUM, { offset: 0, limit: 10 })).items.map(
          (r) => r.entryRole,
        ),
      ).toEqual(['change', 'baseline'])
    })

    it('calls the first edit after a quarantine a change, not an origin', async () => {
      // The whole reason the role is written rather than read: after a quarantine the
      // note has NO trusted latest, so `latestFor` says "never seen" while
      // `hasAnyFor` — trusted and quarantined — says "there is a past". Asking the
      // wrong one announces a birth that never happened.
      const { store, persistence } = await make()
      const res = await store.write({
        title: 'Contaminated',
        directory: 'demo',
        content: 'first body',
        principal: 'ui',
      })

      await store.settle()
      const [first] = (await persistence.listByNote('main', res.id!, { offset: 0, limit: 10 }))
        .items

      persistence.quarantineForTest([first.id])
      expect(await persistence.latestFor('main', res.id!)).toBeNull()
      expect(await persistence.hasAnyFor('main', res.id!)).toBe(true)

      const reread = await store.read(res.id!)

      await store.write({
        title: 'Contaminated',
        directory: 'demo',
        content: 'body after the repair',
        originalId: res.id!,
        versionToken: reread.versionToken,
        principal: 'ui',
      })
      await store.settle()
      const after = await persistence.listByNote('main', res.id!, { offset: 0, limit: 10 })

      expect(after.items[0].entryRole).toBe('change')
      // And no second "baseline" was invented over a past that exists.
      expect(after.items.map((r) => r.entryRole)).toEqual(['change', 'origin'])
    })
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
    const detail = await store.revision(TITANIUM, revs[0].id)
    expect(revs[0].contentHash).toBe(await sha256Hex(encodeDocumentState(detail!.documentState!)))

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

  it('journals every row projection from the same exact state as its document blob', async () => {
    const { inner, store, setDelta } = await withScriptedDelta()
    const stateA = (await inner.list()).find((note) => note.id === TITANIUM)!
    const live = await inner.read(TITANIUM)

    await inner.write({
      title: 'State B',
      content: 'B-body',
      tags: ['B-tag'],
      slug: 'custom-b',
      originalId: TITANIUM,
      versionToken: live.versionToken,
      preservePath: true,
    })
    setDelta({
      cursor: 'mixed-a-b',
      inventory: await inner.list(),
      upserts: [
        {
          meta: { ...stateA, title: 'State A', slug: 'custom-a' },
          content: 'A-body',
          tags: ['A-tag'],
        },
      ],
    })
    await store.reconcile()
    await store.settle()

    const revision = (await timeline(store, TITANIUM))[0]
    const detail = await store.revision(TITANIUM, revision.id)

    expect(revision).toMatchObject({
      title: 'State B',
      slug: 'custom-b',
      tags: ['B-tag'],
    })
    expect(detail).toMatchObject({ content: 'B-body' })
    expect(detail?.documentState?.projection?.body).toBe('B-body')
  })

  it('captures an exact metadata-only external state with one changed-note read and no quiet reads', async () => {
    const { inner, store, setDelta } = await withScriptedDelta()
    const stale = await store.read(TITANIUM)
    const live = await inner.read(TITANIUM)
    const liveTitle = live.title ?? 'Titanium'

    await inner.write({
      title: liveTitle,
      content: live.content,
      frontmatter: parseFrontmatterLines('custom: changed-outside\nplugin:\n  nested: yes'),
      originalId: TITANIUM,
      versionToken: live.versionToken,
    })
    const meta = (await inner.list()).find((note) => note.id === TITANIUM)!
    const read = inner.read.bind(inner)
    let exactReads = 0

    inner.read = async (id, opts) => {
      exactReads += 1
      return read(id, opts)
    }
    // Even when a cheap delta supplies the unchanged BODY, it cannot supply raw
    // authored FM. The read-model must chase exactly this changed note once.
    setDelta({
      cursor: 'metadata-2',
      inventory: await inner.list(),
      upserts: [{ meta, content: live.content, tags: ['metal'] }],
    })
    await store.reconcile()
    await store.settle()

    expect(exactReads).toBe(1)
    const revision = (await timeline(store, TITANIUM))[0]
    const detail = await store.revision(TITANIUM, revision.id)
    expect(revision.stateFormat).toBe('markdown-v2')
    expect(detail?.content).toBe(live.content)
    expect(detail?.logicalState?.markdown).toContain('custom: changed-outside')

    setDelta({ cursor: 'metadata-3', inventory: await inner.list(), upserts: [] })
    await store.reconcile()
    await store.settle()
    expect(exactReads).toBe(1)

    await expect(
      store.write({
        title: liveTitle,
        content: live.content,
        originalId: TITANIUM,
        versionToken: stale.versionToken,
      }),
    ).rejects.toMatchObject({ reason: 'version_conflict' })
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
    const first = (await timeline(store, TITANIUM))[0]
    const detail = await store.revision(TITANIUM, first.id)
    expect(first.contentHash).toBe(await sha256Hex(encodeDocumentState(detail!.documentState!)))

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
      // Even a cheap body cannot stand in for the missing raw authored FM.
      upserts: [{ meta: { ...meta, title: 'Titanium' }, content: 'cheap but incomplete' }],
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
    const detail = await store.revision(TITANIUM, revs[0].id)
    expect(revs[0].contentHash).toBe(await sha256Hex(encodeDocumentState(detail!.documentState!)))
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
    // The compatibility store restore may normalize physical/provenance shape;
    // its authored logical state is still the requested historical state.
    expect(after.logicalState).toEqual(first.logicalState)
  })

  it('restores the complete authored state atomically without moving the live file', async () => {
    const richFixture: StoreSnapshot = {
      ...FIXTURE,
      notes: FIXTURE.notes.map((note) => ({
        ...note,
        frontmatter: 'custom: before\n# authored comment\nplugin:\n  nested: yes',
      })),
    }
    const { store } = await make(new InMemoryStore(richFixture))
    const initial = await store.read(TITANIUM)

    await store.write({
      title: 'Titanium v2',
      content: initial.content,
      frontmatter: parseFrontmatterLines(
        'custom: after\naliases:\n- historical-name\nplugin:\n  nested: no',
      ),
      frontmatterMode: 'replace',
      tags: ['new'],
      slug: 'changed-slug',
      originalId: TITANIUM,
      versionToken: initial.versionToken,
      principal: 'ui',
    })
    await store.settle()

    // A metadata-only change advances the same CAS token as a body change.
    await expect(
      store.write({
        title: 'Titanium v2',
        content: initial.content,
        originalId: TITANIUM,
        versionToken: initial.versionToken,
      }),
    ).rejects.toMatchObject({ reason: 'version_conflict' })

    // Revision list rows intentionally carry only the format marker; detail owns
    // the snapshot blob.
    const baselineRow = (await timeline(store, TITANIUM)).find(
      (revision) => revision.kind === 'external',
    )!
    const live = await store.read(TITANIUM)
    expect(live.filePath).toBe('demo/titanium-v2.md')

    await store.restore({
      id: TITANIUM,
      revisionId: baselineRow.id,
      versionToken: live.versionToken!,
      principal: 'ui',
    })
    const restored = await store.read(TITANIUM)

    expect(restored.title).toBe('Titanium')
    expect(restored.filePath).toBe(live.filePath)
    expect(restored.logicalState?.markdown).toBe(initial.logicalState?.markdown)
    expect(restored.frontmatter).toMatchObject({ custom: 'before', tags: ['metal'] })
    expect(restored.frontmatter).not.toHaveProperty('aliases')
    const restoredMeta = (await store.list()).find((note) => note.id === TITANIUM)!
    expect(restoredMeta).toMatchObject({ title: 'Titanium', tags: ['metal'] })
    expect(restoredMeta.slug).toBeUndefined()
    expect(restoredMeta.aliases).toBeUndefined()
  })

  it('keeps legacy body-only rows explicitly partial and leaves unknown live metadata alone', async () => {
    const richFixture: StoreSnapshot = {
      ...FIXTURE,
      notes: FIXTURE.notes.map((note) => ({
        ...note,
        frontmatter: 'custom: live\nslug: current-slug\naliases: [kept-alias] # authored',
      })),
    }
    const { store, persistence } = await make(new InMemoryStore(richFixture))
    const legacyBody = 'legacy body only'
    const legacy = await persistence.append(
      {
        noteId: TITANIUM,
        space: 'main',
        baseRevisionId: null,
        theirRevisionId: null,
        sourceRevisionId: null,
        kind: 'external',
        entryRole: 'baseline',
        principal: null,
        contentHash: await sha256Hex(legacyBody),
        title: 'Legacy title',
        class: 'user-doc',
        slug: null,
        tags: ['legacy'],
        createdAt: '2026-06-12T11:00:00Z',
        charsAdded: null,
        charsRemoved: null,
      },
      legacyBody,
    )
    const detail = await store.revision(TITANIUM, legacy.id)
    expect(detail).toMatchObject({ stateFormat: null, logicalState: null, content: legacyBody })
    const live = await store.read(TITANIUM)

    await store.restore({
      id: TITANIUM,
      revisionId: legacy.id,
      versionToken: live.versionToken!,
      principal: 'ui',
    })
    const restored = await store.read(TITANIUM)

    expect(restored.title).toBe('Legacy title')
    expect(restored.content).toBe(legacyBody)
    expect(restored.filePath).toBe(live.filePath)
    expect(restored.frontmatter).toMatchObject({ custom: 'live', tags: ['legacy'] })
    expect(restored.logicalState?.markdown).toContain('aliases: [kept-alias] # authored')
    const restoredMeta = (await store.list()).find((note) => note.id === TITANIUM)!
    expect(restoredMeta.slug).toBeUndefined()
    expect(restoredMeta.aliases).toBeUndefined()
  })

  it('records an honest gap and fails when the exact post-write read fails', async () => {
    const inner = new InMemoryStore({
      ...FIXTURE,
      notes: FIXTURE.notes.map((note) => ({ ...note, frontmatter: 'custom: kept' })),
    })
    const { store } = await make(inner)
    const current = await store.read(TITANIUM)
    const read = inner.read.bind(inner)
    let calls = 0

    vi.spyOn(inner, 'read').mockImplementation(async (...args) => {
      calls++
      if (calls === 2) {
        throw new Error('injected post-write read failure')
      }

      return read(...args)
    })

    await expect(
      store.write({
        title: 'Titanium',
        content: 'edited body',
        originalId: TITANIUM,
        versionToken: current.versionToken,
      }),
    ).rejects.toThrow('post-write exact read failed')
    await store.settle()

    const newest = (await timeline(store, TITANIUM))[0]
    expect(newest).toMatchObject({ kind: 'write', contentHash: null, stateFormat: null })
    expect((await store.read(TITANIUM)).frontmatter.custom).toBe('kept')
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
        entryRole: 'baseline',
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
  it('keeps typed import provenance through a capability-thin projection and trash cycle', async () => {
    const sourceLocator = claudeConversationSourceLocator('thin-source')!
    const inner = new InMemoryStore({
      space: 'main',
      now: FIXTURE.now,
      notes: [
        {
          id: 'thin-source-note',
          title: 'Same projection',
          filePath: 'source.md',
          content: 'same body',
          sourceLocator,
        },
        ...['clean', 'raw', 'invalid'].map((kind) => ({
          id: `thin-${kind}-note`,
          title: 'Same projection',
          filePath: `${kind}.md`,
          content: 'same body',
        })),
      ],
    })
    const exactRead = inner.read.bind(inner)
    const exactWrite = inner.write.bind(inner)

    inner.capabilities.cas = false
    inner.read = async (...args) => {
      const thin = { ...(await exactRead(...args)) }

      delete thin.logicalState
      delete thin.documentState
      delete thin.versionToken
      if (thin.id === 'thin-raw-note') {
        thin.frontmatter = { [IMPORT_SOURCE_FRONTMATTER_KEY]: sourceLocator }
      }
      if (thin.id === 'thin-invalid-note') {
        thin.sourceLocator = 'not-a-locator'
      }

      return thin
    }
    inner.write = async (input) => {
      const versionToken = input.originalId
        ? (await exactRead(input.originalId, { identityOnly: true })).versionToken
        : undefined
      const thin = { ...(await exactWrite({ ...input, versionToken })) }

      delete thin.versionToken

      return thin
    }
    const { store } = await make(inner)
    const sourced = await store.read('thin-source-note')
    const clean = await store.read('thin-clean-note')
    const raw = await store.read('thin-raw-note')
    const invalid = await store.read('thin-invalid-note')

    expect(sourced.sourceLocator).toBe(sourceLocator)
    expect(sourced.versionToken).not.toBe(clean.versionToken)
    expect(raw.versionToken).toBe(clean.versionToken)
    expect(invalid.versionToken).toBe(clean.versionToken)

    await store.write({
      originalId: 'thin-source-note',
      title: 'Same projection',
      content: 'updated body',
      versionToken: sourced.versionToken,
      principal: 'ui',
    })
    await store.remove('thin-source-note', { principal: 'ui' })
    await store.restoreFromTrash!('thin-source-note', { principal: 'ui' })

    expect(await store.read('thin-source-note')).toMatchObject({
      content: 'updated body',
      sourceLocator,
    })

    for (const id of ['thin-raw-note', 'thin-invalid-note']) {
      await store.remove(id, { principal: 'ui' })
      await store.restoreFromTrash!(id, { principal: 'ui' })
      const exact = await exactRead(id)

      expect(exact.sourceLocator).toBeUndefined()
      expect(exact.logicalState?.markdown).not.toContain(IMPORT_SOURCE_FRONTMATTER_KEY)
    }
  })

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

  it('delete and undelete preserve the complete authored snapshot', async () => {
    const richFixture: StoreSnapshot = {
      ...FIXTURE,
      notes: FIXTURE.notes.map((note) => ({
        ...note,
        frontmatter: 'custom: exact\n# survives trash\nplugin:\n  nested: yes',
      })),
    }
    const { store } = await make(new InMemoryStore(richFixture))
    const before = await store.read(TITANIUM)

    await store.remove(TITANIUM, { principal: 'ui' })
    await store.settle()
    const deleted = await store.read(TITANIUM, { deletedView: true })
    expect(deleted.logicalState?.markdown).toBe(before.logicalState?.markdown)
    expect(deleted.frontmatter).toMatchObject({ custom: 'exact', tags: ['metal'] })

    await store.restoreFromTrash!(TITANIUM, { principal: 'ui' })
    const restored = await store.read(TITANIUM)
    expect(restored.logicalState?.markdown).toBe(before.logicalState?.markdown)
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
        entryRole: 'change',
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
        entryRole: 'change',
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
  }, 30_000)

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
    expect(view.restoreAvailability).toBe('full')
    expect(view.content).toBe('original body') // last body, from the CAS
    expect(view.deletedByPrincipal).toBe('ui')
    // ...but a DISCOVERY read (preview/previews) must still miss on a deleted note,
    // not resurrect its snippet onto the Feed/cards.
    await expect(store.read(TITANIUM)).rejects.toBeTruthy()
    // a genuinely-unknown id throws even with the opt-in (no fake deleted view)
    await expect(store.read('no-such-note', { deletedView: true })).rejects.toBeTruthy()
  })

  it.each([
    {
      id: 'opaque-utf8-deleted',
      source: new TextEncoder().encode('---\nname: invalid--package\n---\nLiteral source.\n'),
    },
    { id: 'opaque-bytes-deleted', source: Uint8Array.from([0xff, 0x00, 0xfe, 0x61]) },
  ])('keeps exact document source in the deleted view for $id', async ({ id, source }) => {
    const { store, persistence } = await make()
    const documentState = analyzeDocumentState({
      source,
      role: 'skill-root',
      pathFallbackTitle: 'opaque',
      skillDirectoryName: 'opaque',
    })
    const blob = encodeDocumentState(documentState)

    await persistence.append(
      {
        noteId: id,
        space: 'main',
        baseRevisionId: null,
        theirRevisionId: null,
        sourceRevisionId: null,
        kind: 'delete',
        entryRole: 'change',
        principal: 'ui',
        contentHash: await sha256Hex(blob),
        semanticFingerprint: documentState.semanticFingerprint,
        restoreSafety: documentState.restoreSafety.status,
        stateFormat: documentState.format,
        title: 'Opaque deleted',
        class: 'user-doc',
        slug: null,
        tags: [],
        createdAt: '2026-06-12T11:00:00Z',
        charsAdded: null,
        charsRemoved: null,
      },
      blob,
    )

    const view = await store.read(id, { deletedView: true })

    expect(view.content).toBe('')
    expect(view.restoreAvailability).toBe('opaque')
    expect(view.documentState?.format).toBe('opaque-v1')
    expect(view.documentState?.source).toEqual(source)
  })

  it('a legacy deleted view projects its known custom slug', async () => {
    const { store, persistence } = await make()
    const content = 'legacy deleted body'

    await persistence.append(
      {
        noteId: 'legacy-deleted-note',
        space: 'main',
        baseRevisionId: null,
        theirRevisionId: null,
        sourceRevisionId: null,
        kind: 'delete',
        entryRole: 'change',
        principal: 'ui',
        contentHash: await sha256Hex(content),
        title: 'Legacy deleted',
        class: 'user-doc',
        slug: 'known-custom-slug',
        tags: ['legacy'],
        createdAt: '2026-06-12T11:00:00Z',
        charsAdded: null,
        charsRemoved: null,
      },
      content,
    )

    const view = await store.read('legacy-deleted-note', { deletedView: true })

    expect(view.slug).toBe('known-custom-slug')
    expect(view.frontmatter).toMatchObject({ slug: 'known-custom-slug', tags: ['legacy'] })
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
  it('restores the complete tombstone path instead of deriving a basename from title', async () => {
    const inner = new InMemoryStore({
      space: 'main',
      now: '2026-06-10T12:00:00.000Z',
      notes: [
        {
          title: 'Human Title',
          filePath: 'imports/opaque-source.md',
          content: 'imported body',
        },
      ],
    })
    const { store } = await make(inner)
    const note = (await store.list())[0]

    await store.remove(note.id!)
    await store.settle()
    await store.restoreFromTrash!(note.id!)
    await store.settle()

    expect((await store.list()).find((item) => item.id === note.id)?.filePath).toBe(
      'imports/opaque-source.md',
    )
  })

  it('restores canonical hidden class mounts at their exact tombstone paths', async () => {
    const fixtures = [
      ['memory-id', 'agent-memory', '.notarium/memory/category/exact.md'],
      ['profile-id', 'profile', '.notarium/profile/exact.md'],
      ['skill-id', 'skill', '.notarium/skills/pkg/guide.md'],
    ] as const
    const inner = new InMemoryStore({
      space: 'main',
      now: '2026-06-10T12:00:00.000Z',
      notes: fixtures.map(([id, cls, filePath]) => ({
        id,
        class: cls,
        title: `${cls} exact`,
        filePath,
        content: `${cls} body`,
      })),
    })
    const { store } = await make(inner)

    for (const [id, cls, filePath] of fixtures) {
      await store.remove(id)
      await store.settle()
      await store.restoreFromTrash!(id)
      await store.settle()
      expect((await store.list({ scope: 'all' })).find((note) => note.id === id)).toMatchObject({
        class: cls,
        filePath,
      })
    }
  })

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

  it('projects tags from the exact after-state when a body-only write omits the channel', async () => {
    const { store } = await make()
    const first = await store.read(TITANIUM)

    await store.write({
      title: 'Titanium',
      content: 'body-only edit',
      originalId: TITANIUM,
      versionToken: first.versionToken,
    })
    await store.settle()

    const latest = (await timeline(store, TITANIUM))[0]
    const detail = await store.revision(TITANIUM, latest.id)
    expect(latest.tags).toEqual(['metal'])
    expect(detail?.logicalState?.markdown).toContain('tags:\n- metal')
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

  it('a history rollback re-sets a recorded slug and a full baseline clears it', async () => {
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

    // Now roll back to the complete baseline (no slug in its authored state) →
    // the live custom slug is cleared rather than leaking across full restore.
    const baseline = (await timeline(store, TITANIUM)).find((r) => r.kind === 'external')!
    expect(baseline.slug).toBeNull()
    const live2 = await store.read(TITANIUM)
    await store.restore({
      id: TITANIUM,
      revisionId: baseline.id,
      versionToken: live2.versionToken!,
    })
    await store.settle()
    expect((await store.list()).find((n) => n.id === TITANIUM)!.slug).toBeUndefined()
  })
})

describe('trash restore/purge cross-instance ordering', () => {
  const pair = async () => {
    const inner = new InMemoryStore(FIXTURE)
    const persistence = new InMemoryRevisionPersistence()
    const createStore = () =>
      new CachedStore({
        inner,
        revisionPersistence: persistence,
        space: 'main',
        pollIntervalMs: 0,
        relationType: 'links_to',
        now: () => new Date('2026-06-12T12:00:00Z'),
      })
    const restoreStore = createStore()
    const purgeStore = createStore()

    await restoreStore.start()
    await purgeStore.start()
    await restoreStore.remove(TITANIUM)
    await restoreStore.settle()
    return { inner, persistence, restoreStore, purgeStore }
  }

  it('purge-first rejects restore and compensates the already-written live file', async () => {
    const { inner, persistence, restoreStore, purgeStore } = await pair()
    const entered = deferred()
    const release = deferred()
    const append = persistence.append.bind(persistence)

    persistence.append = async (revision, content) => {
      if (revision.kind === 'restore') {
        entered.resolve()
        await release.promise
      }

      return append(revision, content)
    }

    const restoring = restoreStore.restoreFromTrash!(TITANIUM)
    await entered.promise
    await expect(purgeStore.purgeTrash!({ ids: [TITANIUM] })).resolves.toEqual({ purged: 1 })
    release.resolve()
    await expect(restoring).rejects.toThrow(/revision target was permanently purged/)

    expect((await inner.list()).some((note) => note.id === TITANIUM)).toBe(false)
    expect((await restoreStore.list({ scope: 'all' })).some((note) => note.id === TITANIUM)).toBe(
      false,
    )
    expect(await persistence.latestFor('main', TITANIUM)).toBeNull()
  })

  it('keeps the physical restore when the required journal commit loses its acknowledgement', async () => {
    const { inner, persistence, restoreStore } = await pair()
    const append = persistence.append.bind(persistence)

    persistence.append = async (revision, content) => {
      const stored = await append(revision, content)

      if (revision.kind === 'restore') {
        throw new Error('simulated lost ACK after commit')
      }

      return stored
    }

    await expect(restoreStore.restoreFromTrash!(TITANIUM)).rejects.toThrow(
      'simulated lost ACK after commit',
    )
    expect((await inner.list()).some((note) => note.id === TITANIUM)).toBe(true)
    expect(await persistence.latestFor('main', TITANIUM)).toMatchObject({
      kind: 'restore',
      sourceRevisionId: expect.any(String),
    })
  })

  it('never compensates a foreign same-state physical replacement', async () => {
    const { inner, persistence, restoreStore } = await pair()
    const append = persistence.append.bind(persistence)
    let replacementInstalled = false

    persistence.append = async (revision, content) => {
      if (revision.kind === 'restore') {
        inner.load(FIXTURE)
        replacementInstalled = true
        throw new Error('injected required append rejection')
      }

      return append(revision, content)
    }

    await expect(restoreStore.restoreFromTrash!(TITANIUM)).rejects.toThrow(
      /live restore could not be rolled back/,
    )
    expect(replacementInstalled).toBe(true)
    expect((await inner.list()).some((note) => note.id === TITANIUM)).toBe(true)
  })

  it('an exact read-back failure rejects trash restore and compensates the live file', async () => {
    const { inner, persistence, restoreStore } = await pair()
    const write = inner.write.bind(inner)
    const read = inner.read.bind(inner)
    let failReadBack = false

    inner.write = async (input) => {
      const result = await write(input)
      failReadBack = true
      return result
    }
    inner.read = async (...args) => {
      if (failReadBack) {
        failReadBack = false
        throw new Error('injected post-write read failure')
      }

      return read(...args)
    }

    await expect(restoreStore.restoreFromTrash!(TITANIUM)).rejects.toThrow(
      'post-write exact read failed',
    )

    expect((await inner.list()).some((note) => note.id === TITANIUM)).toBe(false)
    expect((await restoreStore.list({ scope: 'all' })).some((note) => note.id === TITANIUM)).toBe(
      false,
    )
    expect((await persistence.latestFor('main', TITANIUM))?.kind).toBe('delete')
  })

  it('keeps a committed identity-engine restore when later snapshot publication fails', async () => {
    const { inner, persistence, restoreStore } = await pair()
    const internals = restoreStore as unknown as {
      afterNotesReady(fn: () => void): void
    }
    const afterNotesReady = internals.afterNotesReady.bind(restoreStore)
    let failAfterPublish = true

    internals.afterNotesReady = (fn) => {
      afterNotesReady(fn)
      if (failAfterPublish) {
        failAfterPublish = false
        throw new Error('injected post-append snapshot failure')
      }
    }

    await expect(restoreStore.restoreFromTrash!(TITANIUM)).rejects.toThrow(
      'injected post-append snapshot failure',
    )

    expect((await inner.list()).some((note) => note.id === TITANIUM)).toBe(true)
    expect((await restoreStore.list({ scope: 'all' })).some((note) => note.id === TITANIUM)).toBe(
      true,
    )
    expect((await persistence.latestFor('main', TITANIUM))?.kind).toBe('restore')
    expect((await restoreStore.listTrashed!({ offset: 0, limit: 10 })).total).toBe(0)
  })

  it('restore-append-first makes a stale purge selection skip the now-live note', async () => {
    const { inner, persistence, restoreStore, purgeStore } = await pair()
    const entered = deferred()
    const release = deferred()
    const purgeNotes = persistence.purgeNotes.bind(persistence)

    persistence.purgeNotes = async (space, ids, expectedLatest) => {
      entered.resolve()
      await release.promise
      return purgeNotes(space, ids, expectedLatest)
    }

    const purging = purgeStore.purgeTrash!({ ids: [TITANIUM] })
    await entered.promise
    await expect(restoreStore.restoreFromTrash!(TITANIUM)).resolves.toMatchObject({ id: TITANIUM })
    release.resolve()
    await expect(purging).resolves.toEqual({ purged: 0 })

    expect((await inner.list()).some((note) => note.id === TITANIUM)).toBe(true)
    expect((await persistence.latestFor('main', TITANIUM))?.kind).toBe('restore')
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
  it('settles requested notes and reads their heads through one persistence batch', async () => {
    const persistence = new SlowRevisionPersistence(30)
    const latestForMany = vi.spyOn(persistence, 'latestForMany')
    const store = await makeWith(persistence)
    const note = await store.write({
      title: 'Beryllium',
      directory: 'demo',
      content: 'fresh body',
      principal: 'user:bob',
    })

    // No settle(): the write has returned, but its journal append is still in
    // the delayed per-note queue. The batch surface must drain it before reading.
    const latest = await store.latestRevisions([note.id!, note.id!])

    expect(latest.get(note.id!)?.principal).toBe('user:bob')
    expect(latestForMany).toHaveBeenCalledOnce()
    expect(latestForMany).toHaveBeenCalledWith(expect.any(String), [note.id!])
    await store.settle()
  })

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

describe('gap shaping (#327) — what a contaminated row is allowed to say', () => {
  // `revisionGapOf` is the ONE place a contaminated row becomes a served row, for
  // all three drivers. Asserted whole rather than field by field: a field added to
  // `Revision` later has to be decided here too, and an assertion listing only
  // today's fields would pass while leaking it. canon: docs/note-history.md#model
  it('withholds every field that could attribute or reconstruct the state', () => {
    const contaminated: Revision = {
      id: '42',
      noteId: 'X',
      space: 'alpha',
      baseRevisionId: '41',
      theirRevisionId: '40',
      sourceRevisionId: '39',
      kind: 'merge',
      entryRole: 'change',
      principal: 'user:someone',
      agent: {
        owner: 'someone',
        agent: 'claude',
        session: { id: 'sess-1', name: 'Morning', attach: 'declared' },
      },
      contentHash: 'sha-of-another-space',
      semanticFingerprint: 'contaminated-fingerprint',
      stateFormat: 'markdown-v2',
      restoreSafety: 'safe',
      title: 'Their title',
      slug: 'their-slug',
      class: 'user-doc',
      tags: ['theirs'],
      createdAt: '2026-06-12T10:00:00.000Z',
      charsAdded: 5,
      charsRemoved: 2,
    }

    expect(revisionGapOf(contaminated)).toEqual({
      // Its place in the stream survives — that is what keeps cursors, totals,
      // pages and session linkage exact.
      id: '42',
      noteId: 'X',
      space: 'alpha',
      kind: 'merge',
      // The role is structural, like `kind`: it says where the entry stands in the
      // note's life, not what the note contained. Quarantine hides payload.
      entryRole: 'change',
      createdAt: '2026-06-12T10:00:00.000Z',
      // Everything else is withheld, and nothing is invented in its place.
      baseRevisionId: null,
      theirRevisionId: null,
      sourceRevisionId: null,
      principal: null,
      agent: null,
      contentHash: null,
      semanticFingerprint: null,
      stateFormat: null,
      restoreSafety: null,
      title: 'Unavailable revision',
      class: null,
      slug: null,
      tags: [],
      charsAdded: null,
      charsRemoved: null,
      unavailableReason: 'identity-conflict',
    })
  })

  it('does not alias the row it sanitizes', () => {
    // The drivers map rows in place; a shared tags array would let a later
    // consumer push a withheld tag back into the served row.
    const row: Revision = {
      id: '1',
      noteId: 'X',
      space: 'alpha',
      baseRevisionId: null,
      theirRevisionId: null,
      sourceRevisionId: null,
      kind: 'write',
      entryRole: 'origin',
      principal: 'ui',
      contentHash: null,
      semanticFingerprint: null,
      stateFormat: null,
      restoreSafety: null,
      title: 'Shared',
      slug: null,
      class: null,
      tags: ['keep'],
      createdAt: '2026-06-12T10:00:00.000Z',
      charsAdded: null,
      charsRemoved: null,
    }

    revisionGapOf(row).tags.push('leaked')

    expect(row.tags).toEqual(['keep'])
  })
})
