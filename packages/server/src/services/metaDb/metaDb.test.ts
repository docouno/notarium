import { describe, expect, it } from 'vitest'

import { createMetaDb } from './metaDb'
import { PgMetaDb } from './pgMetaDb'
import { SqliteMetaDb } from './sqliteMetaDb'

// Driver selection only — both constructors are lazy (no connection, no file), so
// this asserts the classifier→driver seam without touching a database.
describe('createMetaDb — the classifier picks the driver', () => {
  it('routes both Postgres spellings to the Postgres driver', () => {
    expect(createMetaDb('postgres://h/db')).toBeInstanceOf(PgMetaDb)
    expect(createMetaDb('postgresql://h/db')).toBeInstanceOf(PgMetaDb)
    expect(createMetaDb('POSTGRES://h/db')).toBeInstanceOf(PgMetaDb)
  })

  it('routes sqlite URLs, bare paths and :memory: to the SQLite driver', () => {
    expect(createMetaDb('sqlite:/data/meta.db')).toBeInstanceOf(SqliteMetaDb)
    expect(createMetaDb('/data/meta.db')).toBeInstanceOf(SqliteMetaDb)
    expect(createMetaDb('sqlite::memory:')).toBeInstanceOf(SqliteMetaDb)
  })

  it('refuses an unknown scheme instead of opening a file named after it', () => {
    // Without this the caller's guard and the driver disagree: a value one refuses
    // the other happily materialises as a new, empty database.
    expect(() => createMetaDb('postgress://h/db')).toThrow(/unsupported meta-DB URL scheme/)
  })
})
