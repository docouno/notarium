import { analyzeDocumentState } from './documentState'
import {
  DOCUMENT_ROLE,
  DOCUMENT_STATE_FORMAT,
  type DocumentRole,
  type DocumentState,
  type DocumentStateFormat,
  type RestoreSafety,
  STORAGE_OWNER_KEY,
  type StorageOwnerProof,
} from './types'

const MAGIC = new TextEncoder().encode('NDS1')
const UTF8 = new TextEncoder()
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true })

type Header = {
  format: DocumentStateFormat
  role: DocumentRole
  provenance: StorageOwnerProof
  restoreSafety: RestoreSafety
  pathFallbackTitle: string | null
  semanticFingerprint: string
  skillDirectoryName?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value)

const isByteRange = (value: unknown): boolean =>
  isRecord(value) &&
  Number.isSafeInteger(value.start) &&
  Number.isSafeInteger(value.end) &&
  (value.start as number) >= 0 &&
  (value.end as number) >= (value.start as number)

const isOwnerProof = (value: unknown): value is StorageOwnerProof => {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.claims) ||
    (value.generatedContainer !== undefined && typeof value.generatedContainer !== 'boolean')
  ) {
    return false
  }

  return value.claims.every(
    (claim) =>
      isRecord(claim) &&
      Object.values(STORAGE_OWNER_KEY).includes(claim.key as never) &&
      (claim.ownership === 'value' || claim.ownership === 'entry') &&
      isByteRange(claim.valueRange) &&
      isByteRange(claim.entryRange) &&
      isRecord(claim.evidence) &&
      (claim.evidence.kind === 'mutation-receipt' || claim.evidence.kind === 'audited-repair') &&
      typeof claim.evidence.id === 'string' &&
      claim.evidence.id.length > 0,
  )
}

const parseHeader = (value: unknown): Header => {
  if (
    !isRecord(value) ||
    !Object.values(DOCUMENT_STATE_FORMAT).includes(value.format as never) ||
    !Object.values(DOCUMENT_ROLE).includes(value.role as never) ||
    !isOwnerProof(value.provenance) ||
    !isRecord(value.restoreSafety) ||
    typeof value.restoreSafety.status !== 'string' ||
    (value.pathFallbackTitle !== null && typeof value.pathFallbackTitle !== 'string') ||
    typeof value.semanticFingerprint !== 'string' ||
    (value.skillDirectoryName !== undefined && typeof value.skillDirectoryName !== 'string')
  ) {
    throw new Error('invalid document-state blob metadata')
  }

  return value as Header
}

const headerOf = (state: DocumentState): Header => ({
  format: state.format,
  role: state.role,
  provenance: state.provenance,
  restoreSafety: state.restoreSafety,
  pathFallbackTitle: state.pathFallbackTitle,
  semanticFingerprint: state.semanticFingerprint,
  ...(state.skillDirectoryName ? { skillDirectoryName: state.skillDirectoryName } : {}),
})

export const encodeDocumentState = (state: DocumentState): Uint8Array => {
  const header = UTF8.encode(JSON.stringify(headerOf(state)))
  const output = new Uint8Array(MAGIC.byteLength + 4 + header.byteLength + state.source.byteLength)

  output.set(MAGIC, 0)
  new DataView(output.buffer).setUint32(MAGIC.byteLength, header.byteLength)
  output.set(header, MAGIC.byteLength + 4)
  output.set(state.source, MAGIC.byteLength + 4 + header.byteLength)
  return output
}

export const decodeDocumentState = (blob: Uint8Array): DocumentState => {
  if (
    blob.byteLength < MAGIC.byteLength + 4 ||
    !MAGIC.every((value, index) => blob[index] === value)
  ) {
    throw new Error('invalid document-state blob magic')
  }
  const headerLength = new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getUint32(
    MAGIC.byteLength,
  )
  const headerStart = MAGIC.byteLength + 4
  const sourceStart = headerStart + headerLength

  if (sourceStart > blob.byteLength) {
    throw new Error('truncated document-state blob')
  }
  const header = parseHeader(JSON.parse(STRICT_UTF8.decode(blob.slice(headerStart, sourceStart))))
  const state = analyzeDocumentState({
    source: blob.slice(sourceStart),
    role: header.role,
    pathFallbackTitle: header.pathFallbackTitle,
    ownerProof: header.provenance,
    skillDirectoryName: header.skillDirectoryName,
  })

  if (
    state.format !== header.format ||
    state.semanticFingerprint !== header.semanticFingerprint ||
    JSON.stringify(state.restoreSafety) !== JSON.stringify(header.restoreSafety)
  ) {
    throw new Error('document-state blob metadata does not match its source')
  }

  return state
}
