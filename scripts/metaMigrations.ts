import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  checksumMigrationPair,
  loadMetaMigrationsFromDirectory,
} from '../packages/server/src/services/metaDb/migrations'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const directory = join(root, 'packages/server/src/services/metaDb/migrations')
const [mode, stem, ...extra] = process.argv.slice(2)

if (mode === undefined) {
  const migrations = loadMetaMigrationsFromDirectory(directory)
  const last = migrations.at(-1)!
  console.log(
    `meta migrations: ${migrations.length} verified, latest ${String(last.version).padStart(4, '0')}_${last.name}`,
  )
} else if (
  mode === '--checksum' &&
  stem &&
  /^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*$/.test(stem) &&
  extra.length === 0
) {
  const sqlite = readFileSync(join(directory, 'sqlite', `${stem}.sql`))
  const postgres = readFileSync(join(directory, 'postgres', `${stem}.sql`))
  console.log(checksumMigrationPair(sqlite, postgres))
} else {
  throw new Error(
    'usage: npm run meta-migrations:check | npm run meta-migrations:checksum -- 0001_name',
  )
}
