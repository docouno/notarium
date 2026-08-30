import { describe, expect, it } from 'vitest'

import { FIELD_SCHEMA_STATUS } from './consts'
import type { FieldSchemaSnapshot } from './fieldSchemaStore'
import { resolveFieldsUnquoted } from './resolveFieldsUnquoted'

const schema = (readOnly = false): FieldSchemaSnapshot => ({
  version: 1,
  versionToken: 'test',
  status: readOnly ? FIELD_SCHEMA_STATUS.formError : FIELD_SCHEMA_STATUS.ready,
  ...(readOnly ? { readOnly: true as const, error: 'unsupported schema' } : {}),
  fields: [
    { key: 'priority', type: 'number' },
    { key: 'done', type: 'checkbox' },
    { key: 'due', type: 'date' },
    { key: '__proto__', type: 'number' },
  ],
})

describe('resolveFieldsUnquoted', () => {
  it('selects only valid declared number and checkbox scalars', () => {
    expect(
      resolveFieldsUnquoted(schema(), {
        priority: '3',
        done: 'false',
        due: '2026-08-21',
        text: 'plain',
        invalidNumber: '3px',
      }),
    ).toEqual(['priority', 'done'])
  })

  it('iterates own keys so __proto__ remains addressable', () => {
    const fields = Object.create(null) as Record<string, string | string[] | null>
    fields.__proto__ = '7'

    expect(resolveFieldsUnquoted(schema(), fields)).toEqual(['__proto__'])
  })

  it('leaves values that disagree with their declaration quoted', () => {
    expect(resolveFieldsUnquoted(schema(), { priority: '3px', done: 'TRUE' })).toEqual([])
  })

  it('produces no byte-shape advice from a read-only schema', () => {
    expect(resolveFieldsUnquoted(schema(true), { priority: '3', done: 'true' })).toEqual([])
    expect(
      resolveFieldsUnquoted(
        { ...schema(), error: 'schema parse failed' },
        { priority: '3', done: 'true' },
      ),
    ).toEqual([])
  })
})
