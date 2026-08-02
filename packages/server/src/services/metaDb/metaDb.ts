// Driver selection for the meta-DB layer: a SQLite file vs Postgres.
// canon: docs/architecture.md#desktop-vs-cloud-the-divergence-map

import { PgMetaDb } from './pgMetaDb'
import { SqliteMetaDb } from './sqliteMetaDb'
import type { MetaDb } from './types'

/** The sqlite target behind a meta-DB URL, or null when the URL names Postgres.
 *  `:memory:` comes back verbatim — SQLite's sentinel, not a path (SqliteMetaDb
 *  skips its mkdir for it). The ONE meta-DB URL classifier: a second one elsewhere
 *  drifts silently — the file's dir never gets created or write-probed. */
export const sqlitePathOf = (url: string): string | null =>
  /^postgres(ql)?:\/\//.test(url)
    ? null
    : url.startsWith('sqlite:')
      ? url.slice('sqlite:'.length)
      : // No scheme → a file path (local-run convenience).
        url

export const createMetaDb = (url: string): MetaDb => {
  const sqlitePath = sqlitePathOf(url)

  return sqlitePath === null ? new PgMetaDb(url) : new SqliteMetaDb(sqlitePath)
}
