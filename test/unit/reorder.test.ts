import { describe, expect, it } from 'vitest'
import { reorderKeys } from '../../packages/web/src/libs/dnd/reorder'

// reorderKeys is the pure index math behind the context list's DnD reorder (#210): move a
// dragged key to sit before/after a target key. The canonical use lives in ContextPage
// (pins + sets sharing one order); here the tricky splice arithmetic is pinned down.

describe('reorderKeys (#210)', () => {
  const keys = ['a', 'b', 'c', 'd']

  it('moves a key DOWN to after a later target', () => {
    expect(reorderKeys(keys, 'a', 'c', true)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('moves a key DOWN to before a later target', () => {
    expect(reorderKeys(keys, 'a', 'c', false)).toEqual(['b', 'a', 'c', 'd'])
  })

  it('moves a key UP to before an earlier target', () => {
    expect(reorderKeys(keys, 'd', 'b', false)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('moves a key UP to after an earlier target', () => {
    expect(reorderKeys(keys, 'd', 'b', true)).toEqual(['a', 'b', 'd', 'c'])
  })

  it('dropping onto itself is a no-op (returns a copy)', () => {
    expect(reorderKeys(keys, 'b', 'b', false)).toEqual(keys)
    expect(reorderKeys(keys, 'b', 'b', true)).toEqual(keys)
  })

  it('to the very front / very back', () => {
    expect(reorderKeys(keys, 'c', 'a', false)).toEqual(['c', 'a', 'b', 'd'])
    expect(reorderKeys(keys, 'a', 'd', true)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('an unknown target leaves the order unchanged', () => {
    expect(reorderKeys(keys, 'a', 'zz', false)).toEqual(keys)
  })

  it('never duplicates or drops a key (permutation invariant)', () => {
    const out = reorderKeys(keys, 'b', 'd', true)
    expect([...out].sort()).toEqual([...keys].sort())
    expect(out).toHaveLength(keys.length)
  })
})
