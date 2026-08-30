import {
  DOCUMENT_ROLE,
  type DocumentState,
  type FrontmatterEntry,
  frontmatterEntryValue,
  frontmatterHasYamlNodeReferences,
  frontmatterListEntry,
  frontmatterScalarEntry,
} from '../markdown'
import { FIELD_WRITE_ERROR_REASON, PROTECTED_FIELD_KEYS } from './consts'
import { isFieldCheckbox, isFieldNumber, isWritableFieldKey } from './predicates'
import type { FieldPatch } from './types'

export type FieldPatchEmission = { key: string; entry?: FrontmatterEntry }
type FieldEntrySlot = { entry: FrontmatterEntry; count: number }

const protectedKeys = new Set<string>(PROTECTED_FIELD_KEYS)
const skillRootKeys = new Set(['name', 'description'])

const protectedChannel: Record<(typeof PROTECTED_FIELD_KEYS)[number], string> = {
  'notarium-id': 'storage identity',
  'notarium-created': 'storage creation metadata',
  'notarium-source': 'the import source channel',
  title: 'title',
  type: 'noteType',
  tags: 'tags',
  aliases: 'rename/aliases',
  slug: 'slug',
  created: 'createdAt',
  summary: 'summary',
  muted: 'muted',
  view: 'the view marker',
}

class FieldWriteError extends Error {
  readonly isToolError = true

  constructor(
    message: string,
    readonly reason?: string,
  ) {
    super(message)
    this.name = 'FieldWriteError'
  }
}

export const fieldSchemaUnavailable = (detail: string): Error =>
  new FieldWriteError(
    `field schema is unavailable: ${detail}`,
    FIELD_WRITE_ERROR_REASON.fieldSchemaUnavailable,
  )

export const yamlNodeReferenceWriteError = (): Error =>
  new FieldWriteError(
    'frontmatter with YAML anchors or aliases is not supported by writes',
    FIELD_WRITE_ERROR_REASON.yamlNodeReference,
  )

/** Read-side affordance gate for the whole custom-field surface. It is stricter
 * than one addressed patch on purpose: a form must not advertise controls whose
 * first interaction is guaranteed to fail because the document cannot be safely
 * rewritten or contains an ambiguous authored key. */
export const fieldDocumentWriteError = (documentState?: DocumentState): string | undefined => {
  if (!documentState) {
    return 'document structure is unavailable'
  }
  if (documentState.restoreSafety.status !== 'safe') {
    return `document is unsafe: ${documentState.restoreSafety.reason}`
  }
  const entries = documentState.projection?.frontmatterEntries

  if (!entries) {
    return 'frontmatter structure is unavailable'
  }
  if (frontmatterHasYamlNodeReferences(entries)) {
    return 'frontmatter contains YAML anchors or aliases'
  }
  const counts = new Map<string, number>()

  for (const entry of entries) {
    if (entry.key && isWritableFieldKey(entry.key) && !protectedKeys.has(entry.key)) {
      const count = (counts.get(entry.key) ?? 0) + 1

      if (count > 1) {
        return `field "${entry.key}" occurs more than once in frontmatter`
      }
      counts.set(entry.key, count)
    }
  }

  return undefined
}

export const fieldPatchEmissions = (
  fields: FieldPatch,
  fieldsUnquoted: readonly string[] = [],
): FieldPatchEmission[] => {
  const unquoted = new Set(fieldsUnquoted)

  return Object.getOwnPropertyNames(fields).map((key) => {
    const value = fields[key]

    if (value === null) {
      return { key }
    }
    if (Array.isArray(value)) {
      return { key, entry: frontmatterListEntry(key, value) }
    }
    const raw = unquoted.has(key) && (isFieldNumber(value) || isFieldCheckbox(value))
    return { key, entry: frontmatterScalarEntry(key, value, { unquoted: raw }) }
  })
}

/** Apply serializeNoteFile's put/drop semantics to a raw entry sequence. */
export const applyFieldPatchEntries = (
  source: readonly FrontmatterEntry[] | undefined,
  emissions: readonly FieldPatchEmission[],
): FrontmatterEntry[] => {
  const wanted = new Map(emissions.map((emission) => [emission.key, emission.entry]))
  const placed = new Set<string>()
  const entries: FrontmatterEntry[] = []

  for (const entry of source ?? []) {
    if (entry.key === null || !wanted.has(entry.key)) {
      entries.push({ key: entry.key, lines: [...entry.lines] })
      continue
    }
    const key = entry.key
    const replacement = wanted.get(key)

    if (replacement && !placed.has(key)) {
      entries.push({ key: replacement.key, lines: [...replacement.lines] })
      placed.add(key)
    }
  }
  for (const emission of emissions) {
    if (emission.entry && !placed.has(emission.key)) {
      entries.push({ key: emission.entry.key, lines: [...emission.entry.lines] })
      placed.add(emission.key)
    }
  }

  return entries
}

const indexFieldEntries = (entries: readonly FrontmatterEntry[]): Map<string, FieldEntrySlot> => {
  const indexed = new Map<string, FieldEntrySlot>()

  for (const entry of entries) {
    if (entry.key === null) {
      continue
    }
    const current = indexed.get(entry.key)

    if (current) {
      current.count += 1
    } else {
      indexed.set(entry.key, { entry, count: 1 })
    }
  }

  return indexed
}

const patchChangesIndex = (
  fields: FieldPatch,
  currentByKey: ReadonlyMap<string, FieldEntrySlot>,
): boolean =>
  Object.getOwnPropertyNames(fields).some((key) => {
    const current = currentByKey.get(key)?.entry
    const wanted = fields[key]

    if (wanted === null) {
      return current !== undefined
    }
    if (!current) {
      return true
    }
    const value = frontmatterEntryValue(current)

    return Array.isArray(wanted)
      ? !Array.isArray(value) ||
          wanted.length !== value.length ||
          wanted.some((item, index) => item !== value[index])
      : value !== wanted
  })

export const fieldPatchChangesEntries = (
  fields: FieldPatch,
  entries: readonly FrontmatterEntry[],
): boolean => patchChangesIndex(fields, indexFieldEntries(entries))

const protectedFieldError = (key: string, channel: string): FieldWriteError =>
  new FieldWriteError(
    `field "${key}" is protected; use ${channel} instead`,
    FIELD_WRITE_ERROR_REASON.protectedFieldKey,
  )

/** Refuse any point patch that would reinterpret or erase bytes we cannot
 * address exactly. Repository engines call this at their own mutation boundary;
 * semantic ops may call it earlier only to make an honest no-op decision. */
const assertFieldPatchWritableIndexed = (
  fields: FieldPatch | undefined,
  documentState?: DocumentState,
  opts?: { frontmatterMode?: 'replace' },
): Map<string, FieldEntrySlot> | undefined => {
  if (fields === undefined) {
    return undefined
  }
  if (opts?.frontmatterMode === 'replace') {
    throw new FieldWriteError('fields cannot be combined with frontmatter replacement')
  }
  const keys = Object.getOwnPropertyNames(fields)

  for (const key of keys) {
    if (!isWritableFieldKey(key)) {
      throw new FieldWriteError(`field "${key}" is not a safe plain YAML mapping key`)
    }
    if (protectedKeys.has(key)) {
      throw protectedFieldError(key, protectedChannel[key as (typeof PROTECTED_FIELD_KEYS)[number]])
    }
    if (documentState?.role === DOCUMENT_ROLE.skillRoot && skillRootKeys.has(key)) {
      throw protectedFieldError(key, 'the Agent Skill editor')
    }
  }

  if (documentState && documentState.restoreSafety.status !== 'safe') {
    throw new FieldWriteError(
      `field write refused because the document is unsafe: ${documentState.restoreSafety.reason}`,
      `${FIELD_WRITE_ERROR_REASON.unsafeDocument}:${documentState.restoreSafety.reason}`,
    )
  }
  const entries = documentState?.projection?.frontmatterEntries

  if (!entries) {
    return undefined
  }
  if (frontmatterHasYamlNodeReferences(entries)) {
    throw yamlNodeReferenceWriteError()
  }
  const addressedByKey = indexFieldEntries(entries)

  for (const key of keys) {
    const addressed = addressedByKey.get(key)

    if (addressed && addressed.count > 1) {
      throw new FieldWriteError(
        `field "${key}" occurs more than once in frontmatter`,
        FIELD_WRITE_ERROR_REASON.duplicateFieldKey,
      )
    }
    if (addressed && frontmatterEntryValue(addressed.entry) === null) {
      throw new FieldWriteError(
        `field "${key}" has a value that cannot be edited without losing bytes`,
        FIELD_WRITE_ERROR_REASON.unreadableFieldValue,
      )
    }
  }

  return addressedByKey
}

export const assertFieldPatchWritable = (
  fields: FieldPatch | undefined,
  documentState?: DocumentState,
  opts?: { frontmatterMode?: 'replace' },
): void => {
  assertFieldPatchWritableIndexed(fields, documentState, opts)
}

/** Validate the semantic-op point intent and decide its no-op status from the same
 * one-pass entry index. The storage boundary still validates independently. */
export const validatedFieldPatchChanges = (
  fields: FieldPatch,
  documentState?: DocumentState,
): boolean => {
  const indexed = assertFieldPatchWritableIndexed(fields, documentState)

  if (Object.getOwnPropertyNames(fields).length === 0) {
    return false
  }

  return indexed ? patchChangesIndex(fields, indexed) : true
}
