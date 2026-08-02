// The engine index must self-compact. auto_vacuum=INCREMENTAL is set by the
// driver BEFORE journal_mode (the pragma-order gotcha: in WAL a switch needs a
// VACUUM, and it only takes on a brand-new DB), and the store drains the freelist
// with incremental_vacuum after a churn event so a bloated partition returns its
// pages to the OS instead of growing unbounded.

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

import type { Embedder } from '../../libs/embedding'
import { createNodeSqliteDriver } from '../../libs/sql'
import { createNotariumStore } from './createNotariumStore'
import { itVector } from './vectorGate.fixture'

/** A deterministic, instant embedder (no onnxruntime): fast and hermetic, enough to
 *  drive the vector write-path so a note reaches the fully-embedded state. */
const mockEmbedder: Embedder = {
  id: 'mock@v1',
  dimensions: 8,
  embed: async (texts) =>
    texts.map((t) => {
      const v = new Float32Array(8)

      for (let i = 0; i < t.length; i++) {
        v[i % 8] += t.charCodeAt(i) + 1
      }
      let norm = 0

      for (const x of v) {
        norm += x * x
      }
      norm = Math.sqrt(norm) || 1
      for (let i = 0; i < 8; i++) {
        v[i] /= norm
      }

      return v
    }),
}

/** Bloat an existing index DB like PAST churn: a throwaway table filled then dropped
 *  leaves its pages on the (INCREMENTAL) freelist, which the file still occupies —
 *  exactly the 4GB-at-150MB shape, without depending on the engine's internal
 *  schema/migration constants. Returns the resulting freelist page count. */
const bloatIndex = async (db: string, rows: number, vec = false): Promise<number> => {
  const seed = createNodeSqliteDriver(db, vec ? { vec: true } : {})
  await seed.exec(`CREATE TABLE junk(b TEXT)`)
  await seed.exec(`BEGIN`)
  const big = 'x'.repeat(8000) // ~2 pages per row at the 4 KiB default page size

  for (let i = 0; i < rows; i++) {
    await seed.run(`INSERT INTO junk(b) VALUES (?)`, [big])
  }
  await seed.exec(`COMMIT`)
  await seed.exec(`DROP TABLE junk`) // free every junk page into the freelist
  await seed.exec(`PRAGMA wal_checkpoint(TRUNCATE)`) // fold the -wal back so the main file holds the bloat
  const free =
    (await seed.get<{ freelist_count: number }>(`PRAGMA freelist_count`))?.freelist_count ?? 0
  await seed.close()
  return free
}

let notesDir: string
let indexDb: string

beforeEach(() => {
  notesDir = mkdtempSync(join(tmpdir(), 'notarium-vac-notes-'))
  indexDb = join(mkdtempSync(join(tmpdir(), 'notarium-vac-db-')), 'index.db')
})

afterEach(() => {
  rmSync(notesDir, { recursive: true, force: true })
})

it('is born auto_vacuum=INCREMENTAL — the pragma takes on a fresh engine DB', async () => {
  mkdirSync(notesDir, { recursive: true })
  writeFileSync(join(notesDir, 'note.md'), '# Note\n\nbody\n')
  const store = createNotariumStore({ notesDir, indexDb })

  try {
    await store.list() // drives ensureReady → schema build on the fresh handle
  } finally {
    await store.stop()
  }
  // The driver set auto_vacuum BEFORE WAL on the untouched handle, so the mode
  // stuck to the first table. 2 === INCREMENTAL; a wrong pragma order would read 0.
  const db = createNodeSqliteDriver(indexDb)
  const mode = await db.get<{ auto_vacuum: number }>(`PRAGMA auto_vacuum`)
  expect(mode?.auto_vacuum).toBe(2)
  await db.close()
})

it('reclaims a bloated freelist on boot — the file shrinks back to the OS', async () => {
  // Build the index through the REAL boot/migration path (so it's at the current
  // version and boot won't tear it down), keeping one note, then bloat it like past
  // churn — the 4GB-at-150MB shape.
  mkdirSync(notesDir, { recursive: true })
  writeFileSync(join(notesDir, 'kept.md'), '# Kept\n\nbody\n')
  const warm = createNotariumStore({ notesDir, indexDb })
  await warm.list()
  await warm.whenIndexSettled()
  await warm.stop()

  const freeBefore = await bloatIndex(indexDb, 1600)
  const sizeBefore = statSync(indexDb).size
  expect(freeBefore).toBeGreaterThan(2000) // genuinely bloated (multiple reclaim chunks)

  const store = createNotariumStore({ notesDir, indexDb })

  try {
    await store.list() // ensureReady → rescan → FTS-only boot schedules the reclaim
    await store.whenIndexSettled() // await the fire-and-forget compaction pass
    const notes = await store.list()
    expect(notes.map((n) => n.filePath)).toEqual(['kept.md']) // survived the compaction
  } finally {
    await store.stop()
  }

  const sizeAfter = statSync(indexDb).size
  const db = createNodeSqliteDriver(indexDb)
  const freeAfter =
    (await db.get<{ freelist_count: number }>(`PRAGMA freelist_count`))?.freelist_count ?? 0
  await db.close()
  expect(freeAfter).toBeLessThan(512) // the freelist was drained (RECLAIM_MIN_FREE_PAGES)
  expect(sizeAfter).toBeLessThan(sizeBefore / 2) // and the pages actually left the disk
}, 20_000)

// The production shape: a VECTOR-enabled space that boots already fully
// embedded (nothing to backfill) but still carrying a freelist from past churn. The
// boot reclaim must NOT be gated on "FTS-only" — an embed loop that never runs would
// otherwise leave the bloat forever.
//
// This is the SOLE guard for the boot gate being `!pendingEmbed.size` rather than the
// buggy `!vecReady`: the two diverge ONLY when vecReady && nothing-pending, which needs
// a real vec0 table. Where vec0 can't load (musl/alpine) the case is both untestable
// AND unreachable (vecReady stays false, so both gates behave identically) — so a
// vec0-capable CI leg MUST run this test, else a revert to `!vecReady` would ship the
// exact production bloat undetected.
itVector(
  'reclaims on a fully-embedded VECTOR boot — no backfill to piggyback on',
  async () => {
    mkdirSync(notesDir, { recursive: true })
    writeFileSync(join(notesDir, 'kept.md'), '# Kept\n\n## A\n\nalpha body\n\n## B\n\nbeta body\n')

    // Round 1: embed the corpus so the partition identity is stamped and every note is
    // fully embedded (embedded_hash == content_hash).
    const s1 = createNotariumStore({ notesDir, indexDb, embedder: mockEmbedder })
    await s1.list()
    await s1.whenVectorsSettled()
    await s1.whenIndexSettled()
    await s1.stop()

    // Bloat WITHOUT disturbing the embedded state (opened vec:true so note_vectors /
    // its trigger stay loadable — the junk table itself never touches them).
    const freeBefore = await bloatIndex(indexDb, 1400, true)
    const sizeBefore = statSync(indexDb).size
    expect(freeBefore).toBeGreaterThan(2000)

    // Round 2: reopen the SAME vector store. Nothing needs (re)embedding (files
    // unchanged), so the embed loop never runs — the boot reclaim (not gated on vecReady
    // anymore) must compact the freelist itself.
    const s2 = createNotariumStore({ notesDir, indexDb, embedder: mockEmbedder })

    try {
      await s2.list()
      await s2.whenVectorsSettled() // confirm no backfill ran / drained
      await s2.whenIndexSettled() // await the boot reclaim
    } finally {
      await s2.stop()
    }

    const sizeAfter = statSync(indexDb).size
    const db = createNodeSqliteDriver(indexDb, { vec: true })
    const freeAfter =
      (await db.get<{ freelist_count: number }>(`PRAGMA freelist_count`))?.freelist_count ?? 0
    await db.close()
    expect(freeAfter).toBeLessThan(512) // reclaimed despite no backfill to trigger it
    expect(sizeAfter).toBeLessThan(sizeBefore / 2)
  },
  20_000,
)

// Runtime trigger (a): removeDir. Deleting a folder/project subtree is the one
// bulk-free path that isn't a boot teardown or an embed re-write — it must compact
// the pages it frees at runtime, not wait for the next boot. FTS-only, deterministic.
it('removeDir compacts the pages a folder delete frees', async () => {
  const proj = join(notesDir, 'proj')
  mkdirSync(proj, { recursive: true })
  // A big enough subtree that deleting it frees well over a reclaim chunk.
  const body = `слово `.repeat(4000) // ~24 KiB per note

  for (let i = 0; i < 150; i++) {
    writeFileSync(join(proj, `n${i}.md`), `# N${i}\n\n${body}\n`)
  }
  writeFileSync(join(notesDir, 'keep.md'), '# Keep\n\nbody\n')

  const store = createNotariumStore({ notesDir, indexDb })

  try {
    await store.list() // index the whole subtree
    await store.whenIndexSettled() // settle any boot reclaim first
    await store.removeDir('proj') // frees ~1200 pages → triggers the reclaim
    await store.whenIndexSettled()
    const notes = await store.list()
    expect(notes.map((n) => n.filePath)).toEqual(['keep.md'])
  } finally {
    await store.stop()
  }

  const sizeAfter = statSync(indexDb).size
  const db = createNodeSqliteDriver(indexDb)
  const freeAfter =
    (await db.get<{ freelist_count: number }>(`PRAGMA freelist_count`))?.freelist_count ?? 0
  await db.close()
  // Without the removeDir trigger the freed subtree pages would linger on the
  // freelist (freeAfter ≈ 1200) and stay in the file; the reclaim drains them.
  expect(freeAfter).toBeLessThan(512)
  expect(sizeAfter).toBeLessThan(800_000) // only keep.md survives — a tiny file
}, 20_000)

// Runtime trigger (b): the embed backfill DRAIN. A vector boot with notes to embed
// SKIPS the boot reclaim (pendingEmbed non-empty), so the ONLY thing that compacts a
// pre-existing freelist is the reclaim fired when runEmbedLoop drains. vec0-gated.
itVector(
  'embed-drain compacts a freelist when the backfill drains',
  async () => {
    // Bloat first (junk table dropped → freelist); on a fresh DB the store then adopts it.
    const freeBefore = await bloatIndex(indexDb, 1400)
    const sizeBefore = statSync(indexDb).size
    expect(freeBefore).toBeGreaterThan(2000)

    // Notes that WILL need embedding → pendingEmbed non-empty at boot → the boot reclaim
    // is skipped, and only the embed-loop drain can compact the junk freelist.
    mkdirSync(notesDir, { recursive: true })
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(notesDir, `n${i}.md`), `# N${i}\n\nbody ${i}\n`)
    }

    const store = createNotariumStore({ notesDir, indexDb, embedder: mockEmbedder })

    try {
      await store.list()
      await store.whenVectorsSettled() // backfill embeds the 3 notes, then drains
      await store.whenIndexSettled() // the drain-triggered reclaim
    } finally {
      await store.stop()
    }

    const sizeAfter = statSync(indexDb).size
    const db = createNodeSqliteDriver(indexDb, { vec: true })
    const freeAfter =
      (await db.get<{ freelist_count: number }>(`PRAGMA freelist_count`))?.freelist_count ?? 0
    await db.close()
    expect(freeAfter).toBeLessThan(512) // only the embed-drain trigger could have done this
    expect(sizeAfter).toBeLessThan(sizeBefore / 2)
  },
  20_000,
)

// The cooperative-drain safety property: the chunked reclaim yields between chunks and
// bails PROMPTLY when a bulk import pauses it (suspendBackground), leaving the freelist
// undrained rather than freezing the loop through a multi-GB vacuum. Injects a scheduler
// whose turn we release by hand so we can pause mid-drain deterministically.
it('reclaim honours suspendBackground mid-drain — bails without draining', async () => {
  // Build the schema through a real (empty) boot, then bloat it.
  mkdirSync(notesDir, { recursive: true })
  const warm = createNotariumStore({ notesDir, indexDb })
  await warm.list()
  await warm.whenIndexSettled()
  await warm.stop()
  const freeBefore = await bloatIndex(indexDb, 1600)
  expect(freeBefore).toBeGreaterThan(2000) // > one RECLAIM_CHUNK_PAGES, so the drain loops

  // A scheduler whose awaitTurn parks until we release it — lets us step the drain.
  let turns = 0

  let releaseTurn: () => void = () => {}
  const scheduler = {
    awaitTurn: () =>
      new Promise<void>((res) => {
        turns++
        releaseTurn = () => res()
      }),
  }

  // notesDir stays empty → nothing pending → boot schedules the reclaim.
  const store = createNotariumStore({ notesDir, indexDb, scheduler })

  try {
    await store.list() // ensureReady → reclaim starts, parks on the first awaitTurn
    // Wait until the drain is parked on its first yield (before any incremental_vacuum).
    // Generous budget so heavy parallel-suite CPU contention can't time the poll out; the
    // reclaim can only ever reach turn 1 here (it parks until we release), never beyond.
    for (let i = 0; i < 600 && turns < 1; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(turns).toBeGreaterThanOrEqual(1)
    // Pause BEFORE releasing: the loop re-tests the gate after the await and must break
    // out before running a single incremental_vacuum.
    store.suspendBackground()
    releaseTurn()
    await store.whenIndexSettled()
  } finally {
    await store.stop()
  }

  const db = createNodeSqliteDriver(indexDb)
  const freeAfter =
    (await db.get<{ freelist_count: number }>(`PRAGMA freelist_count`))?.freelist_count ?? 0
  await db.close()
  // Bailed at the chunk boundary — the freelist is untouched (no vacuum ran).
  expect(freeAfter).toBe(freeBefore)
}, 20_000)
