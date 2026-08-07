import { createHash } from 'node:crypto'
import { parseDocument, stringify } from 'yaml'

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const WIKI_SKILL = /\[\[([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\]\]/g
const MAX_LINKED_SKILLS = 64
const MAX_SKILL_LINKS_METADATA = 8_192
const MAX_ORIGIN = 128
const MAX_ORIGIN_REVISION = 80
const MAX_INSTRUCTIONS = 262_144
export const MAX_SKILL_MANIFEST_BYTES = 16 * 1024
/** A raw-byte cap in addition to the instruction character cap. Keeping it
 * shared makes catalog acceptance, owned discovery, and activation identical. */
export const MAX_SKILL_FILE_BYTES = MAX_SKILL_MANIFEST_BYTES + MAX_INSTRUCTIONS

export type ParsedSkill = {
  name: string
  description: string
  metadata: Record<string, string>
  instructions: string
  linkedSkills: string[]
  role: boolean
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
 * metadata. The directory-name match is enforced by the package reader. */
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
  const label = `${directoryName}/SKILL.md`
  const frontmatter = parseMap(match[1], label)
  const name = frontmatter.name
  const description = frontmatter.description

  if (
    typeof name !== 'string' ||
    name.length > 64 ||
    !SKILL_NAME.test(name) ||
    name.includes('--') ||
    name !== directoryName
  ) {
    throw new Error(`${label}: name must match its Agent Skill directory`)
  }
  if (typeof description !== 'string' || !description.trim() || description.length > 1024) {
    throw new Error(`${label}: description must contain 1-1024 characters`)
  }
  const metadata = metadataOf(frontmatter.metadata, label)
  const skillLinks = metadata['notarium.skills'] ?? ''

  if (skillLinks.length > MAX_SKILL_LINKS_METADATA) {
    throw new Error(`${label}: metadata.notarium.skills is too long`)
  }
  if ((metadata['notarium.origin']?.length ?? 0) > MAX_ORIGIN) {
    throw new Error(`${label}: metadata.notarium.origin is too long`)
  }
  if ((metadata['notarium.originRevision']?.length ?? 0) > MAX_ORIGIN_REVISION) {
    throw new Error(`${label}: metadata.notarium.originRevision is too long`)
  }
  const linkedSkills = [...skillLinks.matchAll(WIKI_SKILL)].map((entry) => entry[1])
  const uniqueLinkedSkills = [...new Set(linkedSkills)]

  if (uniqueLinkedSkills.length > MAX_LINKED_SKILLS) {
    throw new Error(`${label}: at most ${MAX_LINKED_SKILLS} linked skills are supported`)
  }

  const instructions = raw.slice(match[0].length).trim()

  if (instructions.length > MAX_INSTRUCTIONS) {
    throw new Error(`${label}: instructions are too long`)
  }

  return {
    name,
    description: description.trim(),
    metadata,
    instructions,
    linkedSkills: uniqueLinkedSkills,
    role: metadata['notarium.kind'] === 'role',
  }
}

export const withBuiltinProvenance = (
  raw: string,
  directoryName: string,
  revision: string,
): string => {
  const match = FRONTMATTER.exec(raw)

  if (!match) {
    throw new Error(`${directoryName}/SKILL.md: YAML frontmatter is required`)
  }
  const frontmatter = parseMap(match[1], `${directoryName}/SKILL.md`)
  const metadata = metadataOf(frontmatter.metadata, `${directoryName}/SKILL.md`)
  frontmatter.metadata = {
    ...metadata,
    'notarium.origin': `builtin:${directoryName}`,
    'notarium.originRevision': revision,
  }
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${raw.slice(match[0].length).trimStart()}`
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
