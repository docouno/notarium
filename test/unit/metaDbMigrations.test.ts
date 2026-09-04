import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, constants as sqlite } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { AGENT_SYSTEM_OWNER } from '../../packages/server/src/services/authz'
import {
  checksumMigrationPair,
  loadMetaMigrations,
  loadMetaMigrationsFromDirectory,
  type MetaMigration,
  runSqliteMigrations,
} from '../../packages/server/src/services/metaDb/migrations'
import { SqliteMetaDb } from '../../packages/server/src/services/metaDb/sqliteMetaDb'
import {
  accountIdentityRegistry,
  accountIdentitySeedSql,
  expectAccountIdentityWorld,
  expectActivityProjectionState,
  type LadderReader,
  usersCarriedColumnsSql,
} from '../meta-db-contract/accountIdentityLadder'
import {
  ACCOUNT_IDENTITY_CANDIDATE_COLUMNS,
  approvedTargetCatalog,
  type MetaDbCatalog,
  PROVIDER_CONTOUR_TABLES,
  splitProviderContour,
  sqliteMetaDbCatalog,
  withoutAgentCallTrace,
} from '../meta-db-contract/metaDbCatalog'

type LedgerRow = {
  version: number
  name: string
  checksum: string
  applied_at: string
}

const sourceDirectory = fileURLToPath(
  new URL('../../packages/server/src/services/metaDb/migrations/', import.meta.url),
)
const sqliteGolden = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../meta-db-contract/fixtures/metaDbCatalog.sqlite.json', import.meta.url),
    ),
    'utf8',
  ),
) as MetaDbCatalog

describe('meta-DB migration assets and SQLite runner', () => {
  const databases: DatabaseSync[] = []
  const directories: string[] = []
  const migrations = loadMetaMigrations()
  const nextMigrationVersion = migrations.length
  const appliedVersions = migrations.map(({ version }) => version)

  afterEach(() => {
    while (databases.length) {
      databases.pop()!.close()
    }
    while (directories.length) {
      rmSync(directories.pop()!, { recursive: true, force: true })
    }
  })

  const database = (): DatabaseSync => {
    const db = new DatabaseSync(':memory:')
    databases.push(db)
    return db
  }

  const copiedAssets = (): string => {
    const directory = mkdtempSync(join(tmpdir(), 'notarium-meta-migrations-'))
    directories.push(directory)
    cpSync(sourceDirectory, directory, { recursive: true })
    return directory
  }

  const ledger = (db: DatabaseSync): LedgerRow[] =>
    db
      .prepare('SELECT version, name, checksum, applied_at FROM meta_migrations ORDER BY version')
      .all() as LedgerRow[]

  it('loads the current checksummed dialect pairs from a clean baseline', () => {
    expect(migrations.map(({ version, name }) => ({ version, name }))).toEqual([
      { version: 0, name: 'baseline' },
      { version: 1, name: 'revision_history' },
      { version: 2, name: 'agent_state' },
      { version: 3, name: 'causal_identity' },
      { version: 4, name: 'import_reservations' },
      { version: 5, name: 'provider_contour' },
      { version: 6, name: 'agent_call_trace' },
      { version: 7, name: 'activity_projection' },
      { version: 8, name: 'account_identity' },
    ])
    for (const migration of migrations) {
      expect(migration.checksum).toBe(checksumMigrationPair(migration.sqlite, migration.postgres))
    }
  })

  it('creates the complete current SQLite schema and an immutable ledger row atomically', () => {
    const db = database()
    runSqliteMigrations(db)

    const rows = ledger(db)
    expect(rows).toHaveLength(migrations.length)
    expect(rows[0]).toMatchObject({
      version: 0,
      name: 'baseline',
      checksum: migrations[0].checksum,
    })
    for (const row of rows) {
      expect(Number.isNaN(Date.parse(row.applied_at))).toBe(false)
    }

    const counts = Object.fromEntries(
      (
        db
          .prepare(
            `SELECT type, COUNT(*) AS count
               FROM sqlite_schema
              WHERE sql IS NOT NULL
                AND name NOT LIKE 'sqlite_autoindex_%'
                AND name NOT IN ('meta_migrations', 'sqlite_sequence')
              GROUP BY type`,
          )
          .all() as Array<{ type: string; count: number }>
      ).map(({ type, count }) => [type, count]),
    )
    // On top of the published line, the provider contour adds five tables — the
    // keyring, the three facets and the call journal — and eleven named indexes: the
    // keyring's single-active partial, eight lookup/page keys across the facets, plus
    // the journal's owner and retention indexes. Every primary/UNIQUE autoindex stays
    // excluded by the query above, the journal's send-fence key among them. Agent
    // trace then adds four tables and seventeen named indexes. Activity adds five
    // tables, three named indexes and five triggers.
    expect(counts).toEqual({ index: 95, table: 57, trigger: 36 })
    expect(
      db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'meta_schema'").get(),
    ).toBeUndefined()
    expect((db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum).toBe(2)
    const retentionPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT entry.id
           FROM provider_call_log AS entry
           LEFT JOIN jobs AS job ON job.id = entry.job_id
          WHERE entry.outcome <> 'in-flight' AND entry.settled_at IS NOT NULL
            AND entry.settled_at < '2026-08-30T00:00:00.000Z'
            AND (
              entry.job_id IS NULL OR job.id IS NULL
              OR job.status NOT IN ('pending', 'running')
            )
          ORDER BY entry.settled_at, entry.id
          LIMIT 1000`,
      )
      .all() as Array<{ detail: string }>
    expect(retentionPlan.map(({ detail }) => detail).join('\n')).toContain(
      'USING INDEX idx_provider_call_log_retention',
    )
    expect(retentionPlan.map(({ detail }) => detail).join('\n')).not.toContain('USE TEMP B-TREE')
    const live = splitProviderContour(withoutAgentCallTrace(sqliteMetaDbCatalog(db)))
    expect(live.contour).toEqual(PROVIDER_CONTOUR_TABLES)
    expect(live.published).toEqual(approvedTargetCatalog(sqliteGolden))
  })

  it('installs the Activity carrier without reading or initializing existing journal spaces', () => {
    const db = database()
    runSqliteMigrations(db, migrations.slice(0, 7))
    const append = db.prepare(
      `INSERT INTO note_revisions
        (note_id, space, kind, entry_role, principal, title, class, tags, created_at,
         chars_added, chars_removed, integrity)
       VALUES (?, ?, 'write', ?, 'user:alice', ?, 'user-doc', '[]', ?, 1, 0, 'trusted')`,
    )

    append.run('alpha-note', 'alpha', 'origin', 'Alpha', '2026-08-01T00:00:00.000Z')
    append.run('beta-note', 'beta', 'origin', 'Beta', '2026-08-01T00:00:00.000Z')
    let journalReads = 0

    db.setAuthorizer((actionCode, table) => {
      if (actionCode === sqlite.SQLITE_READ && table === 'note_revisions') {
        journalReads += 1
      }

      return sqlite.SQLITE_OK
    })
    try {
      db.exec(migrations[7]!.sqlite)
    } finally {
      db.setAuthorizer(null)
    }

    expect(journalReads).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM activity_projection_status').get()).toEqual({
      n: 0,
    })
  })

  it('atomically advances the fresh Activity order, state and head and invalidates on rewrite', () => {
    const db = database()
    runSqliteMigrations(db)
    const append = db.prepare(
      `INSERT INTO note_revisions
        (note_id, space, kind, entry_role, principal, title, class, tags, created_at,
         chars_added, chars_removed, integrity)
       VALUES (?, 'fresh', 'write', ?, ?, 'Fresh', 'user-doc', '[]', ?, ?, ?, 'trusted')`,
    )

    const baseline = append.run(
      'fresh-note',
      'baseline',
      'user:alice',
      '2026-08-01T00:00:00.000Z',
      10,
      0,
    )
    const change = append.run(
      'fresh-note',
      'change',
      'user:alice',
      '2026-08-01T01:00:00.000Z',
      3,
      1,
    )

    expect(
      db
        .prepare(
          `SELECT state, active_generation, active_through, next_source_ordinal
             FROM activity_projection_status WHERE space = 'fresh'`,
        )
        .get(),
    ).toEqual({
      state: 'ready',
      active_generation: 1,
      active_through: 2,
      next_source_ordinal: 2,
    })
    expect(
      db
        .prepare(
          `SELECT source_ordinal, revision_id FROM activity_revision_order
            WHERE space = 'fresh' ORDER BY source_ordinal`,
        )
        .all(),
    ).toEqual([
      { source_ordinal: 1, revision_id: baseline.lastInsertRowid },
      { source_ordinal: 2, revision_id: change.lastInsertRowid },
    ])
    expect(
      db
        .prepare(
          `SELECT event_count, chars_added_sum, chars_added_known,
                  chars_removed_sum, chars_removed_known
             FROM activity_note_actor_states WHERE space = 'fresh'`,
        )
        .all(),
    ).toEqual([
      {
        event_count: 1,
        chars_added_sum: 3,
        chars_added_known: 1,
        chars_removed_sum: 1,
        chars_removed_known: 1,
      },
    ])

    db.prepare('UPDATE note_revisions SET integrity = ? WHERE id = ?').run(
      'quarantined',
      change.lastInsertRowid,
    )
    expect(
      db
        .prepare(
          `SELECT state, active_generation, build_generation, source_generation
             FROM activity_projection_status WHERE space = 'fresh'`,
        )
        .get(),
    ).toEqual({
      state: 'rebuilding',
      active_generation: null,
      build_generation: null,
      source_generation: 2,
    })
    expect(db.prepare('SELECT space, generation, phase FROM activity_projection_gc').all()).toEqual(
      [{ space: 'fresh', generation: 1, phase: 'states' }],
    )
  })

  it('rejects rehoming a revision without changing the journal, order, or status', () => {
    const db = database()
    runSqliteMigrations(db)
    const inserted = db
      .prepare(
        `INSERT INTO note_revisions
          (note_id, space, kind, entry_role, principal, title, class, tags, created_at,
           chars_added, chars_removed, integrity)
         VALUES
          ('alpha-note', 'alpha', 'write', 'change', 'user:alice', 'Alpha', 'user-doc', '[]',
           '2026-08-01T00:00:00.000Z', 3, 1, 'trusted')`,
      )
      .run()
    const snapshot = () => ({
      journal: db
        .prepare('SELECT id, note_id, space, integrity FROM note_revisions ORDER BY id')
        .all(),
      order: db
        .prepare(
          'SELECT space, source_ordinal, revision_id FROM activity_revision_order ORDER BY space, source_ordinal',
        )
        .all(),
      status: db.prepare('SELECT * FROM activity_projection_status ORDER BY space').all(),
    })
    const before = snapshot()

    expect(() =>
      db
        .prepare("UPDATE note_revisions SET space = 'beta' WHERE id = ?")
        .run(inserted.lastInsertRowid),
    ).toThrow(/note revision space is immutable/)
    expect(snapshot()).toEqual(before)

    // Writers that redundantly include the unchanged Space still retain the
    // semantic-rewrite path and invalidate the active generation as before.
    expect(() =>
      db
        .prepare(
          "UPDATE note_revisions SET space = 'alpha', integrity = 'quarantined' WHERE id = ?",
        )
        .run(inserted.lastInsertRowid),
    ).not.toThrow()
    expect(
      db
        .prepare(
          `SELECT state, active_generation, build_generation, source_generation
             FROM activity_projection_status WHERE space = 'alpha'`,
        )
        .get(),
    ).toEqual({
      state: 'rebuilding',
      active_generation: null,
      build_generation: null,
      source_generation: 2,
    })
  })

  it('rolls back every fresh Activity effect when the projection trigger tail fails', () => {
    const db = database()
    runSqliteMigrations(db)
    const append = db.prepare(
      `INSERT INTO note_revisions
        (note_id, space, kind, entry_role, principal, title, class, tags, created_at,
         chars_added, chars_removed, integrity)
       VALUES ('fresh-note', 'fresh', 'write', ?, 'user:alice', 'Fresh', 'user-doc', '[]',
               ?, 1, 0, 'trusted')`,
    )

    append.run('baseline', '2026-08-01T00:00:00.000Z')
    db.exec(`
      CREATE TRIGGER fail_activity_state
      BEFORE INSERT ON activity_note_actor_states
      BEGIN
        SELECT RAISE(ABORT, 'injected Activity state failure');
      END;
    `)

    expect(() => append.run('change', '2026-08-01T01:00:00.000Z')).toThrow(
      /injected Activity state failure/,
    )
    expect(db.prepare('SELECT COUNT(*) AS n FROM note_revisions').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM activity_revision_order').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM activity_note_actor_states').get()).toEqual({
      n: 0,
    })
    expect(
      db
        .prepare(
          `SELECT next_source_ordinal, active_through
             FROM activity_projection_status WHERE space = 'fresh'`,
        )
        .get(),
    ).toEqual({ next_source_ordinal: 1, active_through: 1 })
  })

  it('lazily rebuilds exactly one upgraded Activity space and publishes its generation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'notarium-activity-rebuild-'))
    directories.push(directory)
    const path = join(directory, 'meta.sqlite')
    const legacy = new DatabaseSync(path)

    runSqliteMigrations(legacy, migrations.slice(0, 7))
    legacy.exec(`
      INSERT INTO note_revisions
        (note_id, space, kind, entry_role, principal, title, class, tags, created_at,
         chars_added, chars_removed, integrity)
      VALUES
        ('alpha-note', 'alpha', 'external', 'baseline', 'user:alice', 'Alpha', 'user-doc', '[]',
         '2026-08-01T00:00:00.000Z', 10, 0, 'trusted'),
        ('alpha-note', 'alpha', 'write', 'change', 'user:alice', 'Alpha', 'user-doc', '[]',
         '2026-08-01T01:00:00.000Z', 3, 1, 'trusted'),
        ('beta-note', 'beta', 'write', 'origin', 'user:bob', 'Beta', 'user-doc', '[]',
         '2026-08-01T02:00:00.000Z', 4, 0, 'trusted');
    `)
    legacy.close()

    const meta = new SqliteMetaDb(path)

    try {
      expect(await meta.revisions.prepareActivityProjection('alpha')).toEqual({
        state: 'rebuilding',
      })
      const sabotage = new DatabaseSync(path)

      sabotage.exec(`
        INSERT INTO activity_note_actor_states
          (space, generation, source_ordinal, revision_id, note_id,
           actor_kind, actor_key, class_key, event_count,
           chars_added_sum, chars_added_known, chars_removed_sum, chars_removed_known)
        VALUES
          ('alpha', 1, 2, 2, 'alpha-note', 'principal', 'user:alice', 'user-doc',
           1, 3, 1, 1, 1);
      `)
      await expect(meta.revisions.maintainActivityProjection('alpha')).rejects.toThrow(/UNIQUE/)
      expect(
        sabotage
          .prepare('SELECT state, last_error_code FROM activity_projection_status WHERE space = ?')
          .get('alpha'),
      ).toEqual({ state: 'rebuilding', last_error_code: 'rebuild_failed' })
      sabotage.prepare('DELETE FROM activity_note_actor_states WHERE space = ?').run('alpha')
      sabotage.close()
      expect(await meta.revisions.maintainActivityProjection('alpha')).toMatchObject({
        state: 'ready',
        processed: 2,
        published: true,
      })
      expect(await meta.revisions.prepareActivityProjection('alpha')).toEqual({
        state: 'ready',
        lease: { through: '2', activeGeneration: '1', sourceGeneration: '1' },
      })
    } finally {
      await meta.close()
    }

    const inspected = new DatabaseSync(path)
    databases.push(inspected)
    expect(
      inspected
        .prepare(
          `SELECT space, state, active_generation, active_through
             FROM activity_projection_status ORDER BY space`,
        )
        .all(),
    ).toEqual([{ space: 'alpha', state: 'ready', active_generation: 1, active_through: 2 }])
    expect(
      inspected
        .prepare(
          `SELECT note_id, event_count, chars_added_sum, chars_removed_sum
             FROM activity_note_actor_states WHERE space = 'alpha'`,
        )
        .all(),
    ).toEqual([{ note_id: 'alpha-note', event_count: 1, chars_added_sum: 3, chars_removed_sum: 1 }])
  })

  it('does not let stale SQLite maintenance recreate Activity rows after Space purge', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'notarium-activity-purge-fence-'))
    directories.push(directory)
    const path = join(directory, 'meta.sqlite')
    const seeded = new DatabaseSync(path)

    runSqliteMigrations(seeded)
    seeded.exec(`
      INSERT INTO note_revisions
        (note_id, space, kind, entry_role, principal, title, class, tags, created_at,
         chars_added, chars_removed, integrity)
      VALUES
        ('purged-note', 'purged', 'write', 'change', 'user:alice', 'Purged', 'user-doc', '[]',
         '2026-08-01T00:00:00.000Z', 1, 0, 'trusted');
    `)
    seeded.close()
    const meta = new SqliteMetaDb(path)

    try {
      await meta.revisions.init()
      await meta.purgeSpace('purged')

      await expect(meta.revisions.prepareActivityProjection('purged')).rejects.toThrow(
        /activity projection target was permanently purged/,
      )
      await expect(meta.revisions.maintainActivityProjection('purged')).rejects.toThrow(
        /activity projection target was permanently purged/,
      )
    } finally {
      await meta.close()
    }

    const inspected = new DatabaseSync(path)
    databases.push(inspected)
    for (const table of [
      'note_revisions',
      'activity_projection_status',
      'activity_revision_order',
      'activity_note_actor_states',
      'activity_note_actor_heads',
      'activity_projection_gc',
    ]) {
      expect(
        inspected.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE space = ?`).get('purged'),
      ).toEqual({
        n: 0,
      })
    }
    expect(
      inspected
        .prepare(
          "SELECT kind, entity_id, space FROM revision_purge_fences WHERE kind = 'space' AND entity_id = ?",
        )
        .get('purged'),
    ).toEqual({ kind: 'space', entity_id: 'purged', space: 'purged' })
  })

  it('requires both identities on every placement trail row', () => {
    const db = database()
    runSqliteMigrations(db)

    expect(() =>
      db
        .prepare(
          `INSERT INTO ability_placement_trail (from_locator, to_locator, space_id)
           VALUES ('new-from', 'new-to', 'space-main')`,
        )
        .run(),
    ).toThrow(/NOT NULL constraint failed/)
    expect(() =>
      db
        .prepare(
          `INSERT INTO ability_placement_trail
             (from_locator, to_locator, space_id, registry_note_id, manifest_note_id)
           VALUES ('new-from', 'new-to', 'space-main', 'RegistryNote1', 'ManifestNote1')`,
        )
        .run(),
    ).not.toThrow()
  })

  it('releases success-only replay keys held by an existing rejected ability create', () => {
    const db = database()

    runSqliteMigrations(db)
    db.prepare(
      `INSERT INTO ability_create_operations
        (id, actor_digest, idempotency_digest, request_fingerprint, space, package_id,
         note_id, target_path, availability_required, stage_binding, phase,
         prepared_evidence, created_at, updated_at)
       VALUES (?, 'actor', 'key', 'request', 'space-main', ?, ?, ?, 0, 'binding',
               'rejected', '{}', '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z')`,
    ).run('rejected-operation', 'PackageId001', 'RegistryNote1', 'first/SKILL.md')

    expect(() =>
      db
        .prepare(
          `INSERT INTO ability_create_operations
            (id, actor_digest, idempotency_digest, request_fingerprint, space, package_id,
             note_id, target_path, availability_required, stage_binding, phase,
             prepared_evidence, created_at, updated_at)
           VALUES (?, 'actor', 'key', 'request', 'space-main', ?, ?, ?, 0, 'binding',
                   'accepted', '{}', '2026-08-23T00:00:01.000Z', '2026-08-23T00:00:01.000Z')`,
        )
        .run('retry-operation', 'PackageId002', 'RegistryNote2', 'second/SKILL.md'),
    ).not.toThrow()
    expect(
      db
        .prepare(
          `SELECT id, phase FROM ability_create_operations
            WHERE actor_digest = 'actor' AND idempotency_digest = 'key' ORDER BY id`,
        )
        .all(),
    ).toEqual([
      { id: 'rejected-operation', phase: 'rejected' },
      { id: 'retry-operation', phase: 'accepted' },
    ])
  })

  it('reopens a valid prefix as a no-op without rewriting its applied timestamp', () => {
    const db = database()
    runSqliteMigrations(db)
    const before = ledger(db)

    runSqliteMigrations(db)

    expect(ledger(db)).toEqual(before)
  })

  it('adds the whole provider contour over a published-line schema that has rows', () => {
    const db = database()
    const upTo = migrations.findIndex((migration) => migration.name === 'provider_contour')
    runSqliteMigrations(db, migrations.slice(0, upTo))
    db.prepare(
      `INSERT INTO note_identity
        (id, file_path, space, created_at, materialized, deleted_at, legacy_name_aliases)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('existing-identity', 'kept.md', 'main', null, 1, null, '[]')
    for (const table of PROVIDER_CONTOUR_TABLES) {
      expect(
        db.prepare('SELECT 1 FROM sqlite_schema WHERE name = ?').get(table),
        `${table} exists before its carrier`,
      ).toBeUndefined()
    }

    runSqliteMigrations(db, migrations)

    // The carrier only adds: the published line's own rows are untouched, and every
    // contour table arrives empty rather than guessed at from anything.
    expect(
      db.prepare('SELECT file_path FROM note_identity WHERE id = ?').get('existing-identity'),
    ).toEqual({ file_path: 'kept.md' })
    for (const table of PROVIDER_CONTOUR_TABLES) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 })
    }
  })

  it('adds an empty legacy alias set without guessing from existing names or paths', () => {
    const db = database()
    runSqliteMigrations(db, migrations.slice(0, 1))
    db.prepare(
      `INSERT INTO note_identity
        (id, file_path, space, created_at, materialized, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('legacy-identity', 'aza-stan-zhospary.md', 'main', null, 1, null)

    runSqliteMigrations(db)

    expect(
      db
        .prepare('SELECT file_path, legacy_name_aliases FROM note_identity WHERE id = ?')
        .get('legacy-identity'),
    ).toEqual({ file_path: 'aza-stan-zhospary.md', legacy_name_aliases: '[]' })
  })

  it('adds empty settlement lineage without inferring ancestry from existing paths', () => {
    const db = database()
    runSqliteMigrations(db, migrations.slice(0, 1))
    db.prepare(
      `INSERT INTO note_identity
        (id, file_path, space, created_at, materialized, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('existing-identity', 'same.md', 'main', null, 1, null)

    runSqliteMigrations(db)

    expect(
      db
        .prepare('SELECT file_path, settlement_successor_id FROM note_identity WHERE id = ?')
        .get('existing-identity'),
    ).toEqual({ file_path: 'same.md', settlement_successor_id: null })
  })

  it('keeps baseline body blobs as nullable state format', () => {
    const db = database()
    runSqliteMigrations(db, migrations.slice(0, 1))
    db.exec(`
      INSERT INTO revision_blobs (hash, content)
      VALUES ('legacy-hash', 'legacy body');
      INSERT INTO note_revisions
        (note_id, space, kind, title, tags, content_hash, created_at)
      VALUES
        ('legacy-state', 'main', 'write', 'Legacy', '[]', 'legacy-hash', '2026-08-01');
    `)

    runSqliteMigrations(db)

    expect(
      db
        .prepare(
          'SELECT id, content_hash, state_format, integrity, entry_role FROM note_revisions WHERE note_id = ?',
        )
        .get('legacy-state'),
    ).toEqual({
      id: 1,
      content_hash: 'legacy-hash',
      state_format: null,
      integrity: 'trusted',
      entry_role: 'origin',
    })
    expect(
      db.prepare('SELECT content FROM revision_blobs WHERE hash = ?').get('legacy-hash'),
    ).toEqual({ content: 'legacy body' })
    const defaults = db.prepare('PRAGMA table_info(note_revisions)').all() as Array<{
      name: string
      dflt_value: string | null
    }>
    expect(
      defaults
        .filter(({ name }) => name === 'integrity' || name === 'entry_role')
        .map(({ name, dflt_value }) => ({ name, dflt_value })),
    ).toEqual([
      { name: 'integrity', dflt_value: null },
      { name: 'entry_role', dflt_value: null },
    ])
    const appended = db
      .prepare(
        `INSERT INTO note_revisions
          (note_id, space, kind, title, tags, created_at, integrity, entry_role)
         VALUES ('next-state', 'main', 'write', 'Next', '[]', '2026-08-02', 'trusted', 'origin')`,
      )
      .run()
    expect(appended.lastInsertRowid).toBe(2)

    const fresh = database()
    runSqliteMigrations(fresh)
    expect(sqliteMetaDbCatalog(db)).toEqual(sqliteMetaDbCatalog(fresh))
  })

  it('keeps a pre-#327 purge fence global while scoping every new one', () => {
    // The fence used to be keyed by note id alone while the DELETE beside it was
    // already space-scoped, so one space's trash-emptying permanently silenced a
    // colliding id in ANOTHER space. Scoping it cannot be retroactive: a purge
    // already decided must not be re-opened by an upgrade.
    const db = database()
    runSqliteMigrations(db, migrations.slice(0, 1))
    db.prepare(`INSERT INTO revision_purge_fences (kind, entity_id) VALUES ('note', ?)`).run(
      'legacy-note',
    )

    runSqliteMigrations(db)

    expect(db.prepare('SELECT kind, entity_id, space FROM revision_purge_fences').all()).toEqual([
      { kind: 'note', entity_id: 'legacy-note', space: '' },
    ])

    const append = db.prepare(
      `INSERT INTO note_revisions
         (note_id, space, kind, principal, title, tags, created_at, integrity, entry_role)
       VALUES (?, ?, 'write', 'ui', 'T', '[]', 'now', 'trusted', 'change')`,
    )

    // The legacy fence stays GLOBAL: it was decided when ids were not yet global,
    // so it cannot be narrowed to a space nobody recorded.
    expect(() => append.run('legacy-note', 'alpha')).toThrow(/permanently purged/)
    expect(() => append.run('legacy-note', 'beta')).toThrow(/permanently purged/)

    // A fence written AFTER the upgrade binds only its own space.
    db.prepare(
      `INSERT INTO revision_purge_fences (kind, entity_id, space) VALUES ('note', ?, ?)`,
    ).run('shared-note', 'alpha')
    expect(() => append.run('shared-note', 'alpha')).toThrow(/permanently purged/)
    expect(() => append.run('shared-note', 'beta')).not.toThrow()
  })

  it('backfills the entry role by class, and leaves a cross-space legacy first row alone', () => {
    // Four populations, and the third is the reason the backfill keeps
    // `base_rev IS NULL`: before #327 the chain was keyed by note id ALONE, across
    // spaces, so a note's FIRST row here can carry a parent that lives elsewhere.
    // Calling it a baseline would drop it out of Activity at migration time — before
    // any settlement, where no quarantine fixture would ever look.
    const db = database()

    runSqliteMigrations(db, migrations.slice(0, 1))
    const append = db.prepare(
      `INSERT INTO note_revisions
         (note_id, space, base_rev, kind, principal, title, tags, created_at)
       VALUES (?, ?, ?, ?, 'ui', 'T', '[]', ?)`,
    )

    append.run('seen-first', 'alpha', null, 'external', '2026-06-10T10:00:00.000Z')
    append.run('seen-first', 'alpha', 1, 'write', '2026-06-10T11:00:00.000Z')
    append.run('born-here', 'alpha', null, 'write', '2026-06-10T12:00:00.000Z')
    append.run('chained-elsewhere', 'alpha', 999, 'write', '2026-06-10T13:00:00.000Z')
    // Same note id in another space — the collision the task is named after. Each
    // space's first row is judged on its own.
    append.run('seen-first', 'beta', null, 'write', '2026-06-10T14:00:00.000Z')

    runSqliteMigrations(db)

    expect(
      db
        .prepare('SELECT note_id, space, base_rev, entry_role FROM note_revisions ORDER BY id')
        .all(),
    ).toEqual([
      { note_id: 'seen-first', space: 'alpha', base_rev: null, entry_role: 'baseline' },
      { note_id: 'seen-first', space: 'alpha', base_rev: 1, entry_role: 'change' },
      { note_id: 'born-here', space: 'alpha', base_rev: null, entry_role: 'origin' },
      { note_id: 'chained-elsewhere', space: 'alpha', base_rev: 999, entry_role: 'change' },
      { note_id: 'seen-first', space: 'beta', base_rev: null, entry_role: 'origin' },
    ])
    // And the column refuses a fourth role, in the dialect that has no enum type.
    expect(() =>
      db
        .prepare(
          `INSERT INTO note_revisions
             (note_id, space, kind, principal, title, tags, created_at, integrity, entry_role)
           VALUES ('x', 'alpha', 'write', 'ui', 'T', '[]', 'now', 'trusted', 'first')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/)
  })

  it('refuses a spaceless fence from a pre-#327 writer instead of ignoring it', () => {
    // NOT NULL cannot carry this alone: that writer is INSERT OR IGNORE, so the violation
    // is swallowed and its purge commits the DELETE with no fence at all — permissive,
    // which is the opposite of what an irreversible fence may degrade to.
    const db = database()
    runSqliteMigrations(db)

    expect(() =>
      db
        .prepare(`INSERT OR IGNORE INTO revision_purge_fences (kind, entity_id) VALUES ('note', ?)`)
        .run('old-writer-note'),
    ).toThrow(/purge fence requires a space/)
    expect(db.prepare('SELECT count(*) AS n FROM revision_purge_fences').get()).toEqual({ n: 0 })
  })

  it('migrates credential bookmarks to the furthest owner fallback per project', () => {
    const db = database()
    runSqliteMigrations(db, migrations.slice(0, 1))
    db.exec(`
      INSERT INTO spaces (id, slug, notes_dir, display_name, aliases, created_at)
      VALUES
        ('legacy-space-id', 'legacy-space-slug', 'legacy', 'Legacy', '["retired-space-slug"]', '2026-08-04'),
        ('collision-space-id', 'ambiguous-key', 'collision', 'Collision', NULL, '2026-08-04');
      INSERT INTO folders
        (id, space, path, slug, display_name, status, last_seen, created_at, type)
      VALUES
        ('project-a', 'space-a', 'a', 'project-a', 'Project A', 'active', 'x', 'x', 'project'),
        ('project-b', 'space-a', 'b', 'project-b', 'Project B', 'active', 'x', 'x', 'project'),
        ('project-root', 'legacy-space-id', '', 'root', 'Root', 'active', 'x', 'x', 'project'),
        ('ambiguous-key', 'space-a', 'ambiguous', 'ambiguous', 'Ambiguous', 'active', 'x', 'x', 'project'),
        ('collision-root', 'collision-space-id', '', 'collision', 'Collision', 'active', 'x', 'x', 'project');
    `)
    const insert = db.prepare(
      `INSERT INTO mcp_bookmarks (principal_id, space, last_rev, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    insert.run('pat:alice:pat-a', 'project-a', '11', '2026-08-04T10:00:00Z')
    insert.run('oauth:alice:oauth-a', 'project-a', '44', '2026-08-04T10:01:00Z')
    insert.run('pat:alice:pat-a', 'project-b', '22', '2026-08-04T10:02:00Z')
    insert.run('pat:bob:pat-b', 'project-a', '33', '2026-08-04T10:03:00Z')
    insert.run('ui', 'project-a', '55', '2026-08-04T10:04:00Z')
    insert.run('pat:carol:pat-c', 'legacy-space-id', '66', '2026-08-04T10:05:00Z')
    insert.run('pat:dora:pat-d', 'legacy-space-slug', '77', '2026-08-04T10:06:00Z')
    insert.run('pat:erin:pat-e', 'retired-space-slug', '78', '2026-08-04T10:06:30Z')
    insert.run('unknown', 'project-a', '99', '2026-08-04T10:05:00Z')
    insert.run('pat:eve:pat-e', 'ambiguous-key', '88', '2026-08-04T10:07:00Z')
    insert.run('pat:frank:pat-f', 'missing-project', '89', '2026-08-04T10:08:00Z')

    runSqliteMigrations(db)

    expect(
      db
        .prepare(
          'SELECT owner, project, last_rev FROM mcp_delta_owner_cursors ORDER BY owner, project',
        )
        .all(),
    ).toEqual([
      { owner: AGENT_SYSTEM_OWNER, project: 'project-a', last_rev: '55' },
      { owner: 'alice', project: 'project-a', last_rev: '44' },
      { owner: 'alice', project: 'project-b', last_rev: '22' },
      { owner: 'bob', project: 'project-a', last_rev: '33' },
      { owner: 'carol', project: 'project-root', last_rev: '66' },
      { owner: 'dora', project: 'project-root', last_rev: '77' },
      { owner: 'erin', project: 'project-root', last_rev: '78' },
    ])
    expect(
      db
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'mcp_bookmarks'")
        .get(),
    ).toBeUndefined()
  })

  const tableCounts = (db: DatabaseSync): Record<string, number> =>
    Object.fromEntries(
      (
        db
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
          .all() as Array<{ name: string }>
      ).map(({ name }) => [
        name,
        (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n,
      ]),
    )

  it('moves every user reference onto the stable id and leaves orphans byte-for-byte', async () => {
    const db = database()
    const upTo = migrations.findIndex((migration) => migration.name === 'account_identity')
    runSqliteMigrations(db, migrations.slice(0, upTo))
    db.exec(accountIdentitySeedSql(false))
    const read: LadderReader = {
      one: async (sql) => db.prepare(sql).get(),
      all: async (sql) => db.prepare(sql).all(),
    }
    const triggersBefore = db
      .prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name")
      .all()
    const countsBefore = tableCounts(db)
    // The seed must leave the projection built, or the `rebuilding` assertion at the end
    // would hold without the carrier having done anything.
    await expectActivityProjectionState(read, 'ready')
    const usersBefore = await read.all(usersCarriedColumnsSql)

    runSqliteMigrations(db, migrations)

    // The rebuild of `users` must hand its two lifecycle gates back verbatim, and the
    // in-place column renames must leave every other trigger body untouched.
    expect(
      db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name").all(),
    ).toEqual(triggersBefore)
    const countsAfter = tableCounts(db)
    // Beside the ledger row, two counters legitimately move: the idempotency cache is
    // emptied, and the Activity invalidation that the principal rewrite trips queues a
    // generation for GC. Every other table keeps every row.
    expect(countsAfter.mcp_dedup).toBe(0)
    expect(countsAfter.activity_projection_gc).toBeGreaterThan(countsBefore.activity_projection_gc)
    expect(countsAfter.meta_migrations).toBe(countsBefore.meta_migrations + 1)
    for (const table of ['mcp_dedup', 'activity_projection_gc', 'meta_migrations']) {
      delete countsBefore[table]
      delete countsAfter[table]
    }
    expect(countsAfter).toEqual(countsBefore)

    // `users` is the only table the carrier rebuilds, and everything the INSERT…SELECT
    // copies has to come back byte-for-byte — not just the three columns read below.
    expect(await read.all(usersCarriedColumnsSql)).toEqual(usersBefore)

    const users = db
      .prepare('SELECT username, id, email FROM users ORDER BY username')
      .all() as Array<{
      username: string
      id: string
      email: string | null
    }>
    expect(users.map(({ username }) => username)).toEqual([
      'alice',
      'bob',
      'p1',
      'p2',
      'p3',
      'p4',
      'p5',
      'p6',
    ])
    for (const user of users) {
      expect(user.id).toMatch(/^[0-9a-f]{16}$/)
      expect(user.email).toBeNull()
    }
    expect(new Set(users.map(({ id }) => id)).size).toBe(users.length)
    const id = (username: string): string => users.find((u) => u.username === username)!.id
    const alice = id('alice')
    const bob = id('bob')

    await expectAccountIdentityWorld(read, { alice, bob })
    await expectActivityProjectionState(read, 'rebuilding')
  })

  it('accounts for every schema column that can carry a user reference', () => {
    const db = database()
    runSqliteMigrations(db)
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map(({ name }) => name)
    const candidates = tables.flatMap((table) =>
      (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
        .filter(({ name }) => ACCOUNT_IDENTITY_CANDIDATE_COLUMNS.includes(name))
        .map(({ name }) => `${table}.${name}`),
    )

    expect(candidates.sort()).toEqual(accountIdentityRegistry())
  })

  it('preserves pre-session audit rows and leaves their new attribution snapshot null', () => {
    const db = database()
    runSqliteMigrations(db, migrations.slice(0, 1))
    db.exec(`
      INSERT INTO agent_retrievals
        (owner, principal, agent, tool, query, result_count, hits, created_at)
      VALUES
        ('alice', 'pat:alice:legacy', 'Legacy CLI', 'search', 'old query', 0, '[]',
         '2026-08-01T00:00:00.000Z');
      INSERT INTO note_revisions
        (note_id, space, kind, principal, title, tags, created_at)
      VALUES
        ('legacy-note', 'legacy-space', 'write', 'pat:alice:legacy', 'Legacy note', '[]',
         '2026-08-01T00:00:00.000Z');
    `)

    runSqliteMigrations(db)

    expect(
      db
        .prepare(
          `SELECT owner, query, session_id, session_name, session_attach
             FROM agent_retrievals WHERE query = 'old query'`,
        )
        .get(),
    ).toEqual({
      owner: 'alice',
      query: 'old query',
      session_id: null,
      session_name: null,
      session_attach: null,
    })
    expect(
      db
        .prepare(
          `SELECT note_id, agent_owner, agent_name, session_id, session_name, session_attach,
                  state_format
             FROM note_revisions WHERE note_id = 'legacy-note'`,
        )
        .get(),
    ).toEqual({
      note_id: 'legacy-note',
      agent_owner: null,
      agent_name: null,
      session_id: null,
      session_name: null,
      session_attach: null,
      state_format: null,
    })
  })

  it('cascades session delta positions when retention removes their episode', () => {
    const db = database()
    runSqliteMigrations(db)
    db.exec(`
      INSERT INTO folders
        (id, space, path, slug, display_name, status, last_seen, created_at, type)
      VALUES
        ('project-a', 'space-a', 'a', 'project-a', 'Project A', 'active', 'x', 'x', 'project');
      INSERT INTO agent_sessions
        (id, owner, name, named, parent_id, created_at, last_seen_at, calls)
      VALUES
        ('ses_aaaaaaaaaaaa', 'alice', 'retention probe', 1, NULL, '2026-08-01', '2026-08-01', 1);
      INSERT INTO mcp_delta_session_cursors
        (session_id, project, last_rev, updated_at)
      VALUES
        ('ses_aaaaaaaaaaaa', 'project-a', '42', '2026-08-04');
      DELETE FROM agent_sessions WHERE id = 'ses_aaaaaaaaaaaa';
    `)

    expect(
      (
        db.prepare('SELECT COUNT(*) AS count FROM mcp_delta_session_cursors').get() as {
          count: number
        }
      ).count,
    ).toBe(0)
  })

  it('rejects a legacy or otherwise untracked database before mutating it', () => {
    const db = database()
    db.exec(`CREATE TABLE meta_schema (version INTEGER NOT NULL);
      INSERT INTO meta_schema (version) VALUES (26)`)
    const before = db.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY type, name').all()

    expect(() => runSqliteMigrations(db)).toThrow(/non-empty but has no migration ledger/)

    expect(
      db.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY type, name').all(),
    ).toEqual(before)
    expect(
      (db.prepare('SELECT version FROM meta_schema').get() as { version: number }).version,
    ).toBe(26)
  })

  it('rejects a removed post-baseline ledger before applying target DDL', () => {
    const db = database()
    runSqliteMigrations(db, migrations.slice(0, 1))
    db.prepare(
      `INSERT INTO meta_migrations (version, name, checksum, applied_at)
       VALUES (1, 'agent_sessions', ?, '2026-08-01T00:00:00.000Z')`,
    ).run('sha256:0160a883e4a4e02183809ffc424fbf128c4558861022340b1debb641c498c8f0')

    expect(() => runSqliteMigrations(db)).toThrow(/name mismatch/)
    expect(
      db
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'agent_sessions'")
        .get(),
    ).toBeUndefined()
  })

  it.each([
    {
      label: 'an empty ledger',
      mutate: (db: DatabaseSync) => db.exec('DELETE FROM meta_migrations'),
      message: /contains no baseline row/,
    },
    {
      label: 'a version gap',
      mutate: (db: DatabaseSync) => db.exec('DELETE FROM meta_migrations WHERE version = 0'),
      message: /expected version 0, found 1/,
    },
    {
      label: 'name drift',
      mutate: (db: DatabaseSync) =>
        db.exec("UPDATE meta_migrations SET name = 'rewritten_baseline' WHERE version = 0"),
      message: /name mismatch/,
    },
    {
      label: 'checksum drift',
      mutate: (db: DatabaseSync) =>
        db.exec(
          `UPDATE meta_migrations SET checksum = 'sha256:${'0'.repeat(64)}' WHERE version = 0`,
        ),
      message: /checksum mismatch/,
    },
    {
      label: 'an unknown future migration',
      mutate: (db: DatabaseSync) =>
        db.exec(
          `INSERT INTO meta_migrations (version, name, checksum, applied_at)
           VALUES (${nextMigrationVersion}, 'future', 'sha256:${'1'.repeat(64)}', '2099-01-01T00:00:00.000Z')`,
        ),
      message: new RegExp(`unknown future migration ${nextMigrationVersion}`),
    },
  ])('fails closed on $label', ({ mutate, message }) => {
    const db = database()
    runSqliteMigrations(db)
    mutate(db)
    const before = db
      .prepare('SELECT version, name, checksum, applied_at FROM meta_migrations ORDER BY version')
      .all()

    expect(() => runSqliteMigrations(db)).toThrow(message)
    expect(
      db
        .prepare('SELECT version, name, checksum, applied_at FROM meta_migrations ORDER BY version')
        .all(),
    ).toEqual(before)
  })

  it('rolls back failed SQL with its ledger stamp and remains retryable after repair', () => {
    const db = database()
    runSqliteMigrations(db)

    const brokenSql = `CREATE TABLE migration_probe (value TEXT);
      INSERT INTO missing_table (value) VALUES ('never')`
    const broken: MetaMigration = {
      version: nextMigrationVersion,
      name: 'add_probe',
      checksum: checksumMigrationPair(brokenSql, 'SELECT broken'),
      sqlite: brokenSql,
      postgres: 'SELECT broken',
    }

    expect(() => runSqliteMigrations(db, [...migrations, broken])).toThrow(/missing_table/)
    expect(ledger(db).map(({ version }) => version)).toEqual(appliedVersions)
    expect(
      db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'migration_probe'").get(),
    ).toBeUndefined()

    const repairedSql = 'CREATE TABLE migration_probe (value TEXT)'
    const repaired: MetaMigration = {
      version: nextMigrationVersion,
      name: 'add_probe',
      checksum: checksumMigrationPair(repairedSql, 'SELECT repaired'),
      sqlite: repairedSql,
      postgres: 'SELECT repaired',
    }
    runSqliteMigrations(db, [...migrations, repaired])

    expect(ledger(db).map(({ version }) => version)).toEqual([
      ...appliedVersions,
      nextMigrationVersion,
    ])
    expect(
      db.prepare("SELECT type FROM sqlite_schema WHERE name = 'migration_probe'").get(),
    ).toEqual({ type: 'table' })
  })

  it('rejects transaction control inside SQLite assets without escaping the owned transaction', () => {
    const db = database()
    runSqliteMigrations(db)
    const escapingSql = `CREATE TABLE escaped_transaction (value TEXT);
      COMMIT;
      INSERT INTO missing_table (value) VALUES ('never')`
    const escaping: MetaMigration = {
      version: nextMigrationVersion,
      name: 'escape_transaction',
      checksum: checksumMigrationPair(escapingSql, 'SELECT escape'),
      sqlite: escapingSql,
      postgres: 'SELECT escape',
    }

    expect(() => runSqliteMigrations(db, [...migrations, escaping])).toThrow(/not authorized/)
    expect(db.isTransaction).toBe(false)
    expect(ledger(db).map(({ version }) => version)).toEqual(appliedVersions)
    expect(
      db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'escaped_transaction'").get(),
    ).toBeUndefined()
  })

  it('preserves the original error when SQLite rolls back the transaction itself', () => {
    const db = database()
    runSqliteMigrations(db)
    const rollingBackSql = `CREATE TABLE rollback_probe (value TEXT UNIQUE);
      INSERT INTO rollback_probe (value) VALUES ('duplicate');
      INSERT OR ROLLBACK INTO rollback_probe (value) VALUES ('duplicate')`
    const rollingBack: MetaMigration = {
      version: nextMigrationVersion,
      name: 'rollback_transaction',
      checksum: checksumMigrationPair(rollingBackSql, 'SELECT rollback'),
      sqlite: rollingBackSql,
      postgres: 'SELECT rollback',
    }

    expect(() => runSqliteMigrations(db, [...migrations, rollingBack])).toThrow(/UNIQUE constraint/)
    expect(db.isTransaction).toBe(false)
    expect(ledger(db).map(({ version }) => version)).toEqual(appliedVersions)
    expect(
      db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'rollback_probe'").get(),
    ).toBeUndefined()
  })

  it('rejects edited SQL and unmanifested dialect files', () => {
    const checksumDrift = copiedAssets()
    const sqlitePath = join(checksumDrift, 'sqlite', '0000_baseline.sql')
    writeFileSync(sqlitePath, `${readFileSync(sqlitePath, 'utf8')}\n-- rewritten\n`)
    expect(() => loadMetaMigrationsFromDirectory(checksumDrift)).toThrow(/checksum mismatch/)

    const extraFile = copiedAssets()
    writeFileSync(join(extraFile, 'postgres', '0001_untracked.sql'), 'SELECT 1;\n')
    expect(() => loadMetaMigrationsFromDirectory(extraFile)).toThrow(
      /PostgreSQL migration files differ from manifest/,
    )
  })

  it('checksums exact file bytes and rejects an invalid UTF-8 asset', () => {
    expect(checksumMigrationPair(Uint8Array.of(0x80), Uint8Array.of(0x01))).not.toBe(
      checksumMigrationPair(Uint8Array.of(0x81), Uint8Array.of(0x01)),
    )

    const directory = copiedAssets()
    const sqlitePath = join(directory, 'sqlite', '0000_baseline.sql')
    const postgresPath = join(directory, 'postgres', '0000_baseline.sql')
    const corrupted = Buffer.concat([
      readFileSync(sqlitePath),
      Buffer.from([0x0a, 0x2d, 0x2d, 0x20, 0x80]),
    ])
    writeFileSync(sqlitePath, corrupted)
    const manifestPath = join(directory, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      migrations: Array<{ checksum: string }>
    }
    manifest.migrations[0].checksum = checksumMigrationPair(corrupted, readFileSync(postgresPath))
    writeFileSync(manifestPath, JSON.stringify(manifest))

    expect(() => loadMetaMigrationsFromDirectory(directory)).toThrow(/is not valid UTF-8/)
  })

  it('rejects a manifest name that the unique ledger could not store', () => {
    const directory = copiedAssets()
    const manifestPath = join(directory, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      migrations: Array<Record<string, unknown>>
    }
    manifest.migrations.push({
      version: nextMigrationVersion,
      name: 'baseline',
      checksum: `sha256:${'0'.repeat(64)}`,
      sqlite: `sqlite/${String(nextMigrationVersion).padStart(4, '0')}_baseline.sql`,
      postgres: `postgres/${String(nextMigrationVersion).padStart(4, '0')}_baseline.sql`,
    })
    writeFileSync(manifestPath, JSON.stringify(manifest))

    expect(() => loadMetaMigrationsFromDirectory(directory)).toThrow(
      new RegExp(`migration ${nextMigrationVersion} duplicates name baseline`),
    )
  })
})
