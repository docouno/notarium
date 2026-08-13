import { createHash } from 'node:crypto'
import { parseDocument, stringify } from 'yaml'
import {
  analyzeDocumentState,
  DOCUMENT_ROLE,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_MANIFEST_BYTES,
  type SkillProjection,
} from '@notarium/core'

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
export { MAX_SKILL_FILE_BYTES, MAX_SKILL_MANIFEST_BYTES }
export type ParsedSkill = SkillProjection

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
