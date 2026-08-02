// node:sqlite driver of the SQL seam — the Node profile's default (#69).
// Dependency-free like the meta-DB's driver (#51): no native build step, and
// FTS5 is compiled in (verified live on Node 24 / SQLite 3.51). The sync
// builtin sits behind the async seam; the await points are what keep the store
// portable to genuinely-async drivers (wa-sqlite, pg).

import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

import type { SqlDriver, SqlValue } from './types'

export type NodeSqliteDriverOptions = {
  /** Load the sqlite-vec (vec0) extension for vector search (#81). Off by default:
   *  only the engine's index DB needs it, and loading a native extension widens
   *  the process sandbox — enable strictly on our trusted bundled binary, never on
   *  user input (#76 second perimeter). The loadExtension seam stays OUT of the
   *  SqlDriver interface on purpose: wa-sqlite/pg have no such API (P9). */
  vec?: boolean
}

export const createNodeSqliteDriver = (
  path: string,
  opts: NodeSqliteDriverOptions = {},
): SqlDriver => {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }
  // node:sqlite rejects an `undefined` options arg ("must be an object"), so keep
  // the no-extension path on the single-arg ctor — backward-compatible default.
  const db = opts.vec ? new DatabaseSync(path, { allowExtension: true }) : new DatabaseSync(path)

  if (opts.vec) {
    // sqlite-vec is an OPTIONAL native dependency, require'd lazily ONLY when the
    // vector channel is requested — so a host that never enables it (and never
    // installed the platform binary, e.g. the alpine dev image today) still loads
    // this driver without the package present. node:sqlite gates extension loading
    // twice (allowExtension in the ctor AND an explicit enable); sqlite-vec.load()
    // then calls db.loadExtension(vec0.so). Re-disable right after so nothing but
    // our trusted bundled binary can ever load (#76 second perimeter).
    // Close the freshly-opened handle if the extension can't load (no native
    // binary on this platform): the caller (createNotariumStore) catches this to
    // degrade to FTS and opens its OWN driver, so leaving this fd open would leak
    // one connection per space for the process lifetime.
    try {
      const sqliteVec = createRequire(import.meta.url)('sqlite-vec') as {
        load: (db: unknown) => void
      }
      db.enableLoadExtension(true)
      sqliteVec.load(db)
      db.enableLoadExtension(false)
    } catch (err) {
      db.close()
      throw err
    }
  }
  // auto_vacuum BEFORE journal_mode (#198): SQLite only honours an auto_vacuum
  // change on a BRAND-NEW database (before the first table is created) or through a
  // full VACUUM — and once WAL is engaged even a fresh DB needs a VACUUM to switch.
  // So it MUST run first, on the untouched handle, before the store builds its
  // schema. INCREMENTAL (not FULL): freed pages land in the freelist but return to
  // the OS only on an explicit `PRAGMA incremental_vacuum`, which the store drains in
  // quiet windows (reclaimFreePages) — so a churn event (an embed re-write, a schema
  // teardown+rebuild) can't bloat the file unbounded, without paying FULL's
  // per-commit trim on every write. A pre-existing NONE database is left untouched
  // (the pragma is a silent no-op without a VACUUM): we deliberately ship no legacy
  // in-place conversion (a multi-GB VACUUM would freeze the shared loop) — new
  // partitions are born INCREMENTAL, the one deployed instance was compacted by hand.
  db.exec('PRAGMA auto_vacuum = INCREMENTAL')
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL')
  }

  const statements = new Map<string, StatementSync>()

  const prep = (sql: string): StatementSync => {
    let stmt = statements.get(sql)

    if (!stmt) {
      stmt = db.prepare(sql)
      statements.set(sql, stmt)
    }

    return stmt
  }

  return {
    exec: async (sql) => {
      db.exec(sql)
    },
    run: async (sql, params = []) => {
      const { changes } = prep(sql).run(...(params as SqlValue[]))
      return { changes: Number(changes) }
    },
    all: async <T>(sql: string, params: SqlValue[] = []) => prep(sql).all(...params) as T[],
    get: async <T>(sql: string, params: SqlValue[] = []) =>
      prep(sql).get(...params) as T | undefined,
    close: async () => {
      statements.clear()
      db.close()
    },
  }
}
