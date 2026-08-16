// Vector write-path: an embedder + the vec0 driver wired into the
// engine must index notes in the background, invalidate by content_hash (a touch
// with unchanged content does NOT re-embed), cascade-delete a note's vectors, and
// rebuild the partition when the embedder/chunker identity drifts. Uses the REAL
// vec0 extension (so the schema/DDL/bindings are exercised for real) with a
// DETERMINISTIC mock embedder — no onnxruntime, so it's fast and hermetic. The
// suite skips where the vec0 native binary can't load (musl/alpine CI); the live
// onnxruntime path is proven separately on the stand.

import { promises as fs, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { SearchResult } from '@notarium/core'

import type { Chunker } from '../../libs/chunking'
import type { Embedder } from '../../libs/embedding'
import { createLocalFsFiles } from '../../libs/files'
import { createNodeSqliteDriver, type SqlDriver } from '../../libs/sql'
import { NotariumStore } from './notariumStore'
import type { EngineMount } from './types'
import { describeVector } from './vectorGate.fixture'

/** A deterministic, instant embedder: a vector is derived from the text bytes so
 *  distinct texts get distinct directions, L2-normalized. Counts calls so a test
 *  can assert that an unchanged note did NOT re-embed. */
const countingEmbedder = (id = 'mock@v1', dimensions = 8) => {
  let textCount = 0
  const embedder: Embedder = {
    id,
    dimensions,
    embed: async (texts) => {
      textCount += texts.length
      return texts.map((t) => {
        const v = new Float32Array(dimensions)

        for (let i = 0; i < t.length; i++) {
          v[i % dimensions] += t.charCodeAt(i) + 1
        }
        let norm = 0

        for (const x of v) {
          norm += x * x
        }
        norm = Math.sqrt(norm) || 1
        for (let i = 0; i < dimensions; i++) {
          v[i] /= norm
        }

        return v
      })
    },
  }
  return {
    embedder,
    get textCount() {
      return textCount
    },
  }
}

const userMount = (dir: string): EngineMount => ({
  class: 'user-doc',
  prefix: '',
  files: createLocalFsFiles(dir),
})
const agentMount = (dir: string): EngineMount => ({
  class: 'agent-memory',
  prefix: '.notarium/memory',
  files: createLocalFsFiles(join(dir, '.notarium/memory')),
})

/** write() returns filePath as optional (wire divergence); the notarium engine
 *  always sets it — narrow it for the assertions. */
const writePath = async (
  store: NotariumStore,
  input: Parameters<NotariumStore['write']>[0],
): Promise<string> => {
  const r = await store.write(input)

  if (!r.filePath) {
    throw new Error('write returned no filePath')
  }

  return r.filePath
}

const vecCount = (sql: SqlDriver, where = '', params: (string | number | bigint)[] = []) =>
  sql
    .get<{ n: number }>(`SELECT count(*) AS n FROM note_vectors ${where}`, params)
    .then((r) => r?.n ?? 0)

describeVector('NotariumStore vector indexing', () => {
  let notesDir: string

  beforeEach(() => {
    notesDir = mkdtempSync(join(tmpdir(), 'notarium-vec-'))
  })
  afterEach(() => {
    rmSync(notesDir, { recursive: true, force: true })
  })

  it('reports vector/hybrid true once an embedder is wired in', () => {
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const store = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql,
      embedder: countingEmbedder().embedder,
    })
    expect(store.capabilities.vector).toBe(true)
    expect(store.capabilities.hybrid).toBe(true)
    return store.stop()
  })

  it('embeds a written note in the background, carrying class + content_hash', async () => {
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const store = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql,
      embedder: countingEmbedder().embedder,
    })

    try {
      const filePath = await writePath(store, { title: 'Cat', content: 'A small feline.' })
      await store.whenVectorsSettled()
      const row = await sql.get<{
        note_rowid: number
        class: string
        content_hash: string
        chunk_index: number
      }>(
        `SELECT v.note_rowid, v.class, v.content_hash, v.chunk_index
         FROM note_vectors v JOIN notes n ON n.rowid = v.note_rowid
         WHERE n.path = ?`,
        [filePath],
      )
      expect(row).toBeTruthy()
      expect(row!.class).toBe('user-doc')
      expect(row!.chunk_index).toBe(0)
      // The vector's hash matches the note's — the invalidation key (P13).
      const note = await sql.get<{ content_hash: string }>(
        `SELECT content_hash FROM notes WHERE path = ?`,
        [filePath],
      )
      expect(row!.content_hash).toBe(note!.content_hash)
    } finally {
      await store.stop()
    }
  })

  it('a touch with unchanged content does NOT re-embed', async () => {
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const counter = countingEmbedder()
    const store = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql,
      embedder: counter.embedder,
    })

    try {
      const filePath = await writePath(store, { title: 'Stable', content: 'unchanging prose.' })
      await store.whenVectorsSettled()
      const afterFirst = counter.textCount
      expect(afterFirst).toBe(1)
      // Re-save identical content onto the SAME note: same content_hash → skip. Addressed by
      // originalId because a second create onto an occupied path is refused (#274) — a touch
      // is an edit, which is also how every channel that re-saves reaches the engine.
      await store.write({ title: 'Stable', content: 'unchanging prose.', originalId: filePath })
      await store.whenVectorsSettled()
      expect(counter.textCount).toBe(afterFirst) // no new embed
      expect(await vecCount(sql)).toBe(1)
    } finally {
      await store.stop()
    }
  })

  it('a content edit re-embeds and replaces the vector (single-chunk)', async () => {
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const counter = countingEmbedder()
    const store = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql,
      embedder: counter.embedder,
    })

    try {
      const filePath = await writePath(store, { title: 'Edited', content: 'first body.' })
      await store.whenVectorsSettled()
      const hash1 = (await sql.get<{ content_hash: string }>(
        `SELECT content_hash FROM notes WHERE path = ?`,
        [filePath],
      ))!.content_hash
      await store.write({
        title: 'Edited',
        content: 'a wholly different body.',
        originalId: filePath,
      })
      await store.whenVectorsSettled()
      expect(counter.textCount).toBe(2) // re-embedded
      expect(await vecCount(sql)).toBe(1) // replaced, not duplicated
      const hash2 = (await sql.get<{ content_hash: string }>(
        `SELECT content_hash FROM notes WHERE path = ?`,
        [filePath],
      ))!.content_hash
      expect(hash2).not.toBe(hash1)
      const vhash = (await sql.get<{ content_hash: string }>(
        `SELECT content_hash FROM note_vectors LIMIT 1`,
      ))!.content_hash
      expect(vhash).toBe(hash2)
    } finally {
      await store.stop()
    }
  })

  it('a same-size, same-mtime external edit invalidates and replaces the vector', async () => {
    const path = join(notesDir, 'external.md')
    const fixedTime = new Date('2026-07-23T12:00:00.000Z')
    await fs.writeFile(path, '# Probe\n\nAAAA')
    await fs.utimes(path, fixedTime, fixedTime)
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const counter = countingEmbedder()
    const store = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql,
      embedder: counter.embedder,
      integritySweepBatchSize: 0,
    })

    try {
      const seed = await store.changes(null)
      await store.whenVectorsSettled()
      const beforeEmbeds = counter.textCount
      const beforeHash = (
        await sql.get<{ content_hash: string }>(
          `SELECT content_hash FROM notes WHERE path = 'external.md'`,
        )
      )?.content_hash

      // Isolate the LocalFS change-token route: bytes change, while size and
      // mtime remain exactly the values already recorded in the index.
      await new Promise((resolve) => setTimeout(resolve, 20))
      await fs.writeFile(path, '# Probe\n\nBBBB')
      await fs.utimes(path, fixedTime, fixedTime)
      const delta = await store.changes(seed.cursor)
      await store.whenVectorsSettled()

      expect(delta.upserts.map((item) => item.meta.filePath)).toContain('external.md')
      expect(counter.textCount).toBeGreaterThan(beforeEmbeds)
      const hashes = await sql.get<{ note_hash: string; vector_hash: string }>(
        `SELECT notes.content_hash AS note_hash, note_vectors.content_hash AS vector_hash
         FROM notes JOIN note_vectors ON note_vectors.note_rowid = notes.rowid
         WHERE notes.path = 'external.md'`,
      )
      expect(hashes?.note_hash).not.toBe(beforeHash)
      expect(hashes?.vector_hash).toBe(hashes?.note_hash)
    } finally {
      await store.stop()
    }
  })

  it('deleting a note cascades to its vectors (trigger)', async () => {
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const store = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql,
      embedder: countingEmbedder().embedder,
    })

    try {
      const filePath = await writePath(store, { title: 'Doomed', content: 'soon gone.' })
      await store.whenVectorsSettled()
      expect(await vecCount(sql)).toBe(1)
      await store.remove(filePath)
      expect(await vecCount(sql)).toBe(0)
    } finally {
      await store.stop()
    }
  })

  it('a removed note that vanishes externally drops its vectors on the next read', async () => {
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const store = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql,
      embedder: countingEmbedder().embedder,
    })

    try {
      const filePath = await writePath(store, { title: 'Ghost', content: 'here then gone.' })
      await store.whenVectorsSettled()
      expect(await vecCount(sql)).toBe(1)
      // Delete the file out from under the engine; read() must drop the stale row
      // (and its vectors, via the cascade trigger).
      rmSync(join(notesDir, 'ghost.md'))
      await expect(store.read(filePath)).rejects.toMatchObject({ isNotFound: true })
      expect(await vecCount(sql)).toBe(0)
    } finally {
      await store.stop()
    }
  })

  it('stores the mount class on agent-memory vectors (for the visibility post-filter)', async () => {
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const store = new NotariumStore({
      mounts: [userMount(notesDir), agentMount(notesDir)],
      sql,
      embedder: countingEmbedder().embedder,
    })

    try {
      await store.write({ title: 'Memory', content: 'private note.', targetClass: 'agent-memory' })
      await store.write({ title: 'Doc', content: 'public note.' })
      await store.whenVectorsSettled()
      expect(await vecCount(sql, `WHERE class = ?`, ['agent-memory'])).toBe(1)
      expect(await vecCount(sql, `WHERE class = ?`, ['user-doc'])).toBe(1)
    } finally {
      await store.stop()
    }
  })

  it('rebuilds the partition when the embedder id changes (P13), backfilling on boot', async () => {
    const dbFile = join(mkdtempSync(join(tmpdir(), 'notarium-vec-db-')), 'index.db')
    // First boot: model v1 embeds the note.
    const c1 = countingEmbedder('mock@v1')
    const sqlA = createNodeSqliteDriver(dbFile, { vec: true })
    const storeA = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql: sqlA,
      embedder: c1.embedder,
    })
    await storeA.write({ title: 'Drift', content: 'embed me.' })
    await storeA.whenVectorsSettled()
    expect(c1.textCount).toBe(1)
    await storeA.stop()

    // Second boot on the SAME index DB with a DIFFERENT embedder id → the stored
    // vectors are incomparable → wipe + backfill re-embeds with v2.
    const sqlB = createNodeSqliteDriver(dbFile, { vec: true })
    const c2 = countingEmbedder('mock@v2')
    const storeB = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql: sqlB,
      embedder: c2.embedder,
    })
    await storeB.list() // drive ensureReady → setup + backfill enqueue
    await storeB.whenVectorsSettled()
    expect(c2.textCount).toBe(1) // re-embedded under the new model
    expect(await vecCount(sqlB)).toBe(1)
    const idMeta = await sqlB.get<{ value: string }>(
      `SELECT value FROM meta WHERE key = 'embedder_id'`,
    )
    expect(idMeta?.value).toBe('mock@v2')
    await storeB.stop()

    rmSync(dbFile, { force: true })
  })

  it('migrates a real legacy partition-key table to flat on boot, re-embedding even with an unchanged model', async () => {
    const dbFile = join(mkdtempSync(join(tmpdir(), 'notarium-vec-db-')), 'index.db')
    // First boot builds the index at the current layout (flat, vec_layout_version=2).
    const c1 = countingEmbedder('mock@v1')
    const sqlA = createNodeSqliteDriver(dbFile, { vec: true })
    const storeA = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql: sqlA,
      embedder: c1.embedder,
    })
    await storeA.write({ title: 'Layout', content: 'embed me once.' })
    await storeA.whenVectorsSettled()
    expect(c1.textCount).toBe(1)

    // Downgrade the on-disk index to the genuine legacy shape: a note_vectors with
    // `note_rowid integer partition key` (the old DDL), carrying a stale vector, and
    // NO vec_layout_version marker. The completeness sentinel (notes.embedded_hash)
    // stays equal to content_hash — so ONLY the layout drift can force a re-embed.
    // This exercises the actual migration: VEC_TEARDOWN must physically drop a
    // PARTITION-KEY table and rebuild it flat (the plain key-delete variant only hit
    // the code branch on an already-flat table).
    await sqlA.exec('DROP TRIGGER IF EXISTS notes_vec_ad')
    await sqlA.exec('DROP TABLE note_vectors')
    await sqlA.exec(
      `CREATE VIRTUAL TABLE note_vectors USING vec0(
         note_rowid integer partition key, content_hash text, class text,
         +chunk_index integer, +chunk_text text, embedding float[8] distance_metric=cosine)`,
    )
    await sqlA.run(
      `INSERT INTO note_vectors (note_rowid, content_hash, class, chunk_index, chunk_text, embedding)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        BigInt(1),
        'stale',
        'user-doc',
        BigInt(0),
        'old',
        new Uint8Array(new Float32Array(8).fill(0.1).buffer),
      ],
    )
    const before = await sqlA.get<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE name = 'note_vectors'`,
    )
    expect(/partition key/i.test(before?.sql ?? '')).toBe(true) // genuinely the old shape
    await sqlA.run(`DELETE FROM meta WHERE key = 'vec_layout_version'`)
    await storeA.stop()

    // Second boot with the SAME embedder identity (id/chunker/dims all match): not a
    // model drift — the layout alone is stale → drop the partition-key table, rebuild
    // flat, re-embed from the files.
    const sqlB = createNodeSqliteDriver(dbFile, { vec: true })
    const c2 = countingEmbedder('mock@v1')
    const storeB = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql: sqlB,
      embedder: c2.embedder,
    })
    await storeB.list() // drive ensureReady → setup + backfill enqueue
    await storeB.whenVectorsSettled()
    expect(c2.textCount).toBe(1) // re-embedded despite the unchanged model
    expect(await vecCount(sqlB)).toBe(1) // the stale vector is gone, the real one re-landed
    const layout = await sqlB.get<{ value: string }>(
      `SELECT value FROM meta WHERE key = 'vec_layout_version'`,
    )
    expect(layout?.value).toBe('2')
    // The rebuilt table is flat — the partition key the old DDL carried is gone.
    const after = await sqlB.get<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE name = 'note_vectors'`,
    )
    expect(/partition key/i.test(after?.sql ?? '')).toBe(false)
    await storeB.stop()

    rmSync(dbFile, { force: true })
  })

  // ── Review regressions ─────────────────────────────

  it('reopening a vec-ON index WITHOUT an embedder does not crash on delete', async () => {
    const dbFile = join(mkdtempSync(join(tmpdir(), 'notarium-vec-db-')), 'index.db')
    // Boot vec-ON: creates note_vectors + the AFTER DELETE cascade trigger.
    const sqlOn = createNodeSqliteDriver(dbFile, { vec: true })
    const storeOn = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql: sqlOn,
      embedder: countingEmbedder().embedder,
    })
    await storeOn.write({ title: 'Survivor', content: 'keep me.' })
    const doomed = await writePath(storeOn, { title: 'Doomed Off', content: 'delete me later.' })
    await storeOn.whenVectorsSettled()
    await storeOn.stop()

    // Reboot WITHOUT an embedder (operator turned vector off, or a degraded host):
    // vec0 is NOT loaded, but the leftover notes_vec_ad trigger references it. A
    // delete must NOT throw "no such module: vec0" — the trigger is dropped on boot.
    const sqlOff = createNodeSqliteDriver(dbFile) // no vec extension
    const storeOff = new NotariumStore({ mounts: [userMount(notesDir)], sql: sqlOff })

    try {
      expect(storeOff.capabilities.vector).toBe(false)
      await expect(storeOff.remove(doomed)).resolves.toBeUndefined()
      const left = await storeOff.list()
      expect(left.some((n) => n.title === 'Doomed Off')).toBe(false)
      expect(left.some((n) => n.title === 'Survivor')).toBe(true)
    } finally {
      await storeOff.stop()
      rmSync(dbFile, { force: true })
    }
  })

  it('a note deleted DURING its embed is not resurrected as an orphan vector', async () => {
    // A gated embedder lets the test delete the note while embed() is in flight —
    // the multi-second window the rowid-recycle / orphan-resurrection bug lived in.
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    let calls = 0
    const embedder: Embedder = {
      id: 'gated@v1',
      dimensions: 8,
      embed: async (texts) => {
        calls++
        await gate
        return texts.map(() => new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]))
      },
    }
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const store = new NotariumStore({ mounts: [userMount(notesDir)], sql, embedder })

    try {
      const filePath = await writePath(store, { title: 'Vanish', content: 'mid-embed delete.' })

      // Wait until the embed loop has entered embed() (blocked on the gate).
      for (let i = 0; i < 200 && calls === 0; i++) {
        await new Promise((r) => setTimeout(r, 5))
      }
      expect(calls).toBe(1)
      // Delete the note while its embedding is in flight.
      await store.remove(filePath)
      // Let the embed finish: embedNote must re-read, see the row is gone, and bail.
      release()
      await store.whenVectorsSettled()
      expect(await vecCount(sql)).toBe(0) // no orphan resurrected
    } finally {
      release()
      await store.stop()
    }
  })

  it('a wrong-dimension embed does not wipe the existing vector (validate before delete)', async () => {
    let n = 0
    const embedder: Embedder = {
      id: 'flaky@v1',
      dimensions: 8,
      embed: async (texts) => {
        n++
        const dim = n === 1 ? 8 : 4 // second embed returns the wrong width
        return texts.map(() => new Float32Array(dim))
      },
    }
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const store = new NotariumStore({ mounts: [userMount(notesDir)], sql, embedder })

    try {
      const filePath = await writePath(store, { title: 'KeepDim', content: 'first.' })
      await store.whenVectorsSettled()
      expect(await vecCount(sql)).toBe(1)
      // Edit → re-embed returns dim-4 → embedNote must throw BEFORE the DELETE, so
      // the good vector survives rather than being wiped then failing the INSERT.
      await store.write({ title: 'KeepDim', content: 'second body.', originalId: filePath })
      await store.whenVectorsSettled()
      expect(await vecCount(sql)).toBe(1) // not wiped — fail closed
    } finally {
      await store.stop()
    }
  })

  // ── Hybrid read-path: RRF over FTS5 + vec0 ─────────────────────
  //
  // A lookup-table embedder maps an EXACT embed-input string to a fixed vector, so
  // a test controls which note is "semantically near" a query INDEPENDENTLY of the
  // lexical content — the only way to assert "vector finds what FTS can't". A note
  // embeds its chunker output (`title\n\nbody` for a no-heading note under the
  // heading-first default); a query
  // embeds its raw text. Anything not in the table gets the orthogonal `fallback`
  // (a far vector), so decoys never accidentally sit near the query.
  const mapEmbedder = (
    table: Record<string, number[]>,
    opts: { id?: string; dim?: number; fallback?: number[] } = {},
  ): Embedder => {
    const dim = opts.dim ?? 4
    const fallback = opts.fallback ?? Array.from({ length: dim }, (_, i) => (i === dim - 1 ? 1 : 0))

    const norm = (a: number[]): Float32Array => {
      const v = Float32Array.from(a.length === dim ? a : fallback)
      let n = 0

      for (const x of v) {
        n += x * x
      }
      n = Math.sqrt(n) || 1
      for (let i = 0; i < dim; i++) {
        v[i] /= n
      }

      return v
    }

    return {
      id: opts.id ?? 'map@v1',
      dimensions: dim,
      embed: async (texts) => texts.map((t) => norm(table[t] ?? fallback)),
    }
  }

  /** A 2-chunk chunker (`body` split on a `---` line) so the chunk→note collapse is
   *  actually exercised — the default heading-first chunker yields one chunk for the
   *  no-heading notes used here. */
  const splitChunker: Chunker = {
    version: 'split-test-v1',
    chunk: ({ title, body }) =>
      body
        .split('\n---\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((text, index) => ({ index, text: `${title}\n\n${text}` })),
  }

  it('reports vector/hybrid capability and serves hybrid results', async () => {
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const store = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql,
      embedder: mapEmbedder({ 'Doc\n\nbody about cats': [1, 0, 0, 0], cats: [1, 0, 0, 0] }),
    })

    try {
      await store.write({ title: 'Doc', content: 'body about cats' })
      await store.whenVectorsSettled()
      expect(store.capabilities.hybrid).toBe(true)
      const hits = await store.search('cats')
      expect(hits.some((h) => h.title === 'Doc')).toBe(true)
      for (const h of hits) {
        expect(typeof h.snippet).toBe('string')
        expect(typeof h.score).toBe('number')
      }
    } finally {
      await store.stop()
    }
  })

  it('finds a semantic hit with NO lexical overlap that FTS alone misses (DoD)', async () => {
    // "Feline Friend / purrs softly" embeds near the query "cat", but shares no
    // token with it — the vector channel is the only way to reach it.
    const table = {
      'Feline Friend\n\npurrs softly all day': [1, 0, 0, 0],
      cat: [1, 0, 0, 0],
      'Dog Diary\n\nbarks loudly at noon': [0, 0, 0, 1],
    }
    // Hybrid store finds it.
    const sqlH = createNodeSqliteDriver(':memory:', { vec: true })
    const hybrid = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql: sqlH,
      embedder: mapEmbedder(table),
    })
    // FTS-only store over the SAME files finds nothing for "cat".
    const sqlF = createNodeSqliteDriver(':memory:')
    const fts = new NotariumStore({ mounts: [userMount(notesDir)], sql: sqlF })

    try {
      await hybrid.write({ title: 'Feline Friend', content: 'purrs softly all day' })
      await hybrid.write({ title: 'Dog Diary', content: 'barks loudly at noon' })
      await hybrid.whenVectorsSettled()

      const hybridHits = await hybrid.search('cat')
      expect(hybridHits.some((h) => h.title === 'Feline Friend')).toBe(true)

      const ftsHits = await fts.search('cat')
      expect(ftsHits.some((h) => h.title === 'Feline Friend')).toBe(false)
      expect(ftsHits.length).toBe(0) // "cat" is in no note's text
    } finally {
      await hybrid.stop()
      await fts.stop()
    }
  })

  it('RRF lifts a note matching BOTH channels above a single-channel match', async () => {
    const table = {
      // both: lexical "cat" AND near the query vector
      'Apex\n\na cat essay': [1, 0, 0, 0],
      // vector-only: near the query, no "cat" token
      'Feline\n\npurrs softly': [1, 0, 0, 0],
      // lexical-only: has "cat", far vector
      'Plain\n\ncat cat cat': [0, 0, 0, 1],
      cat: [1, 0, 0, 0],
    }
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const store = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql,
      embedder: mapEmbedder(table),
    })

    try {
      await store.write({ title: 'Apex', content: 'a cat essay' })
      await store.write({ title: 'Feline', content: 'purrs softly' })
      await store.write({ title: 'Plain', content: 'cat cat cat' })
      await store.whenVectorsSettled()
      const hits = await store.search('cat')
      const titles = hits.map((h) => h.title)
      // All three reachable; the both-channels note fuses to the top.
      expect(titles).toContain('Apex')
      expect(titles).toContain('Feline')
      expect(titles).toContain('Plain')
      expect(hits[0].title).toBe('Apex')
    } finally {
      await store.stop()
    }
  })

  it('collapses a multi-chunk note to ONE result (best chunk wins)', async () => {
    const table = {
      'Split\n\nfirst part about rivers': [1, 0, 0, 0],
      'Split\n\nsecond part about mountains': [0, 1, 0, 0],
      rivers: [1, 0, 0, 0],
    }
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const store = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql,
      embedder: mapEmbedder(table),
      chunker: splitChunker,
    })

    try {
      await store.write({
        title: 'Split',
        content: 'first part about rivers\n---\nsecond part about mountains',
      })
      await store.whenVectorsSettled()
      // Two vectors stored (one per chunk)…
      expect(await vecCount(sql)).toBe(2)
      // …but the note appears exactly once in the fused results.
      const hits = await store.search('rivers')
      expect(hits.filter((h) => h.title === 'Split').length).toBe(1)
    } finally {
      await store.stop()
    }
  })

  it('every hybrid hit carries its class (the read-model visibility post-filter)', async () => {
    const table = {
      'Secret\n\nshared topic alpha': [1, 0, 0, 0],
      'Public\n\nshared topic alpha': [1, 0, 0, 0],
      shared: [1, 0, 0, 0],
    }
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const store = new NotariumStore({
      mounts: [userMount(notesDir), agentMount(notesDir)],
      sql,
      embedder: mapEmbedder(table),
    })

    try {
      await store.write({
        title: 'Secret',
        content: 'shared topic alpha',
        targetClass: 'agent-memory',
      })
      await store.write({ title: 'Public', content: 'shared topic alpha' })
      await store.whenVectorsSettled()
      // The bare engine returns BOTH (visibility is the read-model's job); each hit
      // must carry its class so that chokepoint can drop the hidden one.
      const hits = await store.search('shared')
      const secret = hits.find((h) => h.title === 'Secret')
      const pub = hits.find((h) => h.title === 'Public')
      expect(secret?.class).toBe('agent-memory')
      expect(pub?.class).toBe('user-doc')
    } finally {
      await store.stop()
    }
  })

  it('a VECTOR-ONLY agent-memory hit still carries its class (the leak guard)', async () => {
    // The highest-stakes case: a note FTS would NEVER return (no shared token),
    // reachable only through the vec side of the FULL OUTER JOIN. Its class must
    // ride through COALESCE(fts.note_rowid, vec.note_rowid) so the read-model can
    // drop it from user search — a regression that joins on fts.note_rowid alone,
    // or nulls class on a vec-only row, would fail HERE (and silently leak memory).
    const table = {
      'Feline Friend\n\npurrs softly all day': [1, 0, 0, 0], // agent-memory, no "qzxq" token
      qzxq: [1, 0, 0, 0], // query lands near it via the vector channel only
    }
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const store = new NotariumStore({
      mounts: [userMount(notesDir), agentMount(notesDir)],
      sql,
      embedder: mapEmbedder(table),
    })

    try {
      await store.write({
        title: 'Feline Friend',
        content: 'purrs softly all day',
        targetClass: 'agent-memory',
      })
      await store.whenVectorsSettled()
      const hits = await store.search('qzxq') // FTS finds nothing; only the vector reaches it
      const feline = hits.find((h) => h.title === 'Feline Friend')
      expect(feline).toBeTruthy() // proves the vec-only branch fired
      expect(feline?.class).toBe('agent-memory') // …and carried the hidden class
    } finally {
      await store.stop()
    }
  })

  it('search stays on FTS (instantly, no block) until the model warms, then fuses (vectorWarm)', async () => {
    // The cold-load cliff guard: while the background (passage) embed is still in
    // flight — the model not yet loaded — a search must answer from FTS WITHOUT
    // calling the query embed (which would block on the cold load). Proven by the
    // query-embed counter: 0 while cold, 1 once warm.
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    let passageCalls = 0
    let queryCalls = 0
    const embedder: Embedder = {
      id: 'gated-warm@v1',
      dimensions: 4,
      embed: async (texts, kind) => {
        if (kind === 'query') {
          queryCalls++
        }
        if (kind === 'passage') {
          passageCalls++
          await gate // simulate the cold model: the first embed blocks
        }

        return texts.map(() => Float32Array.from([1, 0, 0, 0]))
      },
    }
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const store = new NotariumStore({ mounts: [userMount(notesDir)], sql, embedder })

    try {
      await store.write({ title: 'Note', content: 'keyword body' })
      // Wait until the embed loop has entered the (gated) passage embed: cold.
      for (let i = 0; i < 200 && passageCalls === 0; i++) {
        await new Promise((r) => setTimeout(r, 5))
      }
      expect(passageCalls).toBe(1)
      // Cold search: FTS branch, finds the lexical hit, NEVER calls the query embed.
      const cold = await store.search('keyword')
      expect(cold.some((h) => h.title === 'Note')).toBe(true)
      expect(queryCalls).toBe(0) // hybrid branch not taken while cold — no block
      // Warm up: release the embed → vectorWarm flips.
      release()
      await store.whenVectorsSettled()
      // Warm search: hybrid branch now runs (the query embed is consulted).
      const warm = await store.search('keyword')
      expect(warm.some((h) => h.title === 'Note')).toBe(true)
      expect(queryCalls).toBe(1)
    } finally {
      release()
      await store.stop()
    }
  })

  it('a failed boot warmup is retried by a later search, then recovers to hybrid (vectorWarm self-heal)', async () => {
    // The quiescent-corpus gap (final sweep): with nothing to embed, the ONLY path to
    // vectorWarm is warmup() — the background embed (which also flips it) never runs. If a
    // boot warmup FAILS (transient model load), no write re-triggers it, so the store
    // would serve FTS-only forever while capabilities.vector reads true. search() must
    // re-kick warmup on a cold query so it self-heals. Empty corpus = the quiescent case.
    let queryCalls = 0
    let warmupAttempts = 0
    let ctl: { resolve: () => void; reject: (e: Error) => void } | undefined
    const embedder: Embedder = {
      id: 'gated-warmup@v1',
      dimensions: 4,
      warmup: () => {
        warmupAttempts++
        return new Promise<void>((resolve, reject) => {
          ctl = { resolve, reject }
        })
      },
      embed: async (texts, kind) => {
        if (kind === 'query') {
          queryCalls++
        }

        return texts.map(() => Float32Array.from([1, 0, 0, 0]))
      },
    }
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const store = new NotariumStore({ mounts: [userMount(notesDir)], sql, embedder }) // empty corpus
    const drain = () => new Promise((r) => setTimeout(r, 0))

    try {
      // First search lazily boots ensureReady → kicks warmup #1 (still pending) and
      // answers from FTS (empty corpus) WITHOUT embedding the query (cold).
      expect(await store.search('anything')).toEqual([])
      expect(warmupAttempts).toBe(1)
      expect(queryCalls).toBe(0)
      // Warmup #1 FAILS — must NOT poison the store (the embedder no longer caches the
      // rejection, and warmingVector resets so a later kick re-attempts).
      ctl!.reject(new Error('transient model load failure'))
      await drain()
      // A later cold search RE-KICKS warmup (self-heal) — attempt #2 — still on FTS.
      expect(await store.search('anything')).toEqual([])
      expect(warmupAttempts).toBe(2)
      expect(queryCalls).toBe(0)
      // Warmup #2 SUCCEEDS → vectorWarm flips → search now takes the hybrid branch
      // (the query embed is consulted), recovered without any write.
      ctl!.resolve()
      await drain()
      expect(await store.search('anything')).toEqual([])
      expect(queryCalls).toBe(1)
    } finally {
      ctl?.resolve()
      await store.stop()
    }
  })

  it('a query that cannot embed degrades to FTS rather than throwing', async () => {
    // Passage embeds SUCCEED (so the note indexes and the store goes warm → search
    // takes the hybrid branch), but the QUERY embed throws — hybridSearch must catch
    // it and fall back to FTS for that query rather than 500.
    const embedder: Embedder = {
      id: 'query-breaks@v1',
      dimensions: 4,
      embed: async (texts, kind) => {
        if (kind === 'query') {
          throw new Error('query model exploded')
        }

        return texts.map(() => Float32Array.from([1, 0, 0, 0]))
      },
    }
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const store = new NotariumStore({ mounts: [userMount(notesDir)], sql, embedder })

    try {
      await store.write({ title: 'Lexical', content: 'findable by keyword' })
      await store.whenVectorsSettled() // passage embed succeeds → store is warm
      const hits = await store.search('keyword') // query embed throws → FTS fallback
      expect(hits.some((h) => h.title === 'Lexical')).toBe(true)
    } finally {
      await store.stop()
    }
  })

  // ── Stage 3: heading-first chunker fallout — per-chunk snippet + completeness ──

  it('a vector-only hit shows the matched CHUNK as its snippet, not a blind body-head', async () => {
    // "qzxq" lands (by the table) near the rivers chunk but appears in no note's
    // text → vector-only. The snippet must be the rivers chunk, NOT the mountains
    // chunk and NOT the body-head (which would contain BOTH, since both are in the
    // first 200 chars of the body).
    const table = {
      'Split\n\nfirst part about rivers': [1, 0, 0, 0],
      'Split\n\nsecond part about mountains': [0, 1, 0, 0],
      qzxq: [1, 0, 0, 0],
    }
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const store = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql,
      embedder: mapEmbedder(table),
      chunker: splitChunker,
    })

    try {
      await store.write({
        title: 'Split',
        content: 'first part about rivers\n---\nsecond part about mountains',
      })
      await store.whenVectorsSettled()
      const hit = (await store.search('qzxq')).find((h) => h.title === 'Split')
      expect(hit).toBeTruthy() // the vec-only branch fired
      expect(hit!.snippet).toContain('rivers')
      expect(hit!.snippet).not.toContain('mountains') // proves best_chunk, not body_head
    } finally {
      await store.stop()
    }
  })

  it('a multi-chunk note sets the completeness sentinel; an unchanged touch does not re-embed', async () => {
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const counter = countingEmbedder('mc@v1')
    const store = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql,
      embedder: counter.embedder,
      chunker: splitChunker,
    })

    try {
      const fp = await writePath(store, { title: 'Multi', content: 'alpha\n---\nbeta' })
      await store.whenVectorsSettled()
      expect(await vecCount(sql)).toBe(2) // two chunks embedded
      expect(counter.textCount).toBe(2)
      // The sentinel: embedded_hash == content_hash once ALL chunks landed.
      const r = await sql.get<{ c: string | null; e: string | null }>(
        `SELECT content_hash AS c, embedded_hash AS e FROM notes WHERE path = ?`,
        [fp],
      )
      expect(r!.e).toBe(r!.c)
      // Touch identical content on the same note (an edit — see the single-chunk case):
      // same hash → no re-embed.
      await store.write({ title: 'Multi', content: 'alpha\n---\nbeta', originalId: fp })
      await store.whenVectorsSettled()
      expect(counter.textCount).toBe(2)
      expect(await vecCount(sql)).toBe(2)
    } finally {
      await store.stop()
    }
  })

  it('recovers a crash-interrupted (partial) multi-chunk embed on the next boot', async () => {
    const dbFile = join(mkdtempSync(join(tmpdir(), 'notarium-vec-mc-')), 'index.db')
    const sqlA = createNodeSqliteDriver(dbFile, { vec: true })
    const storeA = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql: sqlA,
      embedder: countingEmbedder('mc2@v1').embedder,
      chunker: splitChunker,
    })
    const fp = await writePath(storeA, { title: 'Crash', content: 'one\n---\ntwo' })
    await storeA.whenVectorsSettled()
    expect(await vecCount(sqlA)).toBe(2)
    await storeA.stop()

    // Forge the crash signature: a PARTIAL set (one chunk) survives, and the
    // completeness sentinel was never set (NULL). A "a vector exists for this hash"
    // predicate would call this done and never recover; embedded_hash must catch it.
    const fix = createNodeSqliteDriver(dbFile, { vec: true })
    await fix.run(`DELETE FROM note_vectors WHERE chunk_index = 1`)
    await fix.run(`UPDATE notes SET embedded_hash = NULL`)
    expect(await vecCount(fix)).toBe(1)
    await fix.close()

    // Reboot with the SAME embedder id + chunker (no partition wipe — a pure
    // backfill): the incomplete note must re-embed BOTH chunks.
    const sqlB = createNodeSqliteDriver(dbFile, { vec: true })
    const c2 = countingEmbedder('mc2@v1')
    const storeB = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql: sqlB,
      embedder: c2.embedder,
      chunker: splitChunker,
    })

    try {
      await storeB.list() // ensureReady → backfill enqueues the incomplete note
      await storeB.whenVectorsSettled()
      expect(c2.textCount).toBe(2) // both chunks re-embedded
      expect(await vecCount(sqlB)).toBe(2) // partition complete again
      const r = await sqlB.get<{ c: string | null; e: string | null }>(
        `SELECT content_hash AS c, embedded_hash AS e FROM notes WHERE path = ?`,
        [fp],
      )
      expect(r!.e).toBe(r!.c) // sentinel restored
    } finally {
      await storeB.stop()
      rmSync(dbFile, { force: true })
    }
  })

  // ── Stage 4b: hub-robust 1-hop graph channel ──────────────────────────────────
  //
  // The graph channel is a third RRF channel: the top fused fts+vec hits SEED a
  // 1-hop wikilink expansion, neighbours are down-weighted by 1/√degree and the top
  // global hubs are blacklisted. On the only real corpus the gold is
  // single-relevant known-item over a hub-bipartite graph, so it can't REWARD graph
  // expansion — the channel's QUALITY is proven HERE on a synthetic graph where it
  // genuinely helps (a relevant note reachable only via a link), the corpus eval is
  // mechanics-validation (hub-suppression, no-regression).

  const rankOf = (hits: SearchResult[], title: string): number =>
    hits.findIndex((h) => h.title === title)

  const scoreOf = (hits: SearchResult[], title: string): number => {
    const h = hits.find((x) => x.title === title)

    if (!h || h.score == null) {
      throw new Error(`no scored hit ${title}`)
    }

    return h.score
  }

  it('graph LIFTS a linked neighbour above a CLOSER non-linked note (DoD quality proof)', async () => {
    // Apex is the fts+vec hit for "cat" and links [[Quiet Lake]]. Quiet Lake shares
    // NO token with the query and sits FARTHER from it (vector [0,1,0,0]) than the
    // unrelated Calm Pond ([0.7,0.7,…]) — so on fts+vec alone Calm Pond outranks
    // Quiet Lake. The graph channel must reverse that (Quiet Lake is one hop from a
    // strong hit) while leaving the non-neighbour Calm Pond's score untouched.
    const table = {
      'Apex\n\na cat essay [[Quiet Lake]]': [1, 0, 0, 0],
      'Quiet Lake\n\nstill waters here': [0, 1, 0, 0],
      'Calm Pond\n\ntranquil scene': [0.7, 0.7, 0, 0],
      cat: [1, 0, 0, 0],
    }
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    // graphSeedS=1: only the top hit (Apex) seeds, so the linked Quiet Lake is a
    // boostable NON-seed neighbour (on this tiny corpus every note is a vec hit, so
    // with the default seed count it would itself be a seed and the channel — which
    // only boosts non-seed frontier notes — would skip it).
    const store = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql,
      embedder: mapEmbedder(table),
      searchTuning: { graphSeedS: 1 },
    })

    try {
      await store.write({ title: 'Apex', content: 'a cat essay [[Quiet Lake]]' })
      await store.write({ title: 'Quiet Lake', content: 'still waters here' })
      await store.write({ title: 'Calm Pond', content: 'tranquil scene' })
      await store.whenVectorsSettled()

      const on = await store.search('cat') // undefined scope → user → graph on
      store.setSearchTuning({ wGraph: 0 }) // disable the channel, same warm index
      const off = await store.search('cat')

      // fts+vec ALONE ranks the closer non-neighbour above the linked one…
      expect(rankOf(off, 'Calm Pond')).toBeLessThan(rankOf(off, 'Quiet Lake'))
      // …the graph channel reverses it (the link is the only signal that can).
      expect(rankOf(on, 'Quiet Lake')).toBeLessThan(rankOf(on, 'Calm Pond'))
      // The boost lands ONLY on the neighbour: the linked note gains, the unrelated
      // note's score is byte-identical with and without the channel.
      expect(scoreOf(on, 'Quiet Lake')).toBeGreaterThan(scoreOf(off, 'Quiet Lake'))
      expect(scoreOf(on, 'Calm Pond')).toBeCloseTo(scoreOf(off, 'Calm Pond'), 12)
    } finally {
      await store.stop()
    }
  })

  it('discards an in-flight adjacency build when a legacy alias becomes ambiguous', async () => {
    const table = {
      'Source\n\nanchor topic [[a-b]]': [1, 0, 0, 0],
      'AҚB\n\nfirst': [0, 1, 0, 0],
      'AҒB\n\nsecond': [0, 0.8, 0.2, 0],
      anchor: [1, 0, 0, 0],
    }
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const mount = userMount(notesDir)
    const listDirs = mount.files.listDirs.bind(mount.files)
    let armListDirs = false
    let releaseListDirs!: () => void
    let announceListDirs!: () => void
    const listDirsEntered = new Promise<void>((resolve) => {
      announceListDirs = resolve
    })
    const listDirsRelease = new Promise<void>((resolve) => {
      releaseListDirs = resolve
    })

    mount.files.listDirs = async () => {
      const result = await listDirs()

      if (armListDirs) {
        armListDirs = false
        announceListDirs()
        await listDirsRelease
      }

      return result
    }
    const store = new NotariumStore({
      mounts: [mount],
      sql,
      embedder: mapEmbedder(table),
      searchTuning: { graphSeedS: 1 },
    })

    try {
      const source = await store.write({ title: 'Source', content: 'anchor topic [[a-b]]' })
      const first = await store.write({ title: 'AҚB', content: 'first' })
      const second = await store.write({ title: 'AҒB', content: 'second' })
      await store.whenVectorsSettled()
      const uniqueIdentities = [
        { id: 'source-id', path: source.filePath! },
        { id: 'first-id', path: first.filePath!, legacyNameAliases: ['a-b'] },
        { id: 'second-id', path: second.filePath! },
      ]

      store.setLinkIdentities(uniqueIdentities)
      const unique = await store.search('anchor')
      store.setSearchTuning({ wGraph: 0 })
      const withoutGraph = await store.search('anchor')
      expect(scoreOf(unique, 'AҚB')).toBeGreaterThan(scoreOf(withoutGraph, 'AҚB'))

      store.setSearchTuning({ wGraph: 0.5 })
      store.setLinkIdentities(uniqueIdentities.map(({ id, path }) => ({ id, path })))
      store.setLinkIdentities(uniqueIdentities)
      armListDirs = true
      const raced = store.search('anchor')

      await listDirsEntered
      store.setLinkIdentities([
        ...uniqueIdentities,
        { id: 'second-id', path: second.filePath!, legacyNameAliases: ['a-b'] },
      ])
      releaseListDirs()
      const racedHits = await raced

      expect(scoreOf(racedHits, 'AҚB')).toBeCloseTo(scoreOf(withoutGraph, 'AҚB'), 12)
      const fresh = await store.search('anchor')
      expect(scoreOf(fresh, 'AҚB')).toBeCloseTo(scoreOf(withoutGraph, 'AҚB'), 12)
    } finally {
      releaseListDirs?.()
      await store.stop()
    }
  })

  it('a global hub neighbour is NOT boosted; a rare neighbour is (hub-robustness)', async () => {
    // Source is the hit; it links both Hub Note (also linked by five other notes →
    // high degree) and Rare Note (degree 1). With the top-degree node blacklisted,
    // the graph channel must boost Rare Note but leave Hub Note unboosted — the
    // hub-flooding the Stage-4a research warned about, suppressed.
    const table = {
      'Source\n\nanchor topic [[Hub Note]] [[Rare Note]]': [1, 0, 0, 0],
      anchor: [1, 0, 0, 0],
    }
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const store = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql,
      embedder: mapEmbedder(table),
      // Small graph: top-1% selects no node, so raise the cut so the genuine hub
      // (degree 6 of 8 nodes) is blacklisted — the mechanic under test. graphSeedS=1
      // so only Source seeds (else every vec hit is a seed and the non-seed-only
      // boost would skip Rare/Hub).
      searchTuning: { graphHubPercentile: 0.2, graphSeedS: 1 },
    })

    try {
      await store.write({ title: 'Source', content: 'anchor topic [[Hub Note]] [[Rare Note]]' })
      await store.write({ title: 'Hub Note', content: 'common' })
      await store.write({ title: 'Rare Note', content: 'uncommon' })
      for (let i = 1; i <= 5; i++) {
        await store.write({ title: `Linker ${i}`, content: 'see [[Hub Note]]' })
      }
      await store.whenVectorsSettled()

      const on = await store.search('anchor')
      store.setSearchTuning({ wGraph: 0 })
      const off = await store.search('anchor')

      // The rare neighbour is boosted by the channel…
      expect(scoreOf(on, 'Rare Note')).toBeGreaterThan(scoreOf(off, 'Rare Note'))
      // …the hub neighbour is NOT (blacklisted → never contributes/receives a boost).
      expect(scoreOf(on, 'Hub Note')).toBeCloseTo(scoreOf(off, 'Hub Note'), 12)
    } finally {
      await store.stop()
    }
  })

  it('the graph channel is INERT for scope agentRecall (no double-count with recall)', async () => {
    // recall runs its OWN planNeighbours 1-hop expansion on the agentRecall path, so
    // the engine graph channel must fire ONLY for the user surface (scope 'user' or
    // undefined) — otherwise the same neighbour is counted twice.
    const table = {
      'Apex\n\na cat essay [[Quiet Lake]]': [1, 0, 0, 0],
      'Quiet Lake\n\nstill waters here': [0, 1, 0, 0],
      cat: [1, 0, 0, 0],
    }
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const store = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql,
      embedder: mapEmbedder(table),
      searchTuning: { graphSeedS: 1 },
    })

    try {
      await store.write({ title: 'Apex', content: 'a cat essay [[Quiet Lake]]' })
      await store.write({ title: 'Quiet Lake', content: 'still waters here' })
      await store.whenVectorsSettled()

      const userImplicit = await store.search('cat') // undefined → user
      const userExplicit = await store.search('cat', { scope: 'user' })
      const recall = await store.search('cat', { scope: 'agentRecall' })

      // The neighbour is boosted on BOTH user-surface forms, and identically…
      expect(scoreOf(userExplicit, 'Quiet Lake')).toBeCloseTo(
        scoreOf(userImplicit, 'Quiet Lake'),
        12,
      )
      // …but NOT on the agentRecall path (channel inert → lower, un-boosted score).
      expect(scoreOf(userImplicit, 'Quiet Lake')).toBeGreaterThan(scoreOf(recall, 'Quiet Lake'))
    } finally {
      await store.stop()
    }
  })

  it('the user graph channel excludes an OUT-OF-POOL agent-memory neighbour', async () => {
    // Visibility must hold inside the graph channel, not only in CachedStore's final
    // row filter: a hidden neighbour must never be boosted into the candidate page.
    const table = {
      'Apex\n\na cat essay [[Secret Memo]]': [1, 0, 0, 0],
      cat: [1, 0, 0, 0],
    }
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const store = new NotariumStore({
      mounts: [userMount(notesDir), agentMount(notesDir)],
      sql,
      embedder: mapEmbedder(table),
      searchTuning: { poolSize: 1, wGraph: 5 },
    })

    try {
      await store.write({ title: 'Apex', content: 'a cat essay [[Secret Memo]]' })
      await store.write({
        title: 'Secret Memo',
        content: 'private alpha',
        targetClass: 'agent-memory',
      })
      await store.whenVectorsSettled()
      const hits = await store.search('cat', { pageSize: 1 })
      const memo = hits.find((h) => h.title === 'Secret Memo')
      expect(memo).toBeUndefined()
    } finally {
      await store.stop()
    }
  })

  it('a hidden query hit cannot seed a visible graph result', async () => {
    // Only Secret Memo matches the query and it links Visible. If hidden rows are
    // admitted as seeds, Visible reaches the page solely through that private fact;
    // filtering Secret Memo afterwards cannot undo the side channel.
    const table = {
      'Secret Memo\n\nzzultrasecret [[Visible]]': [1, 0, 0, 0],
      'Visible\n\nordinary public body': [0, 1, 0, 0],
      zzultrasecret: [1, 0, 0, 0],
    }
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const store = new NotariumStore({
      mounts: [userMount(notesDir), agentMount(notesDir)],
      sql,
      embedder: mapEmbedder(table),
      searchTuning: { poolSize: 1, wGraph: 5, graphSeedS: 1 },
    })

    try {
      await store.write({ title: 'Visible', content: 'ordinary public body' })
      await store.write({
        title: 'Secret Memo',
        content: 'zzultrasecret [[Visible]]',
        targetClass: 'agent-memory',
      })
      await store.whenVectorsSettled()
      const hits = await store.search('zzultrasecret', { pageSize: 1 })

      expect(hits.find((h) => h.title === 'Secret Memo')?.class).toBe('agent-memory')
      expect(hits.find((h) => h.title === 'Visible')).toBeUndefined()
    } finally {
      await store.stop()
    }
  })

  it('a degree-regular graph does NOT self-disable the channel (computeHubs guard)', async () => {
    // Regression for the hub-blacklist defect: when every connected node has the same
    // degree (a ring of notes, a long degree-1 tail on a sparse wiki), the cut-degree
    // equals the minimum degree, and a tie-inclusive `d >= threshold` would blacklist
    // the WHOLE graph — silently disabling the channel. The guard must blacklist
    // nobody on a flat distribution so a genuine neighbour is still boosted.
    const table = {
      'A\n\nanchor word [[B]]': [1, 0, 0, 0], // the only query hit + seed
      anchor: [1, 0, 0, 0],
    }
    const sql = createNodeSqliteDriver(':memory:', { vec: true })
    const store = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql,
      embedder: mapEmbedder(table),
      // High cut so the tie-band would (pre-fix) cover the whole regular graph;
      // graphSeedS=1 so only A seeds and B is a boostable non-seed neighbour.
      searchTuning: { graphHubPercentile: 0.5, graphSeedS: 1 },
    })

    try {
      // A 5-note ring A→B→C→D→E→A: undirected, EVERY node has degree 2 (regular).
      await store.write({ title: 'A', content: 'anchor word [[B]]' })
      await store.write({ title: 'B', content: 'see [[C]]' })
      await store.write({ title: 'C', content: 'see [[D]]' })
      await store.write({ title: 'D', content: 'see [[E]]' })
      await store.write({ title: 'E', content: 'see [[A]]' })
      await store.whenVectorsSettled()

      const on = await store.search('anchor')
      store.setSearchTuning({ wGraph: 0 })
      const off = await store.search('anchor')

      // B is A's neighbour and NOT a hub (flat degrees → no blacklist): it must be
      // boosted. Pre-fix, the whole ring was blacklisted and B's score was unchanged.
      expect(scoreOf(on, 'B')).toBeGreaterThan(scoreOf(off, 'B'))
    } finally {
      await store.stop()
    }
  })
})
