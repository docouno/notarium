import { describe, expect, it } from 'vitest'

import {
  FIELD_SCHEMA_MAX_FIELDS,
  FIELD_SCHEMA_MAX_VALUES,
  FIELD_SCHEMA_VERSION,
} from '@notarium/core'

import { FIELD_SCHEMA_STATUS } from './consts'
import { parseFieldSchemaFile, writeFieldSchemaFile } from './schemaFile'

const schema = (fields: Parameters<typeof writeFieldSchemaFile>[1]['fields']) => ({
  version: FIELD_SCHEMA_VERSION,
  fields,
})

describe('field schema YAML document', () => {
  it('round-trips an enum option stable key and editable label', () => {
    const raw = `version: 1\nfields:\n  - key: status\n    type: enum\n    values:\n      - key: in-progress\n        label: In progress\n        color: amber\n`

    expect(parseFieldSchemaFile(raw)).toMatchObject({
      schema: {
        version: 1,
        fields: [
          {
            key: 'status',
            type: 'enum',
            values: [{ key: 'in-progress', label: 'In progress', color: 'amber' }],
          },
        ],
      },
      status: FIELD_SCHEMA_STATUS.ready,
      readOnly: false,
      issues: [],
    })

    const legacy = parseFieldSchemaFile(
      `version: 1\nfields:\n  - key: status\n    type: enum\n    values:\n      - value: In progress\n        color: amber\n`,
    )
    expect(legacy).toMatchObject({
      schema: { version: 1, fields: [{ key: 'status', type: 'enum', values: [] }] },
      status: FIELD_SCHEMA_STATUS.formError,
      readOnly: true,
    })
    expect(legacy.issues.join(' ')).toContain('.key must be a single-line durable string')
  })

  it('writes the canonical block form and parses it back', () => {
    const raw = writeFieldSchemaFile(undefined, schema([{ key: 'status', type: 'text' }]))

    expect(raw).toBe('version: 1\nfields:\n  - key: status\n    type: text\n')
    expect(parseFieldSchemaFile(raw)).toMatchObject({
      schema: { version: 1, fields: [{ key: 'status', type: 'text' }] },
      status: FIELD_SCHEMA_STATUS.ready,
      readOnly: false,
      issues: [],
    })
  })

  it('preserves unknown keys and comments while changing values and order', () => {
    const before = `# schema\nversion: 1\nowner: plugin\nfields:\n  # alpha docs\n  - key: alpha\n    type: enum\n    plugin: keep\n    values:\n      # first docs\n      - key: first\n        color: slate\n      - key: second # inline\n        color: amber\n  - key: beta\n    type: text\n`
    const after = writeFieldSchemaFile(
      before,
      schema([
        { key: 'beta', type: 'text', label: 'Beta' },
        {
          key: 'alpha',
          type: 'enum',
          values: [
            { key: 'second', label: 'Second', color: 'green' },
            { key: 'first', color: 'slate' },
          ],
        },
      ]),
    )

    expect(after).toContain('# schema')
    expect(after).toContain('owner: plugin')
    expect(after).toContain('plugin: keep')
    expect(after).toContain('# alpha docs\n  - key: alpha')
    expect(after).toContain('# first docs\n      - key: first')
    expect(after).toContain('key: second # inline')
    expect(after).toContain('label: Second')
    expect(after.indexOf('key: beta')).toBeLessThan(after.indexOf('key: alpha'))
    expect(after.indexOf('key: second')).toBeLessThan(after.indexOf('key: first'))
    expect(parseFieldSchemaFile(after).schema).toEqual({
      version: 1,
      fields: [
        { key: 'beta', type: 'text', label: 'Beta' },
        {
          key: 'alpha',
          type: 'enum',
          values: [
            { key: 'second', label: 'Second', color: 'green' },
            { key: 'first', color: 'slate' },
          ],
        },
      ],
    })
  })

  it('drops a deleted head comment with its item instead of attaching it to the neighbour', () => {
    const before = `version: 1\nfields:\n  # alpha only\n  - key: alpha\n    type: text\n  # beta only\n  - key: beta\n    type: text\n`
    const after = writeFieldSchemaFile(before, schema([{ key: 'beta', type: 'text' }]))

    expect(after).not.toContain('alpha only')
    expect(after).toContain('# beta only\n  - key: beta')
  })

  it('keeps sequences block-styled after deleting everything and adding again', () => {
    const emptied = writeFieldSchemaFile(
      'version: 1\nfields:\n  - key: old\n    type: enum\n    values:\n      - key: old\n',
      schema([]),
    )
    const refilled = writeFieldSchemaFile(
      emptied,
      schema([{ key: 'new', type: 'enum', values: [{ key: 'one', color: 'blue' }] }]),
    )

    expect(refilled).toContain('fields:\n  - key: new')
    expect(refilled).toContain('values:\n      - key: one')
    expect(refilled).not.toContain('[{')
  })

  it('classifies structural, future-version and recoverable form violations separately', () => {
    const structural = parseFieldSchemaFile('fields: []\n')
    expect(structural).toMatchObject({
      schema: { version: 1, fields: [] },
      status: FIELD_SCHEMA_STATUS.structuralError,
      readOnly: true,
    })
    expect(structural.issues.join(' ')).toContain('version')

    const future = parseFieldSchemaFile(
      'version: 999\nfields:\n  - key: status\n    type: text\n    label: Status\n',
    )
    expect(future).toMatchObject({
      schema: { version: 999, fields: [{ key: 'status', type: 'text', label: 'Status' }] },
      status: FIELD_SCHEMA_STATUS.futureVersion,
      readOnly: true,
    })
    expect(future.issues.join(' ')).toContain('newer')

    const malformed = parseFieldSchemaFile(
      `version: 1\nfields:\n  - key: good\n    type: text\n    card: true\n  - key: tags\n    type: text\n  - key: enum\n    type: enum\n    values:\n      - key: one\n        color: '#ff0000'\n      - key: two\n        color: green\n`,
    )
    expect(malformed.schema.fields).toEqual([
      { key: 'good', type: 'text', card: true },
      { key: 'enum', type: 'enum', values: [{ key: 'two', color: 'green' }] },
    ])
    expect(malformed.status).toBe(FIELD_SCHEMA_STATUS.formError)
    expect(malformed.readOnly).toBe(true)
    expect(malformed.issues.join(' ')).toContain('protected')
    expect(malformed.issues.join(' ')).toContain('color')
  })

  it('classifies multiline wire scalars as a recoverable form violation', () => {
    const parsed = parseFieldSchemaFile(
      'version: 1\nfields:\n  - key: status\n    type: enum\n    label: |\n      Work\n      status\n    values:\n      - key: doing\n        label: |\n          In\n          progress\n',
    )

    expect(parsed.status).toBe(FIELD_SCHEMA_STATUS.formError)
    expect(parsed.readOnly).toBe(true)
    expect(parsed.schema.fields).toEqual([])
    expect(parsed.issues.join(' ')).toContain('single-line')
  })

  it('classifies duplicate human names in their owning scope as a form violation', () => {
    const parsed = parseFieldSchemaFile(
      `version: 1
fields:
  - key: status
    type: enum
    label: Status
    values:
      - key: done
        label: Done
      - key: closed
        label: " done "
  - key: status-secondary
    type: enum
    label: " status "
    values:
      - key: done
        label: Done
`,
    )

    expect(parsed.status).toBe(FIELD_SCHEMA_STATUS.formError)
    expect(parsed.readOnly).toBe(true)
    expect(parsed.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('duplicate enum value name'),
        expect.stringContaining('duplicate field name'),
      ]),
    )
  })

  it('ignores a key that cannot round-trip through note frontmatter', () => {
    const parsed = parseFieldSchemaFile(
      'version: 1\nfields:\n  - key: "a: b"\n    type: text\n  - key: valid\n    type: text\n',
    )

    expect(parsed.status).toBe(FIELD_SCHEMA_STATUS.formError)
    expect(parsed.schema.fields).toEqual([{ key: 'valid', type: 'text' }])
    expect(parsed.issues.join(' ')).toContain('safe plain YAML mapping key')
  })

  it('bounds hand-authored structural fan-out on the read side too', () => {
    const fields = parseFieldSchemaFile(
      `version: 1\nfields:\n${Array.from(
        { length: FIELD_SCHEMA_MAX_FIELDS + 1 },
        (_, index) => `  - key: k${index}\n    type: text\n`,
      ).join('')}`,
    )
    expect(fields.schema.fields).toHaveLength(FIELD_SCHEMA_MAX_FIELDS)
    expect(fields.readOnly).toBe(true)
    expect(fields.issues.join(' ')).toContain('field limit')

    const values = parseFieldSchemaFile(
      `version: 1\nfields:\n  - key: status\n    type: enum\n    values:\n${Array.from(
        { length: FIELD_SCHEMA_MAX_VALUES + 1 },
        (_, index) => `      - key: v${index}\n`,
      ).join('')}`,
    )
    expect(values.schema.fields[0].values).toHaveLength(FIELD_SCHEMA_MAX_VALUES)
    expect(values.readOnly).toBe(true)
    expect(values.issues.join(' ')).toContain('value limit')
  })

  it('still classifies an unaddressable item after the materialization cap as structural', () => {
    const parsed = parseFieldSchemaFile(
      `version: 1\nfields:\n${Array.from(
        { length: FIELD_SCHEMA_MAX_FIELDS },
        (_, index) => `  - key: k${index}\n    type: number\n`,
      ).join('')}  - type: number\n`,
    )

    expect(parsed.status).toBe(FIELD_SCHEMA_STATUS.structuralError)
    expect(parsed.schema.fields).toEqual([])
    expect(parsed.issues.join(' ')).toContain(`fields[${FIELD_SCHEMA_MAX_FIELDS}]`)
  })
})
