import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'

import { AGENT_SYSTEM_OWNER } from '../../packages/server/src/services/authz'
import { REVISION_PURGE_PROTOCOL } from '../../packages/server/src/services/metaDb/consts'
import {
  checksumMigrationPair,
  loadMetaMigrations,
  type MetaMigration,
  runPgMigrations,
} from '../../packages/server/src/services/metaDb/migrations'
import { PgMetaDb } from '../../packages/server/src/services/metaDb/pgMetaDb'
import { approvedTargetCatalog, type MetaDbCatalog, pgMetaDbCatalog } from './metaDbCatalog'
import type { PostgresTestSchema } from './postgresHarness'
import { createPostgresTestSchema, describePostgres } from './postgresHarness'

type LedgerRow = {
  version: number
  name: string
  checksum: string
  applied_at: string
}

const postgresGolden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./fixtures/metaDbCatalog.postgres.json', import.meta.url)),
    'utf8',
  ),
) as MetaDbCatalog

describePostgres('Postgres meta-DB migrations', { timeout: 30_000 }, () => {
  const schemas: PostgresTestSchema[] = []
  const migrations = loadMetaMigrations()
  const nextMigrationVersion = migrations.length
  const appliedVersions = migrations.map(({ version }) => version)

  afterEach(async () => {
    while (schemas.length) {
      await schemas.pop()!.teardown()
    }
  })

  const createSchema = async (prefix: string): Promise<PostgresTestSchema> => {
    const schema = await createPostgresTestSchema(prefix)
    schemas.push(schema)
    return schema
  }

  const quotedIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`
  const identifierOf = ({ schema }: PostgresTestSchema): string => quotedIdentifier(schema)

  const ledger = async (testSchema: PostgresTestSchema): Promise<LedgerRow[]> => {
    const result = await testSchema.admin.query(
      `SELECT version, name, checksum, applied_at
         FROM ${identifierOf(testSchema)}.meta_migrations
        ORDER BY version`,
    )
    return result.rows.map((row): LedgerRow => ({
      version: Number(row.version),
      name: String(row.name),
      checksum: String(row.checksum),
      applied_at: String(row.applied_at),
    }))
  }

  it('serializes concurrent fresh init and remains idempotent after reopen', async () => {
    const testSchema = await createSchema('migration_race')
    const peer = new PgMetaDb(testSchema.scopedUrl)
    const reopened = new PgMetaDb(testSchema.scopedUrl)

    try {
      await Promise.all([testSchema.db.identity.init(), peer.identity.init()])
      await testSchema.db.identity.claimMany([
        {
          id: 'id-concurrent',
          legacyNameAliases: [],
          filePath: 'concurrent.md',
          space: 'space-a',
          createdAt: null,
          materialized: false,
          deletedAt: null,
        },
      ])
      const firstLedger = await ledger(testSchema)
      expect(firstLedger).toHaveLength(migrations.length)
      expect(firstLedger[0]).toMatchObject({
        version: 0,
        name: 'baseline',
        checksum: migrations[0].checksum,
      })

      await reopened.identity.init()
      expect(await reopened.identity.loadAll('space-a')).toHaveLength(1)
      expect(await ledger(testSchema)).toEqual(firstLedger)
      expect(
        await testSchema.admin.query(
          `SELECT to_regclass('${testSchema.schema}.meta_schema') AS legacy`,
        ),
      ).toMatchObject({ rows: [{ legacy: null }] })
    } finally {
      await peer.close()
      await reopened.close()
    }
  })

  it('matches the normalized pre-cut catalog plus the approved deltas', async () => {
    const testSchema = await createSchema('migration_golden')
    const pool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const client = await pool.connect()

    try {
      await runPgMigrations(client)
      expect(await pgMetaDbCatalog(client, testSchema.schema)).toEqual(
        approvedTargetCatalog(postgresGolden),
      )
    } finally {
      client.release()
      await pool.end()
    }
  })

  it('requires both identities on every placement trail row', async () => {
    const testSchema = await createSchema('migration_placement_identity')
    const pool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const client = await pool.connect()

    try {
      await runPgMigrations(client)
      await expect(
        client.query(
          `INSERT INTO ability_placement_trail (from_locator, to_locator, space_id)
           VALUES ('old', 'new', 'space-main')`,
        ),
      ).rejects.toThrow(/null value in column "registry_note_id"/)
      await client.query(
        `INSERT INTO ability_placement_trail
          (from_locator, to_locator, space_id, registry_note_id, manifest_note_id)
         VALUES ('old', 'new', 'space-main', 'RegistryNote1', 'ManifestNote1')`,
      )
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
      await pool.end()
    }
  })

  it('lets an accepted create reuse a key held only by rejected history', async () => {
    const testSchema = await createSchema('migration_create_replay')
    const pool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const client = await pool.connect()

    try {
      await runPgMigrations(client)
      await client.query(
        `INSERT INTO ability_create_operations
          (id, actor_digest, idempotency_digest, request_fingerprint, space, package_id,
           note_id, target_path, availability_required, stage_binding, phase,
           prepared_evidence, created_at, updated_at)
         VALUES
          ('rejected-operation', 'actor', 'key', 'request', 'space-main', 'PackageId001',
           'RegistryNote1', 'first/SKILL.md', false, 'binding', 'rejected', '{}', 'x', 'x'),
          ('retry-operation', 'actor', 'key', 'request', 'space-main', 'PackageId002',
           'RegistryNote2', 'second/SKILL.md', false, 'binding', 'accepted', '{}', 'y', 'y')`,
      )
      expect(
        await client.query(
          `SELECT id, phase FROM ability_create_operations
            WHERE actor_digest = 'actor' AND idempotency_digest = 'key' ORDER BY id`,
        ),
      ).toMatchObject({
        rows: [
          { id: 'rejected-operation', phase: 'rejected' },
          { id: 'retry-operation', phase: 'accepted' },
        ],
      })
    } finally {
      client.release()
      await pool.end()
    }
  })

  it('adds an empty legacy alias set without guessing from existing names or paths', async () => {
    const testSchema = await createSchema('migration_legacy_aliases')
    const pool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const client = await pool.connect()

    try {
      await runPgMigrations(client, migrations.slice(0, 1))
      await client.query(
        `INSERT INTO note_identity
          (id, file_path, space, created_at, materialized, deleted_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['legacy-identity', 'aza-stan-zhospary.md', 'main', null, true, null],
      )

      await runPgMigrations(client, migrations)

      const result = await client.query(
        'SELECT file_path, legacy_name_aliases FROM note_identity WHERE id = $1',
        ['legacy-identity'],
      )
      expect(result.rows).toEqual([
        { file_path: 'aza-stan-zhospary.md', legacy_name_aliases: '[]' },
      ])
    } finally {
      client.release()
      await pool.end()
    }
  })

  it('adds empty settlement lineage without inferring ancestry from existing paths', async () => {
    const testSchema = await createSchema('migration_settlement_lineage')
    const pool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const client = await pool.connect()

    try {
      await runPgMigrations(client, migrations.slice(0, 1))
      await client.query(
        `INSERT INTO note_identity
          (id, file_path, space, created_at, materialized, deleted_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['existing-identity', 'same.md', 'main', null, true, null],
      )

      await runPgMigrations(client, migrations)

      const result = await client.query(
        'SELECT file_path, settlement_successor_id FROM note_identity WHERE id = $1',
        ['existing-identity'],
      )
      expect(result.rows).toEqual([{ file_path: 'same.md', settlement_successor_id: null }])
    } finally {
      client.release()
      await pool.end()
    }
  })

  it('keeps baseline body blobs as nullable state format', async () => {
    const testSchema = await createSchema('migration_revision_state')
    const pool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const client = await pool.connect()

    try {
      await runPgMigrations(client, migrations.slice(0, 1))
      await client.query('INSERT INTO revision_blobs (hash, content) VALUES ($1, $2)', [
        'legacy-hash',
        'legacy body',
      ])
      await client.query(
        `INSERT INTO note_revisions
          (note_id, space, kind, title, tags, content_hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['legacy-state', 'main', 'write', 'Legacy', '[]', 'legacy-hash', '2026-08-01'],
      )

      await runPgMigrations(client, migrations)

      const result = await client.query(
        `SELECT id::int AS id, content_hash, state_format, integrity, entry_role
           FROM note_revisions WHERE note_id = $1`,
        ['legacy-state'],
      )
      expect(result.rows).toEqual([
        {
          id: 1,
          content_hash: 'legacy-hash',
          state_format: null,
          integrity: 'trusted',
          entry_role: 'origin',
        },
      ])
      expect(
        await client.query('SELECT convert_from(content, $1) AS content FROM revision_blobs', [
          'UTF8',
        ]),
      ).toMatchObject({ rows: [{ content: 'legacy body' }] })
      const defaults = await client.query(
        `SELECT column_name, column_default
           FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'note_revisions'
            AND column_name IN ('integrity', 'entry_role')
          ORDER BY ordinal_position`,
        [testSchema.schema],
      )
      expect(defaults.rows).toEqual([
        { column_name: 'integrity', column_default: null },
        { column_name: 'entry_role', column_default: null },
      ])
      expect(await pgMetaDbCatalog(client, testSchema.schema)).toEqual(
        approvedTargetCatalog(postgresGolden),
      )
    } finally {
      client.release()
      await pool.end()
    }
  })

  it('backfills the entry role by class, and leaves a cross-space legacy first row alone', async () => {
    // Twin of the SQLite case in test/unit/metaDbMigrations.test.ts. Same text in both
    // assets on purpose: the backfill defines a rule, and two spellings of one rule
    // drift. The third row is why `base_rev IS NULL` survives in it — pre-#327 the
    // chain ignored the space, so a note's first row here can point at another one.
    const testSchema = await createSchema('migration_entry_role')
    const pool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const client = await pool.connect()

    try {
      await runPgMigrations(client, migrations.slice(0, 1))
      const append = (noteId: string, space: string, baseRev: number | null, kind: string) =>
        client.query(
          `INSERT INTO note_revisions
             (note_id, space, base_rev, kind, principal, title, tags, created_at)
           VALUES ($1, $2, $3, $4, 'ui', 'T', '[]', '2026-06-10T10:00:00.000Z')`,
          [noteId, space, baseRev, kind],
        )

      await append('seen-first', 'alpha', null, 'external')
      await append('seen-first', 'alpha', 1, 'write')
      await append('born-here', 'alpha', null, 'write')
      await append('chained-elsewhere', 'alpha', 999, 'write')
      await append('seen-first', 'beta', null, 'write')

      await runPgMigrations(client, migrations)

      const result = await client.query(
        'SELECT note_id, space, base_rev::int AS base_rev, entry_role FROM note_revisions ORDER BY id',
      )

      expect(result.rows).toEqual([
        { note_id: 'seen-first', space: 'alpha', base_rev: null, entry_role: 'baseline' },
        { note_id: 'seen-first', space: 'alpha', base_rev: 1, entry_role: 'change' },
        { note_id: 'born-here', space: 'alpha', base_rev: null, entry_role: 'origin' },
        { note_id: 'chained-elsewhere', space: 'alpha', base_rev: 999, entry_role: 'change' },
        { note_id: 'seen-first', space: 'beta', base_rev: null, entry_role: 'origin' },
      ])
      await expect(
        client.query(
          `INSERT INTO note_revisions
             (note_id, space, kind, principal, title, tags, created_at, integrity, entry_role)
           VALUES ('x', 'alpha', 'write', 'ui', 'T', '[]', 'now', 'trusted', 'first')`,
        ),
      ).rejects.toThrow(/check constraint/i)
    } finally {
      client.release()
      await pool.end()
    }
  })

  it('rejects the published purge token and accepts the semantic protocol', async () => {
    const testSchema = await createSchema('migration_revision_purge_cas')
    const pool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const client = await pool.connect()

    try {
      await runPgMigrations(client, migrations.slice(0, 1))
      await client.query(
        `INSERT INTO note_revisions (note_id, space, kind, title, tags, created_at)
         VALUES ('rolling-purge', 'main', 'delete', 'Rolling purge', '[]', '2026-08-09')`,
      )
      await runPgMigrations(client, migrations)

      await client.query('BEGIN')
      await client.query("SELECT set_config('notarium.revision_purge_protocol', 'v26', true)")
      await expect(
        client.query("DELETE FROM note_revisions WHERE note_id = 'rolling-purge'"),
      ).rejects.toThrow(/revision purge requires a fenced writer/)
      await client.query('ROLLBACK')

      await client.query('BEGIN')
      await client.query("SELECT set_config('notarium.revision_purge_protocol', $1, true)", [
        REVISION_PURGE_PROTOCOL,
      ])
      await client.query("DELETE FROM note_revisions WHERE note_id = 'rolling-purge'")
      await client.query('COMMIT')
      expect(
        await client.query("SELECT 1 FROM note_revisions WHERE note_id = 'rolling-purge'"),
      ).toMatchObject({ rowCount: 0 })
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
      await pool.end()
    }
  })

  it('keeps a pre-#327 purge fence global while scoping every new one', async () => {
    // Twin of the SQLite case in test/unit/metaDbMigrations.test.ts: the fence used to be
    // keyed by note id alone while the DELETE beside it was already space-scoped, so one
    // space's trash-emptying permanently silenced a colliding id in ANOTHER space. Scoping
    // it cannot be retroactive: a purge already decided must not be re-opened by an upgrade.
    const testSchema = await createSchema('migration_scoped_fences')
    const pool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const client = await pool.connect()

    try {
      await runPgMigrations(client, migrations.slice(0, 1))
      await client.query(
        `INSERT INTO revision_purge_fences (kind, entity_id) VALUES ('note', $1)`,
        ['legacy-note'],
      )

      await runPgMigrations(client, migrations)

      const fences = await client.query(
        'SELECT kind, entity_id, space FROM revision_purge_fences ORDER BY entity_id',
      )
      expect(fences.rows).toEqual([{ kind: 'note', entity_id: 'legacy-note', space: '' }])

      const append = (noteId: string, space: string): Promise<unknown> =>
        client.query(
          `INSERT INTO note_revisions
             (note_id, space, kind, principal, title, tags, created_at, integrity, entry_role)
           VALUES ($1, $2, 'write', 'ui', 'T', '[]', 'now', 'trusted', 'change')`,
          [noteId, space],
        )

      // The legacy fence stays GLOBAL: it was decided when ids were not yet global, so it
      // cannot be narrowed to a space nobody recorded.
      await expect(append('legacy-note', 'alpha')).rejects.toThrow(/permanently purged/)
      await expect(append('legacy-note', 'beta')).rejects.toThrow(/permanently purged/)

      // A fence written AFTER the upgrade binds only its own space.
      await client.query(
        `INSERT INTO revision_purge_fences (kind, entity_id, space) VALUES ('note', $1, $2)`,
        ['shared-note', 'alpha'],
      )
      await expect(append('shared-note', 'alpha')).rejects.toThrow(/permanently purged/)
      await expect(append('shared-note', 'beta')).resolves.toBeDefined()
    } finally {
      client.release()
      await pool.end()
    }
  })

  it('migrates credential bookmarks to the furthest owner fallback per project', async () => {
    const testSchema = await createSchema('migration_agent_delta_cursors')
    const pool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const client = await pool.connect()

    try {
      await runPgMigrations(client, migrations.slice(0, 1))
      await client.query(`
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
          ('collision-root', 'collision-space-id', '', 'collision', 'Collision', 'active', 'x', 'x', 'project')
      `)
      await client.query(
        `INSERT INTO mcp_bookmarks (principal_id, space, last_rev, updated_at)
         VALUES
           ('pat:alice:pat-a', 'project-a', '11', '2026-08-04T10:00:00Z'),
           ('oauth:alice:oauth-a', 'project-a', '44', '2026-08-04T10:01:00Z'),
           ('pat:alice:pat-a', 'project-b', '22', '2026-08-04T10:02:00Z'),
           ('pat:bob:pat-b', 'project-a', '33', '2026-08-04T10:03:00Z'),
           ('ui', 'project-a', '55', '2026-08-04T10:04:00Z'),
           ('pat:carol:pat-c', 'legacy-space-id', '66', '2026-08-04T10:05:00Z'),
           ('pat:dora:pat-d', 'legacy-space-slug', '77', '2026-08-04T10:06:00Z'),
           ('pat:erin:pat-e', 'retired-space-slug', '78', '2026-08-04T10:06:30Z'),
           ('unknown', 'project-a', '99', '2026-08-04T10:05:00Z'),
           ('pat:eve:pat-e', 'ambiguous-key', '88', '2026-08-04T10:07:00Z'),
           ('pat:frank:pat-f', 'missing-project', '89', '2026-08-04T10:08:00Z')`,
      )

      await runPgMigrations(client, migrations)

      const result = await client.query(
        `SELECT owner, project, last_rev
           FROM mcp_delta_owner_cursors
          ORDER BY owner, project`,
      )
      expect(result.rows).toEqual([
        { owner: AGENT_SYSTEM_OWNER, project: 'project-a', last_rev: '55' },
        { owner: 'alice', project: 'project-a', last_rev: '44' },
        { owner: 'alice', project: 'project-b', last_rev: '22' },
        { owner: 'bob', project: 'project-a', last_rev: '33' },
        { owner: 'carol', project: 'project-root', last_rev: '66' },
        { owner: 'dora', project: 'project-root', last_rev: '77' },
        { owner: 'erin', project: 'project-root', last_rev: '78' },
      ])
      expect(await client.query(`SELECT to_regclass('mcp_bookmarks') AS legacy`)).toMatchObject({
        rows: [{ legacy: null }],
      })
    } finally {
      client.release()
      await pool.end()
    }
  })

  it('retires the migration backend before the application pool serves queries', async () => {
    const testSchema = await createSchema('migration_session_isolation')

    const connectionCount = async (): Promise<number> => {
      const result = await testSchema.admin.query(
        'SELECT COUNT(*) AS n FROM pg_stat_activity WHERE application_name = $1',
        [testSchema.schema],
      )
      return Number(result.rows[0]?.n)
    }

    await testSchema.db.identity.init()
    expect(await connectionCount()).toBe(0)

    await testSchema.db.identity.loadAll('space-a')
    expect(await connectionCount()).toBe(1)
  })

  it('waits for an in-flight migration before close and does not resurrect its pool', async () => {
    const testSchema = await createSchema('migration_close_race')
    const blocker = await testSchema.admin.connect()

    try {
      await blocker.query(
        `SELECT pg_advisory_lock(
           hashtext(current_database()),
           hashtext($1::text)
         )`,
        [testSchema.schema],
      )
      const init = testSchema.db.identity.init()
      await vi.waitFor(
        async () => {
          const activity = await testSchema.admin.query(
            `SELECT COUNT(*) AS n
               FROM pg_stat_activity
              WHERE application_name = $1
                AND wait_event_type = 'Lock'`,
            [testSchema.schema],
          )
          expect(Number(activity.rows[0]?.n)).toBe(1)
        },
        { timeout: 5000 },
      )

      let closed = false
      const close = testSchema.db.close().then(() => {
        closed = true
      })
      await testSchema.admin.query('SELECT pg_sleep(0.05)')
      expect(closed).toBe(false)

      await blocker.query(
        `SELECT pg_advisory_unlock(
           hashtext(current_database()),
           hashtext($1::text)
         )`,
        [testSchema.schema],
      )
      await Promise.all([init, close])

      await vi.waitFor(async () => {
        const activity = await testSchema.admin.query(
          'SELECT COUNT(*) AS n FROM pg_stat_activity WHERE application_name = $1',
          [testSchema.schema],
        )
        expect(Number(activity.rows[0]?.n)).toBe(0)
      })
      expect((testSchema.db as unknown as { pool: pg.Pool | null }).pool).toBeNull()
    } finally {
      await blocker
        .query(
          `SELECT pg_advisory_unlock(
             hashtext(current_database()),
             hashtext($1::text)
           )`,
          [testSchema.schema],
        )
        .catch(() => {})
      blocker.release()
    }
  })

  it('rejects an untracked legacy schema without mutation, closes the pool, and retries after repair', async () => {
    const testSchema = await createSchema('migration_untracked')
    const identifier = identifierOf(testSchema)
    await testSchema.admin.query(
      `CREATE TABLE ${identifier}.meta_schema (version INTEGER NOT NULL)`,
    )
    await testSchema.admin.query(`INSERT INTO ${identifier}.meta_schema (version) VALUES (26)`)

    await expect(testSchema.db.identity.init()).rejects.toThrow(
      /non-empty but has no migration ledger/,
    )
    expect(
      await testSchema.admin.query(`SELECT version FROM ${identifier}.meta_schema`),
    ).toMatchObject({ rows: [{ version: 26 }] })
    expect(
      await testSchema.admin.query(
        `SELECT to_regclass('${testSchema.schema}.meta_migrations') AS ledger`,
      ),
    ).toMatchObject({ rows: [{ ledger: null }] })

    await testSchema.admin.query(`DROP TABLE ${identifier}.meta_schema`)
    await testSchema.db.identity.init()
    expect(await ledger(testSchema)).toHaveLength(migrations.length)

    await testSchema.db.close()
    const activity = await testSchema.admin.query(
      'SELECT COUNT(*) AS n FROM pg_stat_activity WHERE application_name = $1',
      [testSchema.schema],
    )
    expect(Number(activity.rows[0]?.n)).toBe(0)
  })

  it('rejects a removed post-baseline ledger before applying target DDL', async () => {
    const testSchema = await createSchema('migration_removed_prefix')
    const pool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const client = await pool.connect()

    try {
      await runPgMigrations(client, migrations.slice(0, 1))
      await client.query(
        `INSERT INTO meta_migrations (version, name, checksum, applied_at)
         VALUES (1, 'agent_sessions', $1, '2026-08-01T00:00:00.000Z')`,
        ['sha256:0160a883e4a4e02183809ffc424fbf128c4558861022340b1debb641c498c8f0'],
      )

      await expect(runPgMigrations(client)).rejects.toThrow(/name mismatch/)
      expect(
        await client.query(`SELECT to_regclass('agent_sessions') AS unexpected`),
      ).toMatchObject({ rows: [{ unexpected: null }] })
    } finally {
      client.release()
      await pool.end()
    }
  })

  it('rejects an untracked schema containing only a user-defined type', async () => {
    const testSchema = await createSchema('migration_untracked_type')
    const identifier = identifierOf(testSchema)
    await testSchema.admin.query(`CREATE TYPE ${identifier}.migration_state AS ENUM ('legacy')`)

    await expect(testSchema.db.identity.init()).rejects.toThrow(
      /non-empty but has no migration ledger \(pg_type:type .*migration_state/,
    )
    expect(
      await testSchema.admin.query(
        `SELECT EXISTS (
           SELECT 1
             FROM pg_type t
             JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = $1
              AND t.typname = 'migration_state'
         ) AS preserved`,
        [testSchema.schema],
      ),
    ).toMatchObject({ rows: [{ preserved: true }] })
    expect(
      await testSchema.admin.query(
        `SELECT to_regclass('${testSchema.schema}.meta_migrations') AS ledger`,
      ),
    ).toMatchObject({ rows: [{ ledger: null }] })
  })

  it('rejects an untracked schema containing only a collation', async () => {
    const testSchema = await createSchema('migration_untracked_collation')
    const identifier = identifierOf(testSchema)
    await testSchema.admin.query(`CREATE COLLATION ${identifier}.migration_collation FROM "C"`)

    await expect(testSchema.db.identity.init()).rejects.toThrow(
      /non-empty but has no migration ledger \(pg_collation:collation .*migration_collation/,
    )
    expect(
      await testSchema.admin.query(
        `SELECT EXISTS (
           SELECT 1
             FROM pg_collation c
             JOIN pg_namespace n ON n.oid = c.collnamespace
            WHERE n.nspname = $1
              AND c.collname = 'migration_collation'
         ) AS preserved`,
        [testSchema.schema],
      ),
    ).toMatchObject({ rows: [{ preserved: true }] })
    expect(
      await testSchema.admin.query(
        `SELECT to_regclass('${testSchema.schema}.meta_migrations') AS ledger`,
      ),
    ).toMatchObject({ rows: [{ ledger: null }] })
  })

  it.each([
    {
      label: 'an empty ledger',
      sql: 'DELETE FROM meta_migrations',
      message: /contains no baseline row/,
    },
    {
      label: 'a version gap',
      sql: 'DELETE FROM meta_migrations WHERE version = 0',
      message: /expected version 0, found 1/,
    },
    {
      label: 'name drift',
      sql: "UPDATE meta_migrations SET name = 'rewritten_baseline' WHERE version = 0",
      message: /name mismatch/,
    },
    {
      label: 'checksum drift',
      sql: `UPDATE meta_migrations SET checksum = 'sha256:${'0'.repeat(64)}' WHERE version = 0`,
      message: /checksum mismatch/,
    },
    {
      label: 'an unknown future migration',
      sql: `INSERT INTO meta_migrations (version, name, checksum, applied_at)
            VALUES (${nextMigrationVersion}, 'future', 'sha256:${'1'.repeat(64)}', '2099-01-01T00:00:00.000Z')`,
      message: new RegExp(`unknown future migration ${nextMigrationVersion}`),
    },
  ])('fails closed on $label', async ({ sql, message }) => {
    const testSchema = await createSchema('migration_drift')
    await testSchema.db.identity.init()
    await testSchema.db.close()
    const identifier = identifierOf(testSchema)
    const mutationClient = await testSchema.admin.connect()

    try {
      await mutationClient.query(`SET search_path TO ${identifier}`)
      await mutationClient.query(sql)
    } finally {
      mutationClient.release()
    }
    const before = await ledger(testSchema)
    const db = new PgMetaDb(testSchema.scopedUrl)

    try {
      await expect(db.identity.init()).rejects.toThrow(message)
      expect(await ledger(testSchema)).toEqual(before)
    } finally {
      await db.close()
    }
  })

  it('rolls back failed SQL with its ledger stamp and remains retryable after repair', async () => {
    const testSchema = await createSchema('migration_retry')
    await testSchema.db.identity.init()
    await testSchema.db.close()
    const pool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const client = await pool.connect()

    try {
      const brokenSql = `CREATE TABLE migration_probe (value TEXT);
        SELECT * FROM missing_table`
      const broken: MetaMigration = {
        version: nextMigrationVersion,
        name: 'add_probe',
        checksum: checksumMigrationPair('SELECT broken', brokenSql),
        sqlite: 'SELECT broken',
        postgres: brokenSql,
      }
      await expect(runPgMigrations(client, [...migrations, broken])).rejects.toThrow(
        /missing_table/,
      )
      expect((await ledger(testSchema)).map(({ version }) => version)).toEqual(appliedVersions)
      expect(
        await testSchema.admin.query(
          `SELECT to_regclass('${testSchema.schema}.migration_probe') AS probe`,
        ),
      ).toMatchObject({ rows: [{ probe: null }] })

      const repairedSql = 'CREATE TABLE migration_probe (value TEXT)'
      const repaired: MetaMigration = {
        version: nextMigrationVersion,
        name: 'add_probe',
        checksum: checksumMigrationPair('SELECT repaired', repairedSql),
        sqlite: 'SELECT repaired',
        postgres: repairedSql,
      }
      await runPgMigrations(client, [...migrations, repaired])
      expect((await ledger(testSchema)).map(({ version }) => version)).toEqual([
        ...appliedVersions,
        nextMigrationVersion,
      ])
    } finally {
      client.release()
      await pool.end()
    }
  })

  it('rejects transaction control inside PostgreSQL assets without escaping the owned transaction', async () => {
    const testSchema = await createSchema('migration_transaction_escape')
    await testSchema.db.identity.init()
    await testSchema.db.close()
    const escapingSql = `CREATE TABLE escaped_transaction (value TEXT);
      COMMIT;
      SELECT * FROM missing_table`
    const escaping: MetaMigration = {
      version: nextMigrationVersion,
      name: 'escape_transaction',
      checksum: checksumMigrationPair('SELECT escape', escapingSql),
      sqlite: 'SELECT escape',
      postgres: escapingSql,
    }
    const pool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const client = await pool.connect()

    try {
      await expect(runPgMigrations(client, [...migrations, escaping])).rejects.toThrow(
        /EXECUTE of transaction commands is not implemented/,
      )
      expect((await ledger(testSchema)).map(({ version }) => version)).toEqual(appliedVersions)
      expect(
        await testSchema.admin.query(
          `SELECT to_regclass('${testSchema.schema}.escaped_transaction') AS escaped`,
        ),
      ).toMatchObject({ rows: [{ escaped: null }] })
    } finally {
      client.release()
      await pool.end()
    }
  })

  it('serializes concurrent pending migration attempts under the schema advisory lock', async () => {
    const testSchema = await createSchema('migration_pending_race')
    await testSchema.db.identity.init()
    await testSchema.db.close()
    const sql = 'CREATE TABLE concurrent_probe (value TEXT)'
    const pending: MetaMigration = {
      version: nextMigrationVersion,
      name: 'add_concurrent_probe',
      checksum: checksumMigrationPair('SELECT probe', sql),
      sqlite: 'SELECT probe',
      postgres: sql,
    }
    const pool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const first = await pool.connect()
    const second = await pool.connect()

    try {
      await Promise.all([
        runPgMigrations(first, [...migrations, pending]),
        runPgMigrations(second, [...migrations, pending]),
      ])
      expect((await ledger(testSchema)).map(({ version }) => version)).toEqual([
        ...appliedVersions,
        nextMigrationVersion,
      ])
    } finally {
      first.release()
      second.release()
      await pool.end()
    }
  })

  it('fails closed if a missing search-path schema later materializes ahead of the target', async () => {
    const testSchema = await createSchema('migration_search_path_shift')
    const lateSchema = `late_${testSchema.schema.slice(-40)}`
    const lateIdentifier = quotedIdentifier(lateSchema)
    const shiftedUrl = new URL(testSchema.scopedUrl)
    shiftedUrl.searchParams.set('options', `-csearch_path=${lateSchema},${testSchema.schema}`)
    const initial = new PgMetaDb(shiftedUrl.toString())
    const reopened = new PgMetaDb(shiftedUrl.toString())

    try {
      await initial.identity.init()
      await initial.identity.claimMany([
        {
          id: 'id-before-search-path-shift',
          legacyNameAliases: [],
          filePath: 'before.md',
          space: 'space-a',
          createdAt: null,
          materialized: false,
          deletedAt: null,
        },
      ])
      await initial.close()
      await testSchema.admin.query(`CREATE SCHEMA ${lateIdentifier}`)

      await expect(reopened.identity.init()).rejects.toThrow(
        /exactly one durable PostgreSQL schema/,
      )
      expect(
        await testSchema.admin.query(
          `SELECT to_regclass('${lateSchema}.meta_migrations') AS unexpected`,
        ),
      ).toMatchObject({ rows: [{ unexpected: null }] })
      expect(await testSchema.db.identity.loadAll('space-a')).toHaveLength(1)
    } finally {
      await initial.close()
      await reopened.close()
      await testSchema.admin.query(`DROP SCHEMA IF EXISTS ${lateIdentifier} CASCADE`)
    }
  })

  it('keeps an existing application pool pinned when a leading search-path schema materializes', async () => {
    const testSchema = await createSchema('migration_live_search_path')
    const lateSchema = `late_${testSchema.schema.slice(-40)}`
    const lateIdentifier = quotedIdentifier(lateSchema)
    const shiftedUrl = new URL(testSchema.scopedUrl)
    shiftedUrl.searchParams.set('options', `-csearch_path=${lateSchema},${testSchema.schema}`)
    const db = new PgMetaDb(shiftedUrl.toString())

    try {
      await db.identity.claimMany([
        {
          id: 'real-row',
          legacyNameAliases: [],
          filePath: 'real.md',
          space: 'space-a',
          createdAt: null,
          materialized: false,
          deletedAt: null,
        },
      ])
      await testSchema.admin.query(
        `CREATE SCHEMA ${lateIdentifier};
         CREATE TABLE ${lateIdentifier}.note_identity (
           id TEXT PRIMARY KEY,
           file_path TEXT NOT NULL,
           space TEXT NOT NULL,
           created_at TEXT,
           materialized BOOLEAN NOT NULL,
           deleted_at TEXT
         );
         INSERT INTO ${lateIdentifier}.note_identity
           (id, file_path, space, created_at, materialized, deleted_at)
         VALUES ('poison-row', 'poison.md', 'space-a', NULL, false, NULL)`,
      )

      expect(await db.identity.loadAll('space-a')).toMatchObject([
        { id: 'real-row', filePath: 'real.md' },
      ])
    } finally {
      await db.close()
      await testSchema.admin.query(`DROP SCHEMA IF EXISTS ${lateIdentifier} CASCADE`)
    }
  })
})
