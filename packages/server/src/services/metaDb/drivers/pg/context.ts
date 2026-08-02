import type pg from 'pg'

/** The shared driver surface each Postgres facet closes over — built once by the
 *  PgMetaDb composer. Exposes exactly what the facet bodies reference: the lazy
 *  init, the live pool getter, and the lifecycle close. */
export type PgDriverCtx = {
  ensureInit: () => Promise<void>
  close: () => Promise<void>
  readonly required: pg.Pool
}
