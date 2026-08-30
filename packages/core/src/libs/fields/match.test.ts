import { describe, expect, it } from 'vitest'

import { compileFieldFilter, matchesFieldFilter } from './match'
import type { FieldFilter, NoteFields } from './types'

const fields = (value: Partial<NoteFields>): NoteFields => ({
  keys: Object.assign(Object.create(null), value.keys ?? {}),
  ...value,
})

const filter = (nodes: FieldFilter['nodes']): FieldFilter => ({ op: 'and', nodes })

describe('matchesFieldFilter', () => {
  it('ORs conditions within one key and ANDs different keys', () => {
    const f = filter([
      {
        op: 'or',
        ns: 'note',
        key: 'status',
        values: [
          { kind: 'eq', value: 'wip' },
          { kind: 'eq', value: 'done' },
        ],
      },
      { op: 'or', ns: 'note', key: 'owner', values: [{ kind: 'eq', value: 'sergey' }] },
    ])

    expect(matchesFieldFilter(fields({ keys: { status: 'wip', owner: 'sergey' } }), f)).toBe(true)
    expect(matchesFieldFilter(fields({ keys: { status: 'wip', owner: 'other' } }), f)).toBe(false)
  })

  it('matches list containment and treats an empty list as an empty value', () => {
    const reviewers = filter([
      { op: 'or', ns: 'note', key: 'reviewers', values: [{ kind: 'eq', value: 'ann' }] },
    ])
    const empty = filter([
      { op: 'or', ns: 'note', key: 'reviewers', values: [{ kind: 'eq', value: '' }] },
    ])

    expect(matchesFieldFilter(fields({ keys: { reviewers: ['ann', 'bo'] } }), reviewers)).toBe(true)
    expect(matchesFieldFilter(fields({ keys: { reviewers: [] } }), empty)).toBe(true)
  })

  it('matches one authored calendar day across day-only and instant values', () => {
    const due = filter([
      { op: 'or', ns: 'note', key: 'due', values: [{ kind: 'day', value: '2026-09-01' }] },
    ])

    expect(matchesFieldFilter(fields({ keys: { due: '2026-09-01' } }), due)).toBe(true)
    expect(matchesFieldFilter(fields({ keys: { due: '2026-09-01T23:59:59Z' } }), due)).toBe(true)
    expect(matchesFieldFilter(fields({ keys: { due: '2026-09-02T00:00:00Z' } }), due)).toBe(false)
    expect(matchesFieldFilter(fields({ keys: { due: '2026-09-01-not-a-date' } }), due)).toBe(false)
  })

  it('distinguishes present, unreadable and truncated names', () => {
    const projected = fields({
      keys: { empty: '' },
      unreadable: ['broken'],
      truncated: ['large'],
      truncatedMore: 1,
      unreadableMore: 1,
    })
    const one = (key: string, kind: 'present' | 'unreadable') =>
      filter([{ op: 'or', ns: 'note', key, values: [{ kind }] }])

    expect(matchesFieldFilter(projected, one('empty', 'present'))).toBe(true)
    expect(matchesFieldFilter(projected, one('broken', 'present'))).toBe(true)
    expect(matchesFieldFilter(projected, one('broken', 'unreadable'))).toBe(true)
    expect(matchesFieldFilter(projected, one('large', 'present'))).toBe(true)
    expect(matchesFieldFilter(projected, one('large', 'unreadable'))).toBe(false)
    expect(matchesFieldFilter(projected, one('lost-name', 'present'))).toBe(false)
  })

  it('uses own keys even for prototype-shaped names', () => {
    const proto = fields({ keys: {} })
    Object.defineProperty(proto.keys, '__proto__', { value: 'kept', enumerable: true })
    const eq = (key: string, value: string) =>
      filter([{ op: 'or', ns: 'note', key, values: [{ kind: 'eq', value }] }])

    expect(matchesFieldFilter(proto, eq('__proto__', 'kept'))).toBe(true)
    expect(matchesFieldFilter(proto, eq('toString', 'anything'))).toBe(false)
  })

  it('compiles repeated equality and name lookups into linear sets', () => {
    const names = Array.from({ length: 400 }, (_, index) => `name-${index}`)
    const values = Array.from({ length: 400 }, (_, index) => `value-${index}`)
    const compiled = compileFieldFilter(
      filter([
        {
          op: 'or',
          ns: 'note',
          key: 'items',
          values: Array.from({ length: 100 }, (_, index) => ({
            kind: 'eq' as const,
            value: `missing-${index}`,
          })),
        },
        {
          op: 'or',
          ns: 'note',
          key: 'absent',
          values: Array.from({ length: 100 }, () => ({ kind: 'present' as const })),
        },
      ]),
    )
    let probes = 0
    const counted = <T>(source: T[]): T[] =>
      new Proxy(source, {
        get: (target, property, receiver) => {
          if (typeof property === 'string' && /^\d+$/u.test(property)) {
            probes++
          }

          return Reflect.get(target, property, receiver)
        },
      })

    expect(compiled(fields({ keys: { items: counted(values) }, unreadable: counted(names) }))).toBe(
      false,
    )
    expect(probes).toBeLessThan(1_000)
  })
})
