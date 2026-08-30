import { deKebab } from '../slug'

type NamedFieldPart = { key: string; label?: string }

export const fieldDisplayName = (field: NamedFieldPart): string =>
  field.label?.trim() || deKebab(field.key) || 'Unnamed field'

export const fieldEnumOptionDisplayName = (option: NamedFieldPart): string =>
  option.label?.trim() || deKebab(option.key) || 'Empty value'

/** Human-name identity is deliberately narrower than slug identity: case and
 * edge whitespace do not create a second visible entity, while punctuation does. */
export const normalizeFieldDisplayName = (name: string): string =>
  name.normalize('NFC').trim().toLowerCase()
