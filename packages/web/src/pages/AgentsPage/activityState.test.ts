import { describe, expect, it } from 'vitest'

import { canonicalActivityParams, readActivityState } from './activityState'

describe('Activity URL state', () => {
  it('makes a hand-authored query visibly select Reads', () => {
    const canonical = canonicalActivityParams(new URLSearchParams('q=unbound+context'))

    expect(canonical.toString()).toBe('q=unbound+context&show=reads')
    expect(readActivityState(canonical)).toMatchObject({ show: 'reads', q: 'unbound context' })
  })

  it('removes an inapplicable query but preserves the independent Tool filter', () => {
    const canonical = canonicalActivityParams(
      new URLSearchParams('show=writes&tool=recall&q=unbound+context'),
    )

    expect(canonical.toString()).toBe('show=writes&tool=recall')
    expect(readActivityState(canonical)).toMatchObject({
      show: 'writes',
      tool: 'recall',
      q: null,
    })
  })

  it('canonicalizes Tool filtering to the flat stream instead of a lying session group', () => {
    const canonical = canonicalActivityParams(new URLSearchParams('group=session&tool=search'))

    expect(canonical.toString()).toBe('tool=search')
    expect(readActivityState(canonical)).toMatchObject({ group: 'none', tool: 'search' })
  })
})
