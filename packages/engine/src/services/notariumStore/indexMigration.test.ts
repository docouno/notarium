// An ADDITIVE index-schema change must NOT tear down the index or re-embed.
// Two halves: planIndexMigration (pure decision, always runs) and the live vector
// path (real vec0 + a call-counting embedder, skipped where the native binary can't
// load). The money test is the contrast — the SAME corpus adopts the ladder with NO
// re-embed when it sits at the baseline, but an unsteppable old version tears down
// and DOES re-embed. That gap is the backfill storm this closes.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { claudeConversationSourceLocator } from '@notarium/core'

import type { Embedder } from '../../libs/embedding'
import { createLocalFsFiles } from '../../libs/files'
import { createNodeSqliteDriver } from '../../libs/sql'
import { createNotariumStore } from './createNotariumStore'
import { NotariumStore } from './notariumStore'
import {
  INDEX_MIGRATIONS,
  INDEX_SCHEMA_VERSION,
  INDEX_VERSION_KEY,
  type IndexMigration,
  LEGACY_VERSION_KEY,
  planIndexMigration,
} from './schema'
import { type EngineMount, engineMountOf } from './types'
import { describeVector } from './vectorGate.fixture'

describe('planIndexMigration', () => {
  it('a fresh index (no version at all) builds from 0 without a teardown', () => {
    expect(planIndexMigration({ ladderVersion: undefined, legacyVersion: undefined })).toEqual({
      fromVersion: 0,
      teardown: false,
    })
  })

  it('the legacy baseline "7" adopts onto the ladder from 0 — no teardown (step 0 is a no-op)', () => {
    expect(planIndexMigration({ ladderVersion: undefined, legacyVersion: '7' })).toEqual({
      fromVersion: 0,
      teardown: false,
    })
  })

  it('an older legacy version ("1".."6") tears down and rebuilds (P2 fallback)', () => {
    for (const v of ['1', '2', '3', '4', '5', '6']) {
      expect(planIndexMigration({ ladderVersion: undefined, legacyVersion: v })).toEqual({
        fromVersion: 0,
        teardown: true,
      })
    }
  })

  it('an index already on the ladder resumes from the stored integer', () => {
    expect(planIndexMigration({ ladderVersion: '1', legacyVersion: undefined, target: 3 })).toEqual(
      {
        fromVersion: 1,
        teardown: false,
      },
    )
  })

  it('a ladder version equal to the target is a no-op', () => {
    expect(
      planIndexMigration({ ladderVersion: String(INDEX_SCHEMA_VERSION), legacyVersion: undefined }),
    ).toEqual({ fromVersion: INDEX_SCHEMA_VERSION, teardown: false })
  })

  it('a corrupt or newer-than-known ladder version rebuilds rather than stepping blindly', () => {
    // Non-numeric, ragged (strict digit test), and newer-than-target all rebuild.
    for (const bad of ['x', '1abc', '1.9', ' 1', '-1']) {
      expect(
        planIndexMigration({ ladderVersion: bad, legacyVersion: undefined, target: 3 }),
      ).toEqual({
        fromVersion: 0,
        teardown: true,
      })
    }
    expect(
      planIndexMigration({ ladderVersion: '999', legacyVersion: undefined, target: 1 }),
    ).toEqual({ fromVersion: 0, teardown: true })
  })

  it('a live ladder version wins over a lingering legacy row', () => {
    expect(planIndexMigration({ ladderVersion: '1', legacyVersion: '7', target: 1 })).toEqual({
      fromVersion: 1,
      teardown: false,
    })
  })
})

// ── live vector path ─────────────────────────────────────────────────────────

/** A deterministic, instant embedder that COUNTS how many texts it embedded, so a
 *  test can assert a note was (or was not) re-embedded across a reboot. */
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

const userMount = (dir: string): EngineMount =>
  engineMountOf({ class: 'user-doc', prefix: '' }, createLocalFsFiles(dir))

const indexVersion = (db: ReturnType<typeof createNodeSqliteDriver>) =>
  db
    .get<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [INDEX_VERSION_KEY])
    .then((r) => r?.value)

const hasColumn = (db: ReturnType<typeof createNodeSqliteDriver>, table: string, col: string) =>
  db
    .all<{ name: string }>(`PRAGMA table_info(${table})`)
    .then((rows) => rows.some((r) => r.name === col))

describeVector('index migration preserves vectors', () => {
  let notesDir: string
  let indexDb: string

  beforeEach(() => {
    notesDir = mkdtempSync(join(tmpdir(), 'notarium-221-notes-'))
    indexDb = join(mkdtempSync(join(tmpdir(), 'notarium-221-db-')), 'index.db')
  })
  afterEach(() => {
    rmSync(notesDir, { recursive: true, force: true })
  })

  /** Boot an index AT THE FROZEN BASELINE (INDEX_MIGRATIONS[0] — the schema as it
   *  shipped at legacy '7'), embed one note, and hand back the embedder (call count),
   *  the note's index path and how many texts the first embed cost.
   *
   *  Seeding at the baseline rather than at the full ladder is what makes the rewind
   *  below an HONEST legacy index: a real pre-ladder '7' has no file_fingerprints
   *  table at all, so the adopt boot genuinely applies every later step — including a
   *  non-idempotent ADD COLUMN. Seeding at the full ladder and only re-stamping meta
   *  fakes a state the product cannot produce (modern columns, legacy version), and
   *  the replay then trips over its own ALTER ("duplicate column name"). */
  const seedEmbeddedIndex = async () => {
    const emb = countingEmbedder()
    const sourceLocatorStep = INDEX_MIGRATIONS.at(-2)!
    const store = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql: createNodeSqliteDriver(indexDb, { vec: true }),
      embedder: emb.embedder,
      // Current code writes the newest notes-table projection. Seed with that
      // additive column present, then remove it below to reproduce the exact
      // pre-step schema without running an old binary in this test process.
      migrations: [INDEX_MIGRATIONS[0], sourceLocatorStep],
    })
    const path = await writePath(store, { title: 'Cat', content: 'A small feline.' })
    await store.whenVectorsSettled()
    const embeddedOnce = emb.textCount
    expect(embeddedOnce).toBeGreaterThan(0)
    await store.stop()
    const legacy = createNodeSqliteDriver(indexDb, { vec: true })
    await legacy.run(`ALTER TABLE notes DROP COLUMN source_locator`)
    await legacy.run(`UPDATE meta SET value = '1' WHERE key = ?`, [INDEX_VERSION_KEY])
    await legacy.close()
    return { emb, path, embeddedOnce }
  }

  it('a legacy "7" index adopts onto the ladder without re-embedding', async () => {
    const { emb, path, embeddedOnce } = await seedEmbeddedIndex()

    // The schema on disk IS the pre-ladder one already (seeded at the baseline);
    // relabel it the way a pre-ladder build stamped its version.
    const pre = createNodeSqliteDriver(indexDb, { vec: true })
    await pre.run(`DELETE FROM meta WHERE key = ?`, [INDEX_VERSION_KEY])
    await pre.run(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, '7')`, [LEGACY_VERSION_KEY])
    const vecsBefore =
      (await pre.get<{ n: number }>(`SELECT count(*) AS n FROM note_vectors`))?.n ?? 0
    expect(vecsBefore).toBeGreaterThan(0)
    await pre.close()

    // Boot the adopt path and let any backfill run: it must NOT re-embed.
    const store = createNotariumStore({ notesDir, indexDb, embedder: emb.embedder })
    await store.list()
    await store.whenVectorsSettled()
    expect(emb.textCount).toBe(embeddedOnce) // ← the fix: no refill on an additive/adopt boot
    await store.stop()

    // Vectors + completeness sentinel intact; version re-stamped; legacy key retired.
    const after = createNodeSqliteDriver(indexDb, { vec: true })
    expect((await after.get<{ n: number }>(`SELECT count(*) AS n FROM note_vectors`))?.n).toBe(
      vecsBefore,
    )
    expect(
      (
        await after.get<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [
          INDEX_VERSION_KEY,
        ])
      )?.value,
    ).toBe(String(INDEX_SCHEMA_VERSION))
    expect(
      await after.get(`SELECT value FROM meta WHERE key = ?`, [LEGACY_VERSION_KEY]),
    ).toBeUndefined()
    // The adopt actually RAN the post-baseline steps on this legacy index — the
    // table step and the non-idempotent ADD COLUMN on top of it — rather than just
    // re-stamping the version over a schema that happened to be current already.
    expect(await hasColumn(after, 'file_fingerprints', 'note_seq')).toBe(true)
    const row = await after.get<{ content_hash: string; embedded_hash: string }>(
      `SELECT content_hash, embedded_hash FROM notes WHERE path = ?`,
      [path],
    )
    expect(row?.embedded_hash).toBe(row?.content_hash) // still "done"
    await after.close()
  })

  it('an unsteppable legacy version tears down and DOES re-embed (the contrast)', async () => {
    const { emb, embeddedOnce } = await seedEmbeddedIndex()

    // A pre-baseline version we can't step from.
    const pre = createNodeSqliteDriver(indexDb, { vec: true })
    await pre.run(`DELETE FROM meta WHERE key = ?`, [INDEX_VERSION_KEY])
    await pre.run(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, '3')`, [LEGACY_VERSION_KEY])
    await pre.close()

    const store = createNotariumStore({ notesDir, indexDb, embedder: emb.embedder })
    await store.list()
    await store.whenVectorsSettled()
    expect(emb.textCount).toBeGreaterThan(embeddedOnce) // teardown → full re-embed
    await store.stop()
  })

  it('applies the shipped fingerprint-table step without re-embedding', async () => {
    const { emb, path, embeddedOnce } = await seedEmbeddedIndex()

    const store = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql: createNodeSqliteDriver(indexDb, { vec: true }),
      embedder: emb.embedder,
    })
    await store.list()
    await store.whenVectorsSettled()
    expect(emb.textCount).toBe(embeddedOnce)
    await store.stop()

    const after = createNodeSqliteDriver(indexDb, { vec: true })
    expect(await indexVersion(after)).toBe(String(INDEX_MIGRATIONS.length))
    expect(
      (
        await after.get<{ n: number }>(
          `SELECT count(*) AS n
           FROM file_fingerprints
           JOIN notes ON notes.rowid = file_fingerprints.note_rowid
           WHERE notes.path = ? AND file_fingerprints.note_seq = notes.seq`,
          [path],
        )
      )?.n,
    ).toBe(1)
    await after.close()
  })

  it('adds nullable source_locator without rowid, FTS, vector or hidden backfill churn', async () => {
    const locator = claudeConversationSourceLocator('pre-task-authored')!
    const emb = countingEmbedder()
    let store = createNotariumStore({ notesDir, indexDb, embedder: emb.embedder })
    const path = await writePath(store, {
      title: 'Tagged before the migration',
      content: 'stable body',
      sourceLocator: locator,
    })
    await store.whenVectorsSettled()
    const embeddedOnce = emb.textCount
    await store.stop()

    const before = createNodeSqliteDriver(indexDb, { vec: true })
    const row = await before.get<{ rowid: number; embedded_hash: string | null }>(
      `SELECT rowid, embedded_hash FROM notes WHERE path = ?`,
      [path],
    )
    const ftsBefore = (await before.get<{ n: number }>(
      `SELECT count(*) AS n FROM notes_fts WHERE rowid = ?`,
      [row!.rowid],
    ))!.n
    const vectorsBefore = (await before.get<{ n: number }>(
      `SELECT count(*) AS n FROM note_vectors WHERE note_rowid = ?`,
      [row!.rowid],
    ))!.n
    // Reproduce the immediately-pre-task index: the file already contains an
    // authored same-name key, but the derived row has no projection column yet.
    await before.run(`ALTER TABLE notes DROP COLUMN source_locator`)
    await before.run(`ALTER TABLE document_proofs DROP COLUMN context_json`)
    await before.run(`UPDATE meta SET value = ? WHERE key = ?`, [
      String(INDEX_MIGRATIONS.length - 2),
      INDEX_VERSION_KEY,
    ])
    await before.close()

    store = createNotariumStore({ notesDir, indexDb, embedder: emb.embedder })
    const listed = await store.list()
    await store.whenVectorsSettled()
    expect(listed.find((note) => note.filePath === path)?.sourceLocator).toBeUndefined()
    expect(emb.textCount).toBe(embeddedOnce)
    await store.stop()

    const after = createNodeSqliteDriver(indexDb, { vec: true })
    const upgraded = await after.get<{
      rowid: number
      source_locator: string | null
      embedded_hash: string | null
    }>(`SELECT rowid, source_locator, embedded_hash FROM notes WHERE path = ?`, [path])
    expect(upgraded).toMatchObject({
      rowid: row!.rowid,
      source_locator: null,
      embedded_hash: row!.embedded_hash,
    })
    expect(
      (await after.get<{ n: number }>(`SELECT count(*) AS n FROM notes_fts WHERE rowid = ?`, [
        row!.rowid,
      ]))!.n,
    ).toBe(ftsBefore)
    expect(
      (await after.get<{ n: number }>(
        `SELECT count(*) AS n FROM note_vectors WHERE note_rowid = ?`,
        [row!.rowid],
      ))!.n,
    ).toBe(vectorsBefore)
    await after.close()
  })

  it('applies an appended additive step through ensureReady, crash-safely, without re-embedding', async () => {
    // Drive the REAL boot path (ensureReady's apply-loop) through an appended step —
    // inject a synthetic two-step ladder rooted at the frozen baseline. This is the
    // core promise end-to-end: an ADD COLUMN bumps the version but keeps rowids, so the
    // note is NOT re-embedded. Plus crash-safety: a step that fails mid-way rolls back
    // whole (no half-applied, non-idempotent ALTER wedging the next boot).
    const baseline = [...INDEX_MIGRATIONS]
    const emb = countingEmbedder()

    // Boot 1 at the baseline ladder (v1): embed one note.
    let store = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql: createNodeSqliteDriver(indexDb, { vec: true }),
      embedder: emb.embedder,
      migrations: baseline,
    })
    const path = await writePath(store, { title: 'Fox', content: 'A quick red fox.' })
    await store.whenVectorsSettled()
    const embeddedOnce = emb.textCount
    expect(embeddedOnce).toBeGreaterThan(0)
    await store.stop()

    // Boot 2 — a step whose SQL fails AFTER the ALTER: the transaction must roll the
    // whole step back. Version stays 1, the column is gone, the boot throws (no silent
    // partial state that a re-run would trip over with "duplicate column").
    const brokenStep: IndexMigration = {
      sql: `ALTER TABLE notes ADD COLUMN future_col TEXT; SELECT no_such_column`,
    }
    store = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql: createNodeSqliteDriver(indexDb, { vec: true }),
      embedder: emb.embedder,
      migrations: [...baseline, brokenStep],
    })
    await expect(store.list()).rejects.toThrow()
    await store.stop()

    let d = createNodeSqliteDriver(indexDb, { vec: true })
    expect(await indexVersion(d)).toBe(String(baseline.length))
    expect(await hasColumn(d, 'notes', 'future_col')).toBe(false) // the ALTER was undone
    await d.close()

    // Boot 3 — the good appended step applies: version → 2, column present, and the
    // note rides its preserved rowid → NO re-embed.
    const goodStep: IndexMigration = { sql: `ALTER TABLE notes ADD COLUMN future_col TEXT` }
    store = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql: createNodeSqliteDriver(indexDb, { vec: true }),
      embedder: emb.embedder,
      migrations: [...baseline, goodStep],
    })
    await store.list()
    await store.whenVectorsSettled()
    expect(emb.textCount).toBe(embeddedOnce) // ← the fix: an additive step re-embeds nothing
    await store.stop()

    d = createNodeSqliteDriver(indexDb, { vec: true })
    expect(await indexVersion(d)).toBe(String(baseline.length + 1))
    expect(await hasColumn(d, 'notes', 'future_col')).toBe(true)
    const row = await d.get<{ content_hash: string; embedded_hash: string }>(
      `SELECT content_hash, embedded_hash FROM notes WHERE path = ?`,
      [path],
    )
    expect(row?.embedded_hash).toBe(row?.content_hash) // still "done"
    expect(
      (await d.get<{ n: number }>(`SELECT count(*) AS n FROM note_vectors`))?.n,
    ).toBeGreaterThan(0)
    await d.close()
  })

  it('a fresh index applies a multi-step ladder in one boot', async () => {
    // A brand-new index replays step 0 (baseline) AND an appended step in the SAME
    // boot — each in its own transaction. Proves the loop drives >1 step end-to-end
    // (not just the one-step-per-reboot path the other tests exercise).
    const emb = countingEmbedder()
    const ladder: IndexMigration[] = [
      ...INDEX_MIGRATIONS,
      { sql: `ALTER TABLE notes ADD COLUMN future_col TEXT` },
    ]
    const store = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql: createNodeSqliteDriver(indexDb, { vec: true }),
      embedder: emb.embedder,
      migrations: ladder,
    })
    const path = await writePath(store, { title: 'Owl', content: 'A wise owl.' })
    await store.whenVectorsSettled()
    expect(emb.textCount).toBeGreaterThan(0) // fresh index embeds its note
    const results = await store.list()
    expect(results.some((n) => n.filePath === path)).toBe(true) // indexed + listable
    await store.stop()

    const d = createNodeSqliteDriver(indexDb, { vec: true })
    expect(await indexVersion(d)).toBe(String(ladder.length))
    expect(await hasColumn(d, 'notes', 'future_col')).toBe(true) // appended step applied
    await d.close()
  })
})
