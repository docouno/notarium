// The field axis on the snapshot: what rides the polling projection, what
// deliberately does not, and how a value LEAVES the snapshot when the file drops it.
// canon: docs/note-model.md#note-ontology

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createLocalFsFiles } from '../../libs/files'
import { createNodeSqliteDriver, type SqlDriver, type SqlValue } from '../../libs/sql'
import { NotariumStore } from './notariumStore'
import { INDEX_MIGRATIONS, type IndexMigration } from './schema'
import { type EngineMount, engineMountOf } from './types'

/** Records the statements the store issues, so a projection claim ("this read does
 *  not pull the column") is asserted on the query the driver actually receives. */
const recording = (inner: SqlDriver) => {
  const queries: string[] = []
  const driver: SqlDriver = {
    exec: (sql) => inner.exec(sql),
    run: (sql, params) => inner.run(sql, params),
    all: <T>(sql: string, params?: SqlValue[]) => {
      queries.push(sql)
      return inner.all<T>(sql, params)
    },
    get: <T>(sql: string, params?: SqlValue[]) => inner.get<T>(sql, params),
    close: () => inner.close(),
  }

  return { driver, queries }
}

describe('the fields column on the read path', () => {
  let notesDir: string

  const userMount = (dir: string): EngineMount =>
    engineMountOf({ class: 'user-doc', prefix: '' }, createLocalFsFiles(dir))

  const open = (migrations?: readonly IndexMigration[]) => {
    const sql = recording(createNodeSqliteDriver(':memory:'))
    const store = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql: sql.driver,
      integritySweepBatchSize: 0,
      ...(migrations ? { migrations } : {}),
    })

    return { store, queries: sql.queries, sql: sql.driver }
  }

  /** The ladder cut just before the rung that adds the column, so every row this store
   *  materializes genuinely lacks it. Found rather than hard-sliced: a hardcoded length
   *  would silently stop truncating the moment a seventh rung is appended. */
  const ladderBeforeFields = (): readonly IndexMigration[] => {
    const rung = INDEX_MIGRATIONS.findIndex((step) => /ADD COLUMN fields/.test(step.sql))

    expect(rung).toBeGreaterThan(0)

    return INDEX_MIGRATIONS.slice(0, rung)
  }

  const write = (name: string, frontmatter: string, body = 'body') =>
    writeFileSync(
      join(notesDir, `${name}.md`),
      `---\ntitle: ${name}\n${frontmatter}\n---\n\n${body}\n`,
    )

  beforeEach(() => {
    notesDir = mkdtempSync(join(tmpdir(), 'notarium-fields-read-'))
  })
  afterEach(() => {
    rmSync(notesDir, { recursive: true, force: true })
  })

  it('rides the boot seed whole and the delta only for rows that moved', async () => {
    write('alpha', 'status: doing')
    write('beta', 'sprint: 42')
    const { store, queries } = open()
    const seed = await store.changes(null)

    expect(seed.inventory.map((n) => n.fields?.keys)).toEqual([
      { status: 'doing' },
      { sprint: '42' },
    ])

    const quiet = await store.changes(seed.cursor)

    // The delta's projection guards `fields` exactly like `body`: a poll on an
    // unchanged corpus must not decode the whole corpus's metadata every interval.
    expect(quiet.upserts).toEqual([])
    expect(
      queries.some((sql) => /CASE WHEN seq > \? THEN fields ELSE '' END AS fields/.test(sql)),
    ).toBe(true)
    // Unchanged rows answer the sentinel, so the meta carries no value of its own —
    // the read-model's carry-forward is what keeps the axis alive between polls. The
    // length comes first because `every` is true of an empty array: a poll that lost
    // the inventory would satisfy the claim below and read as a corpus-wide delete.
    expect(quiet.inventory).toHaveLength(2)
    expect(quiet.inventory.every((n) => n.fields === undefined)).toBe(true)
    await store.stop()
  })

  it('keeps the column out of the graph and resolve projections', async () => {
    write('alpha', 'status: doing\nslug: alpha-slug')
    const { store, queries } = open()

    await store.list()
    const listed = queries.filter((sql) => /SELECT .*FROM notes/.test(sql))

    expect(listed.some((sql) => sql.includes('fields'))).toBe(true)
    queries.length = 0
    await store.graph()
    // graph() walks the whole corpus for wikilink derivation and never reads fields;
    // a mandatory decode per row would be pure loop-block for nothing.
    const graphSelects = queries.filter((sql) => /FROM notes/.test(sql))

    expect(graphSelects).not.toHaveLength(0)
    expect(graphSelects.some((sql) => sql.includes('fields'))).toBe(false)
    queries.length = 0
    // A custom slug is not a storage path, so this read falls past every exact lookup
    // onto the resolver's own full-corpus select — the ONLY way that select runs, and
    // therefore the only way its projection can be asserted at all.
    const resolved = await store.read('alpha-slug')

    expect(resolved.filePath).toBe('alpha.md')
    const resolveSelects = queries.filter((sql) => /FROM notes/.test(sql))

    expect(resolveSelects).not.toHaveLength(0)
    expect(resolveSelects.some((sql) => sql.includes('fields'))).toBe(false)
    await store.stop()
  })

  it('adopts a fingerprint-less row whose author keys already match', async () => {
    write('alpha', 'status: doing\nreviewers:\n- ann\n- bo')
    const { store, sql } = open()
    const seed = await store.changes(null)

    expect(seed.inventory[0].fields!.keys).toEqual({ status: 'doing', reviewers: ['ann', 'bo'] })
    expect(store.rescanStats()).toEqual({ filesRead: 1, rowsRederived: 1 })
    // Exactly what the ladder's fields rung leaves behind on every index in the wild:
    // the row keeps its blob and the fingerprint that vouched for its bytes is gone, so
    // the next scan MUST re-read the file and decide adoption on the projections alone.
    await sql.run(`DELETE FROM file_fingerprints`)
    const quiet = await store.changes(seed.cursor)

    // The "matched" half of the re-derivation rule design/01 states, and the half
    // nothing reached: all three places that wipe fingerprints seed notes with
    // no author keys, where the comparison runs on the column DEFAULT and would pass
    // just as well against a constant. A blob comparison that never matches a NON-empty
    // one is invisible from there — and it puts the whole corpus into permanent
    // re-derivation on every poll with the backfill gate still green.
    expect(quiet.upserts).toEqual([])
    expect(store.rescanStats()).toEqual({ filesRead: 2, rowsRederived: 1 })
    // Same comparison, second consumer: the write path recovers a missing fingerprint
    // through it, and refuses the write outright ("note changed during write") when the
    // materialized row does not describe the bytes it just read.
    await sql.run(`DELETE FROM file_fingerprints`)
    await expect(
      store.write({ title: 'alpha', content: 'edited', originalId: 'alpha.md' }),
    ).resolves.toMatchObject({ filePath: 'alpha.md' })
    await store.stop()
  })

  it('lets an external edit remove the last author key from the snapshot', async () => {
    write('alpha', 'status: doing')
    const { store } = open()
    const seed = await store.changes(null)

    expect(seed.inventory[0].fields?.keys).toEqual({ status: 'doing' })

    write('alpha', 'status: doing', 'body edited')
    const changed = await store.changes(seed.cursor)

    expect(changed.upserts[0].meta.fields?.keys).toEqual({ status: 'doing' })

    writeFileSync(join(notesDir, 'alpha.md'), `---\ntitle: alpha\n---\n\nbody edited again\n`)
    const cleared = await store.changes(changed.cursor)

    // A PRESENT empty blob, not an absent one: the snapshot must drop the value now
    // rather than carry the removed key forward until a restart.
    expect(cleared.upserts[0].meta.fields).toEqual({ keys: {} })
    await store.stop()
  })

  it('answers absence, not an empty blob, for a reader whose row has no such column', async () => {
    write('alpha', 'status: doing')
    const { store } = open(ladderBeforeFields())
    const seed = await store.changes(null)

    expect(seed.inventory).toHaveLength(1)
    // An index without the column has said NOTHING about the author's keys, and the
    // only encoding of that is absence. A present `{keys:{}}` is the opposite claim —
    // the read-model reads it as "the file just lost its last key" and drops the value
    // it was carrying forward, so decoding a missing column into one loses the axis on
    // every reader whose row is narrow (the graph and resolve selects, the adjacency
    // rebuild's hand-built row, and every read on a store short of this rung).
    expect(seed.inventory[0].fields).toBeUndefined()
    await store.stop()
  })

  it('counts the rescan pass alone, not the write path sharing its reconciler', async () => {
    write('alpha', 'status: doing')
    const { store } = open()

    await store.changes(null)
    expect(store.rescanStats()).toEqual({ filesRead: 1, rowsRederived: 1 })
    // Identity materialization rewrites the file and re-derives its row through the
    // SAME reconciler the scan uses, having read no file on the scan's behalf. Counted
    // there, `rowsRederived` outgrew `filesRead` — a state no scan can produce — and
    // the number quoted for a re-derivation included work it never did.
    expect(
      await store.materializeIdentityAtPath({
        filePath: 'alpha.md',
        expectedClaimId: null,
        targetId: 'ZzZzZzZzZzZz',
      }),
    ).toEqual({ status: 'materialized' })
    expect(store.rescanStats()).toEqual({ filesRead: 1, rowsRederived: 1 })
    await store.stop()
  })

  it('survives a search whose adjacency row is hand-built without the column', async () => {
    write('alpha', 'status: doing', 'links to [[beta]]')
    write('beta', 'status: done')
    const { store } = open()

    await store.changes(null)
    // A no-throw guard, and only that: it pins the decoder against a naive
    // `JSON.parse(row.fields)` on the literal row. What the absent column must PROJECT
    // to is pinned by the test above.
    await expect(store.search('links')).resolves.toBeInstanceOf(Array)
    await store.stop()
  })
})
