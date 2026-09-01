import { DatabaseSync } from 'node:sqlite'

import type { RevisionPersistence } from '@notarium/core'

import { maintainSqliteActivityProjection } from '../packages/server/src/services/metaDb/drivers/sqlite/activityProjection'
import type { SqliteDriverCtx } from '../packages/server/src/services/metaDb/drivers/sqlite/context'
import { createRevisionsFacet } from '../packages/server/src/services/metaDb/drivers/sqlite/revisions'

export type ActivityProjectionSpikeDb = {
  revisions: RevisionPersistence
  close(): Promise<void>
}

/** Explicit same-thread control for the approved A/B spike. Production never
 * calls this helper; it exists so the evidence harness cannot accidentally
 * benchmark the production worker on both sides of the comparison. */
export const openActivityProjectionSpikeDb = (
  path: string,
  rebuildBatchSize: number,
): ActivityProjectionSpikeDb => {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA wal_autocheckpoint = 0')
  let open = true
  const ctx: SqliteDriverCtx = {
    ensureInit: async () => {
      if (!open) {
        throw new Error('Activity projection spike database is closed')
      }
    },
    checkpointWal: async () => {
      db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()
    },
    close: async () => {
      if (open) {
        db.close()
        open = false
      }
    },
    get required() {
      if (!open) {
        throw new Error('Activity projection spike database is closed')
      }

      return db
    },
  }
  const base = createRevisionsFacet(ctx)
  const revisions: RevisionPersistence = {
    ...base,
    maintainActivityProjection: (space) =>
      maintainSqliteActivityProjection(ctx, space, rebuildBatchSize),
  }

  return { revisions, close: () => ctx.close() }
}
