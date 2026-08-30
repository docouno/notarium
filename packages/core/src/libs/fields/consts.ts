// The field axis' fixed vocabulary.
// canon: docs/note-model.md#note-ontology

/** Maximum UTF-8 bytes of one note's SERIALIZED fields blob — the whole object,
 *  both name lists and both counters included, not a per-key or per-value budget.
 *  The parser already caps a frontmatter block at 64 KiB, which without this
 *  would be the snapshot's per-note memory ceiling. */
export const FIELDS_BLOB_BYTE_CAP = 4096

export const FIELD_FACET_MIN_NOTES = 10
export const FIELD_FACET_MAX_VALUES = 100

export const FIELD_SCHEMA_VERSION = 1

/** One schema document is read on ordinary field-aware surfaces. Keep both its
 * byte cost and its structural fan-out bounded independently. */
export const FIELD_SCHEMA_MAX_BYTES = 64 * 1024
export const FIELD_SCHEMA_MAX_FIELDS = 128
export const FIELD_SCHEMA_MAX_VALUES = 256

/** Machine-readable refusal reasons owned by the field write contract. The
 * KnowledgeStore vocabulary reuses this object rather than duplicating strings. */
export const FIELD_WRITE_ERROR_REASON = {
  protectedFieldKey: 'protected_field_key',
  unreadableFieldValue: 'unreadable_field_value',
  duplicateFieldKey: 'duplicate_field_key',
  unsafeDocument: 'unsafe_document',
  yamlNodeReference: 'yaml_node_reference',
  frontmatterTooLarge: 'frontmatter_too_large',
  fieldSchemaUnavailable: 'field_schema_unavailable',
} as const

export const FIELD_TYPE = {
  text: 'text',
  number: 'number',
  date: 'date',
  checkbox: 'checkbox',
  list: 'list',
  enum: 'enum',
} as const

/** Semantic palette names persisted in schema.yaml. CSS owns their themed
 * values; keeping names semantic makes future additions migration-free. */
export const FIELD_COLOR = {
  slate: 'slate',
  red: 'red',
  orange: 'orange',
  amber: 'amber',
  green: 'green',
  teal: 'teal',
  blue: 'blue',
  violet: 'violet',
} as const

export type FieldType = (typeof FIELD_TYPE)[keyof typeof FIELD_TYPE]
export type FieldColor = (typeof FIELD_COLOR)[keyof typeof FIELD_COLOR]

/** Protected keys the note projects onto metadata of its own (title, tags, dates,
 *  the storage-owned id/created pair). They never enter the fields column: a
 *  predicate over it would answer "no such value" for the whole corpus. */
export const PROJECTED_FIELD_KEYS = [
  'notarium-id',
  'notarium-created',
  'notarium-source',
  'title',
  'tags',
  'aliases',
  'slug',
  'created',
] as const

/** Protected keys that DO ride the fields column: the note has no metadata field
 *  for them, so the column is the only place a filter could read them from. */
export const INDEXED_PROTECTED_FIELD_KEYS = ['type', 'summary', 'muted', 'view'] as const

/** Every key a human may not declare as a field and an agent may not write
 *  through the field channel — the two subgroups above, which differ only in
 *  whether the index carries them. */
export const PROTECTED_FIELD_KEYS = [
  ...PROJECTED_FIELD_KEYS,
  ...INDEXED_PROTECTED_FIELD_KEYS,
] as const

const PROJECTED = new Set<string>(PROJECTED_FIELD_KEYS)

/** Does this authored key stay out of the index's fields column? */
export const isProjectedFieldKey = (key: string): boolean => PROJECTED.has(key)
