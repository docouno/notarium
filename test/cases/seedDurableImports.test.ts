import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createFsImportStagingStore } from '../../packages/server/src/libs/importStaging'
import { SqliteMetaDb } from '../../packages/server/src/services/metaDb/sqliteMetaDb'
import { seedDurableImports } from '../../scripts/seedDurableImports'
import { buildCaseWorld, DEFAULT_NOW } from './build'

const roots: string[] = []
const dbs: SqliteMetaDb[] = []

afterEach(async () => {
  await Promise.all(dbs.splice(0).map((db) => db.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('seed durable imports', () => {
  it('creates a real retrying row whose upload survives row-aware maintenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-seed-import-'))
    roots.push(root)
    const staging = createFsImportStagingStore(root)
    const db = new SqliteMetaDb(':memory:')
    dbs.push(db)
    const world = buildCaseWorld('jobs', { now: DEFAULT_NOW })
    const declarations = world.durableImports ?? []

    await expect(
      seedDurableImports({
        declarations,
        spaceIds: new Map([['main', 'space-main']]),
        jobs: db.jobs,
        staging,
        principal: 'user:admin',
        createdAt: world.now,
      }),
    ).resolves.toBe(1)

    const declaration = declarations[0]!
    const row = await db.jobs.get(declaration.jobId)
    expect(row).toMatchObject({
      id: declaration.jobId,
      kind: 'import',
      status: 'pending',
      runAt: declaration.retryAt,
      error: declaration.error,
      attempts: 1,
      params: {
        uploadRef: `space-main/${declaration.jobId}.import`,
        filename: declaration.filename,
      },
    })

    // Simulate maintenance long after both filesystem grace windows. The production
    // callback treats pending/running rows as live, so the exact seeded bytes remain.
    await staging.sweepOrphans(async (id) => {
      const job = await db.jobs.get(id)
      return !!job && (job.status === 'pending' || job.status === 'running')
    }, Number.MAX_SAFE_INTEGER)
    await expect(
      readFile(staging.pathOf(`space-main/${declaration.jobId}.import`), 'utf8'),
    ).resolves.toBe(declaration.content)
  })
})
