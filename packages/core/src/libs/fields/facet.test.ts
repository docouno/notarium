import { describe, expect, it, vi } from 'vitest'

import { FIELD_FACET_MAX_VALUES } from './consts'
import { fieldFacet } from './facet'
import type { FieldDeclaration, NoteFields } from './types'

const fields = (
  keys: Record<string, string | string[]> = {},
  rest: Omit<Partial<NoteFields>, 'keys'> = {},
): NoteFields => ({ keys: Object.assign(Object.create(null), keys), ...rest })

describe('fieldFacet', () => {
  it('keeps a small grouping key and rejects a larger identity-shaped key', () => {
    const notes = [0, 1, 2].map((i) => fields({ status: `s${i}` }))
    const identities = Array.from({ length: 40 }, (_, i) => fields({ telegram_id: `${i}` }))
    const result = fieldFacet([...notes, ...identities], [])

    expect(result.fields.map((field) => field.key)).toContain('status')
    expect(result.fields.map((field) => field.key)).not.toContain('telegram_id')
  })

  it('counts list values once per note and uses value entries as the usefulness denominator', () => {
    const notes = Array.from({ length: 20 }, (_, i) =>
      fields({ reviewers: [`r${i % 10}`, `r${(i + 1) % 10}`, `r${i % 10}`] }),
    )
    const result = fieldFacet(notes, [])
    const reviewers = result.fields.find((field) => field.key === 'reviewers')

    expect(reviewers?.notes).toBe(20)
    expect(reviewers?.values.find((value) => value.value === 'r0')?.count).toBe(4)
  })

  it('returns declared enum values in schema order, including zero counts and observed drift', () => {
    const declaration: FieldDeclaration = {
      key: 'status',
      type: 'enum',
      values: [{ key: 'backlog' }, { key: 'wip' }, { key: 'done' }],
    }
    const result = fieldFacet(
      [fields({ status: 'wip' }), fields({ status: 'other' })],
      [declaration],
    )
    const status = result.fields[0]

    expect(status).toMatchObject({ key: 'status', declared: true, notes: 2, total: 4 })
    expect(status.values).toEqual([
      { value: 'backlog', count: 0 },
      { value: 'wip', count: 1 },
      { value: 'done', count: 0 },
      { value: 'other', count: 1 },
    ])
  })

  it('does not surface empty groups or protected and colon-shaped keys', () => {
    const result = fieldFacet(
      [
        fields({}, { unreadable: ['broken'] }),
        fields({ view: 'board', 'https://example': 'linked' }),
      ],
      [],
    )

    expect(result.fields).toEqual([])
  })

  it('represents scalar and list emptiness by one empty value', () => {
    const result = fieldFacet([fields({ scalar: '', list: [] })], [])

    expect(result.fields.find((field) => field.key === 'scalar')?.values).toEqual([
      { value: '', count: 1 },
    ])
    expect(result.fields.find((field) => field.key === 'list')?.values).toEqual([
      { value: '', count: 1 },
    ])
  })

  it('groups date-day and instant spellings into one authored calendar facet', () => {
    const instants = Array.from({ length: 101 }, (_, index) =>
      fields({ due: new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString() }),
    )
    const result = fieldFacet(
      [fields({ due: '2026-09-01' }), ...instants],
      [{ key: 'due', type: 'date' }],
    )

    expect(result.fields[0].values).toEqual([
      {
        value: '2026-09-01',
        count: 102,
      },
    ])
  })

  it('cuts values independently from keys and reports both totals before each cut', () => {
    const declaration: FieldDeclaration = { key: 'client', type: 'text' }
    const notes = Array.from({ length: FIELD_FACET_MAX_VALUES + 20 }, (_, i) =>
      fields({ client: `c${String(i).padStart(3, '0')}` }),
    )
    const result = fieldFacet(notes, [declaration], { limit: 1 })

    expect(result.total).toBe(1)
    expect(result.fields).toHaveLength(1)
    expect(result.fields[0].values).toHaveLength(FIELD_FACET_MAX_VALUES)
    expect(result.fields[0].total).toBe(FIELD_FACET_MAX_VALUES + 20)
    expect(result.fields[0].values.map((value) => value.value)).toEqual(
      Array.from(
        { length: FIELD_FACET_MAX_VALUES },
        (_, index) => `c${String(index).padStart(3, '0')}`,
      ),
    )
  })

  it('deduplicates declared and observed keys without array-wide index scans', () => {
    const declarations = Array.from({ length: 200 }, (_, index) => ({
      key: `field-${index}`,
      type: 'text' as const,
    }))
    const indexOf = vi.spyOn(Array.prototype, 'indexOf')

    const result = fieldFacet([fields({ 'field-199': 'present' })], declarations, { limit: 1 })
    const indexScans = indexOf.mock.calls.length
    indexOf.mockRestore()

    expect(result.total).toBe(200)
    expect(indexScans).toBe(0)
  })

  it('bounds undeclared identity tracking and can skip declared values for usage-only reads', () => {
    const identities = Array.from({ length: 10_000 }, (_, index) =>
      fields({ external_id: `identity-${index}`, status: index % 2 ? 'todo' : 'done' }),
    )
    const result = fieldFacet(identities, [{ key: 'status', type: 'text' }], {
      valuesLimit: 0,
    })

    expect(result.fields).toEqual([
      { key: 'status', declared: true, notes: 10_000, values: [], total: 0 },
    ])
  })

  it('bounds open-world key discovery before ranking even when limit is one', () => {
    const notes = Array.from({ length: 10_000 }, (_, index) =>
      fields({ [`key-${String(index).padStart(5, '0')}`]: `value-${index}` }),
    )
    const result = fieldFacet(notes, [], { limit: 1, valuesLimit: 1 })

    expect(result.truncated).toBe(true)
    expect(result.fields).toHaveLength(1)
    expect(result.fields[0].key).toBe('key-00000')
  })
})
