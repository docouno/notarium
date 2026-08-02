import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { backupLayoutFromEnv } from './dataBackupLayout'

const envFor = (dataDir: string): NodeJS.ProcessEnv => ({
  DATA_DIR: dataDir,
  HOME: process.env.HOME ?? '/tmp',
})

describe('backupLayoutFromEnv', () => {
  it('resolves the canonical one-root layout', () => {
    expect(backupLayoutFromEnv(envFor('/data'))).toEqual({
      dataDir: '/data',
      metaDbPath: '/data/meta.db',
      spacesDir: '/data/spaces',
      jobsDir: '/data/jobs',
    })
  })

  it('refuses external or explicit topology that the archive would omit', () => {
    expect(() =>
      backupLayoutFromEnv({
        ...envFor('/data'),
        META_DB_URL: 'postgres://db/notarium',
      }),
    ).toThrow(/file-backed SQLite/)
    expect(() =>
      backupLayoutFromEnv({
        ...envFor('/data'),
        JOBS_DATA_DIR: join('/tmp', 'external-jobs'),
      }),
    ).toThrow(/canonical one-root layout/)
    expect(() =>
      backupLayoutFromEnv({
        ...envFor('/data'),
        SPACES_ROOT: '/data/custom-spaces',
      }),
    ).toThrow(/spaces root must be/)
    expect(() =>
      backupLayoutFromEnv({
        ...envFor('/data'),
        SPACES_CONFIG: '[]',
      }),
    ).toThrow(/explicit space topology/)
  })
})
