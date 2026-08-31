import type { FieldColor, FieldType } from './consts'

export type FieldEnumOption = {
  key: string
  label?: string
  color?: FieldColor
}

export type FieldDeclaration = {
  key: string
  type: FieldType
  label?: string
  card?: boolean
  values?: FieldEnumOption[]
}

export type FieldSchema = {
  version: number
  fields: FieldDeclaration[]
}

export type FieldClause = {
  op: 'or'
  ns: 'note'
  key: string
  values: Array<
    | { kind: 'eq'; value: string }
    | { kind: 'day'; value: string }
    | { kind: 'present' }
    | { kind: 'unreadable' }
  >
}

export type FieldFilterAstV1 = {
  op: 'and'
  nodes: FieldClause[]
}

/** Compatibility name for the existing REST/MCP field-filter surface. */
export type FieldFilter = FieldFilterAstV1

export type FieldValue = string | string[] | null

/** Point patch over authored frontmatter. Missing keys stay untouched; null
 * removes the addressed key, while empty strings and lists remain values. */
export type FieldPatch = Record<string, FieldValue>

/** One note's authored frontmatter as the index carries it — the shape of the
 *  `fields` column, of `NoteMeta.fields`, and of the same blob on the wire.
 *  Author keys live one level down, so they can never collide with the fixed
 *  ones; empty lists and zero counters are omitted so the serialization is
 *  byte-stable. */
export type NoteFields = {
  /** Author key → its projected value. Built on a null prototype: an authored
   *  `__proto__` must be an own property on both sides, and a "key is present"
   *  predicate must not answer true for `toString`. */
  keys: Record<string, string | string[]>
  /** Keys present in the file whose value the parser cannot project. */
  unreadable?: string[]
  /** Keys whose NAME did not fit the blob either, on top of `unreadable`. */
  unreadableMore?: number
  /** Keys whose value the byte cap dropped; the name still indexes. */
  truncated?: string[]
  /** Keys whose NAME did not fit the blob either, on top of `truncated`. */
  truncatedMore?: number
}

/** Authored fields for one note detail: values and unreadable names are complete,
 * while truncation metadata describes what the capped index projection omitted. */
export type NoteDetailFields = NoteFields & {
  /** Every authored frontmatter key in its first authored position, including
   * keys projected onto dedicated note metadata. */
  order: string[]
}
