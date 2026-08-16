import { isMap, isScalar, type Pair, parseDocument, visit } from 'yaml'

import { isValidNoteId } from '../../id'
import {
  type FrontmatterEntry,
  frontmatterEntryValue,
  frontmatterScalar,
  parseFrontmatterBlock,
} from '../frontmatter'
import { nextPhysicalLineSpan, parseAtxH1Line } from '../title'
import {
  type ByteRange,
  DOCUMENT_ROLE,
  DOCUMENT_STATE_FORMAT,
  type DocumentAnalysisInput,
  type DocumentMutationIntent,
  type DocumentMutationPlan,
  type DocumentPatch,
  type DocumentRestoreCompatibility,
  type DocumentRole,
  type DocumentState,
  type DocumentStateFormat,
  type ExactOwnerObservation,
  type MarkdownProjection,
  type RestoreSafety,
  type SkillProjection,
  STORAGE_OWNER_KEY,
  type StorageOwnerClaim,
  type StorageOwnerKey,
  type StorageOwnerProof,
  type TitleOrigin,
} from './types'

const UTF8 = new TextEncoder()
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true })
const OWNER_KEYS = new Set<StorageOwnerKey>(Object.values(STORAGE_OWNER_KEY))
const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const WIKI_SKILL = /\[\[([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\]\]/g
const MAX_LINKED_SKILLS = 64
const MAX_SKILL_LINKS_METADATA = 8_192
const MAX_ORIGIN = 128
const MAX_ORIGIN_REVISION = 80
const MAX_INSTRUCTIONS = 262_144
export const MAX_SKILL_MANIFEST_BYTES = 16 * 1024
export const MAX_SKILL_FILE_BYTES = MAX_SKILL_MANIFEST_BYTES + MAX_INSTRUCTIONS

type FieldRange = {
  key: string
  entryRange: ByteRange
  valueRange: ByteRange | null
  value: unknown
  anchor?: string | null
}

type FrontmatterAnalysis = {
  block: ReturnType<typeof parseFrontmatterBlock>
  payloadStart: number
  payloadEnd: number
  fields: FieldRange[]
  projection: Record<string, unknown>
  yamlErrors: boolean
  ownerAnchorDependency: boolean
}

const cloneBytes = (bytes: Uint8Array): Uint8Array => Uint8Array.from(bytes)
const cloneEntry = (entry: FrontmatterEntry): FrontmatterEntry => ({
  key: entry.key,
  lines: [...entry.lines],
})

/** Generic note projection deliberately stays on Notarium's conservative frontmatter domain:
 * scalar/list values are strings, unsupported YAML shapes clear an earlier duplicate, and
 * authored bytes remain available through the carrier. The full YAML AST above owns validation,
 * dependency analysis and skill semantics; this adapter owns the stable application projection. */
const genericFrontmatterProjection = (
  entries: readonly FrontmatterEntry[] | undefined,
): Record<string, unknown> => {
  const projection: Record<string, unknown> = {}

  for (const entry of entries ?? []) {
    if (!entry.key || entry.key === 'title' || OWNER_KEYS.has(entry.key as StorageOwnerKey)) {
      continue
    }
    const value = frontmatterEntryValue(entry)

    if (value == null) {
      delete projection[entry.key]
    } else {
      projection[entry.key] = value
    }
  }

  return projection
}

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((value, index) => value === right[index])

const rangeValid = (range: ByteRange, size: number): boolean =>
  Number.isInteger(range.start) &&
  Number.isInteger(range.end) &&
  range.start >= 0 &&
  range.start <= range.end &&
  range.end <= size

const intersects = (left: ByteRange, right: ByteRange): boolean =>
  left.start < right.end && right.start < left.end

/** Every YAML range is UTF-16; persistence/materialization ranges are bytes. */
const utf16ByteOffsets = (text: string): number[] => {
  const offsets = new Array<number>(text.length + 1)
  let bytes = 0

  offsets[0] = 0
  for (let index = 0; index < text.length; index++) {
    const first = text.charCodeAt(index)

    if (first <= 0x7f) {
      bytes += 1
    } else if (first <= 0x7ff) {
      bytes += 2
    } else if (first >= 0xd800 && first <= 0xdbff) {
      const second = text.charCodeAt(index + 1)

      if (second < 0xdc00 || second > 0xdfff) {
        throw new Error('valid UTF-8 decoded to an unpaired surrogate')
      }
      offsets[index + 1] = bytes
      bytes += 4
      index++
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      throw new Error('valid UTF-8 decoded to an unpaired surrogate')
    } else {
      bytes += 3
    }
    offsets[index + 1] = bytes
  }

  return offsets
}

const byteRange = (offsets: readonly number[], start: number, end: number): ByteRange => {
  const byteStart = offsets[start]
  const byteEnd = offsets[end]

  if (byteStart == null || byteEnd == null) {
    throw new Error('parser returned a non-boundary range')
  }

  return { start: byteStart, end: byteEnd }
}

const firstLineEnd = (text: string): number => {
  const line = nextPhysicalLineSpan(text, 0)
  return line?.next ?? text.length
}

const frontmatterBounds = (
  text: string,
  bodyStart: number,
): { payloadStart: number; payloadEnd: number } => {
  const bom = text.startsWith('\uFEFF') ? 1 : 0
  const payloadStart = firstLineEnd(text.slice(bom)) + bom
  let cursor = payloadStart
  let payloadEnd = -1

  while (cursor < bodyStart) {
    const line = nextPhysicalLineSpan(text, cursor)

    if (!line) {
      break
    }
    if (text.slice(line.start, line.end).replace(/[ \t]+$/g, '') === '---') {
      payloadEnd = line.start
      break
    }
    cursor = line.next
  }
  if (payloadEnd < payloadStart) {
    throw new Error('frontmatter parser returned inconsistent bounds')
  }

  return { payloadStart, payloadEnd }
}

const entryRanges = (
  text: string,
  entries: readonly FrontmatterEntry[],
  payloadStart: number,
  offsets: readonly number[],
): Array<{ key: string | null; range: ByteRange }> => {
  const ranges: Array<{ key: string | null; range: ByteRange }> = []
  let cursor = payloadStart

  for (const entry of entries) {
    const start = cursor

    for (const expected of entry.lines) {
      const line = nextPhysicalLineSpan(text, cursor)

      if (!line || text.slice(line.start, line.end) !== expected) {
        throw new Error('frontmatter entry ranges do not match the source')
      }
      cursor = line.next
    }
    ranges.push({ key: entry.key, range: byteRange(offsets, start, cursor) })
  }

  return ranges
}

const pairKey = (pair: Pair): string | null =>
  isScalar(pair.key) && typeof pair.key.value === 'string' ? pair.key.value : null

const analyzeFrontmatter = (text: string, offsets: readonly number[]): FrontmatterAnalysis => {
  const block = parseFrontmatterBlock(text)

  if (!block) {
    return {
      block: null,
      payloadStart: 0,
      payloadEnd: 0,
      fields: [],
      projection: {},
      yamlErrors: false,
      ownerAnchorDependency: false,
    }
  }
  const { payloadStart, payloadEnd } = frontmatterBounds(text, block.bodyStart)
  const payload = text.slice(payloadStart, payloadEnd)
  const doc = parseDocument(payload, { prettyErrors: false, uniqueKeys: false })
  const entries = entryRanges(text, block.entries, payloadStart, offsets)
  const fields: FieldRange[] = []
  const anchored = new Map<string, ByteRange>()
  const aliases: Array<{ source: string; range: ByteRange }> = []

  visit(doc, {
    Node: (_key, node) => {
      if (node.range && 'anchor' in node && typeof node.anchor === 'string') {
        anchored.set(
          node.anchor,
          byteRange(offsets, payloadStart + node.range[0], payloadStart + node.range[2]),
        )
      }
    },
    Alias: (_key, node) => {
      if (node.range) {
        aliases.push({
          source: node.source,
          range: byteRange(offsets, payloadStart + node.range[0], payloadStart + node.range[2]),
        })
      }
    },
  })

  if (isMap(doc.contents)) {
    for (const item of doc.contents.items) {
      const key = pairKey(item)

      if (key == null) {
        continue
      }
      const keyRange = item.key && 'range' in item.key ? item.key.range : null
      const keyStart = keyRange
        ? byteRange(offsets, payloadStart + keyRange[0], payloadStart + keyRange[1]).start
        : null
      // Bind the semantic YAML pair to the physical entry that contains its key. Raw
      // frontmatter intentionally recognizes only plain keys, so matching by decoded key
      // would otherwise cross-wire a quoted key to a later plain-key occurrence.
      const rawEntry =
        keyStart == null
          ? undefined
          : entries.find((entry) => entry.range.start <= keyStart && keyStart < entry.range.end)
      const value = item.value
      const valueRange =
        value && 'range' in value && value.range
          ? byteRange(offsets, payloadStart + value.range[0], payloadStart + value.range[1])
          : null

      if (rawEntry) {
        fields.push({
          key,
          entryRange: rawEntry.range,
          valueRange,
          value: isScalar(value) ? value.value : value?.toJSON(),
          anchor: value && 'anchor' in value ? (value.anchor ?? null) : null,
        })
      }
    }
  }
  let projection: Record<string, unknown> = {}

  try {
    const value = doc.toJS({ maxAliasCount: 20 })

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      projection = value as Record<string, unknown>
    }
  } catch {
    // The exact source remains readable; only semantic projection is unavailable.
  }
  const ownerEntries = fields
    .filter((field) => OWNER_KEYS.has(field.key as StorageOwnerKey))
    .map((field) => field.entryRange)
  const ownerAnchorDependency = aliases.some((alias) => {
    const target = anchored.get(alias.source)
    return ownerEntries.some(
      (owner) => intersects(owner, alias.range) || (target != null && intersects(owner, target)),
    )
  })

  return {
    block,
    payloadStart,
    payloadEnd,
    fields,
    projection,
    yamlErrors: doc.errors.length > 0,
    ownerAnchorDependency,
  }
}

/** Observe the storage owner from the same exact source the engine is about to
 * mutate. Any ambiguity stays `unproven`; callers must never interpret parser
 * failure, duplicate mappings or non-scalars as an absent owner. */
export const exactOwnerObservation = (source: Uint8Array): ExactOwnerObservation => {
  let text: string
  let fm: FrontmatterAnalysis

  try {
    text = STRICT_UTF8.decode(source)
    fm = analyzeFrontmatter(text, utf16ByteOffsets(text))
  } catch {
    return { kind: 'unproven' }
  }

  // The generic Markdown parser treats a leading fence without a closing fence
  // as prose. Destructive identity decisions have a stricter boundary: such bytes
  // could be truncated frontmatter, so absence is not proven.
  if (!fm.block && /^\uFEFF?---[ \t]*(?:#[^\r\n]*)?(?:\r\n|\n|\r|$)/.test(text)) {
    return { kind: 'unproven' }
  }
  if (fm.yamlErrors || fm.ownerAnchorDependency) {
    return { kind: 'unproven' }
  }
  const owners = fm.fields.filter((field) => field.key === STORAGE_OWNER_KEY.id)

  if (owners.length === 0) {
    return { kind: 'absent' }
  }
  if (
    owners.length !== 1 ||
    owners[0].valueRange == null ||
    typeof owners[0].value !== 'string' ||
    !isValidNoteId(owners[0].value)
  ) {
    return { kind: 'unproven' }
  }

  return { kind: 'claimed', id: owners[0].value }
}

const validateProof = (
  proof: StorageOwnerProof | undefined,
  fields: readonly FieldRange[],
  size: number,
): StorageOwnerProof => {
  if (!proof || proof.version !== 1) {
    return { version: 1, claims: [] }
  }
  const claims: StorageOwnerClaim[] = []
  const seen = new Set<StorageOwnerKey>()

  for (const claim of proof.claims) {
    if (
      !OWNER_KEYS.has(claim.key) ||
      seen.has(claim.key) ||
      !claim.evidence ||
      (claim.evidence.kind !== 'mutation-receipt' && claim.evidence.kind !== 'audited-repair') ||
      !claim.evidence.id ||
      !rangeValid(claim.valueRange, size) ||
      !rangeValid(claim.entryRange, size)
    ) {
      continue
    }
    const field = fields.find(
      (candidate) =>
        candidate.key === claim.key &&
        candidate.valueRange != null &&
        candidate.valueRange.start === claim.valueRange.start &&
        candidate.valueRange.end === claim.valueRange.end &&
        candidate.entryRange.start === claim.entryRange.start &&
        candidate.entryRange.end === claim.entryRange.end,
    )

    if (!field) {
      continue
    }
    seen.add(claim.key)
    claims.push({
      ...claim,
      valueRange: { ...claim.valueRange },
      entryRange: { ...claim.entryRange },
      evidence: { ...claim.evidence },
    })
  }

  return {
    version: 1,
    claims,
    ...(proof.generatedContainer && claims.length ? { generatedContainer: true } : {}),
  }
}

const leadingH1 = (
  text: string,
  start: number,
  offsets: readonly number[],
): { title: string; range: ByteRange; lineEnd: number } | null => {
  let cursor = start
  let line = nextPhysicalLineSpan(text, cursor)

  while (line && text.slice(line.start, line.end).trim() === '') {
    cursor = line.next
    line = nextPhysicalLineSpan(text, cursor)
  }
  if (!line) {
    return null
  }
  const raw = text.slice(line.start, line.end).replace(/^\uFEFF/, '')
  const heading = parseAtxH1Line(raw)

  if (!heading) {
    return null
  }
  const titleStart = text.slice(line.start, line.end).indexOf(heading.rawTitle)

  if (titleStart < 0) {
    return null
  }

  return {
    title: heading.title,
    range: byteRange(
      offsets,
      line.start + titleStart,
      line.start + titleStart + heading.rawTitle.length,
    ),
    lineEnd: line.next,
  }
}

const legacyH1 = (
  text: string,
  start: number,
  offsets: readonly number[],
): { title: string; range: ByteRange; lineEnd: number } | null => {
  let cursor = start
  let line = nextPhysicalLineSpan(text, cursor)

  while (line) {
    if (text[line.start] === '#') {
      const heading = parseAtxH1Line(text.slice(line.start, line.end))

      if (heading) {
        const titleStart = text.slice(line.start, line.end).indexOf(heading.rawTitle)
        return {
          title: heading.title,
          range: byteRange(
            offsets,
            line.start + titleStart,
            line.start + titleStart + heading.rawTitle.length,
          ),
          lineEnd: line.next,
        }
      }
    }
    cursor = line.next
    line = nextPhysicalLineSpan(text, cursor)
  }

  return null
}

const titleProjection = (
  text: string,
  offsets: readonly number[],
  fm: FrontmatterAnalysis,
  fallback: string,
): { origin: TitleOrigin; bodyStart: number } => {
  const titleFields = fm.fields.filter((field) => field.key === 'title')
  const bodyStart = fm.block?.bodyStart ?? 0
  const first = leadingH1(text, bodyStart, offsets)

  if (
    titleFields.length === 1 &&
    typeof titleFields[0].value === 'string' &&
    titleFields[0].valueRange
  ) {
    const title = titleFields[0].value
    return {
      origin: {
        kind: 'frontmatter',
        title,
        valueRange: titleFields[0].valueRange,
        ...(first?.title === title ? { coupledH1Range: first.range } : {}),
      },
      bodyStart: first?.title === title ? first.lineEnd : bodyStart,
    }
  }
  if (first) {
    return {
      origin: { kind: 'hidden-h1', title: first.title, valueRange: first.range },
      bodyStart: first.lineEnd,
    }
  }
  const legacy = legacyH1(text, bodyStart, offsets)

  if (legacy) {
    return {
      origin: { kind: 'legacy-h1', title: legacy.title, valueRange: legacy.range },
      bodyStart,
    }
  }

  return { origin: { kind: 'path-fallback', title: fallback }, bodyStart }
}

const trimOneLeadingBlank = (text: string, start: number): number => {
  const line = nextPhysicalLineSpan(text, start)
  return line && text.slice(line.start, line.end).trim() === '' ? line.next : start
}

const metadataOf = (value: unknown): Record<string, string> | null => {
  if (value == null) {
    return {}
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const metadata: Record<string, string> = {}

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      return null
    }
    metadata[key] = entry
  }

  return metadata
}

const skillProjection = (
  fm: FrontmatterAnalysis,
  text: string,
  bodyStart: number,
  directoryName: string | undefined,
  sourceSize: number,
): SkillProjection | null => {
  if (!directoryName || sourceSize > MAX_SKILL_FILE_BYTES || fm.yamlErrors) {
    return null
  }
  const name = fm.projection.name
  const description = fm.projection.description
  const metadata = metadataOf(fm.projection.metadata)

  if (
    typeof name !== 'string' ||
    name.length > 64 ||
    !SKILL_NAME.test(name) ||
    name.includes('--') ||
    name !== directoryName ||
    typeof description !== 'string' ||
    !description.trim() ||
    description.length > 1024 ||
    !metadata
  ) {
    return null
  }
  if (
    (metadata['notarium.skills']?.length ?? 0) > MAX_SKILL_LINKS_METADATA ||
    (metadata['notarium.origin']?.length ?? 0) > MAX_ORIGIN ||
    (metadata['notarium.originRevision']?.length ?? 0) > MAX_ORIGIN_REVISION
  ) {
    return null
  }
  const instructions = text.slice(bodyStart).trim()

  if (instructions.length > MAX_INSTRUCTIONS) {
    return null
  }
  const linkedSkills = [
    ...new Set(
      [...(metadata['notarium.skills'] ?? '').matchAll(WIKI_SKILL)].map((entry) => entry[1]),
    ),
  ]

  if (linkedSkills.length > MAX_LINKED_SKILLS) {
    return null
  }

  return {
    name,
    description: description.trim(),
    metadata,
    instructions,
    linkedSkills,
    role: metadata['notarium.kind'] === 'role',
  }
}

const safetyOf = (fm: FrontmatterAnalysis, proof: StorageOwnerProof): RestoreSafety => {
  if (fm.yamlErrors) {
    return { status: 'unknown', reason: 'invalid-yaml' }
  }
  const duplicates = new Set<string>()
  const seen = new Set<string>()

  for (const field of fm.fields) {
    if (seen.has(field.key)) {
      duplicates.add(field.key)
    }
    seen.add(field.key)
  }
  if (duplicates.has('title') || [...OWNER_KEYS].some((key) => duplicates.has(key))) {
    return { status: 'blocked', reason: 'duplicate-target-mapping' }
  }
  if (proof.claims.length && fm.ownerAnchorDependency) {
    return { status: 'blocked', reason: 'owner-anchor-dependency' }
  }

  return { status: 'safe' }
}

const frame = (chunks: number[], bytes: Uint8Array): void => {
  const length = BigInt(bytes.byteLength)

  for (let shift = 56n; shift >= 0n; shift -= 8n) {
    chunks.push(Number((length >> shift) & 0xffn))
  }
  chunks.push(...bytes)
}

const fnvBytes = (bytes: Uint8Array): string => {
  let hash = 0xcbf29ce484222325n

  for (const byte of bytes) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }

  return hash.toString(16).padStart(16, '0')
}

const authoredSlices = (source: Uint8Array, proof: StorageOwnerProof): Uint8Array[] => {
  const excluded = proof.claims
    .map((claim) => (claim.ownership === 'entry' ? claim.entryRange : claim.valueRange))
    .sort((left, right) => left.start - right.start)
  const slices: Uint8Array[] = []
  let cursor = 0

  for (const range of excluded) {
    if (range.start < cursor) {
      continue
    }
    slices.push(source.slice(cursor, range.start))
    cursor = range.end
  }
  slices.push(source.slice(cursor))

  return slices
}

const fingerprintOf = (
  state: Pick<
    DocumentState,
    'format' | 'role' | 'source' | 'provenance' | 'restoreSafety' | 'pathFallbackTitle'
  >,
): string => {
  const chunks: number[] = []
  const add = (value: string | Uint8Array): void =>
    frame(chunks, typeof value === 'string' ? UTF8.encode(value) : value)

  add('notarium.document-state.fingerprint.v1')
  add(state.format)
  add(state.role)
  add(state.restoreSafety.status)
  add(state.restoreSafety.status === 'safe' ? '' : state.restoreSafety.reason)
  add(state.pathFallbackTitle ?? '')
  for (const claim of [...state.provenance.claims].sort((a, b) => a.key.localeCompare(b.key))) {
    add(claim.key)
    add(claim.ownership)
  }
  add(state.provenance.generatedContainer ? 'generated-container' : 'authored-container')
  for (const slice of authoredSlices(state.source, state.provenance)) {
    add(slice)
  }

  return `ds1:${fnvBytes(Uint8Array.from(chunks))}`
}

const opaqueState = (
  input: DocumentAnalysisInput,
  role: DocumentRole,
  source: Uint8Array,
): DocumentState => {
  const base = {
    format: DOCUMENT_STATE_FORMAT.opaque,
    role,
    source,
    provenance: { version: 1 as const, claims: [] },
    restoreSafety: { status: 'unknown' as const, reason: 'parser-range-uncertainty' as const },
    pathFallbackTitle: input.pathFallbackTitle ?? null,
    projection: null,
    ...(input.skillDirectoryName ? { skillDirectoryName: input.skillDirectoryName } : {}),
  }

  return { ...base, semanticFingerprint: fingerprintOf(base) }
}

export const analyzeDocumentState = (input: DocumentAnalysisInput): DocumentState => {
  const source = cloneBytes(input.source)
  const requestedRole = input.role ?? DOCUMENT_ROLE.generic
  let text: string

  try {
    text = STRICT_UTF8.decode(source)
  } catch {
    return opaqueState(
      input,
      requestedRole === DOCUMENT_ROLE.generic ? DOCUMENT_ROLE.opaque : requestedRole,
      source,
    )
  }
  const offsets = utf16ByteOffsets(text)
  let fm: FrontmatterAnalysis

  try {
    fm = analyzeFrontmatter(text, offsets)
  } catch {
    return opaqueState(input, requestedRole, source)
  }
  const proof = validateProof(input.ownerProof, fm.fields, source.byteLength)
  const fallback = input.pathFallbackTitle ?? ''
  const title = titleProjection(text, offsets, fm, fallback)
  const bodyCharStart = trimOneLeadingBlank(text, title.bodyStart)
  const bodyRange = byteRange(offsets, bodyCharStart, text.length)
  const frontmatterEntries = (fm.block?.entries ?? [])
    .filter((entry) => !entry.key || !OWNER_KEYS.has(entry.key as StorageOwnerKey))
    .map(cloneEntry)
  const projection: MarkdownProjection = {
    title: title.origin.title,
    body: text.slice(bodyCharStart),
    frontmatterEntries,
    frontmatter: genericFrontmatterProjection(fm.block?.entries),
    titleOrigin: title.origin,
    bodyRange,
  }
  let format: DocumentStateFormat = DOCUMENT_STATE_FORMAT.markdown
  const role = requestedRole

  if (requestedRole === DOCUMENT_ROLE.skillRoot) {
    const skill = skillProjection(
      fm,
      text,
      fm.block?.bodyStart ?? 0,
      input.skillDirectoryName,
      source.byteLength,
    )

    if (!skill || offsets[fm.payloadEnd] - offsets[fm.payloadStart] > MAX_SKILL_MANIFEST_BYTES) {
      return opaqueState(input, DOCUMENT_ROLE.skillRoot, source)
    }
    format = DOCUMENT_STATE_FORMAT.skill
    projection.title = skill.name
    projection.skill = skill
  }
  const base = {
    format,
    role,
    source,
    provenance: proof,
    restoreSafety: safetyOf(fm, proof),
    pathFallbackTitle: input.pathFallbackTitle ?? null,
    projection,
    ...(input.skillDirectoryName ? { skillDirectoryName: input.skillDirectoryName } : {}),
  }

  return { ...base, semanticFingerprint: fingerprintOf(base) }
}

/** Bind analyzer ranges to evidence issued by the physical authority. A caller cannot obtain
 * proof by value equality: it must name the receipt/repair and the ownership shape it performed. */
export const bindStorageOwnerProof = (input: {
  source: Uint8Array
  owners: ReadonlyArray<{ key: StorageOwnerKey; ownership: 'value' | 'entry' }>
  evidence: StorageOwnerClaim['evidence']
  generatedContainer?: boolean
}): StorageOwnerProof => {
  const text = STRICT_UTF8.decode(input.source)
  const offsets = utf16ByteOffsets(text)
  const fm = analyzeFrontmatter(text, offsets)
  const claims = input.owners.map(({ key, ownership }) => {
    const matches = fm.fields.filter((field) => field.key === key)

    if (matches.length !== 1 || !matches[0].valueRange) {
      throw new Error(`storage owner field is not a unique scalar: ${key}`)
    }

    return {
      key,
      ownership,
      valueRange: matches[0].valueRange,
      entryRange: matches[0].entryRange,
      evidence: { ...input.evidence },
    }
  })

  return {
    version: 1,
    claims,
    ...(input.generatedContainer ? { generatedContainer: true } : {}),
  }
}

const yamlScalarLike = (raw: string, value: string): string => {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return `'${value.replace(/'/g, "''")}'`
  }

  return frontmatterScalar(value)
}

const applyPatches = (source: Uint8Array, patches: readonly DocumentPatch[]): Uint8Array => {
  const ordered = [...patches].sort(
    (left, right) =>
      left.range.start - right.range.start ||
      left.range.end - left.range.start - (right.range.end - right.range.start),
  )
  let cursor = 0
  let size = source.byteLength

  for (const patch of ordered) {
    if (!rangeValid(patch.range, source.byteLength) || patch.range.start < cursor) {
      throw new Error('document patches overlap or escape the source')
    }
    size += patch.bytes.byteLength - (patch.range.end - patch.range.start)
    cursor = patch.range.end
  }
  const result = new Uint8Array(size)
  let read = 0
  let write = 0

  for (const patch of ordered) {
    result.set(source.slice(read, patch.range.start), write)
    write += patch.range.start - read
    result.set(patch.bytes, write)
    write += patch.bytes.byteLength
    read = patch.range.end
  }
  result.set(source.slice(read), write)

  return result
}

const patchScalar = (state: DocumentState, range: ByteRange, value: string): DocumentPatch => {
  const raw = STRICT_UTF8.decode(state.source.slice(range.start, range.end))
  return { range, bytes: UTF8.encode(yamlScalarLike(raw, value)) }
}

const insertionBeforeClosingFence = (
  state: DocumentState,
  lines: readonly string[],
): DocumentPatch => {
  const text = STRICT_UTF8.decode(state.source)
  const block = parseFrontmatterBlock(text)
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const payload = lines.join(eol)

  if (!block) {
    return {
      range: { start: 0, end: 0 },
      bytes: UTF8.encode(`---${eol}${payload}${eol}---${eol}`),
    }
  }
  const offsets = utf16ByteOffsets(text)
  const bounds = frontmatterBounds(text, block.bodyStart)
  return {
    range: byteRange(offsets, bounds.payloadEnd, bounds.payloadEnd),
    bytes: UTF8.encode(`${payload}${eol}`),
  }
}

const inlineStringList = (values: readonly string[]): string =>
  `[${values.map(frontmatterScalar).join(', ')}]`

/** A lossless lower planner. It mutates only selected byte ranges; equal and untouched channels
 * are returned byte-identical. Receipt binding of proposed owner proof belongs to the physical
 * authority, not this pure planner. */
export const planDocumentMutation = (
  state: DocumentState,
  intent: DocumentMutationIntent,
): DocumentMutationPlan => {
  if (!state.projection || state.format === DOCUMENT_STATE_FORMAT.opaque) {
    throw new Error('opaque source cannot be materialized as Markdown')
  }
  if (state.restoreSafety.status !== 'safe') {
    throw new Error(`document is not safely mutable: ${state.restoreSafety.reason}`)
  }
  const patches: DocumentPatch[] = []
  const insertions: string[] = []
  let pathFallbackTitle = state.pathFallbackTitle

  if (intent.title !== undefined && intent.title !== state.projection.title) {
    const origin = state.projection.titleOrigin

    if (origin.kind === 'path-fallback') {
      if ((intent.fallbackPolicy ?? 'title-derived') === 'title-derived') {
        pathFallbackTitle = intent.title
      } else {
        insertions.push(`title: ${frontmatterScalar(intent.title)}`)
        pathFallbackTitle = null
      }
    } else if (origin.kind === 'frontmatter') {
      patches.push(patchScalar(state, origin.valueRange, intent.title))
      if (origin.coupledH1Range) {
        patches.push({ range: origin.coupledH1Range, bytes: UTF8.encode(intent.title) })
      }
    } else {
      patches.push({ range: origin.valueRange, bytes: UTF8.encode(intent.title) })
    }
  }
  if (intent.body !== undefined && intent.body !== state.projection.body) {
    patches.push({ range: state.projection.bodyRange, bytes: UTF8.encode(intent.body) })
  }
  const text = STRICT_UTF8.decode(state.source)
  const offsets = utf16ByteOffsets(text)
  const frontmatter = analyzeFrontmatter(text, offsets)

  const patchProjection = (key: 'tags' | 'slug', value: string | null): void => {
    const matches = frontmatter.fields.filter((field) => field.key === key)

    if (matches.length > 1 || (matches.length === 1 && !matches[0].valueRange)) {
      throw new Error(`document has no unique scalar/list target for ${key}`)
    }
    const field = matches[0]

    if (value == null) {
      if (field) {
        patches.push({ range: field.entryRange, bytes: new Uint8Array() })
      }
    } else if (field?.valueRange) {
      patches.push({ range: field.valueRange, bytes: UTF8.encode(value) })
    } else {
      insertions.push(`${key}: ${value}`)
    }
  }

  if (intent.tags !== undefined) {
    patchProjection('tags', inlineStringList(intent.tags))
  }
  if (intent.slug !== undefined) {
    patchProjection('slug', intent.slug == null ? null : frontmatterScalar(intent.slug))
  }
  for (const [key, value] of Object.entries(intent.owners ?? {}) as Array<
    [StorageOwnerKey, string | null]
  >) {
    const claim = state.provenance.claims.find((candidate) => candidate.key === key)

    if (!claim) {
      if (value == null) {
        continue
      }
      insertions.push(`${key}: ${frontmatterScalar(value)}`)
      continue
    }
    if (value == null) {
      if (claim.ownership !== 'entry') {
        throw new Error(`cannot remove value-owned storage field: ${key}`)
      }
      patches.push({ range: claim.entryRange, bytes: new Uint8Array() })
    } else {
      patches.push(patchScalar(state, claim.valueRange, value))
    }
  }
  if (insertions.length) {
    patches.push(insertionBeforeClosingFence(state, insertions))
  }
  const source = applyPatches(state.source, patches)
  const candidate = analyzeDocumentState({
    source,
    role: state.role,
    pathFallbackTitle,
    skillDirectoryName: state.skillDirectoryName,
  })
  const candidateText = candidate.projection ? STRICT_UTF8.decode(candidate.source) : ''
  const candidateOffsets = candidate.projection ? utf16ByteOffsets(candidateText) : []
  const candidateFm = candidate.projection
    ? analyzeFrontmatter(candidateText, candidateOffsets)
    : null
  const proposedClaims = Object.keys(intent.owners ?? {}).flatMap((key) => {
    const owner = candidateFm?.fields.find((entry) => entry.key === key)
    const prior = state.provenance.claims.find((claim) => claim.key === key)

    return owner?.valueRange
      ? [
          {
            key: key as StorageOwnerKey,
            ownership: prior?.ownership ?? ('entry' as const),
            valueRange: owner.valueRange,
            entryRange: owner.entryRange,
          },
        ]
      : []
  })

  return {
    source: patches.length ? source : state.source,
    pathFallbackTitle,
    patches,
    proposedOwnerProof: {
      version: 1,
      claims: proposedClaims,
      ...(!frontmatter.block && proposedClaims.length ? { generatedContainer: true } : {}),
    },
  }
}

export const documentStateVersionToken = (state: DocumentState): string =>
  `v3:${state.semanticFingerprint.slice('ds1:'.length)}`

export const documentSourceText = (state: DocumentState): string | null => {
  try {
    return STRICT_UTF8.decode(state.source)
  } catch {
    return null
  }
}

export const sameDocumentSource = (left: DocumentState, right: DocumentState): boolean =>
  bytesEqual(left.source, right.source)

export const documentRestoreCompatibility = (
  historical: DocumentState,
  target: { role: DocumentRole; pathFallbackTitle: string | null },
): DocumentRestoreCompatibility => {
  if (historical.format === DOCUMENT_STATE_FORMAT.opaque || historical.projection == null) {
    return { status: 'non-restorable', reason: 'opaque-source' }
  }
  if (historical.restoreSafety.status !== 'safe') {
    return { status: 'non-restorable', reason: 'unsafe-source' }
  }
  if (historical.role !== target.role) {
    return { status: 'non-restorable', reason: 'role-mismatch' }
  }
  if (
    historical.projection.titleOrigin.kind === 'path-fallback' &&
    historical.pathFallbackTitle !== target.pathFallbackTitle
  ) {
    return { status: 'non-restorable', reason: 'path-fallback-mismatch' }
  }

  return { status: 'compatible' }
}
