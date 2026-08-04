import pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'

import {
  checksumMigrationPair,
  loadMetaMigrations,
  type MetaMigration,
  runPgMigrations,
} from '../../packages/server/src/services/metaDb/migrations'
import { PgMetaDb } from '../../packages/server/src/services/metaDb/pgMetaDb'
import type { PostgresTestSchema } from './postgresHarness'
import { createPostgresTestSchema, describePostgres } from './postgresHarness'

type LedgerRow = {
  version: number
  name: string
  checksum: string
  applied_at: string
}

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
      await testSchema.db.identity.upsertMany([
        {
          id: 'id-concurrent',
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
      await initial.identity.upsertMany([
        {
          id: 'id-before-search-path-shift',
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
      await db.identity.upsertMany([
        {
          id: 'real-row',
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
