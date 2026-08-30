import { FIELD_TYPE } from './consts'
import { FIELD_FACET_MAX_VALUES, FIELD_FACET_MIN_NOTES, PROTECTED_FIELD_KEYS } from './consts'
import { fieldValueMatchesType } from './predicates'
import type { FieldDeclaration, NoteFields } from './types'

type FieldStats = {
  notes: number
  entries: number
  values: Map<string, number>
  saturated: boolean
}

export type FieldFacetItem = {
  key: string
  declared: boolean
  notes: number
  values: Array<{ value: string; count: number }>
  total: number
}

export type FieldFacet = {
  fields: FieldFacetItem[]
  total: number
  truncated?: true
}

const protectedKeys = new Set<string>(PROTECTED_FIELD_KEYS)
const addressableInFacet = (key: string): boolean => !protectedKeys.has(key) && !key.includes(':')

/** Keep discovery memory and sort input bounded before collecting per-key stats.
 * Lexical selection is deterministic across note order, and `q` is applied before
 * the bound so any omitted open-world key remains directly discoverable. */
const boundedUndeclaredKeys = (
  notes: readonly (NoteFields | undefined)[],
  declared: ReadonlySet<string>,
  q: string | undefined,
  limit: number,
): { keys: Set<string>; truncated: boolean } => {
  const heap: string[] = []
  const keys = new Set<string>()
  let truncated = false
  const before = (left: string, right: string) => left.localeCompare(right) > 0

  const bubble = (start: number) => {
    let index = start

    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)

      if (!before(heap[index], heap[parent])) {
        break
      }
      ;[heap[index], heap[parent]] = [heap[parent], heap[index]]
      index = parent
    }
  }

  const sink = () => {
    let index = 0

    while (true) {
      const left = index * 2 + 1
      const right = left + 1
      let candidate = index

      if (left < heap.length && before(heap[left], heap[candidate])) {
        candidate = left
      }
      if (right < heap.length && before(heap[right], heap[candidate])) {
        candidate = right
      }
      if (candidate === index) {
        return
      }
      ;[heap[index], heap[candidate]] = [heap[candidate], heap[index]]
      index = candidate
    }
  }

  const offer = (key: string) => {
    if (
      keys.has(key) ||
      declared.has(key) ||
      !addressableInFacet(key) ||
      (q !== undefined && !key.startsWith(q))
    ) {
      return
    }
    if (heap.length < limit) {
      heap.push(key)
      keys.add(key)
      bubble(heap.length - 1)
      return
    }
    truncated = true
    if (key.localeCompare(heap[0]) >= 0) {
      return
    }
    keys.delete(heap[0])
    heap[0] = key
    keys.add(key)
    sink()
  }

  for (const fields of notes) {
    for (const key of Object.keys(fields?.keys ?? {})) {
      offer(key)
    }
  }

  return { keys, truncated }
}

/** The discovery pass keeps declared values out of the global map: those are
 * reduced one selected field at a time below. An undeclared high-cardinality key
 * is not useful as a facet and saturates after one response page instead of
 * retaining arbitrary identity data for the whole corpus. */
const statsOf = (
  notes: readonly (NoteFields | undefined)[],
  declared: ReadonlySet<string>,
  undeclared: ReadonlySet<string>,
): Map<string, FieldStats> => {
  const stats = new Map<string, FieldStats>()

  const get = (key: string): FieldStats => {
    const current = stats.get(key)

    if (current) {
      return current
    }
    const created = { notes: 0, entries: 0, values: new Map<string, number>(), saturated: false }
    stats.set(key, created)
    return created
  }

  for (const fields of notes) {
    if (!fields) {
      continue
    }
    const carried = new Set<string>([
      ...Object.keys(fields.keys),
      ...(fields.unreadable ?? []),
      ...(fields.truncated ?? []),
    ])

    for (const key of carried) {
      if (declared.has(key) || undeclared.has(key)) {
        get(key).notes++
      }
    }
    for (const key of Object.keys(fields.keys)) {
      if (!declared.has(key) && !undeclared.has(key)) {
        continue
      }
      const value = fields.keys[key]
      const values = Array.isArray(value)
        ? value.length === 0
          ? ['']
          : [...new Set(value)]
        : [value]
      const field = get(key)

      field.entries += values.length
      if (declared.has(key) || field.saturated) {
        continue
      }
      for (const item of values) {
        if (!field.values.has(item) && field.values.size >= FIELD_FACET_MAX_VALUES + 1) {
          field.values.clear()
          field.saturated = true
          break
        }
        field.values.set(item, (field.values.get(item) ?? 0) + 1)
      }
    }
  }

  return stats
}

type ValueStats = { count: number }

const valueIdentity = (declaration: FieldDeclaration, value: string): string =>
  declaration.type === FIELD_TYPE.date && fieldValueMatchesType(FIELD_TYPE.date, value, declaration)
    ? value.slice(0, 10)
    : value

const declaredValues = (
  notes: readonly (NoteFields | undefined)[],
  declaration: FieldDeclaration,
): Map<string, ValueStats> => {
  const values = new Map<string, ValueStats>()

  for (const fields of notes) {
    const raw = fields?.keys[declaration.key]

    if (raw === undefined) {
      continue
    }
    const items = Array.isArray(raw) ? (raw.length ? [...new Set(raw)] : ['']) : [raw]
    const perNote = new Set<string>()

    for (const item of items) {
      perNote.add(valueIdentity(declaration, item))
    }
    for (const identity of perNote) {
      const current = values.get(identity) ?? { count: 0 }
      current.count++
      values.set(identity, current)
    }
  }

  return values
}

const byCountThenValue = (
  a: readonly [string, ValueStats],
  b: readonly [string, ValueStats],
): number => b[1].count - a[1].count || a[0].localeCompare(b[0])

const topEntries = (
  source: ReadonlyMap<string, ValueStats>,
  limit: number,
): Array<readonly [string, ValueStats]> => {
  if (limit === 0) {
    return []
  }
  if (source.size <= limit) {
    return [...source].sort(byCountThenValue)
  }
  const heap: Array<readonly [string, ValueStats]> = []
  const worse = (left: readonly [string, ValueStats], right: readonly [string, ValueStats]) =>
    byCountThenValue(left, right) > 0

  const bubble = (start: number) => {
    let index = start

    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)

      if (!worse(heap[index], heap[parent])) {
        break
      }
      ;[heap[index], heap[parent]] = [heap[parent], heap[index]]
      index = parent
    }
  }

  const sink = () => {
    let index = 0

    while (true) {
      const left = index * 2 + 1
      const right = left + 1
      let candidate = index

      if (left < heap.length && worse(heap[left], heap[candidate])) {
        candidate = left
      }
      if (right < heap.length && worse(heap[right], heap[candidate])) {
        candidate = right
      }
      if (candidate === index) {
        return
      }
      ;[heap[index], heap[candidate]] = [heap[candidate], heap[index]]
      index = candidate
    }
  }

  for (const entry of source) {
    if (heap.length < limit) {
      heap.push(entry)
      bubble(heap.length - 1)
    } else if (byCountThenValue(entry, heap[0]) < 0) {
      heap[0] = entry
      sink()
    }
  }

  return heap.sort(byCountThenValue)
}

const presentValue = (value: string, stats: ValueStats) => ({
  value,
  count: stats.count,
})

const valuesOfDeclared = (
  notes: readonly (NoteFields | undefined)[],
  declaration: FieldDeclaration,
  limit: number,
): { values: FieldFacetItem['values']; total: number } => {
  if (limit === 0) {
    return { values: [], total: 0 }
  }
  const remaining = declaredValues(notes, declaration)
  const values: FieldFacetItem['values'] = []

  for (const option of declaration.values ?? []) {
    const current = remaining.get(option.key) ?? { count: 0 }
    values.push(presentValue(option.key, current))
    remaining.delete(option.key)
  }
  const total = values.length + remaining.size
  const room = Math.max(0, limit - values.length)

  for (const [value, stats] of topEntries(remaining, room)) {
    values.push(presentValue(value, stats))
  }

  return { values: values.slice(0, limit), total }
}

export const fieldFacet = (
  notes: readonly (NoteFields | undefined)[],
  declarations: readonly FieldDeclaration[],
  opts: { q?: string; limit?: number; valuesLimit?: number } = {},
): FieldFacet => {
  const declared = new Map(declarations.map((field) => [field.key, field]))
  const limit = opts.limit ?? 24
  const discovery = boundedUndeclaredKeys(
    notes,
    new Set(declared.keys()),
    opts.q,
    Math.max(64, Math.min(512, limit * 4)),
  )
  const stats = statsOf(notes, new Set(declared.keys()), discovery.keys)
  const orderedKeys = declarations.map((field) => field.key)
  const undeclared = [...stats]
    .filter(([key, value]) => {
      if (declared.has(key) || !addressableInFacet(key) || value.entries === 0 || value.saturated) {
        return false
      }

      return value.values.size < value.entries || value.notes < FIELD_FACET_MIN_NOTES
    })
    .sort(([aKey, a], [bKey, b]) => b.notes - a.notes || aKey.localeCompare(bKey))
    .map(([key]) => key)
  const seen = new Set<string>()
  const keys: string[] = []

  for (const key of [...orderedKeys, ...undeclared]) {
    if (
      seen.has(key) ||
      !addressableInFacet(key) ||
      (opts.q !== undefined && !key.startsWith(opts.q))
    ) {
      continue
    }
    seen.add(key)
    keys.push(key)
  }
  const total = keys.length
  const sliced = opts.limit === undefined ? keys : keys.slice(0, opts.limit)
  const valuesLimit = opts.valuesLimit ?? FIELD_FACET_MAX_VALUES
  const fields: FieldFacetItem[] = []

  for (const key of sliced) {
    const fieldStats = stats.get(key) ?? {
      notes: 0,
      entries: 0,
      values: new Map<string, number>(),
      saturated: false,
    }
    const declaration = declared.get(key)

    if (declaration) {
      const presented = valuesOfDeclared(notes, declaration, valuesLimit)
      fields.push({
        key,
        declared: true,
        notes: fieldStats.notes,
        values: presented.values,
        total: presented.total,
      })
      continue
    }
    const values = [...fieldStats.values]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, valuesLimit)
      .map(([value, count]) => ({ value, count }))
    fields.push({
      key,
      declared: false,
      notes: fieldStats.notes,
      values,
      total: fieldStats.values.size,
    })
  }

  return { fields, total, ...(discovery.truncated ? { truncated: true as const } : {}) }
}
