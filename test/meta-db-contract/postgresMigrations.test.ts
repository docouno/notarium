import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
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
  runSqliteMigrations,
} from '../../packages/server/src/services/metaDb/migrations'
import { PgMetaDb } from '../../packages/server/src/services/metaDb/pgMetaDb'
import {
  accountIdentityRegistry,
  accountIdentitySeedSql,
  expectAccountIdentityWorld,
  expectActivityProjectionState,
  type LadderReader,
  usersCarriedColumnsSql,
} from './accountIdentityLadder'
import {
  ACCOUNT_IDENTITY_CANDIDATE_COLUMNS,
  agentCallTraceCatalog,
  approvedTargetCatalog,
  type MetaDbCatalog,
  pgMetaDbCatalog,
  PROVIDER_CONTOUR_TABLES,
  splitProviderContour,
  sqliteMetaDbCatalog,
  withoutAgentCallTrace,
} from './metaDbCatalog'
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

  it('orders post-carrier revisions by the trigger tail instead of raw id allocation', async () => {
    const testSchema = await createSchema('activity_commit_order')
    const pool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const first = await pool.connect()
    const second = await pool.connect()

    try {
      await testSchema.db.revisions.init()
      await first.query('BEGIN')
      const reserved = await first.query(
        `SELECT nextval(pg_get_serial_sequence('note_revisions', 'id')) AS id`,
      )
      const firstId = String(reserved.rows[0].id)

      await second.query('BEGIN')
      const committedFirst = await second.query(
        `INSERT INTO note_revisions
          (note_id, space, kind, entry_role, principal, title, class, tags, created_at,
           chars_added, chars_removed, integrity)
         VALUES
          ('second-note', 'space-a', 'write', 'origin', 'user:bob', 'Second', 'user-doc', '[]',
           '2026-08-01T00:00:01.000Z', 2, 0, 'trusted')
         RETURNING id`,
      )
      await second.query('COMMIT')

      await first.query(
        `INSERT INTO note_revisions
          (id, note_id, space, kind, entry_role, principal, title, class, tags, created_at,
           chars_added, chars_removed, integrity)
         VALUES
          ($1, 'first-note', 'space-a', 'write', 'origin', 'user:alice', 'First', 'user-doc', '[]',
           '2026-08-01T00:00:00.000Z', 1, 0, 'trusted')`,
        [firstId],
      )
      await first.query('COMMIT')

      expect(BigInt(committedFirst.rows[0].id)).toBeGreaterThan(BigInt(firstId))
      expect(
        await testSchema.admin.query(
          `SELECT source_ordinal::text, revision_id::text
             FROM ${identifierOf(testSchema)}.activity_revision_order
            WHERE space = 'space-a' ORDER BY source_ordinal`,
        ),
      ).toMatchObject({
        rows: [
          { source_ordinal: '1', revision_id: String(committedFirst.rows[0].id) },
          { source_ordinal: '2', revision_id: firstId },
        ],
      })
      expect(
        await testSchema.admin.query(
          `SELECT note_id, source_ordinal::text
             FROM ${identifierOf(testSchema)}.activity_note_actor_heads
            WHERE space = 'space-a' ORDER BY note_id`,
        ),
      ).toMatchObject({
        rows: [
          { note_id: 'first-note', source_ordinal: '2' },
          { note_id: 'second-note', source_ordinal: '1' },
        ],
      })
      const groups = await testSchema.db.revisions.activityGroupsByNote('space-a', {})

      expect(
        groups.items.map(({ noteId, lastSourceOrdinal, lastEvent }) => ({
          noteId,
          lastSourceOrdinal,
          revisionId: lastEvent.id,
        })),
      ).toEqual([
        { noteId: 'first-note', lastSourceOrdinal: '2', revisionId: firstId },
        {
          noteId: 'second-note',
          lastSourceOrdinal: '1',
          revisionId: String(committedFirst.rows[0].id),
        },
      ])
      const historicalEvents = await testSchema.db.revisions.activityEvents('space-a', {
        offset: 0,
        limit: 10,
        activityLease: { ...groups.activityLease, through: '1' },
      })

      expect(historicalEvents.items.map((row) => row.noteId)).toEqual(['second-note'])
    } finally {
      await first.query('ROLLBACK').catch(() => {})
      await second.query('ROLLBACK').catch(() => {})
      first.release()
      second.release()
      await pool.end()
    }
  })

  it('rolls back every fresh PostgreSQL Activity effect when the trigger tail fails', async () => {
    const testSchema = await createSchema('activity_trigger_rollback')
    const pool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const client = await pool.connect()

    try {
      await testSchema.db.revisions.init()
      await client.query(
        `INSERT INTO note_revisions
          (note_id, space, kind, entry_role, principal, title, class, tags, created_at,
           chars_added, chars_removed, integrity)
         VALUES
          ('fresh-note', 'fresh', 'write', 'baseline', 'user:alice', 'Fresh', 'user-doc', '[]',
           '2026-08-01T00:00:00.000Z', 1, 0, 'trusted')`,
      )
      await client.query(`
        CREATE FUNCTION fail_activity_state()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'injected Activity state failure';
        END;
        $$;
        CREATE TRIGGER fail_activity_state
        BEFORE INSERT ON activity_note_actor_states
        FOR EACH ROW EXECUTE FUNCTION fail_activity_state();
      `)

      await expect(
        client.query(
          `INSERT INTO note_revisions
            (note_id, space, kind, entry_role, principal, title, class, tags, created_at,
             chars_added, chars_removed, integrity)
           VALUES
            ('fresh-note', 'fresh', 'write', 'change', 'user:alice', 'Fresh', 'user-doc', '[]',
             '2026-08-01T01:00:00.000Z', 1, 0, 'trusted')`,
        ),
      ).rejects.toThrow(/injected Activity state failure/)
      expect(await client.query('SELECT COUNT(*)::int AS n FROM note_revisions')).toMatchObject({
        rows: [{ n: 1 }],
      })
      expect(
        await client.query('SELECT COUNT(*)::int AS n FROM activity_revision_order'),
      ).toMatchObject({ rows: [{ n: 1 }] })
      expect(
        await client.query('SELECT COUNT(*)::int AS n FROM activity_note_actor_states'),
      ).toMatchObject({ rows: [{ n: 0 }] })
      expect(
        await client.query(
          `SELECT next_source_ordinal::text, active_through::text
             FROM activity_projection_status WHERE space = 'fresh'`,
        ),
      ).toMatchObject({ rows: [{ next_source_ordinal: '1', active_through: '1' }] })
    } finally {
      client.release()
      await pool.end()
    }
  })

  it('rejects rehoming a PostgreSQL revision without changing the journal, order, or status', async () => {
    const testSchema = await createSchema('activity_space_immutable')
    const pool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const client = await pool.connect()

    try {
      await testSchema.db.revisions.init()
      const inserted = await client.query(
        `INSERT INTO note_revisions
          (note_id, space, kind, entry_role, principal, title, class, tags, created_at,
           chars_added, chars_removed, integrity)
         VALUES
          ('alpha-note', 'alpha', 'write', 'change', 'user:alice', 'Alpha', 'user-doc', '[]',
           '2026-08-01T00:00:00.000Z', 3, 1, 'trusted')
         RETURNING id`,
      )
      const snapshot = async () => ({
        journal: (
          await client.query(
            'SELECT id::text, note_id, space, integrity FROM note_revisions ORDER BY id',
          )
        ).rows,
        order: (
          await client.query(
            `SELECT space, source_ordinal::text, revision_id::text
               FROM activity_revision_order ORDER BY space, source_ordinal`,
          )
        ).rows,
        status: (await client.query('SELECT * FROM activity_projection_status ORDER BY space'))
          .rows,
      })
      const before = await snapshot()

      await expect(
        client.query("UPDATE note_revisions SET space = 'beta' WHERE id = $1", [
          inserted.rows[0].id,
        ]),
      ).rejects.toThrow(/note revision space is immutable/)
      expect(await snapshot()).toEqual(before)

      // A semantic rewrite may still include the unchanged Space explicitly.
      await expect(
        client.query(
          `UPDATE note_revisions
              SET space = 'alpha', integrity = 'quarantined'
            WHERE id = $1`,
          [inserted.rows[0].id],
        ),
      ).resolves.toBeDefined()
      expect(
        await client.query(
          `SELECT state, active_generation, build_generation, source_generation::text
             FROM activity_projection_status WHERE space = 'alpha'`,
        ),
      ).toMatchObject({
        rows: [
          {
            state: 'rebuilding',
            active_generation: null,
            build_generation: null,
            source_generation: '2',
          },
        ],
      })
    } finally {
      client.release()
      await pool.end()
    }
  })

  it('lazily rebuilds one upgraded Activity space and leaves siblings uninitialized', async () => {
    const testSchema = await createSchema('activity_upgrade_rebuild')
    const pool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const client = await pool.connect()

    try {
      await runPgMigrations(client, migrations.slice(0, 7))
      await client.query(
        `INSERT INTO note_revisions
          (note_id, space, kind, entry_role, principal, title, class, tags, created_at,
           chars_added, chars_removed, integrity)
         VALUES
          ('alpha-note', 'alpha', 'external', 'baseline', 'user:alice', 'Alpha', 'user-doc', '[]',
           '2026-08-01T00:00:00.000Z', 10, 0, 'trusted'),
          ('alpha-note', 'alpha', 'write', 'change', 'user:alice', 'Alpha', 'user-doc', '[]',
           '2026-08-01T01:00:00.000Z', 3, 1, 'trusted'),
          ('beta-note', 'beta', 'write', 'origin', 'user:bob', 'Beta', 'user-doc', '[]',
           '2026-08-01T02:00:00.000Z', 4, 0, 'trusted')`,
      )
      await runPgMigrations(client, migrations)
      expect(
        await client.query('SELECT COUNT(*)::int AS n FROM activity_projection_status'),
      ).toMatchObject({ rows: [{ n: 0 }] })

      expect(await testSchema.db.revisions.prepareActivityProjection('alpha')).toEqual({
        state: 'rebuilding',
      })
      expect(await testSchema.db.revisions.maintainActivityProjection('alpha')).toMatchObject({
        state: 'ready',
        processed: 2,
        published: true,
      })
      expect(await testSchema.db.revisions.prepareActivityProjection('alpha')).toEqual({
        state: 'ready',
        lease: { through: '2', activeGeneration: '1', sourceGeneration: '1' },
      })
      expect(
        await client.query(
          `SELECT space, state, active_generation::text, active_through::text
             FROM activity_projection_status ORDER BY space`,
        ),
      ).toMatchObject({
        rows: [{ space: 'alpha', state: 'ready', active_generation: '1', active_through: '2' }],
      })
      expect(
        await client.query(
          `SELECT note_id, event_count::text, chars_added_sum::text, chars_removed_sum::text
             FROM activity_note_actor_states WHERE space = 'alpha'`,
        ),
      ).toMatchObject({
        rows: [
          {
            note_id: 'alpha-note',
            event_count: '1',
            chars_added_sum: '3',
            chars_removed_sum: '1',
          },
        ],
      })

      await client.query(
        `UPDATE note_revisions SET integrity = 'quarantined'
          WHERE space = 'alpha' AND entry_role = 'change'`,
      )
      expect(await testSchema.db.revisions.prepareActivityProjection('alpha')).toEqual({
        state: 'rebuilding',
      })
      expect(await testSchema.db.revisions.maintainActivityProjection('alpha')).toMatchObject({
        state: 'ready',
        processed: 2,
        published: true,
      })
      expect(await testSchema.db.revisions.prepareActivityProjection('alpha')).toEqual({
        state: 'ready',
        lease: { through: '2', activeGeneration: '2', sourceGeneration: '2' },
      })
      while ((await testSchema.db.revisions.maintainActivityProjectionGc('alpha')).pending) {
        // Bounded GC is deliberately resumable; this tiny fixture drains in a few units.
      }
      expect(
        await client.query(
          `SELECT generation::text, actor_kind, event_count::text
             FROM activity_note_actor_states WHERE space = 'alpha'`,
        ),
      ).toMatchObject({ rows: [{ generation: '2', actor_kind: 'gap', event_count: '1' }] })
      expect(
        await client.query('SELECT COUNT(*)::int AS n FROM activity_projection_gc'),
      ).toMatchObject({ rows: [{ n: 0 }] })
    } finally {
      client.release()
      await pool.end()
    }
  })

  it('does not let stale PostgreSQL maintenance recreate Activity rows after Space purge', async () => {
    const testSchema = await createSchema('activity_purge_fence')
    const pool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const client = await pool.connect()

    try {
      await testSchema.db.revisions.init()
      await client.query(
        `INSERT INTO note_revisions
          (note_id, space, kind, entry_role, principal, title, class, tags, created_at,
           chars_added, chars_removed, integrity)
         VALUES
          ('purged-note', 'purged', 'write', 'change', 'user:alice', 'Purged', 'user-doc', '[]',
           '2026-08-01T00:00:00.000Z', 1, 0, 'trusted')`,
      )
      await testSchema.db.purgeSpace('purged')

      await expect(testSchema.db.revisions.prepareActivityProjection('purged')).rejects.toThrow(
        /activity projection target was permanently purged/,
      )
      await expect(testSchema.db.revisions.maintainActivityProjection('purged')).rejects.toThrow(
        /activity projection target was permanently purged/,
      )

      for (const table of [
        'note_revisions',
        'activity_projection_status',
        'activity_revision_order',
        'activity_note_actor_states',
        'activity_note_actor_heads',
        'activity_projection_gc',
      ]) {
        expect(
          await client.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE space = $1`, [
            'purged',
          ]),
        ).toMatchObject({
          rows: [{ n: 0 }],
        })
      }
      expect(
        await client.query(
          `SELECT kind, entity_id, space FROM revision_purge_fences
            WHERE kind = 'space' AND entity_id = $1`,
          ['purged'],
        ),
      ).toMatchObject({
        rows: [{ kind: 'space', entity_id: 'purged', space: 'purged' }],
      })
    } finally {
      client.release()
      await pool.end()
    }
  })

  it('matches the normalized pre-cut catalog plus the approved deltas', async () => {
    const testSchema = await createSchema('migration_golden')
    const pool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const client = await pool.connect()

    try {
      await runPgMigrations(client)
      const liveCatalog = await pgMetaDbCatalog(client, testSchema.schema)
      const sqlite = new DatabaseSync(':memory:')

      try {
        runSqliteMigrations(sqlite)
        expect(agentCallTraceCatalog(liveCatalog)).toEqual(
          agentCallTraceCatalog(sqliteMetaDbCatalog(sqlite)),
        )
      } finally {
        sqlite.close()
      }
      const live = splitProviderContour(withoutAgentCallTrace(liveCatalog))
      expect(live.contour).toEqual(PROVIDER_CONTOUR_TABLES)
      expect(live.published).toEqual(approvedTargetCatalog(postgresGolden))
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

  it('adds the keyring with its single-active fence after the published line', async () => {
    const testSchema = await createSchema('migration_contour_keyring')
    const pool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const client = await pool.connect()

    try {
      await runPgMigrations(
        client,
        migrations.slice(
          0,
          migrations.findIndex((migration) => migration.name === 'provider_contour'),
        ),
      )
      expect(await client.query("SELECT to_regclass('secret_keyring') AS keyring")).toMatchObject({
        rows: [{ keyring: null }],
      })

      await runPgMigrations(client, migrations)
      await client.query(
        `INSERT INTO secret_keyring
          (key_id, canary, state, generation, created_at, retired_at)
         VALUES ($1, $2, 'active', 1, $3, NULL)`,
        [
          'ck_111111111111111111111111',
          'v1.ck_111111111111111111111111.Y2lwaGVydGV4dA',
          '2026-08-22T00:00:00.000Z',
        ],
      )

      expect(
        await client.query('SELECT key_id, state, generation::integer FROM secret_keyring'),
      ).toMatchObject({
        rows: [
          {
            key_id: 'ck_111111111111111111111111',
            state: 'active',
            generation: 1,
          },
        ],
      })
      await expect(
        client.query(
          `INSERT INTO secret_keyring
            (key_id, canary, state, generation, created_at, retired_at)
           VALUES ($1, 'canary', 'active', 2, $2, NULL)`,
          ['ck_222222222222222222222222', '2026-08-22T00:00:01.000Z'],
        ),
      ).rejects.toMatchObject({ code: '23505' })
    } finally {
      client.release()
      await pool.end()
    }
  })

  it('adds the provider facets with the two ordered foreign keys', async () => {
    const testSchema = await createSchema('migration_contour_facets')
    const pool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const client = await pool.connect()

    try {
      // Pinned to the migration UNDER TEST, not to "everything but the last": a later
      // migration would otherwise silently move this probe onto its own predecessor.
      await runPgMigrations(
        client,
        migrations.slice(
          0,
          migrations.findIndex((migration) => migration.name === 'provider_contour'),
        ),
      )
      expect(await client.query("SELECT to_regclass('credentials') AS credentials")).toMatchObject({
        rows: [{ credentials: null }],
      })

      await runPgMigrations(client, migrations)
      const tables = await client.query(
        `SELECT to_regclass('credentials') AS credentials,
                to_regclass('provider_resources') AS resources,
                to_regclass('provider_attachments') AS attachments`,
      )
      expect(tables.rows[0]).toEqual({
        credentials: 'credentials',
        resources: 'provider_resources',
        attachments: 'provider_attachments',
      })
      const foreignKeys = await client.query(
        `SELECT child.relname AS child, parent.relname AS parent, fk.confdeltype
           FROM pg_constraint AS fk
           JOIN pg_class AS child ON child.oid = fk.conrelid
           JOIN pg_class AS parent ON parent.oid = fk.confrelid
          WHERE fk.contype = 'f'
            AND fk.connamespace = to_regnamespace(current_schema())
            AND child.relname IN ('provider_resources', 'provider_attachments')
          ORDER BY child.relname, parent.relname`,
      )
      expect(foreignKeys.rows).toEqual([
        { child: 'provider_attachments', parent: 'provider_resources', confdeltype: 'c' },
        { child: 'provider_resources', parent: 'credentials', confdeltype: 'r' },
      ])
    } finally {
      client.release()
      await pool.end()
    }
  })

  it('adds the call journal with the send-fence key and no foreign key of its own', async () => {
    const testSchema = await createSchema('migration_contour_call_log')
    const pool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const client = await pool.connect()

    try {
      await runPgMigrations(
        client,
        migrations.slice(
          0,
          migrations.findIndex((migration) => migration.name === 'provider_contour'),
        ),
      )
      expect(await client.query("SELECT to_regclass('provider_call_log') AS log")).toMatchObject({
        rows: [{ log: null }],
      })

      await runPgMigrations(client, migrations)
      expect(await client.query("SELECT to_regclass('provider_call_log') AS log")).toMatchObject({
        rows: [{ log: 'provider_call_log' }],
      })
      // The audit outlives what it names, so it points at nothing: a RESTRICT would
      // make a credential delete a lie and a CASCADE would erase the evidence.
      const foreignKeys = await client.query(
        `SELECT parent.relname AS parent
           FROM pg_constraint AS fk
           JOIN pg_class AS child ON child.oid = fk.conrelid
           JOIN pg_class AS parent ON parent.oid = fk.confrelid
          WHERE fk.contype = 'f'
            AND fk.connamespace = to_regnamespace(current_schema())
            AND child.relname = 'provider_call_log'`,
      )
      expect(foreignKeys.rows).toEqual([])
      const retentionIndex = await client.query(
        `SELECT indexdef
           FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = 'idx_provider_call_log_retention'`,
      )
      expect(retentionIndex.rows).toHaveLength(1)
      expect((retentionIndex.rows[0] as { indexdef: string }).indexdef).toMatch(
        /\(settled_at, id, job_id\) WHERE \(settled_at IS NOT NULL\)$/u,
      )

      const row = (id: string, jobId: string | null, attempt: number | null) => [
        id,
        'alice',
        'user:alice',
        null,
        'resource-a',
        null,
        'provider.example',
        '[]',
        jobId,
        jobId ? 'embed' : null,
        attempt,
        'may-have-sent',
        false,
        'in-flight',
        null,
        '2026-08-24T00:00:00.000Z',
        null,
      ]
      const insert = `INSERT INTO provider_call_log
          (id, owner, principal, agent, resource_id, credential_id, host, spaces,
           job_id, job_call_key, attempt_no, delivery_state, retry_safe, outcome,
           token_usage, created_at, settled_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`
      await client.query(insert, row('call-job', 'job-1', 1))
      // Two interactive rows carry three NULLs each and must not collide on them.
      await client.query(insert, row('call-interactive-a', null, null))
      await client.query(insert, row('call-interactive-b', null, null))
      await expect(client.query(insert, row('call-job-twin', 'job-1', 1))).rejects.toMatchObject({
        code: '23505',
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
      const live = splitProviderContour(
        withoutAgentCallTrace(await pgMetaDbCatalog(client, testSchema.schema)),
      )
      expect(live.contour).toEqual(PROVIDER_CONTOUR_TABLES)
      expect(live.published).toEqual(approvedTargetCatalog(postgresGolden))
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

  it('moves every user reference onto the stable id and leaves orphans byte-for-byte', async () => {
    const testSchema = await createSchema('migration_account_identity')
    const pool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const client = await pool.connect()

    try {
      const upTo = migrations.findIndex((migration) => migration.name === 'account_identity')
      await runPgMigrations(client, migrations.slice(0, upTo))
      await client.query(accountIdentitySeedSql(true))
      const read: LadderReader = {
        one: async (sql) => (await client.query(sql)).rows[0],
        all: async (sql) => (await client.query(sql)).rows,
      }
      const triggers = async () =>
        (
          await client.query(
            `SELECT t.tgname AS name, pg_get_triggerdef(t.oid) AS definition
               FROM pg_trigger t
               JOIN pg_class c ON c.oid = t.tgrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = $1 AND NOT t.tgisinternal
              ORDER BY t.tgname`,
            [testSchema.schema],
          )
        ).rows

      const tableCounts = async (): Promise<Record<string, number>> => {
        const tables = (
          await client.query(
            `SELECT c.relname AS name
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = $1 AND c.relkind = 'r'
              ORDER BY c.relname`,
            [testSchema.schema],
          )
        ).rows as Array<{ name: string }>
        const counts: Record<string, number> = {}

        for (const { name } of tables) {
          counts[name] = (
            await client.query(`SELECT COUNT(*)::int AS n FROM ${quotedIdentifier(name)}`)
          ).rows[0].n
        }

        return counts
      }
      const triggersBefore = await triggers()
      const countsBefore = await tableCounts()
      // The seed must leave the projection built, or the `rebuilding` assertion at the
      // end would hold without the carrier having done anything. It only does because
      // the revisions go in one statement per row: PostgreSQL defers AFTER ROW triggers
      // to the end of a statement, so a single multi-row INSERT would open the
      // projection already `rebuilding` — and this test would pass on a carrier that
      // never tripped the invalidation at all.
      await expectActivityProjectionState(read, 'ready')
      const usersBefore = await read.all(usersCarriedColumnsSql)

      await runPgMigrations(client, migrations)

      expect(await triggers()).toEqual(triggersBefore)
      const countsAfter = await tableCounts()
      expect(countsAfter.mcp_dedup).toBe(0)
      expect(countsAfter.activity_projection_gc).toBeGreaterThan(
        countsBefore.activity_projection_gc,
      )
      expect(countsAfter.meta_migrations).toBe(countsBefore.meta_migrations + 1)
      for (const table of ['mcp_dedup', 'activity_projection_gc', 'meta_migrations']) {
        delete countsBefore[table]
        delete countsAfter[table]
      }
      expect(countsAfter).toEqual(countsBefore)

      // `users` is the only table the carrier rebuilds, and everything the INSERT…SELECT
      // copies has to come back byte-for-byte — not just the three columns read below.
      expect(await read.all(usersCarriedColumnsSql)).toEqual(usersBefore)

      const users = (await client.query('SELECT username, id, email FROM users ORDER BY username'))
        .rows as Array<{ username: string; id: string; email: string | null }>
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

      await expectAccountIdentityWorld(read, { alice: id('alice'), bob: id('bob') })
      await expectActivityProjectionState(read, 'rebuilding')
    } finally {
      client.release()
      await pool.end()
    }
  })

  it('accounts for every schema column that can carry a user reference', async () => {
    const testSchema = await createSchema('migration_account_registry')
    const pool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const client = await pool.connect()

    try {
      await runPgMigrations(client)
      const candidates = (
        await client.query(
          `SELECT c.relname AS "table", a.attname AS "column"
             FROM pg_attribute a
             JOIN pg_class c ON c.oid = a.attrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relkind = 'r'
              AND a.attnum > 0 AND NOT a.attisdropped
              AND a.attname = ANY($2::text[])
            ORDER BY c.relname, a.attname`,
          [testSchema.schema, [...ACCOUNT_IDENTITY_CANDIDATE_COLUMNS]],
        )
      ).rows as Array<{ table: string; column: string }>

      expect(candidates.map(({ table, column }) => `${table}.${column}`).sort()).toEqual(
        accountIdentityRegistry(),
      )
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
