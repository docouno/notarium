import { describe, expect, it } from 'vitest'

import { canonicalActivityParams, readActivityState } from './activityState'

describe('Activity URL state', () => {
  it('makes a hand-authored query visibly select Reads', () => {
    const canonical = canonicalActivityParams(new URLSearchParams('q=unbound+context'))

    expect(canonical.toString()).toBe('q=unbound+context&show=reads')
    expect(readActivityState(canonical)).toMatchObject({ show: 'reads', q: 'unbound context' })
  })

  it('removes an inapplicable query instead of resurrecting it after Writes', () => {
    const canonical = canonicalActivityParams(
      new URLSearchParams('show=writes&tool=recall&q=unbound+context'),
    )

    expect(canonical.toString()).toBe('show=writes')
    expect(readActivityState(canonical)).toMatchObject({ show: 'writes', tool: null, q: null })
  })
})
