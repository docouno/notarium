import { describe, expect, it } from 'vitest'
import { editingSaveAction } from './editingSaveAction'

describe('editing Save action', () => {
  it.each([
    ['inactive', false, false, false, false, false, 'remain'],
    ['saving', true, true, true, false, true, 'remain'],
    ['existing clean', true, false, false, false, false, 'finish'],
    ['existing clean unavailable', true, false, false, false, false, 'finish'],
    ['existing dirty saveable', true, false, true, false, true, 'save'],
    ['existing dirty unavailable', true, false, false, false, true, 'remain'],
    ['new saveable', true, false, true, true, false, 'save'],
    ['new not saveable', true, false, false, true, false, 'remain'],
    ['new dirty invalid', true, false, false, true, true, 'remain'],
  ] as const)('%s', (_name, active, saving, canSave, isNew, dirty, decision) => {
    expect(editingSaveAction({ active, saving, canSave, isNew, dirty })).toBe(decision)
  })
})
