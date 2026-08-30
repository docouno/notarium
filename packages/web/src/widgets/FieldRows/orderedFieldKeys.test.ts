import { describe, expect, it } from 'vitest'

import { orderedFieldKeys } from './orderedFieldKeys'

describe('orderedFieldKeys', () => {
  it('deduplicates a cap-sized detail without a quadratic UI stall', () => {
    const keys = Array.from({ length: 6500 }, (_, index) => `k${index}`)
    const started = performance.now()
    const result = orderedFieldKeys(keys, new Set(keys))
    const elapsed = performance.now() - started

    expect(result).toEqual(keys)
    expect(elapsed).toBeLessThan(150)
  })
})
