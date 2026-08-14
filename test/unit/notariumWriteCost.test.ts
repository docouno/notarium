// What ONE write is allowed to cost (#302) — on the medium AND in the read-model.
//
// The engine used to walk the whole mount twice per write — once to decide
// whether a non-portable destination component already existed, once to prove a
// directory's spelling matched storage. Both are O(tree), so a write got slower
// as the space grew and an import was quadratic: the 10 000-note archive the
// import contract promises never finished.
//
// The fix is only meaningful if it stays fixed, and a throughput assertion would
// be a flaky benchmark. So this pins the SHAPE instead: a write does not
// enumerate the tree, and the number of filesystem calls it makes does not grow
// with the number of notes already there.
//
// The medium is only half of it. Measuring the BARE engine let every O(corpus)
// term above it live on unmeasured — and let a later fix add one: the destination
// guard's snapshot scan, and a resolve table rebuilt by the very write that had
// just moved the counter it is keyed on, were both invisible to a gate that
// counts `FileStore` calls. So the second half of this file measures the same
// shape on the PRODUCTION composition, the read-model over the engine, and counts
// the corpus the write touched inside it.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CachedStore, IF_EXISTS } from '@notarium/core'
import { createLocalFsFiles, type FileStore } from '@notarium/engine'
import { InMemoryStore } from '@notarium/engine-memory'

import { createNodeSqliteDriver } from '../../packages/engine/src/libs/sql'
import { NotariumStore } from '../../packages/engine/src/services/notariumStore/notariumStore'

type Calls = Record<string, number>

/** Counts what the store asks the medium for, and forwards everything. */
const counting = (inner: FileStore, into: Calls): FileStore =>
  new Proxy(inner, {
    get: (target, key: string) => {
      const value = (target as unknown as Record<string, unknown>)[key]

      if (typeof value !== 'function') {
        return value
      }

      return (...args: unknown[]) => {
        into[key] = (into[key] ?? 0) + 1

        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    },
  }) as FileStore

/** A store on its own temp dir with its own call counter, already booted — so a
 *  later measurement counts the write and not the first-touch scan. */
const freshStore = async (opts?: { accelerator?: boolean; legacyDir?: string }) => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-write-cost-'))

  if (opts?.legacyDir) {
    mkdirSync(join(dir, opts.legacyDir), { recursive: true })
  }
  const calls: Calls = {}
  const files = counting(createLocalFsFiles(dir), calls)

  if (opts?.accelerator === false) {
    delete files.dirExistsExact
  }
  const store = new NotariumStore({
    mounts: [{ class: 'user-doc', prefix: '', files }],
    sql: createNodeSqliteDriver(':memory:'),
  })

  await store.list()
  return {
    store,
    calls,
    reset: () => {
      for (const key of Object.keys(calls)) {
        delete calls[key]
      }
    },
    close: async () => {
      await store.stop()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const nested = (n: number) => ({
  title: `Note ${n}`,
  content: `Body ${n}.`,
  directory: `vault/${n % 3}/${n % 2}`,
})

describe('what one write costs the filesystem (#302)', () => {
  it('never enumerates the whole mount', async () => {
    const h = await freshStore()

    try {
      await h.store.write(nested(1))
      await h.store.write(nested(2))

      // `listDirs` is the directory CHANNEL (the tree surface asks for it); a write
      // must not. It is the call whose cost grows with the corpus.
      expect(h.calls.listDirs ?? 0).toBe(0)
    } finally {
      await h.close()
    }
  })

  it('costs the same on a full space as on an empty one', async () => {
    // TWO stores, one write, the only difference being what is already there.
    // Measuring both writes inside a single store cannot say this: whatever the
    // second write costs, the tree it ran against was the tree the first one left.
    const busy = await freshStore()
    const empty = await freshStore()

    try {
      for (let n = 0; n < 25; n++) {
        await busy.store.write(nested(n))
      }
      const seeding = { ...busy.calls }
      const solo = { title: 'Solo', content: 'x', directory: 'other' }

      busy.reset()
      empty.reset()
      await busy.store.write(solo)
      await empty.store.write(solo)

      // Not "no worse than" with a constant to absorb the difference — the same
      // write on 25 notes and on none is the same conversation with the medium.
      expect(busy.calls).toEqual(empty.calls)
      // And the corpus that made the space full was itself never enumerated.
      expect(seeding.listDirs ?? 0).toBe(0)
    } finally {
      await busy.close()
      await empty.close()
    }
  })

  it('asks one walk for the whole path when the medium has no shallow probe', async () => {
    // An adapter that cannot answer the exact spelling cheaply is SLOWER, never
    // refused — and the degradation costs one recursive walk for the whole path,
    // not one per component. That difference is why the port asks the question in
    // a batch: answering prefix-by-prefix would make the fallback scale with depth.
    const h = await freshStore({ accelerator: false })

    try {
      h.reset()
      await h.store.write({ title: 'Deep', content: 'x', directory: 'a/b/c/d' })
      expect(h.calls.dirExistsExact ?? 0).toBe(0)
      expect(h.calls.listDirs).toBe(1)
      expect((await h.store.list()).map((n) => n.filePath)).toEqual(['a/b/c/d/deep.md'])
    } finally {
      await h.close()
    }
  })

  it('still asks one walk when the destination also needs the legacy exception', async () => {
    // The write has TWO questions for the medium: which ancestors of the
    // destination exist under exactly that spelling, and whether a non-portable
    // component is a folder that was already there. They are the same KIND of
    // question, so a degraded adapter must answer both in the one walk it is
    // already paying for — asking them one fence at a time cost it two.
    const h = await freshStore({ accelerator: false, legacyDir: 'legacy:root' })

    try {
      h.reset()
      await h.store.write({
        title: 'Imported',
        content: 'x',
        directory: 'legacy:root/con',
        fileName: 'con',
        legacyImportRoot: 'legacy:root',
      })
      expect(h.calls.listDirs).toBe(1)
      expect((await h.store.list()).map((n) => n.filePath)).toEqual(['legacy:root/con/con.md'])
    } finally {
      await h.close()
    }
  })

  it('never merges two spellings of one directory into one identity', async () => {
    const h = await freshStore()

    try {
      await h.store.write({ title: 'First', content: 'x', directory: 'Vault' })

      // Same folder, different case. On a case-insensitive filesystem the medium
      // resolves one onto the other and the write must refuse rather than land in
      // a folder it did not name; on a case-sensitive one they are two real
      // folders and both notes are kept. Which branch this machine takes is a
      // property of the machine — that no note is lost or merged is not. (The
      // refusal itself is pinned medium-independently in
      // `test/store-contract/notarium.test.ts`, against a simulated
      // case-insensitive adapter, with and without the exact-spelling probe.)
      const outcome = await h.store
        .write({ title: 'Second', content: 'y', directory: 'vault' })
        .then(
          () => 'written' as const,
          (err: Error) => err.message,
        )

      if (outcome !== 'written') {
        expect(outcome).toMatch(/spelling/)
        return
      }
      const paths = (await h.store.list()).map((n) => n.filePath).sort()

      expect(paths).toEqual(['Vault/first.md', 'vault/second.md'])
    } finally {
      await h.close()
    }
  })
})

/** How much of the read-model's NOTE MAP a write walked. The write path's expensive
 *  terms are internal by nature (the medium never sees a scan of the snapshot, nor
 *  the construction of the resolve table), so a gate on them has to attach where
 *  they happen — and the note map is where they happen: the destination guard's
 *  occupancy scan, the displaced-owner sweep, the resolve table's own
 *  `graphVisibleNotes()` and the bracket's graph-context expansion all enumerate
 *  THIS map. Counted in ENTRIES rather than calls — one walk of 25 notes and one of
 *  1 must not read the same.
 *
 *  What it does NOT see, so that the claim above stays the claim below: iteration
 *  of `snap.edgesBySource` or `snap.ghosts`, of the identity registry, of the
 *  directory index, and anything inside the engine. Those are either bounded by the
 *  edge/ghost count rather than the corpus, or measured by the medium's own call
 *  counter in the first half of this file. */
const corpusWalked = (store: CachedStore) => {
  const notes = (store as unknown as { snap: { notes: Map<string, unknown> } }).snap.notes
  const walked = { entries: 0 }

  const stepping = <T>(iterate: () => IterableIterator<T>) =>
    function* (): IterableIterator<T> {
      for (const item of iterate()) {
        walked.entries++
        yield item
      }
    }
  const patched = notes as unknown as Record<string | symbol, unknown>

  patched[Symbol.iterator] = stepping(notes[Symbol.iterator].bind(notes))
  patched.values = stepping(notes.values.bind(notes))
  patched.keys = stepping(notes.keys.bind(notes))

  return walked
}

/** The bracket's coalesced broadcast window. The broadcast republishes the whole id
 *  registry to a path-keyed engine — a corpus pass amortised over everything written
 *  in the window, part of no single write, and therefore not something a measurement
 *  of one write may include. */
const BULK_EMIT_COALESCE_MS = 300

/** Seed both stacks inside the import bracket the notes would really arrive in, then
 *  land the pending broadcast BEFORE the counter goes on. Fake timers rather than a
 *  wall-clock wait: the measured write re-arms the same timer on its way in, so any
 *  wait long enough to settle the seed is still a race with the write's own — and
 *  the pass it would have caught costs ~26 corpus steps on a 25-note stack, which is
 *  exactly the size of the effect under test. Nothing advances the clock once the
 *  seed has settled, so the timer the measured write arms cannot fire. */
const settleBulkBroadcast = async () => {
  await vi.advanceTimersByTimeAsync(BULK_EMIT_COALESCE_MS)
  await vi.advanceTimersByTimeAsync(BULK_EMIT_COALESCE_MS)
}

const seedBulk = async (store: CachedStore, seed: number) => {
  store.beginBulk()
  // At least one seeded note on BOTH stacks: it creates the seed folder and warms
  // the batch table, so the measured write differs in the size of the corpus and in
  // nothing else.
  for (let n = 0; n < seed; n++) {
    await store.write({
      title: `Seed ${n}`,
      content: `Body ${n}. See [[Seed ${(n + 1) % seed}]].`,
      directory: 'vault',
    })
  }
  await settleBulkBroadcast()
}

/** The production composition — the read-model over the engine — on its own temp
 *  dir, with the medium's call counter and the read-model's corpus counter. */
const freshStack = async (seed: number) => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-read-model-cost-'))
  const calls: Calls = {}
  const files = counting(createLocalFsFiles(dir), calls)
  const inner = new NotariumStore({
    mounts: [{ class: 'user-doc', prefix: '', files }],
    sql: createNodeSqliteDriver(':memory:'),
  })
  const store = new CachedStore({ inner, pollIntervalMs: 0, relationType: 'links_to' })

  await store.start()
  await store.list()
  await seedBulk(store, seed)
  const walked = corpusWalked(store)

  for (const key of Object.keys(calls)) {
    delete calls[key]
  }

  return {
    store,
    calls,
    walked,
    close: async () => {
      await store.endBulk()
      await store.stop()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** The same read-model over an IDENTITY-keyed engine. Half the write path's
 *  path-occupancy work is wired per capability — the displaced-owner sweep in
 *  `applyWrite` runs only when the engine owns identity — so the production
 *  composition alone leaves that half proved by reading it rather than by measuring
 *  it. This is the composition that executes it. */
const freshIdentityStack = async (seed: number) => {
  const inner = new InMemoryStore({ space: 'main', notes: [] })
  const store = new CachedStore({ inner, pollIntervalMs: 0, relationType: 'links_to' })

  await store.start()
  await store.list()
  await seedBulk(store, seed)

  return {
    store,
    walked: corpusWalked(store),
    close: async () => {
      await store.endBulk()
      await store.stop()
    },
  }
}

describe('what one write costs the read-model (#302)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('costs the same on a full space as on an empty one', async () => {
    // The import's write, on the composition an import really runs on. TWO stacks
    // differing only in what is already there, because a second write inside one
    // stack can only be compared against the tree the first one left.
    //
    // What this does NOT claim: an INTERACTIVE write (outside an import bracket) is
    // still O(corpus) in the read-model — it republishes the whole id registry to a
    // path-keyed engine and rebuilds the exact resolve table. Both are deliberate,
    // both are outside #302, and neither is what made the import quadratic.
    const busy = await freshStack(25)
    const empty = await freshStack(1)

    try {
      // Into a folder the bracket has NOT created yet: a new directory is what
      // schedules the bracket's corpus-wide graph repair, and that repair is a term
      // of its own — deferred to the close as a flag, or (before it was) expanded
      // into every id right here, inside the write. Writing into the seeded folder
      // measured everything but that.
      const solo = { title: 'Solo', content: 'x [[Seed 0]]', directory: 'inbox' }

      await busy.store.write(solo)
      await empty.store.write(solo)

      // Not "no worse than" with a constant to absorb the difference: the same
      // write onto 25 notes and onto 1 is the same work, in the read-model exactly
      // as on the medium.
      expect(busy.walked.entries).toBe(empty.walked.entries)
      expect(busy.calls).toEqual(empty.calls)
      // And it is not "the same amount of walking" either — there is none. A write
      // reaches the note it displaces through the snapshot's path index, derives its
      // edges against the bracket's table instead of rebuilding one per note, and
      // leaves the corpus-wide repair as a flag for the close to expand.
      expect(busy.walked.entries).toBe(0)
    } finally {
      await busy.close()
      await empty.close()
    }
  })

  it('costs the same when the write REWRITES a note instead of adding one', async () => {
    // The repeated import: the same archive again, its titles edited. Destinations
    // come from the member's FILE NAME, so the notes land back on their own paths
    // and every write is a rename. A batch table that survived only additions
    // rebuilt on each of them — the corpus per write, the same quadratic the bracket
    // exists to remove, reached through the door marked "overwrite".
    const busy = await freshStack(25)
    const empty = await freshStack(1)

    try {
      const rewrite = {
        title: 'Seed 0, Revised',
        fileName: 'seed-0',
        content: 'revised body [[Seed 0]]',
        directory: 'vault',
        ifExists: IF_EXISTS.overwrite,
      }

      await busy.store.write(rewrite)
      await empty.store.write(rewrite)

      expect(busy.walked.entries).toBe(empty.walked.entries)
      expect(busy.calls).toEqual(empty.calls)
      expect(busy.walked.entries).toBe(0)
    } finally {
      await busy.close()
      await empty.close()
    }
  })

  it('costs the same on an engine that owns identity, where the sweep lives', async () => {
    // Same shape, other capability branch. The displaced-owner sweep only runs here,
    // and "asked of the path index rather than by walking the snapshot" is a claim
    // about a line the production composition never executes.
    const busy = await freshIdentityStack(25)
    const empty = await freshIdentityStack(1)

    try {
      const solo = { title: 'Solo', content: 'x [[Seed 0]]', directory: 'inbox' }

      await busy.store.write(solo)
      await empty.store.write(solo)

      expect(busy.walked.entries).toBe(empty.walked.entries)
      expect(busy.walked.entries).toBe(0)
    } finally {
      await busy.close()
      await empty.close()
    }
  })
})
