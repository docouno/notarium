import { describe, expect, it } from 'vitest'

import type { NoteMeta } from '../knowledgeStore'
import {
  bucketCounts,
  bucketKeyOf,
  queryNotes,
  tagFacet,
  treeChildren,
  treeSummary,
} from './listing'

const note = (filePath: string, over: Partial<NoteMeta> = {}): NoteMeta => ({
  title: filePath.split('/').pop()!.replace(/\.md$/, ''),
  filePath,
  modifiedAt: '2026-06-01T00:00:00.000Z',
  createdAt: '2026-06-01T10:00:00Z',
  ...over,
})

const NOW = Date.parse('2026-06-10T00:00:00Z')

const BASE: NoteMeta[] = [
  note('root.md', {
    id: 'n-root',
    modifiedAt: '2026-06-09T00:00:00.000Z',
    createdAt: '2026-06-08T08:00:00Z',
  }),
  note('demo/a.md', {
    id: 'n-a',
    modifiedAt: '2026-06-07T00:00:00.000Z',
    createdAt: '2026-06-02T10:00:00Z',
  }),
  note('demo/b.md', {
    id: 'n-b',
    modifiedAt: '2026-06-08T00:00:00.000Z',
    createdAt: '2026-06-03T10:00:00Z',
  }),
  note('demo/sub/c.md', { id: 'n-c', modifiedAt: '2026-05-01T00:00:00.000Z', createdAt: null }),
  note('archive/2020/old.md', {
    id: 'n-old',
    modifiedAt: '2020-01-15T00:00:00.000Z',
    createdAt: null,
  }),
]

const q = (over: object) => ({
  sort: 'modified' as const,
  offset: 0,
  depth: 'subtree' as const,
  ...over,
})

describe('queryNotes', () => {
  it('modified sort: newest first, total = population, slice respects offset+limit', () => {
    const r = queryNotes(BASE, q({ offset: 1, limit: 2 }))
    expect(r.total).toBe(5)
    expect(r.notes.map((n) => n.filePath)).toEqual(['demo/b.md', 'demo/a.md'])
  })
  it('created sort hides undated notes — they are not in total either', () => {
    const r = queryNotes(BASE, q({ sort: 'created' }))
    expect(r.total).toBe(3)
    expect(r.notes.map((n) => n.filePath)).toEqual(['root.md', 'demo/b.md', 'demo/a.md'])
  })
  it('title sort is A→Z and stable', () => {
    const r = queryNotes(BASE, q({ sort: 'title', folder: 'demo', depth: 'direct' }))
    expect(r.notes.map((n) => n.title)).toEqual(['a', 'b'])
  })
  it('folder subtree scope includes nested folders; direct does not', () => {
    expect(queryNotes(BASE, q({ folder: 'demo' })).total).toBe(3)
    expect(queryNotes(BASE, q({ folder: 'demo', depth: 'direct' })).total).toBe(2)
  })
  it("folder '' direct = the root level; '' subtree = the whole base", () => {
    expect(queryNotes(BASE, q({ folder: '', depth: 'direct' })).total).toBe(1)
    expect(queryNotes(BASE, q({ folder: '' })).total).toBe(5)
  })
  it('no limit returns the full filtered tail from offset', () => {
    const r = queryNotes(BASE, q({ offset: 3 }))
    expect(r.notes).toHaveLength(2)
    expect(r.total).toBe(5)
  })
  it('an offset past the population yields an empty page with the true total', () => {
    const r = queryNotes(BASE, q({ offset: 99, limit: 10 }))
    expect(r.notes).toEqual([])
    expect(r.total).toBe(5)
  })
  it('folders keeps a subtree (prefix-cascade), dropping the rest (#109 inclusion)', () => {
    const r = queryNotes(BASE, q({ folders: ['demo'] }))
    expect(r.total).toBe(3) // demo/a, demo/b, demo/sub/c
    expect(r.notes.map((n) => n.filePath).sort()).toEqual([
      'demo/a.md',
      'demo/b.md',
      'demo/sub/c.md',
    ])
  })
  it('selecting a child keeps only its subtree (a leaf, not the parent)', () => {
    expect(queryNotes(BASE, q({ folders: ['demo/sub'] })).total).toBe(1) // demo/sub/c only
  })
  it('multiple folders are OR/union (the "add widens" model)', () => {
    // demo/sub (c) ∪ archive (old) → 2; root.md stays out (under neither).
    const r = queryNotes(BASE, q({ folders: ['demo/sub', 'archive'] }))
    expect(r.notes.map((n) => n.filePath).sort()).toEqual(['archive/2020/old.md', 'demo/sub/c.md'])
  })
  it('folders composes with a folder scope (narrow within the scope)', () => {
    expect(queryNotes(BASE, q({ folder: 'demo' })).total).toBe(3)
    expect(queryNotes(BASE, q({ folder: 'demo', folders: ['demo/sub'] })).total).toBe(1)
  })
  it('an empty folders set is a no-op (everything shown)', () => {
    expect(queryNotes(BASE, q({ folders: [] })).total).toBe(5)
  })
  it('date range filters inclusive local days before slice and total (#201)', () => {
    const r = queryNotes(BASE, q({ sort: 'created', from: '2026-06-02', to: '2026-06-03', tz: 0 }))
    expect(r.total).toBe(2)
    expect(r.notes.map((n) => n.filePath)).toEqual(['demo/b.md', 'demo/a.md'])
  })
  it('date range excludes notes whose selected date axis is unknown (#201)', () => {
    const r = queryNotes(
      BASE,
      q({ sort: 'modified', from: '2020-01-01', to: '2026-12-31', dateField: 'created', tz: 0 }),
    )
    expect(r.notes.map((n) => n.filePath)).not.toContain('demo/sub/c.md')
    expect(r.notes.map((n) => n.filePath)).not.toContain('archive/2020/old.md')
    expect(r.total).toBe(3)
  })
  it('dateField can filter by created while sorting by modified (#201)', () => {
    const r = queryNotes(
      BASE,
      q({ sort: 'modified', from: '2026-06-02', to: '2026-06-03', dateField: 'created', tz: 0 }),
    )
    expect(r.notes.map((n) => n.filePath)).toEqual(['demo/b.md', 'demo/a.md'])
  })
  it('date range uses the client timezone for local-day bounds (#201)', () => {
    const late = [note('late.md', { modifiedAt: '2026-06-01T23:30:00.000Z' })]
    expect(
      queryNotes(late, q({ sort: 'modified', from: '2026-06-02', to: '2026-06-02', tz: 180 }))
        .total,
    ).toBe(1)
    expect(
      queryNotes(late, q({ sort: 'modified', from: '2026-06-02', to: '2026-06-02', tz: 0 })).total,
    ).toBe(0)
  })
  it('ids keeps only a stable-id membership set and composes with folders', () => {
    const r = queryNotes(BASE, q({ folders: ['demo'], ids: ['n-root', 'n-b', 'n-c'] }))
    expect(r.total).toBe(2)
    expect(r.notes.map((n) => n.id)).toEqual(['n-b', 'n-c'])
  })
})

describe('treeSummary', () => {
  it('every folder (incl. intermediate ancestors) appears with subtree + direct counts', () => {
    const t = treeSummary(BASE, [], NOW)
    const byPath = Object.fromEntries(t.folders.map((f) => [f.path, f]))
    expect(byPath['demo']).toMatchObject({ name: 'demo', count: 3, direct: 2 })
    expect(byPath['demo/sub']).toMatchObject({ name: 'sub', count: 1, direct: 1 })
    expect(byPath['archive']).toMatchObject({ count: 1, direct: 0 })
    expect(byPath['archive/2020']).toMatchObject({ count: 1, direct: 1 })
  })
  it('stats: total, root-level population, created-this-week (undated never counts)', () => {
    const t = treeSummary(BASE, [], NOW)
    expect(t.stats.total).toBe(5)
    expect(t.stats.root).toBe(1)
    expect(t.stats.week).toBe(2) // root.md (June 8) and demo/b.md (June 3 10:00) fall inside June 3–10
  })
  it('folders come sorted by path for a deterministic wire shape', () => {
    const t = treeSummary(BASE, [], NOW)
    expect(t.folders.map((f) => f.path)).toEqual(['archive', 'archive/2020', 'demo', 'demo/sub'])
  })
  it('directory channel (#97): an empty folder + its ancestors appear with count 0', () => {
    const t = treeSummary(BASE, ['ideas', 'projects/q1/empty'], NOW)
    const byPath = Object.fromEntries(t.folders.map((f) => [f.path, f]))
    expect(byPath['ideas']).toMatchObject({ name: 'ideas', count: 0, direct: 0 })
    expect(byPath['projects']).toMatchObject({ count: 0, direct: 0 })
    expect(byPath['projects/q1']).toMatchObject({ count: 0, direct: 0 })
    expect(byPath['projects/q1/empty']).toMatchObject({ name: 'empty', count: 0, direct: 0 })
  })
  it('directory channel never clobbers a note-backed folder count', () => {
    // `demo` is note-backed (count 3); passing it as a dir must not zero it.
    const t = treeSummary(BASE, ['demo'], NOW)
    const demo = t.folders.find((f) => f.path === 'demo')!
    expect(demo).toMatchObject({ count: 3, direct: 2 })
  })
})

describe('treeChildren (#64)', () => {
  const tq = (over: object = {}) => ({ path: '', offset: 0, ...over })
  it('root step: direct subfolders with counts + direct notes, title-ordered', () => {
    const r = treeChildren(BASE, [], tq())
    expect(r.folders.map((f) => f.path)).toEqual(['archive', 'demo'])
    expect(r.folders[1]).toMatchObject({ name: 'demo', count: 3, direct: 2 })
    expect(r.folders[0]).toMatchObject({ name: 'archive', count: 1, direct: 0 })
    expect(r.notes.map((n) => n.filePath)).toEqual(['root.md'])
    expect(r.total).toBe(1)
  })
  it('nested step: only the next level of folders, only direct notes', () => {
    const r = treeChildren(BASE, [], tq({ path: 'demo' }))
    expect(r.folders).toEqual([{ path: 'demo/sub', name: 'sub', count: 1, direct: 1 }])
    expect(r.notes.map((n) => n.title)).toEqual(['a', 'b'])
    expect(r.total).toBe(2)
  })
  it('directory channel (#97): an empty child folder shows under its parent', () => {
    // `demo` has note-backed child `demo/sub`; an empty `demo/fresh` joins it.
    const r = treeChildren(BASE, ['demo/fresh'], tq({ path: 'demo' }))
    const byPath = Object.fromEntries(r.folders.map((f) => [f.path, f]))
    expect(byPath['demo/sub']).toMatchObject({ count: 1, direct: 1 })
    expect(byPath['demo/fresh']).toMatchObject({ name: 'fresh', count: 0, direct: 0 })
  })
  it('carries folder identities like the tree skeleton, so lazy rows can link durably', () => {
    const r = treeChildren(BASE, ['demo/fresh'], tq({ path: 'demo' }), [
      { id: 'fid-sub', path: 'demo/sub', pathAliases: [] },
      { id: 'fid-fresh', path: 'demo/fresh', pathAliases: ['demo/old-fresh'] },
    ])
    const byPath = Object.fromEntries(r.folders.map((f) => [f.path, f]))
    expect(byPath['demo/sub']).toMatchObject({ id: 'fid-sub' })
    expect(byPath['demo/fresh']).toMatchObject({ id: 'fid-fresh', aliases: ['demo/old-fresh'] })
  })
  it('offset/limit window the notes; total stays the full direct population', () => {
    const r = treeChildren(BASE, [], tq({ path: 'demo', offset: 1, limit: 1 }))
    expect(r.notes.map((n) => n.title)).toEqual(['b'])
    expect(r.total).toBe(2)
    expect(r.folders).toHaveLength(1) // subfolders are never windowed
  })
})

describe('bucketKeyOf (#64)', () => {
  it('date-only strings ARE the local date — no tz shifting', () => {
    expect(bucketKeyOf('2026-06-09', 'day', 180)).toBe('2026-06-09')
    expect(bucketKeyOf('2026-06-09', 'day', -300)).toBe('2026-06-09')
  })
  it('ISO instants shift into the client tz before taking the date', () => {
    // 23:30 UTC = 02:30 next day at UTC+3
    expect(bucketKeyOf('2026-06-08T23:30:00Z', 'day', 180)).toBe('2026-06-09')
    expect(bucketKeyOf('2026-06-08T23:30:00Z', 'day', 0)).toBe('2026-06-08')
  })
  it('week buckets key by the Monday, month buckets by the 1st', () => {
    expect(bucketKeyOf('2026-06-09', 'week', 0)).toBe('2026-06-08') // Tue → Mon
    expect(bucketKeyOf('2026-06-08', 'week', 0)).toBe('2026-06-08') // Mon stays
    expect(bucketKeyOf('2026-06-09', 'month', 0)).toBe('2026-06-01')
  })
  it("no usable date → '' (the undated bucket)", () => {
    expect(bucketKeyOf(null, 'day', 0)).toBe('')
    expect(bucketKeyOf('garbage', 'day', 0)).toBe('')
    expect(bucketKeyOf('2026-13-01', 'day', 0)).toBe('')
    expect(bucketKeyOf('2026-02-30', 'day', 0)).toBe('')
  })
})

describe('bucketCounts (#64)', () => {
  const bq = (over: object = {}) => ({
    sort: 'modified' as const,
    group: 'day' as const,
    depth: 'subtree' as const,
    tz: 0,
    ...over,
  })
  it('counts sum to the same total the matching notes query reports', () => {
    const b = bucketCounts(BASE, bq())
    expect(b.total).toBe(queryNotes(BASE, q({})).total)
    expect(b.buckets.reduce((acc, x) => acc + x.count, 0)).toBe(b.total)
  })
  it('buckets are consecutive runs in list order (newest first)', () => {
    const b = bucketCounts(BASE, bq())
    expect(b.buckets.map((x) => x.key)).toEqual([
      '2026-06-09',
      '2026-06-08',
      '2026-06-07',
      '2026-05-01',
      '2020-01-15',
    ])
    expect(b.buckets.every((x) => x.count === 1)).toBe(true)
  })
  it('created sort mirrors the window: undated notes are excluded, no "" bucket', () => {
    const b = bucketCounts(BASE, bq({ sort: 'created' }))
    expect(b.total).toBe(3)
    expect(b.buckets.some((x) => x.key === '')).toBe(false)
  })
  it('month granularity + folder scope collapse runs', () => {
    const b = bucketCounts(BASE, bq({ group: 'month', folder: 'demo' }))
    expect(b.buckets).toEqual([
      { key: '2026-06-01', count: 2 },
      { key: '2026-05-01', count: 1 },
    ])
    expect(b.total).toBe(3)
  })
  it('folders keeps the histogram total in lockstep with the notes window', () => {
    const f = { folders: ['demo'] }
    const b = bucketCounts(BASE, bq(f))
    expect(b.total).toBe(queryNotes(BASE, q(f)).total) // == 3, the invariant
    expect(b.buckets.reduce((acc, x) => acc + x.count, 0)).toBe(b.total)
  })
  it('date range keeps the histogram total in lockstep with the notes window (#201)', () => {
    const f = { sort: 'created' as const, from: '2026-06-02', to: '2026-06-03', tz: 0 }
    const b = bucketCounts(BASE, bq(f))
    expect(b.total).toBe(queryNotes(BASE, q(f)).total)
    expect(b.buckets).toEqual([
      { key: '2026-06-03', count: 1 },
      { key: '2026-06-02', count: 1 },
    ])
  })
  it('dateField filters by created while buckets still group by modified sort axis (#201)', () => {
    const f = {
      sort: 'modified' as const,
      dateField: 'created' as const,
      from: '2026-06-02',
      to: '2026-06-03',
      tz: 0,
    }
    const b = bucketCounts(BASE, bq(f))
    expect(b.total).toBe(queryNotes(BASE, q(f)).total)
    expect(b.buckets).toEqual([
      { key: '2026-06-08', count: 1 },
      { key: '2026-06-07', count: 1 },
    ])
  })
})

// ── tag axis ──────────────────────────────────────────────────────────

const TAGGED: NoteMeta[] = [
  note('a.md', { tags: ['ML'] }),
  note('b.md', { tags: ['ml/nlp'] }),
  note('c.md', { tags: ['ML/NLP/bert', 'design'] }),
  note('d.md', { tags: ['Design'] }),
  note('e.md', {}), // untagged
]

describe('queryNotes — tag filter (#109)', () => {
  it('matches case-insensitively', () => {
    expect(queryNotes(TAGGED, q({ tags: ['ml'] })).notes.map((n) => n.filePath)).toEqual([
      'a.md',
      'b.md',
      'c.md',
    ])
    // an upper-case query folds to the same population
    expect(queryNotes(TAGGED, q({ tags: ['DESIGN'] })).total).toBe(2)
  })
  it('a parent tag pulls its whole subtree (hierarchical cascade)', () => {
    // `ml` catches ml, ml/nlp, ml/nlp/bert; a leaf query is narrower
    expect(queryNotes(TAGGED, q({ tags: ['ml/nlp'] })).total).toBe(2) // b, c
  })
  it('multiple tags are OR (union — the "add to filter widens" model)', () => {
    // ml → a,b,c (subtree); design → c,d; union keeps c once.
    expect(queryNotes(TAGGED, q({ tags: ['ml', 'design'] })).notes.map((n) => n.filePath)).toEqual([
      'a.md',
      'b.md',
      'c.md',
      'd.md',
    ])
  })
  it('the tag filter narrows total + window (composes with the slice)', () => {
    const r = queryNotes(TAGGED, q({ tags: ['ml'], offset: 1, limit: 1 }))
    expect(r.total).toBe(3)
    expect(r.notes).toHaveLength(1)
  })
})

describe('tagFacet (#109 the tag tree)', () => {
  it('builds a folder-like tree: parents carry subtree counts, leaves direct counts', () => {
    const f = tagFacet(TAGGED)
    const by = new Map(f.tags.map((t) => [t.tag, t]))
    // `ml` is a parent of nobody-exactly-ml? a.md is exactly `ml`; b,c are descendants.
    expect(by.get('ml')).toMatchObject({ count: 3, direct: 1 }) // subtree a/b/c; direct only a
    expect(by.get('ml/nlp')).toMatchObject({ count: 2, direct: 1 }) // b, c subtree; b direct
    expect(by.get('ml/nlp/bert')).toMatchObject({ count: 1, direct: 1 })
    // `design` folds Design + design into one node
    expect(by.get('design')).toMatchObject({ count: 2, direct: 2 })
    // total distinct facet nodes: ml, ml/nlp, ml/nlp/bert, design
    expect(f.total).toBe(4)
  })
  it('keeps the AUTHOR casing as the display label (first-seen)', () => {
    const f = tagFacet(TAGGED)
    const by = new Map(f.tags.map((t) => [t.tag, t]))
    expect(by.get('ml')!.label).toBe('ML') // a.md's `ML` seen first
    expect(by.get('design')!.label).toBe('design') // c.md's `design` before d.md's `Design`
  })
  it('a note carrying both an ancestor and its descendant counts ONCE for the ancestor', () => {
    const f = tagFacet([note('x.md', { tags: ['ml', 'ml/nlp'] })])
    const by = new Map(f.tags.map((t) => [t.tag, t]))
    expect(by.get('ml')).toMatchObject({ count: 1, direct: 1 })
    expect(by.get('ml/nlp')).toMatchObject({ count: 1, direct: 1 })
  })
  it('is sorted most-used first; `limit` takes the top-N but `total` stays honest', () => {
    const f = tagFacet(TAGGED, { limit: 1 })
    expect(f.tags).toHaveLength(1)
    expect(f.tags[0].tag).toBe('ml') // count 3, the most used
    expect(f.total).toBe(4)
  })
  it('`q` substring-filters the folded path', () => {
    const f = tagFacet(TAGGED, { q: 'nlp' })
    expect(f.tags.map((t) => t.tag).sort()).toEqual(['ml/nlp', 'ml/nlp/bert'])
  })
})

describe('folder pages (#212): index.md is the cover, hidden from the tree', () => {
  const withPage: NoteMeta[] = [
    note('demo/a.md'),
    note('demo/b.md'),
    note('demo/index.md', { id: 'idx-demo' }),
  ]

  it('treeSummary excludes the page from counts + total and marks its folder pageNoteId', () => {
    const t = treeSummary(withPage, [], NOW)
    const demo = t.folders.find((f) => f.path === 'demo')!
    expect(demo.direct).toBe(2) // a, b — NOT index.md
    expect(demo.count).toBe(2)
    expect(demo.pageNoteId).toBe('idx-demo')
    expect(t.stats.total).toBe(2) // covers are not counted as notes
  })

  it('treeChildren never lists the page among a folder’s direct notes', () => {
    const c = treeChildren(withPage, [], { path: 'demo', offset: 0 })
    expect(c.notes.map((n) => n.filePath)).toEqual(['demo/a.md', 'demo/b.md'])
    expect(c.total).toBe(2)
  })

  it('a page-only folder still surfaces (with its pageNoteId), counts 0', () => {
    const t = treeSummary([note('solo/index.md', { id: 'idx-solo' })], [], NOW)
    const solo = t.folders.find((f) => f.path === 'solo')
    expect(solo).toBeTruthy()
    expect(solo!.direct).toBe(0)
    expect(solo!.pageNoteId).toBe('idx-solo')
  })
})
