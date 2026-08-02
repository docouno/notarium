import { type DatabaseSync, constants as sqlite } from 'node:sqlite'

import { loadMetaMigrations, validateAppliedMetaMigrations } from './manifest'
import type { AppliedMetaMigration, MetaMigration } from './types'

// canon: docs/meta-db.md#startup
type SqliteSchemaObject = {
  type: string
  name: string
}

type SqliteMigrationState = {
  fresh: boolean
  nextVersion: number
}

const executeMigrationSql = (db: DatabaseSync, sql: string): void => {
  db.setAuthorizer((actionCode) =>
    actionCode === sqlite.SQLITE_TRANSACTION || actionCode === sqlite.SQLITE_SAVEPOINT
      ? sqlite.SQLITE_DENY
      : sqlite.SQLITE_OK,
  )
  try {
    db.exec(sql)
  } finally {
    db.setAuthorizer(null)
  }
}

const sqliteSchemaObjects = (db: DatabaseSync): SqliteSchemaObject[] =>
  db
    .prepare(
      `SELECT type, name
         FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_autoindex_%'
        ORDER BY type, name`,
    )
    .all() as SqliteSchemaObject[]

const inspectSqliteMigrationState = (
  db: DatabaseSync,
  migrations: readonly MetaMigration[],
): SqliteMigrationState => {
  const objects = sqliteSchemaObjects(db)
  const hasLedger = objects.some(({ type, name }) => type === 'table' && name === 'meta_migrations')

  if (!hasLedger) {
    if (objects.length) {
      const names = objects.map(({ type, name }) => `${type}:${name}`).join(', ')
      throw new Error(
        `meta database is non-empty but has no migration ledger (${names}); ` +
          'run the version-specific operator migration before starting this build',
      )
    }

    return { fresh: true, nextVersion: 0 }
  }

  const rows = db
    .prepare('SELECT version, name, checksum FROM meta_migrations ORDER BY version')
    .all() as AppliedMetaMigration[]

  return {
    fresh: false,
    nextVersion: validateAppliedMetaMigrations(rows, migrations),
  }
}

export const runSqliteMigrations = (
  db: DatabaseSync,
  migrations: readonly MetaMigration[] = loadMetaMigrations(),
): void => {
  db.exec('PRAGMA busy_timeout = 5000')
  const preflight = inspectSqliteMigrationState(db, migrations)

  if (preflight.fresh) {
    db.exec('PRAGMA auto_vacuum = INCREMENTAL')
  }
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('BEGIN IMMEDIATE')

  const applied: Array<{ migration: MetaMigration; durationMs: number }> = []

  try {
    const state = inspectSqliteMigrationState(db, migrations)

    for (const migration of migrations.slice(state.nextVersion)) {
      const startedAt = Date.now()
      executeMigrationSql(db, migration.sqlite)
      db.prepare(
        `INSERT INTO meta_migrations (version, name, checksum, applied_at)
         VALUES (?, ?, ?, ?)`,
      ).run(migration.version, migration.name, migration.checksum, new Date().toISOString())
      applied.push({ migration, durationMs: Date.now() - startedAt })
    }

    db.exec('COMMIT')
  } catch (err) {
    if (db.isTransaction) {
      try {
        db.exec('ROLLBACK')
      } catch (rollbackError) {
        throw new AggregateError(
          [err, rollbackError],
          'meta migration failed and its SQLite transaction could not be rolled back',
        )
      }
    }
    throw err
  }

  if (process.env.NODE_ENV !== 'test') {
    for (const { migration, durationMs } of applied) {
      console.log(
        `[notarium] meta migration ${String(migration.version).padStart(4, '0')}_${migration.name} applied (sqlite, ${durationMs} ms)`,
      )
    }
  }
}
