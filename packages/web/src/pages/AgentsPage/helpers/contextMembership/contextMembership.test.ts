import { describe, expect, it } from 'vitest'

import {
  buildContextMembershipIndex,
  contextMembershipHasAny,
  type ContextMembershipIndex,
  contextSetIdsForNotes,
} from './contextMembership'

describe('Context visible-tail membership index', () => {
  it('builds shared-note topology linearly and tests relevance without enumeration', () => {
    const sets = Array.from({ length: 40_000 }, (_, index) => ({
      id: `set-${index}`,
      items: [{ noteId: 'shared' }],
    }))
    const index = buildContextMembershipIndex(sets)

    expect(contextMembershipHasAny(index, ['shared'])).toBe(true)
    expect(contextSetIdsForNotes(index, ['shared'], new Set(['set-39999']))).toEqual(
      new Set(['set-39999']),
    )
  })

  it('returns every set for a shared note without duplicates', () => {
    const index = buildContextMembershipIndex([
      { id: 'a', items: [{ noteId: 'shared' }, { noteId: 'only-a' }] },
      { id: 'b', items: [{ noteId: 'shared' }] },
    ])

    expect(contextSetIdsForNotes(index, ['shared', 'shared'])).toEqual(new Set(['a', 'b']))
  })

  it('intersects a huge shared membership through the smaller cached-set side', () => {
    let membershipIterations = 0
    let membershipHasCalls = 0
    const memberships = {
      size: 600_001,
      has: (setId: string) => {
        membershipHasCalls += 1
        return setId === 'cached'
      },
      forEach: () => {
        membershipIterations += 1
      },
    } as unknown as ReadonlySet<string>
    const index = new Map([['shared', memberships]]) as ContextMembershipIndex

    expect(contextSetIdsForNotes(index, ['shared'], new Set(['cached']))).toEqual(
      new Set(['cached']),
    )
    expect(membershipHasCalls).toBe(1)
    expect(membershipIterations).toBe(0)
  })
})
