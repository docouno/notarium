import { describe, expect, it } from 'vitest'
import {
  changedFields,
  createdAtPatch,
  dateInputToIso,
  fieldsWithPending,
  isoToDateInput,
} from './useNoteDraft'

describe('editor field patch', () => {
  it('sends only changed values and expresses removal as null', () => {
    expect(
      changedFields(
        { status: 'Doing', reviewers: ['ann', 'bo'], unchanged: '' },
        { status: 'Todo', reviewers: ['bo'], unchanged: '', added: 'yes' },
      ),
    ).toEqual({
      status: 'Todo',
      reviewers: ['bo'],
      added: 'yes',
    })

    expect(changedFields({ status: 'Doing' }, {})).toEqual({ status: null })
  })

  it('is empty when a draft returns to its snapshot', () => {
    expect(
      changedFields(
        { status: 'Doing', reviewers: ['ann'] },
        {
          status: 'Doing',
          reviewers: ['ann'],
        },
      ),
    ).toEqual({})
  })

  it('includes a list item that is still being typed when dirty/save is computed', () => {
    const fields = fieldsWithPending({ reviewers: ['ann'] }, { reviewers: 'bo' })

    expect(fields).toEqual({ reviewers: ['ann', 'bo'] })
    expect(changedFields({ reviewers: ['ann'] }, fields)).toEqual({
      reviewers: ['ann', 'bo'],
    })
  })
})

describe('editor authored creation date payload', () => {
  it('shows the stored instant as its local calendar day', () => {
    const instant = new Date(2024, 0, 2, 12, 30).toISOString()

    expect(isoToDateInput(instant)).toBe('2024-01-02')
  })

  it('sends local midnight only for a changed non-empty day', () => {
    expect(createdAtPatch('2024-01-02', '2024-01-02')).toEqual({})
    expect(createdAtPatch('2024-01-02', '')).toEqual({})
    expect(createdAtPatch('2024-01-02', '2024-01-03')).toEqual({
      createdAt: dateInputToIso('2024-01-03'),
    })
    expect(dateInputToIso('2024-01-03')).toBe(new Date(2024, 0, 3).toISOString())
  })
})
