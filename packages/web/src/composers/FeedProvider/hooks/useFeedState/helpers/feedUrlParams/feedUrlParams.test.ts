import { describe, expect, it } from 'vitest'

import { clearFieldParam, clearFiltersParam, toggleFieldParam } from './feedUrlParams'

describe('field feed URL params', () => {
  it('toggles one equality expression without disturbing another field', () => {
    const start = new URLSearchParams('field=note.status%3Awip&tag=planning')
    const added = toggleFieldParam(start, 'owner', 'sergey')

    expect(added.getAll('field')).toEqual(['note.status:wip', 'note.owner:sergey'])
    expect(added.getAll('tag')).toEqual(['planning'])
    expect(toggleFieldParam(added, 'status', 'wip').getAll('field')).toEqual(['note.owner:sergey'])
  })

  it('clear filters removes all three field forms', () => {
    const result = clearFiltersParam(
      new URLSearchParams(
        'field=note.status%3Awip&fieldAny=note.owner&fieldBad=note.shape&tag=planning',
      ),
    )

    expect(result.getAll('field')).toEqual([])
    expect(result.getAll('fieldAny')).toEqual([])
    expect(result.getAll('fieldBad')).toEqual([])
    expect(result.getAll('tag')).toEqual([])
  })

  it('clears only one field across equality, presence and unreadable forms', () => {
    const result = clearFieldParam(
      new URLSearchParams(
        'field=note.status%3Awip&field=note.owner%3Asergey&fieldAny=note.status&fieldAny=note.owner&fieldBad=note.status&fieldBad=note.shape',
      ),
      'status',
    )

    expect(result.getAll('field')).toEqual(['note.owner:sergey'])
    expect(result.getAll('fieldAny')).toEqual(['note.owner'])
    expect(result.getAll('fieldBad')).toEqual(['note.shape'])
  })
})
