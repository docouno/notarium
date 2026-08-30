import { describe, expect, it } from 'vitest'

import { FIELD_TYPE } from './consts'
import {
  fieldValueMatchesType,
  isFieldCheckbox,
  isFieldDate,
  isFieldNumber,
  isWritableFieldKey,
} from './predicates'

describe('field declaration predicates', () => {
  it('accepts only complete decimal numbers', () => {
    for (const value of ['0', '-3', '+2.5', '.75', '4.']) {
      expect(isFieldNumber(value), value).toBe(true)
    }
    for (const value of ['', ' 3', '3 ', '1e3', 'NaN', 'Infinity', '3px']) {
      expect(isFieldNumber(value), value).toBe(false)
    }
  })

  it('keeps day and moment dates distinct from parseable prose', () => {
    expect(isFieldDate('2026-02-28')).toBe(true)
    expect(isFieldDate('2026-02-29')).toBe(false)
    expect(isFieldDate('2026-08-21T10:30:00Z')).toBe(true)
    expect(isFieldDate('2026-02-29T10:30:00Z')).toBe(false)
    expect(isFieldDate('August 21, 2026')).toBe(false)
  })

  it('accepts checkbox literals and declaration-owned enum values without coercion', () => {
    expect(isFieldCheckbox('true')).toBe(true)
    expect(isFieldCheckbox('TRUE')).toBe(false)
    expect(fieldValueMatchesType(FIELD_TYPE.list, 'one')).toBe(true)
    expect(fieldValueMatchesType(FIELD_TYPE.list, ['one', 'two'])).toBe(true)
    expect(
      fieldValueMatchesType(FIELD_TYPE.enum, 'doing', {
        values: [{ key: 'todo' }, { key: 'doing' }],
      }),
    ).toBe(true)
    expect(
      fieldValueMatchesType(FIELD_TYPE.enum, 'Doing', {
        values: [{ key: 'doing' }],
      }),
    ).toBe(false)
  })

  it('accepts only plain keys that parse back to the same authored key', () => {
    expect(isWritableFieldKey('review owner')).toBe(true)
    expect(isWritableFieldKey('__proto__')).toBe(true)
    expect(isWritableFieldKey('a: b')).toBe(false)
    expect(isWritableFieldKey('&anchor')).toBe(false)
  })
})
