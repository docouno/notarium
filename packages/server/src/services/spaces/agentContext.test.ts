import { describe, expect, it } from 'vitest'

import { curatePersonalScope, curateProjectScope, type WeighedSet } from './agentContext'

// The scope-curation composition (#208/#209): one SINGLE budget over an ordered chain
// — local pins, then attached SET items, then memory — with the flat curateBudget
// loaded[] split back onto pins vs sets vs memory (and, in a project, project-first
// then embedded personal). curateBudget's flat primitive is unit-tested in core; THIS
// pins down the split/offset arithmetic, the muted exclusion, the pin→set→memory
// priority, and the cross-set/pin DEDUP the pult + start_session ride.

const pin = (noteId: string, tokens: number) => ({ noteId, title: noteId.toUpperCase(), tokens })
/** A LOOSE cross-space pin (#209): a pin carrying its home `space`, merged into the pin
 *  list by the callers alongside the same-space (space-less) tag pins. */
const crossPin = (noteId: string, tokens: number, space: string) => ({
  noteId,
  title: noteId.toUpperCase(),
  tokens,
  space,
})
const mem = (noteId: string, tokens: number, muted = false) => ({ noteId, tokens, muted })
const set = (id: string, ...items: Array<[string, number]>): WeighedSet => ({
  id,
  name: id,
  homeSpace: 'sp',
  items: items.map(([noteId, tokens]) => ({
    noteId,
    title: noteId.toUpperCase(),
    tokens,
    space: 'sp',
  })),
})

const BIG = 1_000_000 // a budget nothing can exhaust

describe('curatePersonalScope (#208/#209)', () => {
  it('loads everything under budget; muted memory is off the budget but still listed (loaded:false)', () => {
    const r = curatePersonalScope(
      [pin('p1', 10), pin('p2', 10)],
      [],
      [mem('m1', 5), mem('m2', 5, true), mem('m3', 5)],
      BIG,
    )
    expect(r.pins.map((p) => p.loaded)).toEqual([true, true])
    expect(r.memory.map((m) => [m.noteId, m.loaded])).toEqual([
      ['m1', true],
      ['m2', false],
      ['m3', true],
    ])
    // totalTokens counts only ACTIVE (non-muted) weight: pins 20 + active memory 10.
    expect(r.loadedTokens).toBe(30)
    expect(r.totalTokens).toBe(30)
  })

  it('pins load FIRST, then memory — the strict prefix trims memory once the budget is spent', () => {
    // pins 10+10 = 20 fit budget 22; the first memory (5) overflows → memory all trimmed.
    const r = curatePersonalScope(
      [pin('p1', 10), pin('p2', 10)],
      [],
      [mem('m1', 5), mem('m2', 5, true), mem('m3', 5)],
      22,
    )
    expect(r.pins.map((p) => p.loaded)).toEqual([true, true])
    expect(r.memory.map((m) => [m.noteId, m.loaded])).toEqual([
      ['m1', false],
      ['m2', false],
      ['m3', false],
    ])
    expect(r.loadedTokens).toBe(20)
    expect(r.totalTokens).toBe(30)
  })

  it('a pin that overflows trims itself and every later pin AND all memory (priority preserved)', () => {
    const r = curatePersonalScope(
      [pin('p1', 10), pin('p2', 10), pin('p3', 10)],
      [],
      [mem('m1', 1)],
      15,
    )
    expect(r.pins.map((p) => p.loaded)).toEqual([true, false, false])
    expect(r.memory.map((m) => m.loaded)).toEqual([false])
    expect(r.loadedTokens).toBe(10)
  })

  it('is a no-op on empty inputs', () => {
    expect(curatePersonalScope([], [], [], BIG)).toEqual({
      pins: [],
      sets: [],
      memory: [],
      loadedTokens: 0,
      totalTokens: 0,
    })
  })

  it('SET items load AFTER local pins, BEFORE memory (specific > general)', () => {
    // chain [p1:10, s.a:10, s.b:10, m1:10] against 25: 10+10=20 fit, +10=30 overflows → 2 loaded.
    const r = curatePersonalScope(
      [pin('p1', 10)],
      [set('front', ['a', 10], ['b', 10])],
      [mem('m1', 10)],
      25,
    )
    expect(r.pins.map((p) => p.loaded)).toEqual([true])
    expect(r.sets[0].items.map((item) => [item.noteId, item.loaded])).toEqual([
      ['a', true],
      ['b', false],
    ])
    expect(r.memory.map((m) => m.loaded)).toEqual([false])
    expect(r.loadedTokens).toBe(20)
  })

  it('DEDUP: a note pinned AND carried by a set loads once (as the pin), dropped from the set view', () => {
    const r = curatePersonalScope([pin('a', 10)], [set('front', ['a', 10], ['b', 10])], [], BIG)
    expect(r.pins.map((p) => p.noteId)).toEqual(['a'])
    // 'a' deduped out of the set; only 'b' survives there.
    expect(r.sets[0].items.map((item) => item.noteId)).toEqual(['b'])
    // total = pin a (10) + set b (10), NOT counted twice.
    expect(r.totalTokens).toBe(20)
    expect(r.loadedTokens).toBe(20)
  })

  it('DEDUP across two sets: the same note in set A and set B survives only in A (first wins)', () => {
    const r = curatePersonalScope([], [set('A', ['x', 5]), set('B', ['x', 5], ['y', 5])], [], BIG)
    expect(r.sets[0].items.map((item) => item.noteId)).toEqual(['x'])
    expect(r.sets[1].items.map((item) => item.noteId)).toEqual(['y'])
    expect(r.totalTokens).toBe(10) // x once + y
  })

  it('LOOSE cross-space pins ride the pin bucket and keep their `space` on the wire; a plain pin carries none', () => {
    const r = curatePersonalScope(
      [pin('local', 10), crossPin('far', 10, 'conventions')],
      [],
      [],
      BIG,
    )
    expect(r.pins.map((p) => p.noteId)).toEqual(['local', 'far'])
    expect(r.pins.find((p) => p.noteId === 'far')?.space).toBe('conventions')
    // A same-space (tag) pin stays space-less — the UI reads that as "no home chip".
    expect(r.pins.find((p) => p.noteId === 'local')?.space).toBeUndefined()
  })

  it('DEDUP: a note both TAG-pinned and CROSS-pinned (or in a set) loads once, first occurrence wins', () => {
    // Local tag pin 'a' precedes a cross-space pin 'a' and a set carrying 'a' → one load.
    const r = curatePersonalScope(
      [pin('a', 10), crossPin('a', 10, 'other')],
      [set('s', ['a', 10], ['b', 10])],
      [],
      BIG,
    )
    expect(r.pins.map((p) => p.noteId)).toEqual(['a']) // the tag pin wins (space-less)
    expect(r.pins[0].space).toBeUndefined()
    expect(r.sets[0].items.map((item) => item.noteId)).toEqual(['b'])
    expect(r.totalTokens).toBe(20) // a once + b
  })
})

describe('curateProjectScope (#208/#209)', () => {
  it('project pins load FIRST, then the personal background embeds fully into the remainder', () => {
    const r = curateProjectScope(
      [pin('j1', 10)],
      [],
      [pin('p1', 8), pin('p2', 8)],
      [],
      [mem('m1', 4), mem('m2', 4, true)],
      BIG,
    )
    expect(r.pins.map((p) => p.loaded)).toEqual([true])
    expect(r.projectLoadedTokens).toBe(10)
    expect(r.personal.pins.map((p) => p.loaded)).toEqual([true, true])
    expect(r.personal.memory.map((m) => [m.noteId, m.loaded])).toEqual([
      ['m1', true],
      ['m2', false],
    ])
    expect(r.personal.loadedTokens).toBe(20) // 8 + 8 + 4 active memory
    expect(r.loadedTokens).toBe(30)
    expect(r.totalTokens).toBe(30)
  })

  it('SQUEEZE: fat project pins take the front of Q → personal embeds only PARTIALLY (loaded:false on the tail)', () => {
    // chain [j1:10, p1:8, p2:8, m1:4] against 24: 10+8=18 fit, +8=26 overflows → loadedCount 2.
    const r = curateProjectScope(
      [pin('j1', 10)],
      [],
      [pin('p1', 8), pin('p2', 8)],
      [],
      [mem('m1', 4)],
      24,
    )
    expect(r.projectLoadedTokens).toBe(10)
    expect(r.personal.pins.map((p) => p.loaded)).toEqual([true, false]) // p1 fits, p2 trimmed
    expect(r.personal.memory.map((m) => m.loaded)).toEqual([false]) // memory beyond the break
    expect(r.personal.loadedTokens).toBe(8)
    expect(r.loadedTokens).toBe(18)
  })

  it('the flat loaded[] maps to the RIGHT segment — a personal pin gets its own verdict, not a shifted one', () => {
    // chain [j1:5, j2:5, p1:5, p2:5, m1:5] against 17: first three fit (15), p2 overflows.
    const r = curateProjectScope(
      [pin('j1', 5), pin('j2', 5)],
      [],
      [pin('p1', 5), pin('p2', 5)],
      [],
      [mem('m1', 5)],
      17,
    )
    expect(r.pins.map((p) => p.loaded)).toEqual([true, true]) // both project pins
    expect(r.personal.pins.map((p) => p.loaded)).toEqual([true, false]) // p1 (chain idx 2) loaded, p2 (idx 3) trimmed
    expect(r.personal.memory.map((m) => m.loaded)).toEqual([false]) // m1 (chain idx 4) trimmed
    expect(r.projectLoadedTokens).toBe(10)
    expect(r.personal.loadedTokens).toBe(5)
  })

  it('project-DOMINANT: the project pins alone spend Q → the personal background loads nothing', () => {
    const r = curateProjectScope([pin('j1', 14)], [], [pin('p1', 8)], [], [mem('m1', 4)], 15)
    expect(r.projectLoadedTokens).toBe(14)
    expect(r.personal.pins.map((p) => p.loaded)).toEqual([false])
    expect(r.personal.memory.map((m) => m.loaded)).toEqual([false])
    expect(r.personal.loadedTokens).toBe(0)
  })

  it('project SETS load after project pins, before personal; project set tokens count as project-loaded', () => {
    // chain [j1:5, projSet.a:5, p1:5, m1:5] against BIG — all load.
    const r = curateProjectScope(
      [pin('j1', 5)],
      [set('canon', ['a', 5])],
      [pin('p1', 5)],
      [],
      [mem('m1', 5)],
      BIG,
    )
    expect(r.sets[0].items.map((item) => [item.noteId, item.loaded])).toEqual([['a', true]])
    expect(r.projectLoadedTokens).toBe(10) // j1 (5) + project set a (5)
    expect(r.personal.loadedTokens).toBe(10) // p1 (5) + memory (5)
    expect(r.loadedTokens).toBe(20)
  })

  it('DEDUP: a note in a project pin AND a personal set loads once under the project (project wins)', () => {
    const r = curateProjectScope([pin('a', 5)], [], [], [set('mine', ['a', 5], ['b', 5])], [], BIG)
    expect(r.pins.map((p) => p.noteId)).toEqual(['a'])
    expect(r.personal.sets[0].items.map((item) => item.noteId)).toEqual(['b']) // 'a' deduped to the project pin
    expect(r.totalTokens).toBe(10) // a once + b
  })
})

describe('order overlay (#210)', () => {
  it('default (no overlay): pins keep insertion order, THEN sets — dense 0-based positions', () => {
    const r = curatePersonalScope([pin('p1', 5), pin('p2', 5)], [set('s', ['a', 5])], [], BIG)
    expect(r.pins.map((p) => [p.noteId, p.order])).toEqual([
      ['p1', 0],
      ['p2', 1],
    ])
    expect(r.sets[0].order).toBe(2)
  })

  it('a set dragged ABOVE a pin loads first and carries the lower position (pins & sets share one rank space)', () => {
    const r = curatePersonalScope([pin('p1', 5)], [set('s', ['a', 5])], [], BIG, [
      { kind: 'set', ref: 's' },
      { kind: 'pin', ref: 'p1' },
    ])
    expect(r.sets[0].order).toBe(0)
    expect(r.pins[0].order).toBe(1)
  })

  it('order = budget PRIORITY: dragging a pin to the top saves it from a squeeze that trims the default-first one', () => {
    // Two 10-token pins under budget 12 → only the FIRST in the sequence loads.
    const def = curatePersonalScope([pin('p1', 10), pin('p2', 10)], [], [], 12)
    expect(def.pins.map((p) => [p.noteId, p.loaded])).toEqual([
      ['p1', true],
      ['p2', false],
    ])
    // Drag p2 to the top → p2 now loads, p1 trims. The wire array comes out in the new order.
    const r = curatePersonalScope([pin('p1', 10), pin('p2', 10)], [], [], 12, [
      { kind: 'pin', ref: 'p2' },
      { kind: 'pin', ref: 'p1' },
    ])
    expect(r.pins.map((p) => [p.noteId, p.loaded, p.order])).toEqual([
      ['p2', true, 0],
      ['p1', false, 1],
    ])
  })

  it('an entry absent from the overlay sorts AFTER the ranked ones, in the default order (self-healing)', () => {
    // Only p2 is ranked (dragged to front); p1 + the set fall back to their default order behind it.
    const r = curatePersonalScope([pin('p1', 5), pin('p2', 5)], [set('s', ['a', 5])], [], BIG, [
      { kind: 'pin', ref: 'p2' },
    ])
    expect(r.pins.map((p) => [p.noteId, p.order])).toEqual([
      ['p2', 0],
      ['p1', 1],
    ])
    expect(r.sets[0].order).toBe(2)
  })

  it('set items carry their within-set index as `order` (a set is one draggable group)', () => {
    const r = curatePersonalScope([], [set('s', ['a', 5], ['b', 5], ['c', 5])], [], BIG)
    expect(r.sets[0].items.map((i) => [i.noteId, i.order])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ])
  })

  it('project & personal blocks are ordered INDEPENDENTLY (each its own overlay, each 0-based)', () => {
    const r = curateProjectScope(
      [pin('j1', 5), pin('j2', 5)],
      [],
      [pin('p1', 5), pin('p2', 5)],
      [],
      [],
      BIG,
      [
        { kind: 'pin', ref: 'j2' },
        { kind: 'pin', ref: 'j1' },
      ],
      [
        { kind: 'pin', ref: 'p2' },
        { kind: 'pin', ref: 'p1' },
      ],
    )
    expect(r.pins.map((p) => [p.noteId, p.order])).toEqual([
      ['j2', 0],
      ['j1', 1],
    ])
    expect(r.personal.pins.map((p) => [p.noteId, p.order])).toEqual([
      ['p2', 0],
      ['p1', 1],
    ])
  })
})
