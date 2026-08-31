import { isFieldDate } from './predicates'
import type { FieldClause, FieldFilter, FieldFilterAstV1, NoteFields } from './types'

export type FieldFilterTarget = {
  fields?: NoteFields
  viewType?: string
}

export const FIELD_MATCH_STATE = {
  match: 'match',
  miss: 'miss',
  ambiguous: 'ambiguous',
} as const

export type FieldMatchState = (typeof FIELD_MATCH_STATE)[keyof typeof FIELD_MATCH_STATE]

type CompiledClause = {
  key: string
  equality: ReadonlySet<string>
  days: ReadonlySet<string>
  present: boolean
  unreadable: boolean
}

const matchesDay = (days: ReadonlySet<string>, value: string): boolean =>
  days.size > 0 && isFieldDate(value) && days.has(value.slice(0, 10))

const compileClause = (clause: FieldClause): CompiledClause => {
  const equality = new Set<string>()
  const days = new Set<string>()
  let present = false
  let unreadable = false

  for (const condition of clause.values) {
    if (condition.kind === 'eq') {
      equality.add(condition.value)
    } else if (condition.kind === 'day') {
      days.add(condition.value)
    } else if (condition.kind === 'present') {
      present = true
    } else {
      unreadable = true
    }
  }

  return { key: clause.key, equality, days, present, unreadable }
}

const conditionId = (condition: FieldClause['values'][number]): string =>
  condition.kind === 'eq' || condition.kind === 'day'
    ? `${condition.kind}\u0000${condition.value}`
    : condition.kind

const normalizeClause = (clause: FieldClause): FieldClause => {
  const seen = new Set<string>()

  return {
    op: 'or',
    ns: clause.ns,
    key: clause.key,
    values: clause.values.filter((condition) => {
      const id = conditionId(condition)

      if (seen.has(id)) {
        return false
      }
      seen.add(id)
      return true
    }),
  }
}

const clauseId = (clause: FieldClause): string =>
  JSON.stringify([clause.ns, clause.key, clause.values])

export const normalizeFieldFilter = (
  filter: FieldFilterAstV1 | undefined,
): FieldFilterAstV1 | undefined => {
  if (!filter || filter.nodes.length === 0) {
    return undefined
  }
  const clauses: FieldClause[] = []
  const seen = new Set<string>()

  for (const raw of filter.nodes) {
    const clause = normalizeClause(raw)
    const id = clauseId(clause)

    if (seen.has(id)) {
      continue
    }
    seen.add(id)
    clauses.push(clause)
  }

  return { op: 'and', nodes: clauses }
}

export const andFieldFilters = (
  ...filters: Array<FieldFilterAstV1 | undefined>
): FieldFilterAstV1 | undefined =>
  normalizeFieldFilter({ op: 'and', nodes: filters.flatMap((filter) => filter?.nodes ?? []) })

export const fieldFilterKeys = (filter: FieldFilterAstV1 | undefined): string[] => [
  ...new Set((filter?.nodes ?? []).map((clause) => clause.key)),
]

const evaluateClause = (meta: FieldFilterTarget, clause: CompiledClause): FieldMatchState => {
  if (clause.key === 'view') {
    const value = meta.viewType

    if (clause.present && value !== undefined) {
      return FIELD_MATCH_STATE.match
    }
    if (value !== undefined && clause.equality.has(value)) {
      return FIELD_MATCH_STATE.match
    }

    return FIELD_MATCH_STATE.miss
  }
  const fields = meta.fields

  if (!fields) {
    return FIELD_MATCH_STATE.ambiguous
  }
  const unreadable = fields.unreadable ?? []
  const truncated = fields.truncated ?? []
  const isUnreadable = unreadable.includes(clause.key)
  const isTruncated = truncated.includes(clause.key)
  const hasValue = Object.hasOwn(fields.keys, clause.key)

  if (clause.present && (hasValue || isUnreadable || isTruncated)) {
    return FIELD_MATCH_STATE.match
  }
  if (clause.unreadable && isUnreadable) {
    return FIELD_MATCH_STATE.match
  }
  if (hasValue && (clause.equality.size > 0 || clause.days.size > 0)) {
    const value = fields.keys[clause.key]
    const matches = Array.isArray(value)
      ? value.length === 0
        ? clause.equality.has('')
        : value.some((item) => clause.equality.has(item) || matchesDay(clause.days, item))
      : clause.equality.has(value) || matchesDay(clause.days, value)

    if (matches) {
      return FIELD_MATCH_STATE.match
    }
  }
  const keyKnown = hasValue || isUnreadable || isTruncated
  const hiddenNames = (fields.unreadableMore ?? 0) > 0 || (fields.truncatedMore ?? 0) > 0

  return !keyKnown && hiddenNames ? FIELD_MATCH_STATE.ambiguous : FIELD_MATCH_STATE.miss
}

export const compileFieldFilterEvaluator = (
  filter: FieldFilterAstV1 | undefined,
): ((meta: FieldFilterTarget) => FieldMatchState) => {
  const normalized = normalizeFieldFilter(filter)

  if (!normalized) {
    return () => FIELD_MATCH_STATE.match
  }
  const clauses = normalized.nodes.map(compileClause)

  return (meta) => {
    let ambiguous = false

    for (const clause of clauses) {
      const result = evaluateClause(meta, clause)

      if (result === FIELD_MATCH_STATE.miss) {
        return result
      }
      ambiguous ||= result === FIELD_MATCH_STATE.ambiguous
    }

    return ambiguous ? FIELD_MATCH_STATE.ambiguous : FIELD_MATCH_STATE.match
  }
}

export const evaluateFieldFilter = (
  meta: FieldFilterTarget,
  filter: FieldFilterAstV1 | undefined,
): FieldMatchState => compileFieldFilterEvaluator(filter)(meta)

export const compileFieldFilter = (
  filter: FieldFilter | undefined,
): ((fields: NoteFields | undefined) => boolean) => {
  const evaluate = compileFieldFilterEvaluator(filter)

  return (fields) => evaluate({ fields }) === FIELD_MATCH_STATE.match
}

export const matchesFieldFilter = (
  fields: NoteFields | undefined,
  filter: FieldFilter | undefined,
): boolean => {
  return compileFieldFilter(filter)(fields)
}
