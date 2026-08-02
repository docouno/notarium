import { describe, expect, it } from 'vitest'

import {
  dedupeAliases,
  nextAliases,
  nextAliasesMulti,
  nextPathAliases,
  nextPathAliasesMulti,
  normAliases,
} from './aliases'

describe('normAliases', () => {
  it('accepts a YAML list and a comma string; drops blanks; else undefined', () => {
    expect(normAliases(['Old Name', ' Other '])).toEqual(['Old Name', 'Other'])
    expect(normAliases('A, B ,, C')).toEqual(['A', 'B', 'C'])
    expect(normAliases(undefined)).toBeUndefined()
    expect(normAliases(42)).toBeUndefined()
  })
})

describe('dedupeAliases', () => {
  it('dedups by slug (keeps first raw form) and drops empties', () => {
    // 'Foo Bar' and 'foo-bar' slug the same — first raw kept.
    expect(dedupeAliases(['Foo Bar', 'foo-bar', '  ', 'Baz'])).toEqual(['Foo Bar', 'Baz'])
    // camelCase splits like core slugify, so these collide too.
    expect(dedupeAliases(['BookStack', 'Book Stack'])).toEqual(['BookStack'])
  })
})

describe('nextAliases', () => {
  it('adds the old name and never keeps the current name (idempotent A→B→A)', () => {
    // A → B: 'A' joins the history.
    expect(nextAliases([], 'A', 'B')).toEqual(['A'])
    // B → A: 'B' joins, the now-current 'A' is dropped from the history.
    expect(nextAliases(['A'], 'B', 'A')).toEqual(['B'])
  })

  it('accumulates distinct past names, deduped by slug', () => {
    expect(nextAliases(['Королёв'], 'Гагарин', 'Терешкова')).toEqual(['Королёв', 'Гагарин'])
    // re-adding a name already present (by slug) is a no-op
    expect(nextAliases(['Old'], 'old', 'New')).toEqual(['Old'])
  })

  it('a rename whose slug is unchanged adds nothing (the current name is filtered)', () => {
    // 'Foo ' and 'Foo' slug identically → the old name IS the current name.
    expect(nextAliases([], 'Foo', 'Foo ')).toEqual([])
  })
})

describe('nextAliasesMulti (#100 — title + slug)', () => {
  it('retires every old name no longer current; drops still-current ones', () => {
    // title A→B AND slug s→t: both old forms retire.
    expect(nextAliasesMulti([], ['A', 's'], ['B', 't'])).toEqual(['A', 's'])
    // title unchanged (T), slug s→t: only the old slug retires; T stays current.
    expect(nextAliasesMulti([], ['T', 's'], ['T', 't'])).toEqual(['s'])
  })

  it('dedups by slug, keeping the first raw form (a title beats its own slug-form)', () => {
    // old names ['Old Title', 'old-title'] slug the same → keep the readable raw.
    expect(nextAliasesMulti([], ['Old Title', 'old-title'], ['New', 'new'])).toEqual(['Old Title'])
  })

  it('nextAliases is the single-name special case', () => {
    expect(nextAliasesMulti(['A'], ['B'], ['A'])).toEqual(nextAliases(['A'], 'B', 'A'))
  })
})

describe('nextPathAliases (#100 — folder paths, dedup by slugifyPath)', () => {
  it('adds the old path and never keeps the current one (idempotent A→B→A)', () => {
    expect(nextPathAliases([], 'a', 'b')).toEqual(['a'])
    expect(nextPathAliases(['a'], 'b', 'a')).toEqual(['b']) // back to 'a' drops it from history
  })

  it('preserves the structural `/` — multi-segment paths do NOT collapse like slugify', () => {
    // 'a/b' and 'ab' are DISTINCT paths (slugify would conflate them; slugifyPath doesn't).
    expect(nextPathAliases(['a/b'], 'ab', 'c')).toEqual(['a/b', 'ab'])
    // re-adding the same path (by slugifyPath) is a no-op.
    expect(nextPathAliases(['old/dir'], 'old/dir', 'new/dir')).toEqual(['old/dir'])
  })

  it('multi heals a displaced path: marker ∪ row history, dropping the now-current path', () => {
    // boot reconcile: marker carries ['p1'], row had ['p0'], the row's old path 'p2'
    // was externally displaced to current 'p3' → all old paths retire, p3 stays out.
    expect(nextPathAliasesMulti(['p1', 'p0'], ['p2'], ['p3'])).toEqual(['p1', 'p0', 'p2'])
  })
})
