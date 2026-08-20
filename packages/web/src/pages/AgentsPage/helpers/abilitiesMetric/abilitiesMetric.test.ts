import { describe, expect, it } from 'vitest'
import { abilitiesMetric } from './abilitiesMetric'

describe('the Abilities pill’s identity line', () => {
  // The counts come from the listing scoped to the active Space; the library under
  // the pill is owner-wide. Unqualified, "2 roles" reads as a count of the seven
  // cards below it.
  it('names the scope the counts were taken in', () => {
    expect(abilitiesMetric({ count: 2, activeRole: null, truncated: false }, null)).toBe(
      '2 roles · in this Space',
    )
    expect(
      abilitiesMetric(
        { count: 2, activeRole: 'writer', truncated: false },
        {
          count: 3,
          truncated: false,
        },
      ),
    ).toBe('2 roles · writer active · 3 skills · in this Space')
  })

  it('keeps the counts themselves as they read today', () => {
    expect(abilitiesMetric({ count: 1, activeRole: null, truncated: false }, null)).toContain(
      '1 role',
    )
    expect(abilitiesMetric({ count: 0, activeRole: null, truncated: false }, null)).toContain(
      '0 roles added',
    )
    expect(abilitiesMetric({ count: 4, activeRole: null, truncated: true }, null)).toContain(
      '4+ roles',
    )
    expect(abilitiesMetric({ count: 0, activeRole: null, truncated: true }, null)).toContain(
      'partial role count',
    )
    expect(abilitiesMetric(null, { count: 1, truncated: true })).toContain('1+ skill')
  })

  it('says nothing at all before either listing has answered', () => {
    expect(abilitiesMetric(null, null)).toBeUndefined()
  })
})
