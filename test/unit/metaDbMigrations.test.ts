import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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

type LedgerRow = {
  version: number
  name: string
  checksum: string
  applied_at: string
}

const sourceDirectory = fileURLToPath(
  new URL('../../packages/server/src/services/metaDb/migrations/', import.meta.url),
)

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
      { version: 1, name: 'agent_sessions' },
      { version: 2, name: 'agent_session_role' },
      { version: 3, name: 'revision_integrity' },
      { version: 4, name: 'scoped_purge_fences' },
      { version: 5, name: 'revision_entry_role' },
      { version: 6, name: 'revision_state' },
      { version: 7, name: 'revision_purge_cas' },
      { version: 8, name: 'causal_metadata' },
      { version: 9, name: 'agent_activity' },
      { version: 10, name: 'import_reservations' },
      { version: 11, name: 'legacy_name_aliases' },
      { version: 12, name: 'identity_settlement_lineage' },
      { version: 13, name: 'agent_session_role_identity' },
      { version: 14, name: 'ability_availability' },
      { version: 15, name: 'ability_preferences' },
      { version: 16, name: 'ability_placement_trail' },
      { version: 17, name: 'ability_create_operations' },
      { version: 18, name: 'causal_operation_lifecycle' },
      { version: 19, name: 'ability_placement_identity' },
      { version: 20, name: 'ability_create_success_replay' },
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
    // Both lines land in one schema: main's import reservation pair (#302) on top of
    // the agent session/availability/preference tables (#309). Two of the indexes are
    // the second key each ability table is found again by: the availability policy's
    // registry note, and the locator a placement move rewrites for every owner. The
    // placement trail adds the third table of that group and its own two: the hop is
    // read forwards (by `from_locator`, which is the primary key), re-pointed backwards
    // (by `to_locator`, the sweep that keeps it one hop deep) and purged by Space.
    // Two 0019 guards allow legacy identity-less rows to remain while refusing any
    // new or rewritten hop that does not bind a registry note identity.
    expect(counts).toEqual({ index: 64, table: 44, trigger: 33 })
    expect(
      db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'meta_schema'").get(),
    ).toBeUndefined()
    expect((db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum).toBe(2)
  })

  it('keeps a legacy identity-less trail row but requires identity on new and rewritten rows', () => {
    const db = database()

    runSqliteMigrations(db, migrations.slice(0, 19))
    db.prepare(
      `INSERT INTO ability_placement_trail (from_locator, to_locator, space_id)
       VALUES ('legacy-from', 'legacy-to', 'space-main')`,
    ).run()

    runSqliteMigrations(db)

    expect(
      db
        .prepare(
          `SELECT to_locator, registry_note_id, manifest_note_id
             FROM ability_placement_trail
            WHERE from_locator = 'legacy-from'`,
        )
        .get(),
    ).toEqual({ to_locator: 'legacy-to', registry_note_id: null, manifest_note_id: null })
    expect(() =>
      db
        .prepare(
          `INSERT INTO ability_placement_trail (from_locator, to_locator, space_id)
           VALUES ('new-from', 'new-to', 'space-main')`,
        )
        .run(),
    ).toThrow(/requires both note identities/)
    expect(() =>
      db
        .prepare(
          `UPDATE ability_placement_trail
              SET to_locator = 'legacy-next'
            WHERE from_locator = 'legacy-from'`,
        )
        .run(),
    ).toThrow(/requires both note identities/)
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

    runSqliteMigrations(db, migrations.slice(0, 20))
    db.prepare(
      `INSERT INTO ability_create_operations
        (id, actor_digest, idempotency_digest, request_fingerprint, space, package_id,
         note_id, target_path, availability_required, stage_binding, phase,
         prepared_evidence, created_at, updated_at)
       VALUES (?, 'actor', 'key', 'request', 'space-main', ?, ?, ?, 0, 'binding',
               'rejected', '{}', '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z')`,
    ).run('rejected-operation', 'PackageId001', 'RegistryNote1', 'first/SKILL.md')

    runSqliteMigrations(db)

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

  it('adds a null role without losing an existing v1 session row', () => {
    const db = database()
    runSqliteMigrations(db, migrations.slice(0, 2))
    db.prepare(
      `INSERT INTO agent_sessions
        (id, owner, name, named, parent_id, created_at, last_seen_at, calls)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('ses_existingv1aa', 'alice', 'Existing', 1, null, 'created', 'seen', 7)

    runSqliteMigrations(db)

    expect(
      db
        .prepare(
          'SELECT owner, name, calls, role, role_locator, role_context_project_id, project_id FROM agent_sessions WHERE id = ?',
        )
        .get('ses_existingv1aa'),
    ).toEqual({
      owner: 'alice',
      name: 'Existing',
      calls: 7,
      role: null,
      role_locator: null,
      role_context_project_id: null,
      project_id: null,
    })
  })

  it('adds an empty legacy alias set without guessing from existing names or paths', () => {
    const db = database()
    runSqliteMigrations(db, migrations.slice(0, 10))
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
    runSqliteMigrations(db, migrations.slice(0, 12))
    db.prepare(
      `INSERT INTO note_identity
        (id, file_path, space, created_at, materialized, deleted_at, legacy_name_aliases)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('existing-identity', 'same.md', 'main', null, 1, null, '[]')

    runSqliteMigrations(db)

    expect(
      db
        .prepare('SELECT file_path, settlement_successor_id FROM note_identity WHERE id = ?')
        .get('existing-identity'),
    ).toEqual({ file_path: 'same.md', settlement_successor_id: null })
  })

  it('adds the revision snapshot marker without relabelling legacy body blobs', () => {
    const db = database()
    runSqliteMigrations(db, migrations.slice(0, 6))
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
        .prepare('SELECT content_hash, snapshot_format FROM note_revisions WHERE note_id = ?')
        .get('legacy-state'),
    ).toEqual({ content_hash: 'legacy-hash', snapshot_format: null })
  })

  it('keeps a pre-#327 purge fence global while scoping every new one', () => {
    // The fence used to be keyed by note id alone while the DELETE beside it was
    // already space-scoped, so one space's trash-emptying permanently silenced a
    // colliding id in ANOTHER space. Scoping it cannot be retroactive: a purge
    // already decided must not be re-opened by an upgrade.
    const db = database()
    runSqliteMigrations(db, migrations.slice(0, 4))
    db.prepare(`INSERT INTO revision_purge_fences (kind, entity_id) VALUES ('note', ?)`).run(
      'legacy-note',
    )

    runSqliteMigrations(db)

    expect(db.prepare('SELECT kind, entity_id, space FROM revision_purge_fences').all()).toEqual([
      { kind: 'note', entity_id: 'legacy-note', space: '' },
    ])

    const append = db.prepare(
      `INSERT INTO note_revisions
         (note_id, space, kind, principal, title, tags, created_at, integrity)
       VALUES (?, ?, 'write', 'ui', 'T', '[]', 'now', 'trusted')`,
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

    runSqliteMigrations(db, migrations.slice(0, 5))
    const append = db.prepare(
      `INSERT INTO note_revisions
         (note_id, space, base_rev, kind, principal, title, tags, created_at, integrity)
       VALUES (?, ?, ?, ?, 'ui', 'T', '[]', ?, 'trusted')`,
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
                  snapshot_format
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
      snapshot_format: null,
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
