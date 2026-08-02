import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'

import type { AppliedMetaMigration, MetaMigration } from './types'

// canon: docs/meta-db.md#source-of-truth
const MANIFEST_FORMAT = 1
const MIGRATION_NAME = /^[a-z0-9]+(?:_[a-z0-9]+)*$/
const SHA256 = /^sha256:[0-9a-f]{64}$/
const UTF8 = new TextDecoder('utf-8', { fatal: true })

const integrityError = (message: string): Error =>
  new Error(`meta migration integrity error: ${message}`)

const asRecord = (value: unknown, subject: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw integrityError(`${subject} must be an object`)
  }

  return value as Record<string, unknown>
}

const readSqlFiles = (directory: string): string[] => {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
      .map((entry) => entry.name)
      .sort()
  } catch (err) {
    throw integrityError(
      `cannot read SQL directory ${directory}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

export const checksumMigrationPair = (
  sqlite: string | Uint8Array,
  postgres: string | Uint8Array,
): string => {
  const hash = createHash('sha256')
  hash.update('sqlite\u0000')
  hash.update(sqlite)
  hash.update('\u0000postgres\u0000')
  hash.update(postgres)
  return `sha256:${hash.digest('hex')}`
}

const decodeSql = (bytes: Uint8Array, stem: string, dialect: string): string => {
  try {
    return UTF8.decode(bytes)
  } catch (err) {
    throw integrityError(
      `migration ${stem} ${dialect} is not valid UTF-8: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
}

export const loadMetaMigrationsFromDirectory = (directory: string): readonly MetaMigration[] => {
  let manifestValue: unknown

  try {
    manifestValue = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
  } catch (err) {
    throw integrityError(
      `cannot read manifest: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const manifest = asRecord(manifestValue, 'manifest')

  if (manifest.format !== MANIFEST_FORMAT) {
    throw integrityError(`unsupported manifest format ${String(manifest.format)}`)
  }
  if (!Array.isArray(manifest.migrations) || manifest.migrations.length === 0) {
    throw integrityError('manifest must contain at least the baseline migration')
  }

  const migrationNames = new Set<string>()
  const migrations = manifest.migrations.map((value, index): MetaMigration => {
    const entry = asRecord(value, `migration ${index}`)
    const version = entry.version
    const name = entry.name
    const checksum = entry.checksum
    const sqlitePath = entry.sqlite
    const postgresPath = entry.postgres
    const stem = `${String(index).padStart(4, '0')}_${String(name)}.sql`

    if (!Number.isSafeInteger(version) || version !== index) {
      throw integrityError(`migration ${index} has non-contiguous version ${String(version)}`)
    }
    if (typeof name !== 'string' || !MIGRATION_NAME.test(name)) {
      throw integrityError(`migration ${index} has invalid name ${String(name)}`)
    }
    if (index === 0 && name !== 'baseline') {
      throw integrityError('migration 0 must be named baseline')
    }
    if (migrationNames.has(name)) {
      throw integrityError(`migration ${index} duplicates name ${name}`)
    }
    migrationNames.add(name)
    if (typeof checksum !== 'string' || !SHA256.test(checksum)) {
      throw integrityError(`migration ${index} has invalid checksum`)
    }
    if (sqlitePath !== `sqlite/${stem}` || postgresPath !== `postgres/${stem}`) {
      throw integrityError(`migration ${index} dialect filenames must be ${stem}`)
    }

    let sqliteBytes: Buffer
    let postgresBytes: Buffer

    try {
      sqliteBytes = readFileSync(join(directory, sqlitePath))
      postgresBytes = readFileSync(join(directory, postgresPath))
    } catch (err) {
      throw integrityError(
        `cannot read migration ${stem}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    const actualChecksum = checksumMigrationPair(sqliteBytes, postgresBytes)

    if (checksum !== actualChecksum) {
      throw integrityError(
        `migration ${stem} checksum mismatch: manifest ${checksum}, actual ${actualChecksum}`,
      )
    }

    const sqlite = decodeSql(sqliteBytes, stem, 'SQLite')
    const postgres = decodeSql(postgresBytes, stem, 'PostgreSQL')

    if (!sqlite.trim() || !postgres.trim()) {
      throw integrityError(`migration ${stem} contains an empty dialect`)
    }

    return { version, name, checksum, sqlite, postgres }
  })

  const expectedFiles = migrations.map(
    ({ version, name }) => `${String(version).padStart(4, '0')}_${name}.sql`,
  )
  const sqliteFiles = readSqlFiles(join(directory, 'sqlite'))
  const postgresFiles = readSqlFiles(join(directory, 'postgres'))

  if (!sameStrings(sqliteFiles, expectedFiles)) {
    throw integrityError(
      `SQLite migration files differ from manifest: expected ${expectedFiles.join(', ')}, found ${sqliteFiles.join(', ')}`,
    )
  }
  if (!sameStrings(postgresFiles, expectedFiles)) {
    throw integrityError(
      `PostgreSQL migration files differ from manifest: expected ${expectedFiles.join(', ')}, found ${postgresFiles.join(', ')}`,
    )
  }

  return migrations
}

let cachedMigrations: readonly MetaMigration[] | undefined

export const loadMetaMigrations = (): readonly MetaMigration[] => {
  if (cachedMigrations) {
    return cachedMigrations
  }

  const candidates = [
    new URL('.', import.meta.url),
    new URL('./metaDb-migrations/', import.meta.url),
  ]
  const directory = candidates.find((candidate) =>
    existsSync(fileURLToPath(new URL('manifest.json', candidate))),
  )

  if (!directory) {
    throw integrityError('migration assets are missing from the runtime artifact')
  }

  cachedMigrations = loadMetaMigrationsFromDirectory(fileURLToPath(directory))
  return cachedMigrations
}

export const validateAppliedMetaMigrations = (
  applied: readonly AppliedMetaMigration[],
  available: readonly MetaMigration[],
): number => {
  if (applied.length === 0) {
    throw integrityError('meta_migrations exists but contains no baseline row')
  }

  for (let index = 0; index < applied.length; index++) {
    const row = applied[index]

    if (!Number.isSafeInteger(row.version) || row.version !== index) {
      throw integrityError(
        `ledger is not a contiguous prefix: expected version ${index}, found ${String(row.version)}`,
      )
    }

    const migration = available[index]

    if (!migration) {
      throw integrityError(`database contains unknown future migration ${row.version}`)
    }
    if (row.name !== migration.name) {
      throw integrityError(
        `migration ${row.version} name mismatch: database ${row.name}, manifest ${migration.name}`,
      )
    }
    if (row.checksum !== migration.checksum) {
      throw integrityError(
        `migration ${row.version} checksum mismatch: database ${row.checksum}, manifest ${migration.checksum}`,
      )
    }
  }

  return applied.length
}
