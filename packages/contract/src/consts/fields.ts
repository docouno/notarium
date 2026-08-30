// The wire's copy of the field axis' protected keys. Why the seam carries two copies
// and which one answers for what is stated once, in the canon line below — restating it
// here is what put one sentence in three files, this one a line above the pointer to
// its own home.
// canon: docs/architecture.md#literals

/** Protected keys projected onto the note's own metadata. The field axis answers
 *  400 for them: they are not in the index's fields column, so a predicate over it
 *  would silently report "no matches" for a corpus that has them everywhere. */
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

/** Protected keys the fields column does carry — filterable, never declarable. */
export const INDEXED_PROTECTED_FIELD_KEYS = ['type', 'summary', 'muted', 'view'] as const

/** Every key a declaration or a field write is refused for. */
export const PROTECTED_FIELD_KEYS = [
  ...PROJECTED_FIELD_KEYS,
  ...INDEXED_PROTECTED_FIELD_KEYS,
] as const

export const FIELD_SCHEMA_VERSION = 1
export const FIELD_SCHEMA_MAX_BYTES = 64 * 1024
export const FIELD_SCHEMA_MAX_FIELDS = 128
export const FIELD_SCHEMA_MAX_VALUES = 256
export const FIELD_FACET_MAX_VALUES = 100
export const FIELD_FACET_DEFAULT_LIMIT = 24

export const FIELD_TYPE = {
  text: 'text',
  number: 'number',
  date: 'date',
  checkbox: 'checkbox',
  list: 'list',
  enum: 'enum',
} as const

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
