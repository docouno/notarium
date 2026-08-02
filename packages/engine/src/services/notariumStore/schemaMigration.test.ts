// Regression (#78 follow-up): a file-backed index left at an OLD schema version
// must tear down and reindex on boot, not crash. The v2 schema adds a `class`
// column plus `CREATE INDEX … ON notes(class)`; if the full schema runs before
// the version check, that index throws "no such column: class" against the
// stale v1 `notes` table and the migration never happens. This pins the order.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { createNodeSqliteDriver } from '../../libs/sql'
import { createNotariumStore } from './createNotariumStore'
import { INDEX_SCHEMA_VERSION, INDEX_VERSION_KEY, LEGACY_VERSION_KEY } from './schema'

// The notes table as it shipped BEFORE #78 — no `class` column, version '1'.
const V1_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notes (
  path TEXT PRIMARY KEY, title TEXT NOT NULL, mtime_ms INTEGER NOT NULL,
  size INTEGER NOT NULL, created_at TEXT, modified_at TEXT, id_claim TEXT,
  tags TEXT NOT NULL DEFAULT '[]', body TEXT NOT NULL, seq INTEGER NOT NULL
);
`

let notesDir: string
let indexDb: string

beforeEach(() => {
  notesDir = mkdtempSync(join(tmpdir(), 'notarium-migrate-notes-'))
  indexDb = join(mkdtempSync(join(tmpdir(), 'notarium-migrate-db-')), 'index.db')
})

afterEach(() => {
  rmSync(notesDir, { recursive: true, force: true })
})

it('tears down a stale v1 index and reindexes from files on boot', async () => {
  // Seed a v1 index: old schema, version '1', and a stale row that no longer
  // has a backing file (so a successful rebuild must DROP it).
  const seed = createNodeSqliteDriver(indexDb)
  await seed.exec(V1_SCHEMA)
  await seed.run(`INSERT INTO meta (key, value) VALUES ('schema_version', '1')`)
  await seed.run(
    `INSERT INTO notes (path, title, mtime_ms, size, body, seq)
     VALUES ('gone.md', 'Gone', 1, 1, '', 1)`,
  )
  await seed.close()

  // A real note on disk for the rebuild to pick up.
  mkdirSync(notesDir, { recursive: true })
  writeFileSync(join(notesDir, 'kept.md'), '# Kept\n\nbody\n')

  const store = createNotariumStore({ notesDir, indexDb })

  try {
    // list() drives ensureReady → migration. Pre-fix this threw
    // "no such column: class"; it must now resolve to the reindexed file.
    const notes = await store.list()
    const paths = notes.map((n) => n.filePath ?? '').sort()
    expect(paths).toEqual(['kept.md'])
    // class is materialized from the mount (#78), proving the v2 schema is live.
    expect(notes[0].class).toBe('user-doc')
  } finally {
    await store.stop()
  }

  // The on-disk index was actually migrated, not left at the legacy v1. It now
  // carries the ladder's integer version, and the pre-ladder string key is retired.
  const after = createNodeSqliteDriver(indexDb)
  const ver = await after.get<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [
    INDEX_VERSION_KEY,
  ])
  expect(ver?.value).toBe(String(INDEX_SCHEMA_VERSION))
  const legacy = await after.get<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [
    LEGACY_VERSION_KEY,
  ])
  expect(legacy).toBeUndefined()
  // v3 added content_hash; v4 added embedded_hash (the multi-chunk completeness
  // sentinel, #81 Stage 3); v5 added aliases (#100 alias-history); v6 added slug
  // (#100 phase 1 editable slug); v7 added note_type for Spotlight/search note-type
  // badges. The rebuilt row carries a content_hash, and its embedded_hash is NULL
  // until the (embedder-less here) backfill would run.
  const row = await after.get<{ content_hash: string | null; embedded_hash: string | null }>(
    `SELECT content_hash, embedded_hash FROM notes WHERE path = 'kept.md'`,
  )
  expect(typeof row?.content_hash).toBe('string')
  expect(row?.embedded_hash).toBeNull()
  expect(
    (
      await after.get<{ n: number }>(
        `SELECT count(*) AS n
         FROM file_fingerprints
         JOIN notes ON notes.rowid = file_fingerprints.note_rowid
         WHERE file_fingerprints.note_seq = notes.seq`,
      )
    )?.n,
  ).toBe(1)
  await after.close()
})
