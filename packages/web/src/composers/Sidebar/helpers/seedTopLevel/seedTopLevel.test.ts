import { describe, expect, it } from 'vitest'

import { seedTopLevel } from './seedTopLevel'

describe('seedTopLevel', () => {
  it('opens the top level on a cold first load', () => {
    expect([...seedTopLevel(new Set(), ['demo', 'archive'])]).toEqual(['demo', 'archive'])
  })

  it('keeps a chain opened before the skeleton landed', () => {
    // The seed must add roots without replacing a chain already opened by reveal.
    const revealed = new Set(['archive', 'archive/2020', 'archive/2020/deep'])

    expect([...seedTopLevel(revealed, ['demo', 'archive'])]).toEqual([
      'archive',
      'archive/2020',
      'archive/2020/deep',
      'demo',
    ])
  })

  it('returns the SAME set when every top-level path is already open', () => {
    // Identity is load-bearing: `openSet` is a dependency of the lazy-listing
    // effect, so a fresh set with equal contents would re-run it for nothing.
    const prev = new Set(['demo', 'archive'])

    expect(seedTopLevel(prev, ['demo', 'archive'])).toBe(prev)
    expect(seedTopLevel(prev, [])).toBe(prev)
  })

  it('never mutates the set it was given', () => {
    const prev = new Set(['demo'])
    seedTopLevel(prev, ['archive'])

    expect([...prev]).toEqual(['demo'])
  })
})
