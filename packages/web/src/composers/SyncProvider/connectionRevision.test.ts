import { describe, expect, it } from 'vitest'

import { advanceConnectionRevisions, advanceObservationEpoch } from './connectionRevision'

describe('SSE connection revision', () => {
  it('advances on every successful transport connection', () => {
    const first = advanceConnectionRevisions({ connectionRevision: 0, observationEpoch: 0 })
    const reconnect = advanceConnectionRevisions(first)

    expect(first).toEqual({ connectionRevision: 1, observationEpoch: 1 })
    expect(reconnect).toEqual({ connectionRevision: 2, observationEpoch: 2 })
  })

  it('advances the request epoch before a changed frame reaches consumers', () => {
    expect(advanceObservationEpoch(7)).toBe(8)
  })
})
