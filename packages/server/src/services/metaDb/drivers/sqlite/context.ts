import type { DatabaseSync } from 'node:sqlite'

/** The shared driver surface each SQLite facet closes over — built once by the
 *  SqliteMetaDb composer. Exposes exactly what the facet bodies reference: the
 *  lazy init, the live db getter, and the lifecycle close. */
export type SqliteDriverCtx = {
  ensureInit: () => Promise<void>
  close: () => Promise<void>
  readonly required: DatabaseSync
}
