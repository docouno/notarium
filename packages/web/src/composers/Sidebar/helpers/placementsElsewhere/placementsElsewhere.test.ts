import { describe, expect, it } from 'vitest'
import { hasPlacementsElsewhere } from './placementsElsewhere'

const spaces = [{ id: 'space-1' }, { id: 'space-2' }, { id: 'personal' }]

describe('placements outside the scoped tree', () => {
  it('offers the way out when the user belongs to another Space', () => {
    expect(
      hasPlacementsElsewhere({
        truncated: false,
        activeSpaceId: 'space-1',
        personalSpaceId: 'personal',
        spaces,
      }),
    ).toBe(true)
  })

  it('stays silent when the active Space and Personal are all there is', () => {
    expect(
      hasPlacementsElsewhere({
        truncated: false,
        activeSpaceId: 'space-1',
        personalSpaceId: 'personal',
        spaces: [{ id: 'space-1' }, { id: 'personal' }],
      }),
    ).toBe(false)
  })

  it('still answers yes when the server truncated its scan', () => {
    expect(
      hasPlacementsElsewhere({
        truncated: true,
        activeSpaceId: 'space-1',
        personalSpaceId: 'personal',
        spaces: [{ id: 'space-1' }],
      }),
    ).toBe(true)
  })

  it('says nothing is elsewhere while the scope is unresolved', () => {
    expect(
      hasPlacementsElsewhere({
        truncated: false,
        activeSpaceId: null,
        personalSpaceId: 'personal',
        spaces,
      }),
    ).toBe(false)
  })
})
