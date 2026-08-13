// Environment adapter for the backup library. Kept at the inbound app edge so
// the reusable library does not depend on server wiring or persistence services.

import { join, resolve } from 'node:path'

import {
  type BackupLayout,
  DEFAULT_MAX_BACKUP_BYTES,
  DEFAULT_MAX_BACKUP_ENTRIES,
  DEFAULT_MAX_BACKUP_METADATA_BYTES,
} from '../../../../libs/dataBackup'
import { META_DB_TARGET_KIND, metaDbTargetOf } from '../../../../services/metaDb'
import { dataPathsFromEnv } from '../../dataPaths'

const canonicalPath = (path: string, expected: string, label: string): void => {
  if (path !== expected) {
    throw new Error(
      `online backup supports the canonical one-root layout only: ${label} must be ${expected}`,
    )
  }
}

/** Fail closed instead of publishing an archive that silently omits external state. */
export const backupLayoutFromEnv = (env: NodeJS.ProcessEnv = process.env): BackupLayout => {
  const paths = dataPathsFromEnv(env)
  const metaDb = metaDbTargetOf(paths.metaDbUrl)
  const spacesDir = resolve(env.SPACES_ROOT?.trim() || paths.defaultSpacesRoot)

  if (metaDb.kind !== META_DB_TARGET_KIND.file) {
    throw new Error('online backup requires the canonical file-backed SQLite meta-DB')
  }
  const resolvedMetaDb = resolve(metaDb.path)
  const expectedMetaDb = join(paths.dataDir, 'meta.db')

  if (resolvedMetaDb !== expectedMetaDb) {
    throw new Error(
      `online backup supports the canonical one-root layout only: meta-DB must be ${expectedMetaDb}`,
    )
  }
  if (env.SPACES_CONFIG?.trim() || env.ENGINE?.trim() || env.NOTES_DIR?.trim()) {
    throw new Error(
      'online backup supports the canonical one-root layout only; explicit space topology needs a provider-specific backup',
    )
  }
  canonicalPath(spacesDir, join(paths.dataDir, 'spaces'), 'spaces root')
  canonicalPath(paths.jobsDataDir, join(paths.dataDir, 'jobs'), 'jobs root')

  return {
    dataDir: paths.dataDir,
    metaDbPath: resolvedMetaDb,
    spacesDir,
    jobsDir: paths.jobsDataDir,
    keyringDir: join(paths.dataDir, 'replay-keyring'),
  }
}

const positive = (name: string, value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === '') {
    return fallback
  }
  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive safe integer`)
  }

  return parsed
}

export const backupRuntimeFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): {
  scratchDir?: string
  maxArchiveBytes: number
  maxArchiveEntries: number
  maxMetadataBytes: number
} => ({
  scratchDir: env.NOTARIUM_BACKUP_TMPDIR?.trim() || undefined,
  maxArchiveBytes: positive(
    'NOTARIUM_BACKUP_MAX_BYTES',
    env.NOTARIUM_BACKUP_MAX_BYTES,
    DEFAULT_MAX_BACKUP_BYTES,
  ),
  maxArchiveEntries: positive(
    'NOTARIUM_BACKUP_MAX_ENTRIES',
    env.NOTARIUM_BACKUP_MAX_ENTRIES,
    DEFAULT_MAX_BACKUP_ENTRIES,
  ),
  maxMetadataBytes: positive(
    'NOTARIUM_BACKUP_MAX_METADATA_BYTES',
    env.NOTARIUM_BACKUP_MAX_METADATA_BYTES,
    DEFAULT_MAX_BACKUP_METADATA_BYTES,
  ),
})
