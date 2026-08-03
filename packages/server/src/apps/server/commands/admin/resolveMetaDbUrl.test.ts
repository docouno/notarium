import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveMetaDbUrl } from './resolveMetaDbUrl'

const HOME = '/home/op'
const CWD = '/srv/checkout/packages/server'

/** A fixed world for the search order. The walk climbs to the filesystem ROOT, so a
 *  real-disk fixture would be asserting against `/tmp` and `/` — directories no test
 *  owns and a neighbouring process can fill. */
const world =
  (...present: string[]) =>
  (path: string) =>
    present.includes(path)

const env = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ HOME, ...over })

const roots: string[] = []

const tmpRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'notarium-admin-resolve-'))
  roots.push(root)

  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

describe('resolveMetaDbUrl — an explicit META_DB_URL', () => {
  it('refuses a path that merely LOOKS like a Postgres URL instead of creating an empty DB', () => {
    // The defect: `startsWith('postgres')` classified this as Postgres and returned it
    // untouched, so it skipped the existence guard — and createMetaDb, reading the
    // scheme properly, opened it as a NEW SQLite file. Recovery then reported "no
    // users" against a database it had just created.
    expect(() =>
      resolveMetaDbUrl(env({ META_DB_URL: 'postgres-backup/meta.db' }), CWD, world()),
    ).toThrow(
      /\/srv\/checkout\/packages\/server\/postgres-backup\/meta\.db, which is not a database/,
    )
  })

  it('opens that same path once it really exists — as SQLite, absolute', () => {
    const abs = `${CWD}/postgres-backup/meta.db`

    expect(resolveMetaDbUrl(env({ META_DB_URL: 'postgres-backup/meta.db' }), CWD, world(abs))).toBe(
      `sqlite:${abs}`,
    )
  })

  it('reads the real disk through the default probe, not just an injected one', async () => {
    // One end-to-end case so the default wiring cannot rot unnoticed — and it is the
    // probe that has to be right: a bare `touch meta.db` would otherwise pass for a
    // database, and the CLI would fill that empty file and answer from it.
    const root = await tmpRoot()
    const db = join(root, 'meta.db')
    await writeFile(db, 'meta')
    const empty = join(root, 'empty.db')
    await writeFile(empty, '')

    expect(resolveMetaDbUrl(env({ META_DB_URL: db }), root)).toBe(`sqlite:${db}`)
    expect(() => resolveMetaDbUrl(env({ META_DB_URL: join(root, 'nope.db') }), root)).toThrow(
      /is not a database/,
    )
    expect(() => resolveMetaDbUrl(env({ META_DB_URL: empty }), root)).toThrow(/is not a database/)
    // A directory carrying the name is not one either.
    expect(() => resolveMetaDbUrl(env({ META_DB_URL: root }), root)).toThrow(/is not a database/)
  })

  it('passes a real Postgres URL through untouched, in either spelling', () => {
    expect(resolveMetaDbUrl(env({ META_DB_URL: 'postgres://u@h/db' }), CWD, world())).toBe(
      'postgres://u@h/db',
    )
    expect(resolveMetaDbUrl(env({ META_DB_URL: 'POSTGRESQL://u@h/db' }), CWD, world())).toBe(
      'POSTGRESQL://u@h/db',
    )
  })

  it('rejects an unknown scheme rather than recovering into a file named after it', () => {
    expect(() =>
      resolveMetaDbUrl(env({ META_DB_URL: 'postgress://u@h/db' }), CWD, world()),
    ).toThrow(/unsupported meta-DB URL scheme/)
  })

  it('rejects an in-memory database — there is nothing to recover in one', () => {
    expect(() => resolveMetaDbUrl(env({ META_DB_URL: 'sqlite::memory:' }), CWD, world())).toThrow(
      /in-memory database/,
    )
  })
})

describe('resolveMetaDbUrl — the search order when META_DB_URL is unset', () => {
  const NAMED = '/srv/data/meta.db'
  const STAND = '/srv/checkout/docker/volumes/data/meta.db'
  const PRE_ROOT = '/srv/checkout/docker/volumes/notarium-state/meta.db'
  const DOT_DATA = '/srv/checkout/.data/meta.db'
  const IMPLICIT = `${HOME}/.local/share/notarium/meta.db`

  it('takes the DATA_DIR root when the operator named one', () => {
    expect(resolveMetaDbUrl(env({ DATA_DIR: '/srv/data' }), CWD, world(NAMED))).toBe(
      `sqlite:${NAMED}`,
    )
  })

  it('prefers a named root over every stand found up the tree', () => {
    // Recovery must land where the SERVER would run, not on the nearest database.
    expect(
      resolveMetaDbUrl(env({ DATA_DIR: '/srv/data' }), CWD, world(NAMED, STAND, IMPLICIT)),
    ).toBe(`sqlite:${NAMED}`)
  })

  it('falls back to the checkout when DATA_DIR names a root with no DB yet', () => {
    // A named-but-empty root is a typo or a not-yet-started host; the real stand is
    // still the honest target, and a missing one must NOT be created.
    expect(resolveMetaDbUrl(env({ DATA_DIR: '/srv/data' }), CWD, world(STAND))).toBe(
      `sqlite:${STAND}`,
    )
  })

  it('walks up from a nested cwd to the stand in the checkout root', () => {
    expect(resolveMetaDbUrl(env(), CWD, world(STAND))).toBe(`sqlite:${STAND}`)
  })

  it('also finds each layout from before the single root', () => {
    expect(resolveMetaDbUrl(env(), CWD, world(PRE_ROOT))).toBe(`sqlite:${PRE_ROOT}`)
    expect(resolveMetaDbUrl(env(), CWD, world(DOT_DATA))).toBe(`sqlite:${DOT_DATA}`)
  })

  it('takes the newest layout first when one directory holds several', () => {
    expect(resolveMetaDbUrl(env(), CWD, world(STAND, PRE_ROOT, DOT_DATA))).toBe(`sqlite:${STAND}`)
  })

  it('prefers the NEAREST directory up the tree over one further away', () => {
    const nested = '/srv/checkout/packages/server/.data/meta.db'

    expect(resolveMetaDbUrl(env(), CWD, world(nested, STAND))).toBe(`sqlite:${nested}`)
  })

  it('falls back to the implicit host default only when nothing else matched', () => {
    // Any bare `npm run server` materialises this file, so reaching it first would aim
    // recovery at a throwaway DB — it must lose to every stand above.
    expect(resolveMetaDbUrl(env(), CWD, world(IMPLICIT))).toBe(`sqlite:${IMPLICIT}`)
    expect(resolveMetaDbUrl(env(), CWD, world(IMPLICIT, STAND))).toBe(`sqlite:${STAND}`)
  })

  it('says how to aim it when there is no meta-DB anywhere', () => {
    expect(() => resolveMetaDbUrl(env(), CWD, world())).toThrow(/could not find a meta-DB/)
  })
})
