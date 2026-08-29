import { describe, expect, it } from 'vitest'

import { diffStats, isDiffStatsWithinBudget } from './diffStats'

describe('diffStats budget', () => {
  it('uses the same inclusive character budget for the predicate and the diff', () => {
    expect(isDiffStatsWithinBudget(400_000, 600_000)).toBe(true)
    expect(isDiffStatsWithinBudget(400_000, 600_001)).toBe(false)
    expect(diffStats('a'.repeat(400_000), 'a'.repeat(600_000))).not.toBeNull()
    expect(diffStats('a'.repeat(400_000), 'a'.repeat(600_001))).toBeNull()
  })
})
