import { createHash } from 'node:crypto'
import { parseDocument, stringify } from 'yaml'
import {
  analyzeDocumentState,
  DOCUMENT_ROLE,
  type FrontmatterEntry,
  frontmatterEntryOf,
  isDurableFrontmatter,
  isGeneratedNoteId,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_MANIFEST_BYTES,
  NOTE_ID_FRONTMATTER_KEY,
  parseFrontmatterBlock,
  type SkillProjection,
  STORAGE_OWNER_KEY,
} from '@notarium/core'

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
export { MAX_SKILL_FILE_BYTES, MAX_SKILL_MANIFEST_BYTES }
export type ParsedSkill = SkillProjection
export type BundledAbilityIdentity = {
  source: 'system' | 'catalog'
  packageId: string
}

const parseMap = (raw: string, label: string): Record<string, unknown> => {
  const doc = parseDocument(raw, { prettyErrors: false })

  if (doc.errors.length) {
    throw new Error(`${label}: invalid YAML frontmatter`)
  }
  const value = doc.toJS({ maxAliasCount: 20 })

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}: frontmatter must be a mapping`)
  }

  return value as Record<string, unknown>
}

const metadataOf = (value: unknown, label: string): Record<string, string> => {
  if (value == null) {
    return {}
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}: metadata must be a string mapping`)
  }
  const metadata: Record<string, string> = {}

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      throw new Error(`${label}: metadata.${key} must be a string`)
    }
    metadata[key] = entry
  }

  return metadata
}

/** Parse the open Agent Skills SKILL.md format plus Notarium's namespaced
 * metadata. The package position establishes the role; its directory is storage
 * identity and deliberately independent from the editable manifest name. */
export const parseSkillFile = (raw: string, directoryName: string): ParsedSkill => {
  if (Buffer.byteLength(raw, 'utf8') > MAX_SKILL_FILE_BYTES) {
    throw new Error(`${directoryName}/SKILL.md: file is too large`)
  }
  const match = FRONTMATTER.exec(raw)

  if (!match) {
    throw new Error(`${directoryName}/SKILL.md: YAML frontmatter is required`)
  }
  if (Buffer.byteLength(match[0], 'utf8') > MAX_SKILL_MANIFEST_BYTES) {
    throw new Error(`${directoryName}/SKILL.md: YAML frontmatter is too large`)
  }
  const state = analyzeDocumentState({
    source: new TextEncoder().encode(raw),
    role: DOCUMENT_ROLE.skillRoot,
    skillDirectoryName: directoryName,
  })
  const skill = state.projection?.skill

  if (!skill) {
    throw new Error(`${directoryName}/SKILL.md: invalid Agent Skill manifest`)
  }

  return skill
}

export const bundledAbilityIdentityOf = (
  skill: SkillProjection,
  label: string,
): BundledAbilityIdentity => {
  const source = skill.metadata['notarium.source']
  const packageId = skill.metadata['notarium.package-id']

  if (
    (source !== 'system' && source !== 'catalog') ||
    !packageId ||
    !isGeneratedNoteId(packageId)
  ) {
    throw new Error(`${label}: bundled source and package id are required`)
  }

  return { source, packageId }
}

export const withCatalogProvenance = (
  raw: string,
  catalogPackageId: string,
  revision: string,
  noteId?: string,
): string => {
  const match = FRONTMATTER.exec(raw)

  if (!match) {
    throw new Error('SKILL.md: YAML frontmatter is required')
  }
  const frontmatter = parseMap(match[1], 'SKILL.md')
  const metadata = metadataOf(frontmatter.metadata, 'SKILL.md')
  delete metadata['notarium.source']
  delete metadata['notarium.package-id']
  frontmatter.metadata = {
    ...metadata,
    'notarium.origin': `catalog:${catalogPackageId}`,
    'notarium.originRevision': revision,
  }
  if (noteId) {
    frontmatter[NOTE_ID_FRONTMATTER_KEY] = noteId
  }

  return `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${raw.slice(match[0].length).trimStart()}`
}

/** Re-address one authored SKILL.md as a NEW package: the note id is the only thing
 * that may not be shared, because two notes claiming one id is a collision the
 * identity engine arbitrates rather than a copy. Everything else — the authored H1
 * that IS the title, description, metadata, links — is carried verbatim, which is
 * what makes a copy a starting point instead of a reconstruction. */
export const withFreshNoteId = (raw: string, noteId: string): string => {
  const match = FRONTMATTER.exec(raw)

  if (!match) {
    throw new Error('SKILL.md: YAML frontmatter is required')
  }
  const frontmatter = parseMap(match[1], 'SKILL.md')
  frontmatter[NOTE_ID_FRONTMATTER_KEY] = noteId

  return `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${raw.slice(match[0].length).trimStart()}`
}

export const withSkillLinks = (raw: string, links: readonly string[]): string => {
  const match = FRONTMATTER.exec(raw)

  if (!match) {
    throw new Error('SKILL.md: YAML frontmatter is required')
  }
  const frontmatter = parseMap(match[1], 'SKILL.md')
  const metadata = metadataOf(frontmatter.metadata, 'SKILL.md')
  frontmatter.metadata = { ...metadata, 'notarium.skills': links.join(' ') }

  return `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${raw.slice(match[0].length).trimStart()}`
}

/** Which of these tokens the frontmatter channel cannot write back, in the author's own
 *  spelling. Empty means the whole list round-trips.
 *
 *  WHY THIS EXISTS AS ITS OWN ANSWER. The wire carries every token the PARSER produces —
 *  that is the point of the `invalid` arm: an unrecognisable token travels verbatim and
 *  goes back to the file unchanged. Writing is narrower, and by a rule that is not ours:
 *  `yaml.stringify` escapes C0 into `\0`/`\x1f`, but puts `U+007F`, C1, NEL, LS and PS
 *  into quotes RAW, and the durable-frontmatter gate then refuses the line. It also folds
 *  a long quoted scalar around column 80 and can split a surrogate pair doing it.
 *
 *  So reading opened wider than writing, and the seam showed as a bare 400 from a gate
 *  three layers down that knows nothing about attachments. Answered HERE instead, next
 *  to the two writers, so both refuse in the same words and name the token.
 *
 *  Deliberately asks the real writer rather than restating its rule: the ban lives in
 *  `isDurableFrontmatter`, the folding lives in `stringify`, and a second copy of either
 *  would drift the first time `yaml` changes a default. */
export const unwritableSkillLinks = (links: readonly string[]): string[] =>
  links.filter((link) => !isDurableFrontmatter([skillLinksMetadataEntry([], [link])]))

/** Replace only the authored `metadata:` entry used by a Role attachment edit.
 * The note engine merges this entry by key, leaving every unrelated raw
 * frontmatter entry byte-for-byte intact. */
export const skillLinksMetadataEntry = (
  entries: readonly FrontmatterEntry[],
  links: readonly string[],
): FrontmatterEntry => {
  const current = frontmatterEntryOf(entries, 'metadata')
  const root = current ? parseMap(current.lines.join('\n'), 'SKILL.md metadata') : {}
  const metadata = metadataOf(root.metadata, 'SKILL.md')

  if (links.length) {
    metadata['notarium.skills'] = links.join(' ')
  } else {
    delete metadata['notarium.skills']
  }
  const lines = stringify({ metadata }).trimEnd().split('\n')

  return { key: 'metadata', lines }
}

/** Exact authored bytes used when deciding whether an installed dependency is
 * the same catalog fork. Storage identity differs per fork and is not content. */
export const authoredSkillFile = (raw: string): string => {
  const block = parseFrontmatterBlock(raw)

  if (!block) {
    return raw
  }
  const storageKeys = new Set<string>(Object.values(STORAGE_OWNER_KEY))
  const payload = block.entries
    .filter((entry) => entry.key == null || !storageKeys.has(entry.key))
    .flatMap((entry) => entry.lines)
    .join('\n')

  return `---\n${payload}\n---\n${raw.slice(block.bodyStart)}`
}

export const hasCatalogProvenance = (skill: SkillProjection): boolean => {
  const origin = skill.metadata['notarium.origin']
  const revision = skill.metadata['notarium.originRevision']
  const packageId = origin?.startsWith('catalog:') ? origin.slice('catalog:'.length) : ''

  return isGeneratedNoteId(packageId) && /^sha256:[a-f0-9]{64}$/.test(revision ?? '')
}

export const packageRevision = (files: ReadonlyMap<string, Uint8Array>): string => {
  const hash = createHash('sha256')

  const frame = (bytes: Uint8Array): void => {
    const length = Buffer.allocUnsafe(8)
    length.writeBigUInt64BE(BigInt(bytes.byteLength))
    hash.update(length)
    hash.update(bytes)
  }

  for (const name of [...files.keys()].sort()) {
    frame(Buffer.from(name, 'utf8'))
    frame(files.get(name)!)
  }

  return `sha256:${hash.digest('hex')}`
}
