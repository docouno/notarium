import { describe, expect, it } from 'vitest'

import { notesQs } from './query'

describe('notesQs field filters', () => {
  it('serializes every field form as a repeated wire key', () => {
    const result = new URLSearchParams(
      notesQs({
        field: ['note.status:wip', 'note.status:done'],
        fieldDay: ['note.due:2026-09-01'],
        fieldAny: ['note.owner'],
        fieldBad: ['note.shape'],
      }).slice(1),
    )

    expect(result.getAll('field')).toEqual(['note.status:wip', 'note.status:done'])
    expect(result.getAll('fieldDay')).toEqual(['note.due:2026-09-01'])
    expect(result.getAll('fieldAny')).toEqual(['note.owner'])
    expect(result.getAll('fieldBad')).toEqual(['note.shape'])
  })
})
