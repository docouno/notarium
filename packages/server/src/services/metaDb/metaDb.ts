// Driver selection for the meta-DB layer: a SQLite file vs Postgres.
// canon: docs/architecture.md#desktop-vs-cloud-the-divergence-map

import { IN_MEMORY_DB, META_DB_TARGET_KIND, metaDbTargetOf } from './metaDbUrl'
import { PgMetaDb } from './pgMetaDb'
import { SqliteMetaDb } from './sqliteMetaDb'
import type { MetaDb } from './types'

export const createMetaDb = (url: string): MetaDb => {
  const target = metaDbTargetOf(url)

  if (target.kind === META_DB_TARGET_KIND.postgres) {
    return new PgMetaDb(target.url)
  }

  return new SqliteMetaDb(target.kind === META_DB_TARGET_KIND.memory ? IN_MEMORY_DB : target.path)
}
