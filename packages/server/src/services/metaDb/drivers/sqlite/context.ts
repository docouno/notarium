import type { DatabaseSync, StatementSync } from 'node:sqlite'

import type { RevisionPersistence } from '@notarium/core'

export type SqliteActivityWorker = Pick<
  RevisionPersistence,
  | 'maintainActivityProjection'
  | 'maintainActivityProjectionGc'
  | 'activityEvents'
  | 'activityGroupsByNote'
>

/** SQLite INTEGER is wider than JavaScript's safe number range. Statements that
 * carry revision ordinals or cumulative Activity counters opt into bigint before
 * reading; conversion to decimal strings happens at the persistence boundary. */
export const readSqliteBigInts = <T extends StatementSync>(statement: T): T => {
  statement.setReadBigInts(true)
  return statement
}

/** The shared driver surface each SQLite facet closes over — built once by the
 *  SqliteMetaDb composer. Exposes exactly what the facet bodies reference: the
 *  lazy init, the live db getter, and the lifecycle close. */
export type SqliteDriverCtx = {
  ensureInit: () => Promise<void>
  checkpointWal: () => Promise<void>
  activityWorker?: () => SqliteActivityWorker | null
  close: () => Promise<void>
  readonly required: DatabaseSync
}
