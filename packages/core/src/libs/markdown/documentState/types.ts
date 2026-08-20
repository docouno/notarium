import type { FrontmatterEntry } from '../frontmatter'
import type { SkillLink } from './skillLinks'

export const DOCUMENT_STATE_FORMAT = {
  markdown: 'markdown-v2',
  skill: 'skill-markdown-v1',
  opaque: 'opaque-v1',
} as const

export type DocumentStateFormat = (typeof DOCUMENT_STATE_FORMAT)[keyof typeof DOCUMENT_STATE_FORMAT]

export const DOCUMENT_ROLE = {
  generic: 'generic',
  skillRoot: 'skill-root',
  skillAuxiliary: 'skill-auxiliary',
  opaque: 'opaque',
} as const

export type DocumentRole = (typeof DOCUMENT_ROLE)[keyof typeof DOCUMENT_ROLE]

export const STORAGE_OWNER_KEY = {
  id: 'notarium-id',
  created: 'notarium-created',
} as const

export type StorageOwnerKey = (typeof STORAGE_OWNER_KEY)[keyof typeof STORAGE_OWNER_KEY]

export type ByteRange = {
  start: number
  end: number
}

export type StorageOwnerClaim = {
  key: StorageOwnerKey
  ownership: 'value' | 'entry'
  valueRange: ByteRange
  entryRange: ByteRange
  /** Receipt/repair lineage is audit data. It is persisted but excluded from the fingerprint. */
  evidence: { kind: 'mutation-receipt' | 'audited-repair'; id: string }
}

export type StorageOwnerProof = {
  version: 1
  claims: StorageOwnerClaim[]
  /** True only when the same receipt created the complete frontmatter container. */
  generatedContainer?: boolean
}

/** Fail-closed reading of the physical `notarium-id` field. This is deliberately
 * independent from StorageOwnerProof: a proof says which bytes Notarium owns;
 * this observation says what the exact bytes currently claim. */
export type ExactOwnerObservation =
  { kind: 'absent' } | { kind: 'claimed'; id: string } | { kind: 'unproven' }

export type RestoreSafety =
  | { status: 'safe' }
  | { status: 'blocked'; reason: 'owner-anchor-dependency' | 'duplicate-target-mapping' }
  | { status: 'unknown'; reason: 'invalid-yaml' | 'parser-range-uncertainty' }

export type TitleOrigin =
  /** `entryRange` is the field's whole physical entry: a frontmatter title may be
   * authored as a block scalar, whose value has no slot to rewrite on the key's line. */
  | {
      kind: 'frontmatter'
      title: string
      valueRange: ByteRange
      entryRange: ByteRange
      coupledH1Range?: ByteRange
    }
  | { kind: 'hidden-h1' | 'legacy-h1'; title: string; valueRange: ByteRange }
  | { kind: 'path-fallback'; title: string }

export type SkillProjection = {
  /** Human-facing document title. The manifest `name` below is a stable machine key. */
  title: string
  name: string
  description: string
  metadata: Record<string, string>
  instructions: string
  linkedSkills: SkillLink[]
  role: boolean
}

export type MarkdownProjection = {
  title: string
  body: string
  /** Exact raw authored ordering for compatibility adapters; never a restore serializer. */
  frontmatterEntries: FrontmatterEntry[]
  frontmatter: Record<string, unknown>
  titleOrigin: TitleOrigin
  bodyRange: ByteRange
  skill?: SkillProjection
}

export type DocumentState = {
  format: DocumentStateFormat
  role: DocumentRole
  source: Uint8Array
  provenance: StorageOwnerProof
  restoreSafety: RestoreSafety
  pathFallbackTitle: string | null
  semanticFingerprint: string
  projection: MarkdownProjection | null
  /** The package directory this manifest physically sits in. A skill root projects only
   *  when the caller can name it — the analyzer never reads the path — and it rides the
   *  persisted state so a re-analysis lands on the same role. */
  skillDirectoryName?: string
}

export type DocumentAnalysisInput = {
  source: Uint8Array
  role?: DocumentRole
  pathFallbackTitle?: string | null
  ownerProof?: StorageOwnerProof
  skillDirectoryName?: string
}

export type DocumentPatch = {
  range: ByteRange
  bytes: Uint8Array
}

export type DocumentMutationIntent = {
  title?: string
  /** A fallback title may remain path-derived or become pinned authored metadata. */
  fallbackPolicy?: 'title-derived' | 'pinned'
  body?: string
  /** Legacy partial-restore channels. Full restore carries their authored bytes
   * directly and does not use these projections. */
  tags?: readonly string[]
  slug?: string | null
  owners?: Partial<Record<StorageOwnerKey, string | null>>
}

export type DocumentMutationPlan = {
  source: Uint8Array
  pathFallbackTitle: string | null
  patches: DocumentPatch[]
  /** Proposed proof is inert until the physical authority binds it to its receipt. */
  proposedOwnerProof: Omit<StorageOwnerProof, 'claims'> & {
    claims: Array<Omit<StorageOwnerClaim, 'evidence'>>
  }
}

export type DocumentRestoreCompatibility =
  | { status: 'compatible' }
  | {
      status: 'non-restorable'
      reason: 'opaque-source' | 'unsafe-source' | 'role-mismatch' | 'path-fallback-mismatch'
    }
