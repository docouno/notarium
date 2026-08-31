import { describe, expect, it } from 'vitest'

import {
  andFieldFilters,
  compileFieldFilter,
  compileFieldFilterEvaluator,
  evaluateFieldFilter,
  FIELD_MATCH_STATE,
  fieldFilterKeys,
  matchesFieldFilter,
  normalizeFieldFilter,
} from './match'
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

describe('FieldFilterAstV1 evaluator', () => {
  it('distinguishes a proven miss from a capped ambiguous key', () => {
    const status = filter([
      { op: 'or', ns: 'note', key: 'status', values: [{ kind: 'eq', value: 'doing' }] },
    ])

    expect(evaluateFieldFilter({ fields: fields({ keys: {} }) }, status)).toBe(
      FIELD_MATCH_STATE.miss,
    )
    expect(evaluateFieldFilter({ fields: fields({ keys: {}, truncatedMore: 1 }) }, status)).toBe(
      FIELD_MATCH_STATE.ambiguous,
    )
    expect(evaluateFieldFilter({}, status)).toBe(FIELD_MATCH_STATE.ambiguous)
  })

  it('routes note.view through the dedicated marker instead of the fields blob', () => {
    const view = filter([
      { op: 'or', ns: 'note', key: 'view', values: [{ kind: 'eq', value: 'board' }] },
    ])

    expect(
      evaluateFieldFilter(
        { viewType: 'board', fields: fields({ keys: {}, truncatedMore: 10 }) },
        view,
      ),
    ).toBe(FIELD_MATCH_STATE.match)
    expect(evaluateFieldFilter({ viewType: 'table' }, view)).toBe(FIELD_MATCH_STATE.miss)
  })

  it('deduplicates repeated conditions without widening same-key AND clauses', () => {
    const base = filter([
      { op: 'or', ns: 'note', key: 'status', values: [{ kind: 'eq', value: 'doing' }] },
    ])
    const perView = filter([
      {
        op: 'or',
        ns: 'note',
        key: 'status',
        values: [
          { kind: 'eq', value: 'doing' },
          { kind: 'eq', value: 'doing' },
          { kind: 'eq', value: 'done' },
        ],
      },
      { op: 'or', ns: 'note', key: 'owner', values: [{ kind: 'present' }] },
    ])
    const combined = andFieldFilters(base, perView)

    expect(combined).toEqual({
      op: 'and',
      nodes: [
        {
          op: 'or',
          ns: 'note',
          key: 'status',
          values: [{ kind: 'eq', value: 'doing' }],
        },
        {
          op: 'or',
          ns: 'note',
          key: 'status',
          values: [
            { kind: 'eq', value: 'doing' },
            { kind: 'eq', value: 'done' },
          ],
        },
        { op: 'or', ns: 'note', key: 'owner', values: [{ kind: 'present' }] },
      ],
    })
    expect(fieldFilterKeys(combined)).toEqual(['status', 'owner'])
    expect(
      evaluateFieldFilter(
        { fields: fields({ keys: { status: 'doing', owner: 'ann' } }) },
        combined,
      ),
    ).toBe(FIELD_MATCH_STATE.match)
    expect(
      evaluateFieldFilter({ fields: fields({ keys: { status: 'done', owner: 'ann' } }) }, combined),
    ).toBe(FIELD_MATCH_STATE.miss)
    expect(normalizeFieldFilter({ op: 'and', nodes: [] })).toBeUndefined()
  })

  it('keeps contradictory base and per-view clauses unsatisfiable', () => {
    const combined = andFieldFilters(
      filter([{ op: 'or', ns: 'note', key: 'kind', values: [{ kind: 'eq', value: 'task' }] }]),
      filter([{ op: 'or', ns: 'note', key: 'kind', values: [{ kind: 'eq', value: 'note' }] }]),
    )

    expect(evaluateFieldFilter({ fields: fields({ keys: { kind: 'task' } }) }, combined)).toBe(
      FIELD_MATCH_STATE.miss,
    )
    expect(evaluateFieldFilter({ fields: fields({ keys: { kind: 'note' } }) }, combined)).toBe(
      FIELD_MATCH_STATE.miss,
    )
  })

  it('does not revisit or compile the AST while evaluating a hot loop', () => {
    let nodeReads = 0
    const nodes = new Proxy(
      [
        {
          op: 'or' as const,
          ns: 'note' as const,
          key: 'status',
          values: [{ kind: 'eq' as const, value: 'doing' }],
        },
      ],
      {
        get: (target, property, receiver) => {
          if (typeof property === 'string' && /^\d+$/u.test(property)) {
            nodeReads++
          }

          return Reflect.get(target, property, receiver)
        },
      },
    )
    const evaluate = compileFieldFilterEvaluator(filter(nodes))
    const readsAfterCompile = nodeReads

    for (let index = 0; index < 1_000; index++) {
      expect(evaluate({ fields: fields({ keys: { status: 'doing' } }) })).toBe(
        FIELD_MATCH_STATE.match,
      )
    }

    expect(readsAfterCompile).toBeGreaterThan(0)
    expect(nodeReads).toBe(readsAfterCompile)
  })
})
