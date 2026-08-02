import { Readable } from 'node:stream'

import { type ImportStagingStore, JOB_KIND_IMPORT, type JobsPersistence } from '@notarium/server'

import type { DurableImportDecl } from '../test/cases'

export type SeedDurableImportsOptions = {
  declarations: readonly DurableImportDecl[]
  spaceIds: ReadonlyMap<string, string>
  jobs: JobsPersistence
  staging: ImportStagingStore
  principal: string
  createdAt: string
}

/** Materialize a retrying import exactly as production does: durable staging first,
 *  then a live queue row which row-aware maintenance recognizes and preserves. */
export const seedDurableImports = async ({
  declarations,
  spaceIds,
  jobs,
  staging,
  principal,
  createdAt,
}: SeedDurableImportsOptions): Promise<number> => {
  let seeded = 0

  for (const declaration of declarations) {
    const spaceId = spaceIds.get(declaration.space)

    if (!spaceId) {
      throw new Error(`seed: durable import targets unknown space "${declaration.space}"`)
    }
    const retryAtMs = Date.parse(declaration.retryAt)

    if (!Number.isFinite(retryAtMs) || retryAtMs <= Date.now()) {
      throw new Error(`seed: durable import "${declaration.jobId}" retryAt must be in the future`)
    }

    const uploadRef = await staging.stage(
      spaceId,
      declaration.jobId,
      Readable.from([declaration.content]),
    )
    const row = await jobs.enqueue({
      id: declaration.jobId,
      space: spaceId,
      kind: JOB_KIND_IMPORT,
      principal,
      params: { uploadRef, filename: declaration.filename },
      createdAt,
    })
    const workerId = `seed-${row.id}`
    const claimed = await jobs.claimNext(workerId, [JOB_KIND_IMPORT], createdAt)

    if (!claimed || claimed.id !== row.id) {
      throw new Error(
        `seed: durable import ${row.id} was not claimable (got ${claimed?.id ?? 'none'})`,
      )
    }
    const rescheduled = await jobs.fail(row.id, workerId, {
      error: declaration.error,
      retryAt: declaration.retryAt,
      now: createdAt,
    })

    if (!rescheduled) {
      throw new Error(`seed: durable import ${row.id} could not be rescheduled`)
    }
    seeded++
  }

  return seeded
}
