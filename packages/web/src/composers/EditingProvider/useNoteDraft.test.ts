import { describe, expect, it } from 'vitest'
import { changedFields, fieldsWithPending } from './useNoteDraft'

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
