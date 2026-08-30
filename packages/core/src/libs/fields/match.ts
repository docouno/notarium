import { isFieldDate } from './predicates'
import type { FieldClause, FieldFilter, NoteFields } from './types'

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

export const compileFieldFilter = (
  filter: FieldFilter | undefined,
): ((fields: NoteFields | undefined) => boolean) => {
  if (!filter || filter.nodes.length === 0) {
    return () => true
  }
  const clauses = filter.nodes.map(compileClause)
  const needsNames = clauses.some((clause) => clause.present || clause.unreadable)

  return (fields) => {
    if (!fields) {
      return false
    }
    const unreadable = needsNames ? new Set(fields.unreadable ?? []) : undefined
    const truncated = needsNames ? new Set(fields.truncated ?? []) : undefined

    return clauses.every((clause) => {
      const hasValue = Object.hasOwn(fields.keys, clause.key)

      if (
        clause.present &&
        (hasValue || unreadable?.has(clause.key) || truncated?.has(clause.key))
      ) {
        return true
      }
      if (clause.unreadable && unreadable?.has(clause.key)) {
        return true
      }
      if (!hasValue || (clause.equality.size === 0 && clause.days.size === 0)) {
        return false
      }
      const value = fields.keys[clause.key]

      if (Array.isArray(value)) {
        return value.length === 0
          ? clause.equality.has('')
          : value.some((item) => clause.equality.has(item) || matchesDay(clause.days, item))
      }

      return clause.equality.has(value) || matchesDay(clause.days, value)
    })
  }
}

export const matchesFieldFilter = (
  fields: NoteFields | undefined,
  filter: FieldFilter | undefined,
): boolean => {
  return compileFieldFilter(filter)(fields)
}
