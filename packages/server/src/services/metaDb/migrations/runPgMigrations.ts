import type pg from 'pg'

import { loadMetaMigrations, validateAppliedMetaMigrations } from './manifest'
import type { AppliedMetaMigration, MetaMigration } from './types'

// canon: docs/meta-db.md#startup
type PostgresSchemaObject = {
  kind: string
  name: string
}

const PG_MIGRATION_EXECUTOR = `
  DO $notarium_executor$
  BEGIN
    EXECUTE current_setting('notarium.meta_migration_script');
  END;
  $notarium_executor$
`

const effectivePostgresSchemas = async (client: pg.ClientBase): Promise<string[]> => {
  const result = await client.query('SELECT unnest(current_schemas(false))::text AS schema')

  return result.rows.map(({ schema }) => String(schema))
}

const assertPostgresSchemaPinned = async (client: pg.ClientBase, schema: string): Promise<void> => {
  const schemas = await effectivePostgresSchemas(client)

  if (schemas.length !== 1 || schemas[0] !== schema) {
    throw new Error(
      `meta migration changed the PostgreSQL search_path from its pinned schema ${schema}`,
    )
  }
}

const pinPostgresSchema = async (client: pg.ClientBase): Promise<string> => {
  const schemas = await effectivePostgresSchemas(client)

  if (schemas.length !== 1) {
    const found = schemas.length ? schemas.join(', ') : '(none)'
    throw new Error(
      `meta database connection must resolve to exactly one durable PostgreSQL schema; ` +
        `effective search_path: ${found}; set connection options=-csearch_path=<schema>`,
    )
  }

  const schema = schemas[0]
  const namespace = await client.query(
    `SELECT oid = pg_my_temp_schema() AS temporary
       FROM pg_namespace
      WHERE nspname = $1`,
    [schema],
  )

  if (!namespace.rows.length || namespace.rows[0]?.temporary === true) {
    throw new Error(`meta database PostgreSQL schema must be durable, found ${schema}`)
  }

  await client.query(`SELECT set_config('search_path', quote_ident($1), true)`, [schema])
  await assertPostgresSchemaPinned(client, schema)
  return schema
}

const postgresSchemaObjects = async (
  client: pg.ClientBase,
  schema: string,
): Promise<PostgresSchemaObject[]> => {
  const result = await client.query(
    `SELECT DISTINCT
            d.classid::regclass::text AS kind,
            pg_describe_object(d.classid, d.objid, d.objsubid) AS name
      FROM pg_depend d
       JOIN pg_namespace n ON n.oid = d.refobjid
      WHERE d.refclassid = 'pg_namespace'::regclass
        AND n.nspname = $1
      ORDER BY kind, name`,
    [schema],
  )

  return result.rows as PostgresSchemaObject[]
}

const postgresHasMigrationLedger = async (
  client: pg.ClientBase,
  schema: string,
): Promise<boolean> => {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1
          AND c.relname = 'meta_migrations'
          AND c.relkind IN ('r', 'p')
     ) AS present`,
    [schema],
  )

  return result.rows[0]?.present === true
}

const inspectPostgresMigrationState = async (
  client: pg.ClientBase,
  schema: string,
  migrations: readonly MetaMigration[],
): Promise<number> => {
  const objects = await postgresSchemaObjects(client, schema)
  const hasLedger = await postgresHasMigrationLedger(client, schema)

  if (!hasLedger) {
    if (objects.length) {
      const names = objects.map(({ kind, name }) => `${kind}:${name}`).join(', ')
      throw new Error(
        `meta database schema is non-empty but has no migration ledger (${names}); ` +
          'run the version-specific operator migration before starting this build',
      )
    }

    return 0
  }

  const result = await client.query(
    'SELECT version, name, checksum FROM meta_migrations ORDER BY version',
  )
  const rows = result.rows.map((row): AppliedMetaMigration => ({
    version: Number(row.version),
    name: String(row.name),
    checksum: String(row.checksum),
  }))

  return validateAppliedMetaMigrations(rows, migrations)
}

export const runPgMigrations = async (
  client: pg.ClientBase,
  migrations: readonly MetaMigration[] = loadMetaMigrations(),
): Promise<string> => {
  const applied: Array<{ migration: MetaMigration; durationMs: number }> = []
  let pinnedSchema: string | null = null

  await client.query('BEGIN')

  try {
    const schema = await pinPostgresSchema(client)
    pinnedSchema = schema
    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtext(current_database()),
         hashtext($1::text)
       )`,
      [schema],
    )
    const nextVersion = await inspectPostgresMigrationState(client, schema, migrations)

    for (const migration of migrations.slice(nextVersion)) {
      const startedAt = Date.now()
      // SPI executes the whole asset inside the owned transaction but rejects
      // transaction-control statements at the DO-block boundary.
      await client.query(`SELECT set_config('notarium.meta_migration_script', $1, true)`, [
        migration.postgres,
      ])
      await client.query(PG_MIGRATION_EXECUTOR)
      await assertPostgresSchemaPinned(client, schema)
      await client.query(
        `INSERT INTO meta_migrations (version, name, checksum, applied_at)
         VALUES ($1, $2, $3, $4)`,
        [migration.version, migration.name, migration.checksum, new Date().toISOString()],
      )
      applied.push({ migration, durationMs: Date.now() - startedAt })
    }

    await client.query('COMMIT')
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackError) {
      throw new AggregateError(
        [err, rollbackError],
        'meta migration failed and its PostgreSQL transaction could not be rolled back',
      )
    }
    throw err
  }

  if (process.env.NODE_ENV !== 'test') {
    for (const { migration, durationMs } of applied) {
      console.log(
        `[notarium] meta migration ${String(migration.version).padStart(4, '0')}_${migration.name} applied (postgres, ${durationMs} ms)`,
      )
    }
  }

  if (!pinnedSchema) {
    throw new Error('meta migration finished without a pinned PostgreSQL schema')
  }

  return pinnedSchema
}
