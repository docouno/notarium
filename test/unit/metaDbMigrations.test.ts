import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

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
    expect(counts).toEqual({ index: 31, table: 25, trigger: 1 })
    expect(
      db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'meta_schema'").get(),
    ).toBeUndefined()
    expect((db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum).toBe(2)
  })

  it('reopens a valid prefix as a no-op without rewriting its applied timestamp', () => {
    const db = database()
    runSqliteMigrations(db)
    const before = ledger(db)

    runSqliteMigrations(db)

    expect(ledger(db)).toEqual(before)
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
