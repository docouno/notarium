// The implicit frontmatter note-type — a note with unset `type:` carries this; the single source
// shared by web drafts and the engine store fallbacks. Must stay lowercase (the omission and
// badge-hiding checks compare against it). NOTE: the SQLite `note_type` DDL default is a FROZEN
// migration-baseline literal (schema.ts) deliberately NOT wired to this const — interpolating a
// mutable const would change the baseline bytes and break migration determinism; the store always
// writes an explicit note_type, so keep the two in sync by hand if this value ever changes.
export const DEFAULT_NOTE_TYPE = 'note'

/** The typed note-type channel is human-authored scalar metadata, but every
 * engine/list projection must expose one canonical primary value immediately.
 * Undefined remains a channel concern at the caller; once addressed, blank means
 * the implicit type and edge whitespace is never part of the identity. */
export const normalizeNoteType = (value: string): string => value.trim() || DEFAULT_NOTE_TYPE
