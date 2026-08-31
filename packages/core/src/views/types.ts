import type { Document } from 'yaml'

export const VIEW_DOCUMENT_VERSION = 1

export const VIEW_DOCUMENT_LIMIT = {
  payloadBytes: 1024 * 1024,
  blocks: 32,
  views: 64,
  astLeaves: 128,
  properties: 128,
  yamlNodes: 2_048,
  yamlTokens: 8_192,
  yamlDepth: 64,
} as const

export type ViewRange = {
  start: number
  end: number
}

export const VIEW_BLOCK_STATUS = {
  ready: 'ready',
  malformed: 'malformed',
  future: 'future',
  readOnly: 'read-only',
  resourceLimit: 'resource-limit',
} as const

export type ViewBlockStatus = (typeof VIEW_BLOCK_STATUS)[keyof typeof VIEW_BLOCK_STATUS]

export const VIEW_DIAGNOSTIC = {
  incompleteFence: 'incomplete-fence',
  malformedYaml: 'malformed-yaml',
  invalidRoot: 'invalid-root',
  unsupportedVersion: 'unsupported-version',
  invalidSource: 'invalid-source',
  invalidViews: 'invalid-views',
  invalidView: 'invalid-view',
  duplicateViewName: 'duplicate-view-name',
  yamlNodeReference: 'yaml-node-reference',
  duplicateSemanticKey: 'duplicate-semantic-key',
  resourceLimit: 'resource-limit',
} as const

export type ViewDiagnosticCode = (typeof VIEW_DIAGNOSTIC)[keyof typeof VIEW_DIAGNOSTIC]

export type ViewDiagnostic = {
  code: ViewDiagnosticCode
  message: string
  block: number
  view?: number
}

export type ViewSourceDefinition = {
  kind: string
  [key: string]: unknown
}

export type ViewDefinition = {
  name: string
  type: string
  filter?: unknown
  fields?: string[]
  limit?: number
  options?: Record<string, unknown>
  [key: string]: unknown
}

export type ViewReferencePayload = {
  documentId: string
  versionToken: string
  block: number
  view: number
}

export type ParsedView = {
  block: number
  occurrence: number
  name: string
  type: string
  definition: ViewDefinition
  viewRef?: string
}

export type ParsedViewBlock = {
  occurrence: number
  complete: boolean
  eol: '\n' | '\r\n'
  sourceRange: ViewRange
  payloadRange: ViewRange
  /** Exact payload witness used to refuse stale range-based writes. */
  payload: string
  status: ViewBlockStatus
  diagnostics: ViewDiagnostic[]
  source?: ViewSourceDefinition
  views: ParsedView[]
  /** Internal CST owner for local structured writes. Never crosses a transport. */
  yamlDocument?: Document.Parsed
}

export type ViewMarkerProof =
  { kind: 'value'; value: string } | { kind: 'absent' } | { kind: 'unproven' }

export type ViewDocumentContext = {
  documentId: string
  versionToken: string
}

export type ParsedViewDocument = {
  blocks: ParsedViewBlock[]
  views: ParsedView[]
  diagnostics: ViewDiagnostic[]
  primaryReader: ViewMarkerProof
  semanticContent: string
}

export type ViewObjectPatch = {
  set?: Record<string, unknown>
  remove?: readonly string[]
}

export type ViewConfigPatch = {
  source?: ViewObjectPatch
  common?: ViewObjectPatch
  options?: ViewObjectPatch
}

export type ViewWriteResult = {
  content: string
  viewType?: string
}
