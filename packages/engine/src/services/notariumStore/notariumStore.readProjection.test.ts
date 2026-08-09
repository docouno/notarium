import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { FRONTMATTER_BYTE_CAP, FrontmatterLimitError, parseFrontmatterBlock } from '@notarium/core'

import { createNotariumStore } from './createNotariumStore'

// #222: the read/reconcile path must project only the columns each surface uses —
// never `SELECT *` — so a big space's space-open seed, list() and every poll stop
// materializing the whole corpus's bodies on the shared loop. Metadata surfaces stay
// body-free; bodies ride ONLY the delta's changed rows and the graph derivation.
//
// The first test observes the ACTUAL SQL the store issues (not just the returned
// values), because value-level assertions can't tell a meta-only projection apart from
// `SELECT *` (metaOf ignores the body either way) — so only a query-text assertion
// actually guards against a regression back to `SELECT *`.

/** Wrap the store's SqlDriver.all to record every query text it issues. */
const spyQueries = (store: unknown): { queries: string[] } => {
  const box = { queries: [] as string[] }
  const sql = (store as { sql: { all: (q: string, p?: unknown[]) => Promise<unknown> } }).sql
  const orig = sql.all.bind(sql)

  sql.all = (q: string, p?: unknown[]) => {
    box.queries.push(q)
    return orig(q, p)
  }

  return box
}

/** The one query each read surface issues over the whole notes table. */
const notesListQuery = (queries: string[]): string | undefined =>
  queries.filter((q) => /FROM notes\s+ORDER BY path/i.test(q)).at(-1)

describe('NotariumStore read/reconcile projection (#222)', () => {
  const write = (root: string, name: string, body: string): Promise<void> =>
    fs.writeFile(join(root, name), body)

  it('never issues `SELECT *` on the read path: seed/list are body-free, the delta gates body by seq', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'nstore-proj-'))
    const store = createNotariumStore({ notesDir: root })

    try {
      await write(root, 'a.md', '# A\n\nbody of A')
      const spy = spyQueries(store)

      // Boot seed (cursor=null): the notes projection must select metadata only —
      // no `body`, no `SELECT *`. This is what would regress if someone put `*` back.
      spy.queries.length = 0
      await store.changes(null)
      const seedQ = notesListQuery(spy.queries)
      expect(seedQ, 'seed must query the notes table').toBeTruthy()
      expect(seedQ).not.toMatch(/SELECT \*/i)
      expect(seedQ).not.toMatch(/\bbody\b/i)

      // list(): same — metadata only, never `SELECT *`.
      spy.queries.length = 0
      await store.list()
      const listQ = notesListQuery(spy.queries)
      expect(listQ).toBeTruthy()
      expect(listQ).not.toMatch(/SELECT \*/i)
      expect(listQ).not.toMatch(/\bbody\b/i)

      // Delta poll: bodies ride the query, but GATED by seq (CASE) so unchanged rows
      // don't materialize their body — never a bare `SELECT *`.
      const cursor = (await store.changes(null)).cursor
      spy.queries.length = 0
      await store.changes(cursor)
      const deltaQ = notesListQuery(spy.queries)
      expect(deltaQ).toBeTruthy()
      expect(deltaQ).not.toMatch(/SELECT \*/i)
      expect(deltaQ).toMatch(/CASE WHEN seq >/i)
    } finally {
      await store.stop()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('list() carries full metadata under a meta-only projection', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'nstore-proj-'))
    const store = createNotariumStore({ notesDir: root })

    try {
      await write(
        root,
        'a.md',
        [
          '---',
          'tags: [alpha, beta]',
          'aliases: [Old Name]',
          'slug: custom-a',
          '---',
          '# Note A',
          '',
          'body of A',
        ].join('\n'),
      )
      await store.changes(null)
      const [meta] = await store.list()
      expect(meta.title).toBe('Note A')
      expect(meta.tags).toEqual(['alpha', 'beta'])
      expect(meta.aliases).toEqual(['Old Name'])
      expect(meta.slug).toBe('custom-a')
    } finally {
      await store.stop()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('pushes semantic class narrowing into the indexed metadata query', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'nstore-proj-'))
    const memoryRoot = join(root, '.notarium/memory')
    await fs.mkdir(memoryRoot, { recursive: true })
    const store = createNotariumStore({
      mounts: [
        { class: 'user-doc', dir: root },
        { class: 'agent-memory', dir: memoryRoot, prefix: '.notarium/memory' },
      ],
    })

    try {
      await write(root, 'doc.md', '# Ordinary note\n\nbody')
      await write(memoryRoot, 'memory.md', '# Memory\n\nsummary')
      await store.changes(null)
      const spy = spyQueries(store)

      const rows = await store.list({ classes: ['agent-memory'] })

      expect(rows.map((row) => row.filePath)).toEqual(['.notarium/memory/memory.md'])
      const query = spy.queries.find((candidate) =>
        /FROM notes WHERE class IN \(\?\)/i.test(candidate),
      )
      expect(query, 'class filter must be part of the engine query').toBeTruthy()
      expect(query).not.toMatch(/SELECT \*/i)
      expect(query).not.toMatch(/\bbody\b/i)
      const sql = (
        store as unknown as {
          sql: { all: <T>(query: string, params?: unknown[]) => Promise<T[]> }
        }
      ).sql
      const plan = await sql.all<{ detail: string }>(
        'EXPLAIN QUERY PLAN SELECT path FROM notes WHERE class IN (?) ORDER BY path',
        ['agent-memory'],
      )
      expect(plan.some((step) => step.detail.includes('idx_notes_class'))).toBe(true)
    } finally {
      await store.stop()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('the boot seed is inventory-only (no upserts); bodies ride ONLY the delta', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'nstore-proj-'))
    const store = createNotariumStore({ notesDir: root })

    try {
      await write(root, 'a.md', '# A\n\nfirst body')
      const seed = await store.changes(null)
      expect(seed.inventory.length).toBe(1)
      expect(seed.upserts).toEqual([])

      // A new note lands; the next poll carries it as an upsert WITH its body.
      await write(root, 'b.md', '# B\n\nsecond body')
      const delta = await store.changes(seed.cursor)
      const upsert = delta.upserts.find((u) => u.meta.filePath === 'b.md')
      expect(upsert?.content).toContain('second body')
      expect(delta.inventory.length).toBe(2)
      // The unchanged note is in the inventory but NOT re-sent as an upsert.
      expect(delta.upserts.some((u) => u.meta.filePath === 'a.md')).toBe(false)

      // A no-change poll: inventory intact, zero upserts.
      const quiet = await store.changes(delta.cursor)
      expect(quiet.inventory.length).toBe(2)
      expect(quiet.upserts).toEqual([])
    } finally {
      await store.stop()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('a MODIFIED note re-emits its NEW body on the next delta (body gate hits the edit, not just new files)', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'nstore-proj-'))
    const store = createNotariumStore({ notesDir: root })

    try {
      await write(root, 'a.md', '# A\n\noriginal body')
      const cursor = (await store.changes(null)).cursor
      // Rewrite the SAME file with new content + a bumped mtime (rescan keys on mtime/size).
      await write(root, 'a.md', '# A\n\nrewritten body text that is clearly different')
      await fs.utimes(join(root, 'a.md'), new Date(), new Date(Date.now() + 5_000))
      const delta = await store.changes(cursor)
      const upsert = delta.upserts.find((u) => u.meta.filePath === 'a.md')
      expect(upsert, 'a modified note must surface as an upsert').toBeTruthy()
      expect(upsert!.content).toContain('rewritten body text')
      expect(upsert!.content).not.toContain('original body')
    } finally {
      await store.stop()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('a DELETED note drops out of the (meta-only) inventory used for deletion-diffing', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'nstore-proj-'))
    const store = createNotariumStore({ notesDir: root })

    try {
      await write(root, 'a.md', '# A\n\nbody')
      await write(root, 'b.md', '# B\n\nbody')
      const cursor = (await store.changes(null)).cursor
      await fs.rm(join(root, 'b.md'))
      const delta = await store.changes(cursor)
      const paths = delta.inventory.map((m) => m.filePath)
      expect(paths).toContain('a.md')
      expect(paths).not.toContain('b.md') // gone from inventory → read-model tombstones it
    } finally {
      await store.stop()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('cursor="0" replays every row as an upsert with its body (numeric-cursor boundary, not the null-seed branch)', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'nstore-proj-'))
    const store = createNotariumStore({ notesDir: root })

    try {
      await write(root, 'a.md', '# A\n\nbody of A')
      await write(root, 'b.md', '# B\n\nbody of B')
      await store.changes(null) // index both (seq 1, 2 > 0)
      const delta = await store.changes('0')
      expect(delta.upserts.length).toBe(2) // every row seq>0 → full replay
      expect(
        delta.upserts.every((u) => typeof u.content === 'string' && u.content.length > 0),
      ).toBe(true)
    } finally {
      await store.stop()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a final over-cap frontmatter payload before mutating the source file', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'nstore-proj-'))
    const store = createNotariumStore({ notesDir: root })
    const before = `---\npad: ${'a'.repeat(FRONTMATTER_BYTE_CAP - 8)}\n---\n\n# T\n\nbefore`

    try {
      await write(root, 'near.md', before)
      await store.list()

      await expect(
        store.write({ originalId: 'near.md', title: 'T', content: 'after' }),
      ).rejects.toBeInstanceOf(FrontmatterLimitError)
      expect(await fs.readFile(join(root, 'near.md'), 'utf8')).toBe(before)
      expect((await store.read('near.md')).content).toBe('before')
    } finally {
      await store.stop()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('resolves createdAt for an ordinary create without inventing authored date metadata', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'nstore-proj-'))
    const store = createNotariumStore({ notesDir: root })

    try {
      const result = await store.write({ title: 'Fresh note', content: 'body' })
      const detail = await store.read(result.filePath!)
      const raw = await fs.readFile(join(root, result.filePath!), 'utf8')
      const keys = parseFrontmatterBlock(raw)!.entries.map((entry) => entry.key)

      expect(detail.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/)
      expect(detail.frontmatter).not.toHaveProperty('created')
      expect(detail.frontmatter).not.toHaveProperty('notarium-created')
      expect(keys).not.toContain('created')
      expect(keys).not.toContain('notarium-created')
    } finally {
      await store.stop()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('graph() still derives wikilink edges from bodies (meta+body projection)', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'nstore-proj-'))
    const store = createNotariumStore({ notesDir: root })

    try {
      await write(root, 'a.md', '# A\n\nlinks to [[B]]')
      await write(root, 'b.md', '# B\n\nplain')
      await store.changes(null)
      const graph = await store.graph()
      expect(graph.links.some((l) => l.source === 'a.md')).toBe(true)
    } finally {
      await store.stop()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
