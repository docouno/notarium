import { isMap, isScalar, type Pair, parseDocument, visit } from 'yaml'

import { isValidNoteId } from '../../id'
import {
  type FrontmatterBlock,
  frontmatterBlockEol,
  type FrontmatterEntry,
  frontmatterEntrySpans,
  frontmatterEntryValue,
  frontmatterPayloadBounds,
  frontmatterScalar,
  parseFrontmatterBlock,
} from '../frontmatter'
import { nextPhysicalLineSpan, parseAtxH1Line } from '../title'
import { isSkillName, parseSkillLinks } from './skillLinks'
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
/** The ONE decoding of a document's bytes, and it has to be LOSSLESS, not merely valid.
 * Everything below reads the text and then names byte ranges in the source it came from,
 * so a decoder that drops input silently puts the two in different coordinate systems and
 * every range afterwards points at the wrong bytes. `TextDecoder` does exactly that by
 * default: `ignoreBOM` is false, which means "consume a leading BOM and do not emit it".
 * Those three missing bytes made the planner splice its patch into the middle of the
 * preceding entry — and where the wreckage still parsed as YAML, nothing downstream
 * objected and the document lost the owner key the write existed to add. */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
/** A byte-order mark is the file's encoding prologue, not document content: exactly one
 * leads the source, no projection channel carries it, and every mutation writes around
 * it. A second U+FEFF is ordinary content — and `FM_OPEN` agrees, refusing to read a
 * frontmatter block behind it. */
const BOM = '\uFEFF'
const afterBom = (text: string): number => (text.startsWith(BOM) ? BOM.length : 0)
const OWNER_KEYS = new Set<StorageOwnerKey>(Object.values(STORAGE_OWNER_KEY))
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
  /** The document PARSED, but its semantic projection could not be built — an unresolved
   * alias is the shape that produces it. Distinct from `yamlErrors`: the source stays
   * perfectly readable, and only the meaning is gone. Deliberately not an input to
   * `safetyOf`: that value is hashed into stored revisions, so widening it would make
   * already-written blobs unreadable. */
  projectionFailed: boolean
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

/** The parser owns the block's character geometry; this file owns the translation of it
 * into the byte coordinates persistence and materialization speak. */
const entryRanges = (
  text: string,
  block: FrontmatterBlock,
  offsets: readonly number[],
): Array<{ key: string | null; range: ByteRange }> =>
  frontmatterEntrySpans(text, block).map((span) => ({
    key: span.key,
    range: byteRange(offsets, span.start, span.end),
  }))

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
      projectionFailed: false,
      ownerAnchorDependency: false,
    }
  }
  const { payloadStart, payloadEnd } = frontmatterPayloadBounds(text, block.bodyStart)
  const payload = text.slice(payloadStart, payloadEnd)
  const doc = parseDocument(payload, { prettyErrors: false, uniqueKeys: false })
  const entries = entryRanges(text, block, offsets)
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
  let projectionFailed = false

  try {
    const value = doc.toJS({ maxAliasCount: 20 })

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      projection = value as Record<string, unknown>
    }
  } catch {
    // The exact source remains readable; only semantic projection is unavailable. Readers
    // degrade to the empty projection as they always have — but a WRITER has to be able to
    // tell whether its own candidate is what lost the meaning.
    projectionFailed = true
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
    projectionFailed,
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
  // could be truncated frontmatter, so absence is not proven. The mark is counted
  // loosely (`*`) where the parser counts it strictly (`?`) precisely so the two can
  // disagree without the disagreement reading as "no owner here".
  if (!fm.block && /^\uFEFF*---[ \t]*(?:#[^\r\n]*)?(?:\r\n|\n|\r|$)/.test(text)) {
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
        entryRange: titleFields[0].entryRange,
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
  titleOrigin: TitleOrigin,
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
    !isSkillName(name) ||
    (description !== undefined &&
      (typeof description !== 'string' ||
        (!!description && !description.trim()) ||
        description.length > 1024)) ||
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
  const linkedSkills = parseSkillLinks(metadata['notarium.skills'] ?? '')

  if (linkedSkills.length > MAX_LINKED_SKILLS) {
    return null
  }

  return {
    // A skill root goes through the normal note write chokepoint: its authored H1 is
    // stored as the note title and therefore returns as a generated `title` frontmatter
    // field on later reads. Keep that human title; only a true path fallback means the
    // package has no authored display title and must fall back to its machine name.
    title: titleOrigin.kind === 'path-fallback' ? name : titleOrigin.title.trim() || name,
    name,
    description: typeof description === 'string' ? description.trim() : '',
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

// The framed byte stream below is the order every stored `ds1:` token and revision
// blob was written in, so it can never change; the accumulator must STREAM it, because
// the framed length is a function of document size and any intermediate per-byte array
// puts that size into one argument list — V8 aborts a spread past ~125k arguments.
type Fnv64 = { hi: number; lo: number }

const FNV_OFFSET_HI = 0xcbf29ce4
const FNV_OFFSET_LO = 0x84222325

/** One 64-bit FNV-1a step on two uint32 halves: xor the byte in, multiply by the FNV
 *  prime modulo 2^64. The prime 0x100000001b3 is 2^40 + 0x1b3 — two non-zero 16-bit
 *  limbs — so the multiply is four partial products, each exact in float64. */
const fnvStep = (hash: Fnv64, byte: number): void => {
  const lo = (hash.lo ^ byte) >>> 0
  const a0 = lo & 0xffff
  const a1 = lo >>> 16
  const a2 = hash.hi & 0xffff
  const a3 = hash.hi >>> 16
  let carry = a0 * 0x1b3
  const r0 = carry & 0xffff

  carry = (carry >>> 16) + a1 * 0x1b3
  const r1 = carry & 0xffff

  carry = (carry >>> 16) + a2 * 0x1b3 + a0 * 0x100
  const r2 = carry & 0xffff

  carry = (carry >>> 16) + a3 * 0x1b3 + a1 * 0x100

  hash.lo = ((r1 << 16) | r0) >>> 0
  hash.hi = (((carry & 0xffff) << 16) | r2) >>> 0
}

const frame = (hash: Fnv64, bytes: Uint8Array): void => {
  const length = bytes.byteLength
  // The high word must come from a division: `>>> shift` reads its operand as 32-bit
  // and would silently wrap the prefix past 4 GiB.
  const hiWord = Math.floor(length / 0x100000000)
  const loWord = length >>> 0

  for (let shift = 24; shift >= 0; shift -= 8) {
    fnvStep(hash, (hiWord >>> shift) & 0xff)
  }
  for (let shift = 24; shift >= 0; shift -= 8) {
    fnvStep(hash, (loWord >>> shift) & 0xff)
  }
  for (const byte of bytes) {
    fnvStep(hash, byte)
  }
}

const fnvDigest = (hash: Fnv64): string =>
  hash.hi.toString(16).padStart(8, '0') + hash.lo.toString(16).padStart(8, '0')

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
  const hash: Fnv64 = { hi: FNV_OFFSET_HI, lo: FNV_OFFSET_LO }
  const add = (value: string | Uint8Array): void =>
    frame(hash, typeof value === 'string' ? UTF8.encode(value) : value)

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

  return `ds1:${fnvDigest(hash)}`
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

/** The opaque reading of these bytes: exact source, no interpretation, nothing owned.
 * It is what the analyzer returns for bytes it cannot prove a Markdown reading for —
 * and therefore what a persisted `opaque-v1` snapshot MEANS. Exported so the codec can
 * reconstruct one whose bytes a later analyzer learned to read: an opaque row records
 * the reader of the day, not a property of the file, so gaining the ability to parse it
 * must not turn stored history into a forgery. */
export const opaqueDocumentState = (input: DocumentAnalysisInput): DocumentState =>
  opaqueState(input, input.role ?? DOCUMENT_ROLE.opaque, cloneBytes(input.source))

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
  // A document with no frontmatter and no readable heading starts its body at offset
  // zero, which is where the encoding prologue sits. Excluding the mark keeps it out of
  // authored prose and — because the range excludes it too — keeps a body rewrite from
  // writing over it.
  const bodyCharStart = trimOneLeadingBlank(
    text,
    title.bodyStart === 0 ? afterBom(text) : title.bodyStart,
  )
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
      bodyCharStart,
      title.origin,
      input.skillDirectoryName,
      source.byteLength,
    )

    if (!skill || offsets[fm.payloadEnd] - offsets[fm.payloadStart] > MAX_SKILL_MANIFEST_BYTES) {
      return opaqueState(input, DOCUMENT_ROLE.skillRoot, source)
    }
    format = DOCUMENT_STATE_FORMAT.skill
    projection.title = skill.title
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

type TargetField = { key: string; entryRange: ByteRange; valueRange: ByteRange }

/** Rewrite one frontmatter field to carry `render(authored value)`.
 *
 * A value is replaced WHERE IT STANDS only when it occupies a slot on its key's own
 * line. A block list, a nested map, a block scalar, a multi-line plain scalar and a bare
 * `key:` have no such slot: the analyzer's value range then runs past the line break
 * that terminates the entry, or is empty. Patching that range alone writes over the
 * terminator and glues the next line — the following field, or the closing fence — onto
 * the value, which is how a settled `notarium-id` got swallowed by the field above it
 * and the note lost its identity in bytes that still parsed.
 *
 * Those shapes are rewritten as one whole `key: value` entry instead. Refusing was the
 * other candidate and it is the worse one here: every caller of this planner is already
 * REPLACING the value, so the only thing an entry rewrite discards is the authored
 * formatting of a value that does not survive the mutation either way — while a refusal
 * would strand ordinary imported documents (a block-list `tags:` is what both Notarium's
 * own serializer and every Obsidian vault write). */
const patchField = (
  state: DocumentState,
  field: TargetField,
  render: (raw: string) => string,
): DocumentPatch => {
  const raw = STRICT_UTF8.decode(state.source.slice(field.valueRange.start, field.valueRange.end))

  if (raw.length > 0 && !/[\n\r]/.test(raw)) {
    return { range: field.valueRange, bytes: UTF8.encode(render(raw)) }
  }
  const entry = STRICT_UTF8.decode(state.source.slice(field.entryRange.start, field.entryRange.end))

  return {
    range: field.entryRange,
    bytes: UTF8.encode(`${field.key}: ${render('')}${/\r\n$/.test(entry) ? '\r\n' : '\n'}`),
  }
}

const patchScalar = (state: DocumentState, field: TargetField, value: string): DocumentPatch =>
  patchField(state, field, (raw) => yamlScalarLike(raw, value))

const insertionBeforeClosingFence = (
  state: DocumentState,
  lines: readonly string[],
): DocumentPatch => {
  const text = STRICT_UTF8.decode(state.source)
  const block = parseFrontmatterBlock(text)
  const offsets = utf16ByteOffsets(text)

  if (!block) {
    const eol = frontmatterBlockEol(text)
    const payload = lines.join(eol)
    // A generated envelope opens the document — but the encoding prologue opens the
    // FILE, and a mark that no longer leads its bytes is not a mark at all: it becomes a
    // stray zero-width space in the middle of the prose.
    const start = afterBom(text)

    return {
      range: byteRange(offsets, start, start),
      bytes: UTF8.encode(`---${eol}${payload}${eol}---${eol}`),
    }
  }
  const bounds = frontmatterPayloadBounds(text, block.bodyStart)
  const eol = frontmatterBlockEol(text, bounds)
  const payload = lines.join(eol)
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
      patches.push(
        patchScalar(
          state,
          { key: 'title', entryRange: origin.entryRange, valueRange: origin.valueRange },
          intent.title,
        ),
      )
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
      patches.push(
        patchField(
          state,
          { key, entryRange: field.entryRange, valueRange: field.valueRange },
          () => value,
        ),
      )
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
      // The reserved key already sits in the file with no proof bound to it — an imported
      // document, or bytes older than the proof row. It is rewritten WHERE IT STANDS, the
      // answer the physical serializer gives; a second entry appended beside it left the
      // proposed proof bound to the field it had not written.
      const authored = frontmatter.fields.find((field) => field.key === key)

      if (!authored) {
        insertions.push(`${key}: ${frontmatterScalar(value)}`)
      } else if (authored.valueRange) {
        patches.push(
          patchScalar(
            state,
            { key, entryRange: authored.entryRange, valueRange: authored.valueRange },
            value,
          ),
        )
      } else {
        throw new Error(`document has no unique scalar target for ${key}`)
      }
      continue
    }
    if (value == null) {
      if (claim.ownership !== 'entry') {
        throw new Error(`cannot remove value-owned storage field: ${key}`)
      }
      patches.push({ range: claim.entryRange, bytes: new Uint8Array() })
    } else {
      patches.push(
        patchScalar(
          state,
          { key, entryRange: claim.entryRange, valueRange: claim.valueRange },
          value,
        ),
      )
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

  // The plan's second promise, next to the per-key one below: a mutation may not cost the
  // document its meaning. An entry-wide rewrite is the shape that does it — a block list, a
  // block scalar and a bare `key:` have no value slot on their own line, so `patchField`
  // replaces the whole entry and carries off any anchor defined there, leaving a
  // neighbour's alias dangling. Nothing else notices: unresolved aliases are not PARSE
  // errors, so `doc.errors` stays empty, `safetyOf` reads anchor dependency for owner keys
  // only, and the analyzer swallows the failed projection by design.
  //
  // Asymmetric on purpose. A source whose projection ALREADY failed is not something this
  // plan broke — it arrived that way, and refusing it here would be a new prohibition over
  // documents the task promised nothing about.
  if (candidateFm?.projectionFailed && !frontmatter.projectionFailed) {
    throw new Error('document mutation made its frontmatter unreadable')
  }
  const requestedOwners = Object.entries(intent.owners ?? {}) as Array<
    [StorageOwnerKey, string | null]
  >
  // A plan is a promise about identity, so it is checked against the bytes it produced
  // rather than against the ranges it trusted. Every key asked for has to read back out
  // of the candidate as exactly the value requested, and every key asked to go has to be
  // gone. Without this the planner handed back a proposed proof missing the very key it
  // was told to write and no caller could tell: the receipt bound only what HAD landed,
  // the mangled document still parsed, and the restore reported success over a note that
  // no longer named itself. It fires on shapes with no top-level mapping to take a key at
  // all (a sequence, a bare scalar), and it is the backstop for any future disagreement
  // between a range and the source it is supposed to address.
  //
  // A candidate that cannot be READ AT ALL is deliberately not this check's verdict: it is
  // a statement about the whole document rather than about one key, and the callers own a
  // gate that says so in their own, more precise words — `candidate-is-unsafe` from the
  // restore coordinator, an invalid-manifest refusal from ability publication. Answering
  // here would replace those verdicts with a vaguer one. That division is pinned by tests
  // on the callers, not assumed.
  const proposedClaims = (candidateFm ? requestedOwners : []).flatMap(([key, value]) => {
    const written = candidateFm?.fields.filter((entry) => entry.key === key) ?? []

    if (
      value == null
        ? written.length > 0
        : written.length !== 1 || !written[0].valueRange || written[0].value !== value
    ) {
      throw new Error(`document mutation did not land its storage owner field: ${key}`)
    }
    const owner = written[0]
    const prior = state.provenance.claims.find((claim) => claim.key === key)

    return owner?.valueRange
      ? [
          {
            key,
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
