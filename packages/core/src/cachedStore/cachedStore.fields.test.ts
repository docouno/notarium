// The field axis on the read-model's own two paths: carry-forward across polls (the
// engine sends the column only for rows a delta moved, so "absent" and "empty" are
// two different signals) and the optimistic snapshot of OUR write, which has to
// state what the serializer is putting on disk before any poll confirms it.
//
// The write half is asserted against BYTES. Each case names the author-key block the
// serializer writes for it and reads that block back with the very builder the index
// derives the column with — never a hand-listed key map. Two reasons, and both are
// the difference between a mirror claim and a tautology:
//
//  - an expectation assembled by the rule under test ("three channels, three keys")
//    agrees with a private reimplementation of that rule just as happily as with the
//    shared one, so it can only catch a channel disappearing outright;
//  - `toEqual` on `keys` does not see ORDER, and below the cap the mirror owes the
//    derivation byte-for-byte, authored order included (design: what the optimistic
//    mirror may promise). Order is not cosmetic: the cap sacrifices from the tail.
//
// Byte equality is required only where the input stays below the cap. On a degenerate
// note the mirror is explicitly not authoritative, so the case there states which
// divergence is allowed and of what kind, instead of demanding an equality the
// projection cannot deliver.
// canon: docs/note-model.md#note-ontology

import { describe, expect, it, vi } from 'vitest'

import {
  type KnowledgeStore,
  liveSyncStatus,
  type NoteMeta,
  type StoreDelta,
  type WriteInput,
} from '../knowledgeStore'
import {
  buildNoteFields,
  buildNoteFieldsBlob,
  FIELDS_BLOB_BYTE_CAP,
  type NoteFields,
  patchNoteFields,
  serializeNoteFields,
} from '../libs/fields'
import { parseFrontmatterLines, utf8Bytes } from '../libs/markdown'
import { CachedStore } from './cachedStore'

const FILE = 'notes/alpha.md'
const ID = 'AbCdefGhij_1'

/** The blob the index derives from a file whose author-key block is exactly these
 *  bytes — the same read the engine performs over the file it just wrote. */
const derivedFrom = (block: string): string => buildNoteFieldsBlob(parseFrontmatterLines(block))

/** The projection a poll would deliver for a note whose file carries that block. */
const projectionOf = (block: string): NoteFields => buildNoteFields(parseFrontmatterLines(block))

/** Enough author keys to spend most of the cap, so the cleared key's own weight plus
 *  one incoming value is the difference between the merge fitting and sacrificing a
 *  key that is on disk. Below that regime nothing is observable: a key subtracted
 *  after the cap has run looks exactly like a key subtracted before it. */
const FILLER = Array.from({ length: 22 }, (_, index) => `k${index + 10}: ${'f'.repeat(100)}`)

/** The value forms a file can carry ONE key in. What each of them produces is not
 *  declared here — the run reads it back off the derivation, and the coverage
 *  assertion is what ties this set of forms to the set of surfaces the blob form has.
 *  A form listed here that stopped reaching its surface fails that assertion instead
 *  of quietly testing nothing. */
const VALUE_FORMS: Record<string, string[]> = {
  projectable: [`summary: ${'d'.repeat(1000)}`],
  unprojectable: ['summary:', '  nested: 1'],
  oversized: [`summary: ${'d'.repeat(2500)}`],
}

/** The key the write ADDS, heavy enough that the merge only fits once the cleared
 *  key's weight is released. */
const ADDED = `spent: ${'y'.repeat(1000)}`

/** A file that degenerates in every direction at once — a readable key, an
 *  unprojectable one and one the cap demotes — so the set of surfaces is READ OFF the
 *  builder's own output rather than written down beside it.
 *
 *  What that closes and what it does not, said plainly: a member the builder starts
 *  producing HERE joins the set on its own and the coverage line goes red until a form
 *  reaches it. A member no derivation of this input produces is outside it — the
 *  residue is a surface reachable only by some other shape of file, and closing that
 *  would take reflection over a type TypeScript erases. */
const ALL_SURFACES = projectionOf(
  [...FILLER, 'broken:', '  nested: 1', `heavy: ${'d'.repeat(2500)}`].join('\n'),
)

/** Every member of the blob that can hold a key NAME. `keys` maps names to values and
 *  the two lists hold names; the two `More` members hold numbers and fall out of this
 *  reading by themselves. A member added to the form joins the set the same way — which
 *  is the point: the surfaces a key can sit on are a function of the blob's shape, and
 *  a hand-written list of them is wrong one member later. */
const nameBearingSurfaces = (blob: NoteFields): string[] =>
  Object.getOwnPropertyNames(blob).filter(
    (member) =>
      member === 'keys' || Array.isArray((blob as unknown as Record<string, unknown>)[member]),
  )

/** Which of those surfaces a blob keeps a key's name on — `null` when it does not
 *  mention the key at all, which is what a cleared key owes on every one of them. */
const surfaceOf = (blob: NoteFields, key: string): string | null =>
  nameBearingSurfaces(blob).find((member) =>
    member === 'keys'
      ? Object.hasOwn(blob.keys, key)
      : ((blob as unknown as Record<string, string[]>)[member] ?? []).includes(key),
  ) ?? null

const meta = (fields?: NoteMeta['fields']): NoteMeta => ({
  id: ID,
  title: 'Alpha',
  filePath: FILE,
  modifiedAt: '2026-08-20T00:00:00.000Z',
  createdAt: '2026-08-20T00:00:00.000Z',
  ...(fields ? { fields } : {}),
})

/** Replays a scripted sequence of deltas, one per poll — the shape of an engine whose
 *  projection guards the column behind the delta cursor. */
const scripted = (deltas: readonly StoreDelta[]) => {
  let index = 0
  const inner: Partial<KnowledgeStore> = {
    capabilities: {
      fts: true,
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
    changes: async () => deltas[Math.min(index++, deltas.length - 1)],
    list: async () => [],
    graph: async () => ({ nodes: [], links: [] }),
    search: async () => [],
    syncStatus: async () => liveSyncStatus(),
  }

  return inner as KnowledgeStore
}

const axisOf = async (store: CachedStore) => (await store.list()).find((n) => n.filePath === FILE)

/** A store whose snapshot already holds ONE note with the given projection, over an
 *  engine that accepts a write and answers every later poll without the column — so
 *  what a test reads back after `write` is the optimistic mirror and nothing else. */
const overWritten = async (fields: NoteMeta['fields']) => {
  let seeded = false
  const setLinkIdentities = vi.fn()
  const inner: Partial<KnowledgeStore> = {
    capabilities: {
      fts: true,
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
    changes: async (): Promise<StoreDelta> => {
      const inventory = [seeded ? meta() : meta(fields)]

      seeded = true
      return { cursor: '1', upserts: [], inventory }
    },
    list: async () => [],
    graph: async () => ({ nodes: [], links: [] }),
    search: async () => [],
    syncStatus: async () => liveSyncStatus(),
    setLinkIdentities,
    write: async () => ({ id: ID, filePath: FILE, versionToken: 'v1' }),
    read: async () => ({
      id: ID,
      title: 'Alpha',
      filePath: FILE,
      content: 'body',
      frontmatter: {},
    }),
  }
  const store = new CachedStore({ inner: inner as KnowledgeStore, pollIntervalMs: 0 })

  await store.start()
  setLinkIdentities.mockClear()

  return {
    store,
    /** A create pinned to the seeded id, so the write patches THAT snapshot row. */
    write: async (input: Partial<WriteInput>) => {
      await store.write({ title: 'Alpha', directory: 'notes', id: ID, content: 'body', ...input })
      return (await axisOf(store))!.fields
    },
    stop: async () => {
      store.stop()
      await store.settle()
    },
    setLinkIdentities,
  }
}

describe('the field axis across polls', () => {
  it('carries the previous value through a poll that omits the column', async () => {
    const store = new CachedStore({
      inner: scripted([
        { cursor: '1', upserts: [], inventory: [meta({ keys: { status: 'doing' } })] },
        // An unchanged row: the engine parks its sentinel, the meta carries no value.
        { cursor: '2', upserts: [], inventory: [meta()] },
      ]),
      pollIntervalMs: 0,
    })

    await store.start()
    expect((await axisOf(store))!.fields!.keys).toEqual({ status: 'doing' })

    await store.reconcile()
    expect((await axisOf(store))!.fields!.keys).toEqual({ status: 'doing' })
    store.stop()
    await store.settle()
  })

  it('drops the value when the file loses its last author key', async () => {
    const store = new CachedStore({
      inner: scripted([
        { cursor: '1', upserts: [], inventory: [meta({ keys: { status: 'doing' } })] },
        // A PRESENT empty blob: the key was removed outside, and carry-forward must
        // not resurrect it until the next restart.
        { cursor: '2', upserts: [], inventory: [meta({ keys: {} })] },
      ]),
      pollIntervalMs: 0,
    })

    await store.start()
    expect((await axisOf(store))!.fields!.keys).toEqual({ status: 'doing' })

    await store.reconcile()
    expect((await axisOf(store))!.fields!.keys).toEqual({})
    store.stop()
    await store.settle()
  })
})

describe('the field axis on our own write', () => {
  it('mirrors the typed channels that reach the index through a frontmatter key', async () => {
    const h = await overWritten(projectionOf('status: doing\nsummary: old digest'))
    // The serializer merges the typed channels BELOW the authored ones, so a typed
    // value overrides an incoming raw key of the same name here as it does on disk.
    // `summary` was already in the file, so `put` replaces it in ITS slot, while
    // `type` and `muted` are new keys and land after everything the file had.
    const fields = await h.write({
      noteType: 'task',
      summary: 'new digest',
      muted: true,
      frontmatter: [{ key: 'summary', lines: ['summary: from raw'] }],
    })

    expect(serializeNoteFields(fields!)).toBe(
      derivedFrom('status: doing\nsummary: new digest\ntype: task\nmuted: "true"'),
    )
    expect(h.setLinkIdentities).not.toHaveBeenCalled()
    await h.stop()
  })

  it('takes a cleared typed key out of the projection, as the write takes it out of the file', async () => {
    const h = await overWritten(
      projectionOf('status: doing\ntype: task\nsummary: old digest\nmuted: "true"'),
    )
    // The implicit type is never spelled in a file, and an empty digest / a false
    // opt-out are explicit clears: all three keys leave the file, so a key left
    // standing here would outlive the note's own frontmatter until the next poll.
    const fields = await h.write({ noteType: 'note', summary: '', muted: false })

    expect(serializeNoteFields(fields!)).toBe(derivedFrom('status: doing'))
    await h.stop()
  })

  it('says "no author keys" the way the derivation says it, not by leaving the column out', async () => {
    // The plainest note there is: frontmatter that is title and id and nothing else.
    // The derivation answers `{"keys":{}}` for it — a state, and the column's own
    // default — while an absent member means something else entirely on the read path,
    // where it is the poll's "this row did not move" sentinel. A mirror that leaves the
    // member out on a save publishes the one reading the file cannot have, and the
    // boundary gate that compares mirror to file bytes has nothing to compare.
    const h = await overWritten(undefined)
    const fields = await h.write({})

    expect(fields ? serializeNoteFields(fields) : 'no column at all').toBe(derivedFrom(''))
    await h.stop()
  })

  it('merges the frontmatter block a body carries — the fourth authored channel', async () => {
    const h = await overWritten(projectionOf('status: doing'))
    // The serializer parses a leading block out of the body and merges it with the
    // same `put` as raw frontmatter; a mirror that only reads WriteInput.frontmatter
    // leaves the note's freshly written key invisible for a poll interval.
    const fields = await h.write({ content: '---\nsprint: 12\n---\n\nbody' })

    expect(serializeNoteFields(fields!)).toBe(derivedFrom('status: doing\nsprint: 12'))
    await h.stop()
  })

  it('rebuilds the projection from scratch on a replacing write', async () => {
    const h = await overWritten(projectionOf('status: doing\nsprint: 12'))
    // A full-state restore makes the incoming entries the COMPLETE authored set —
    // the one row of the table whose semantics are not a patch. Patching here would
    // keep every key the restore just took off the disk alive in the snapshot.
    const fields = await h.write({
      frontmatter: [{ key: 'status', lines: ['status: done'] }],
      frontmatterMode: 'replace',
    })

    expect(serializeNoteFields(fields!)).toBe(derivedFrom('status: done'))
    await h.stop()
  })

  it('leaves a replacing write the body block it did not ask for', async () => {
    const h = await overWritten(projectionOf('status: doing'))
    // A replacing write carries a canonical split already, so the serializer does
    // NOT re-read a fenced block in its body — the block stays prose and none of its
    // keys reach the file's frontmatter. Merging it here would put a key in the
    // filter and on the card that the note does not carry.
    const fields = await h.write({
      frontmatter: [{ key: 'gamma', lines: ['gamma: 3'] }],
      frontmatterMode: 'replace',
      content: '---\ninline: yes\n---\n\nbody',
    })

    expect(serializeNoteFields(fields!)).toBe(derivedFrom('gamma: 3'))
    await h.stop()
  })

  it('takes a cleared key off every surface, from either side of the merge, before the cap runs', async () => {
    // On disk a typed channel that clears its key `drop`s it BEFORE the serializer
    // measures the block, so the file keeps every other value and stays under the cap.
    // Two things follow, and they are the same statement rather than two: the key has
    // to leave whichever list of the projection it sat on, and it has to leave BOTH
    // things the merge reads — what the note carried and what this write brings — or
    // the sacrifice it caused survives it. A key subtracted from the FINISHED blob
    // instead demotes a value that is on disk and the note drops out of `field=` for a
    // poll interval right after a successful save.
    //
    // One statement over a generated matrix, not a case per surface: cases are what
    // produced this defect twice already. The forms feed BOTH sides of the merge from
    // the same generator, the surface each one reaches is read back off the derivation,
    // and the coverage lines below tie the matrix to the shapes it has to cover — the
    // blob's own members and the merge's own arity — so a surface or a side added later
    // fails here instead of waiting to be noticed.
    const written = [...FILLER, ADDED].join('\n')
    const mirrored: Record<string, string> = {}
    const owed: Record<string, string> = {}
    const surfaces: string[] = []
    const sides = new Set<string>()

    for (const [form, lines] of Object.entries(VALUE_FORMS)) {
      // Every channel a write can restate an authored key through: the raw entries and
      // the block a body may lead with. The typed channels cannot appear here — a clear
      // is a verdict, not an entry — and `none` is the note's own history alone.
      for (const channel of ['none', 'raw', 'inline'] as const) {
        const cell = `${form} restated via ${channel}`
        const seeded = projectionOf([...FILLER, ...lines].join('\n'))
        const h = await overWritten(seeded)
        const fields = await h.write({
          // The typed channel clears the key; the raw or inline channel restates it
          // with the same weight the file gave it, so the clear has to beat an entry
          // this very write is carrying and not only the note's own history.
          summary: '',
          content: channel === 'inline' ? `---\n${lines.join('\n')}\n---\n\nbody` : 'body',
          frontmatter: parseFrontmatterLines(
            [...(channel === 'raw' ? lines : []), ADDED].join('\n'),
          ),
        })

        await h.stop()
        surfaces.push(surfaceOf(seeded, 'summary')!)
        sides.add('carried')
        if (channel !== 'none') {
          sides.add('incoming')
        }
        mirrored[cell] = serializeNoteFields(fields!)
        owed[cell] = derivedFrom(written)
      }
    }

    expect(mirrored).toEqual(owed)
    // The surfaces the matrix reached are every surface the blob form HAS — computed
    // from a blob that reaches them all, never listed. Add a seventh member to
    // `NoteFields` and this line goes red until a form gets a key onto it.
    expect(new Set(surfaces)).toEqual(new Set(nameBearingSurfaces(ALL_SURFACES)))
    // …and the key came from every side the merge has, counted as the merge's own
    // arity: `patchNoteFields(previous, entries)`. Give the merge a third source and
    // this line goes red the same way.
    expect(sides.size).toBe(patchNoteFields.length)
  })

  it('states which divergence a degenerate note is allowed, instead of an equality it cannot reach', async () => {
    // 900 unprojectable keys: the blob is AT the cap, so most of those names live in
    // `unreadableMore` as a bare count. The mirror is not authoritative here — the
    // projection it merges from carries names, never positions or byte weights — so
    // this case pins the KIND of divergence rather than byte equality.
    const authored = Array.from(
      { length: 900 },
      (_, index) => `an-unreadable-key-number-${index}:\n  nested: ${index}`,
    ).join('\n')
    const h = await overWritten(projectionOf(`${authored}\nmuted: "true"`))
    const fields = await h.write({
      muted: false,
      frontmatter: [{ key: 'muted', lines: ['muted: "true"'] }],
    })
    const onDisk = projectionOf(authored)
    const names = (blob: NoteFields) => [
      ...(blob.unreadable ?? []),
      ...(blob.truncated ?? []),
      ...Object.getOwnPropertyNames(blob.keys),
    ]
    const accounted = (blob: NoteFields) =>
      (blob.unreadable ?? []).length +
      (blob.unreadableMore ?? 0) +
      (blob.truncated ?? []).length +
      (blob.truncatedMore ?? 0)

    // What the mirror still owes, cap or no cap: the cleared key is gone BY NAME,
    // nothing readable is invented, and the cap holds.
    expect(names(fields!)).not.toContain('muted')
    expect(names(onDisk)).not.toContain('muted')
    expect(Object.getOwnPropertyNames(fields!.keys)).toEqual([])
    expect(utf8Bytes(serializeNoteFields(fields!))).toBeLessThanOrEqual(FIELDS_BLOB_BYTE_CAP)
    // What it does not owe, and exactly how much: the split between listed names and
    // the counter. `muted` gave up its NAME to the cap on the previous write, so the
    // projection this write merges from holds it as a number — nothing the mirror can
    // subtract by name. So one term stays counted for a key the file no longer has,
    // and the byte its removal bought cannot buy back a name the count swallowed.
    // The overshoot is bounded by the number of typed keys the write clears; the
    // sidebar reads 901 unindexed where the file says 900, until the next poll. Only
    // an entry list carrying positions and weights could close it, and the blob form
    // deliberately does not (design: what the optimistic mirror may promise).
    expect(accounted(onDisk)).toBe(900)
    expect(accounted(fields!) - accounted(onDisk)).toBe(1)
    expect(fields!.truncatedMore).toBe(1)
    expect(onDisk.truncatedMore ?? 0).toBe(0)
    expect(fields!.unreadable).toEqual(
      (onDisk.unreadable ?? []).slice(0, fields!.unreadable!.length),
    )
    await h.stop()
  })
})
