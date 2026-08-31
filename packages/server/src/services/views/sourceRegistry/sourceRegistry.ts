import type { FieldColor, ViewDefinitionV1, ViewRow, ViewSourceV1 } from '@notarium/contract'
import type {
  compileReaderView,
  KnowledgeStore,
  ViewDataNeeds,
  ViewMutationCapabilities,
} from '@notarium/core'

import type { FieldSchemaSnapshot, FieldSchemaStore } from '../../fields'
import type { ProjectRecord } from '../../metaDb'

export type ViewExecution = {
  exactFallbackTruncated?: true
  exactReads: number
  exactCacheHits: number
  exactRemaining: number
}

export type ViewProjectedGroup = {
  state: 'value' | 'absent' | 'empty-string' | 'empty-list' | 'unreadable'
  value?: string | string[]
  label?: string
  color?: FieldColor
  key: string
  count: number
}

export type PreparedView = {
  status: 'ready' | 'unsupported' | 'invalid' | 'incomplete'
  diagnostics?: string[]
  total?: number
  groups?: ViewProjectedGroup[]
  totalGroups?: number
  groupsTruncated?: true
  rows?: unknown[]
  execution?: ViewExecution
  /** Source-private exact-body versions that complete this projection. */
  exactWitnesses?: ReadonlyMap<string, string>
  snapshotGeneration: string
  schemaVersionToken?: string
  dataNeeds?: ViewDataNeeds
  capabilities?: ViewMutationCapabilities
  readerOptions?: unknown
  sourceKind?: string
  /** Source-private index. It never crosses the wire. */
  rowBuckets?: Map<string, unknown[]>
}

export type ReadyReaderView = Extract<ReturnType<typeof compileReaderView>, { status: 'ready' }>

export type ViewSourceCaptureInput = {
  store: KnowledgeStore
  projects: readonly ProjectRecord[]
  source: ViewSourceV1
  directory: string
  sourceContext: unknown
  cacheScope?: string
  signal?: AbortSignal
  snapshot?: unknown
  snapshotGeneration?: string
}

export type ViewSourceExecutionContext = {
  snapshotGeneration: string
}

export type ViewSourcePrepareInput<Context extends ViewSourceExecutionContext> = {
  store: KnowledgeStore
  source: ViewSourceV1
  view: ViewDefinitionV1
  reader: ReadyReaderView
  directory: string
  projects: readonly ProjectRecord[]
  schema?: FieldSchemaSnapshot
  signal?: AbortSignal
  context: Context
  purpose: 'view' | 'summary'
}

export type ViewSourcePlanIdentityInput = {
  source: ViewSourceV1
  directory: string
  projects: readonly ProjectRecord[]
  cacheScope?: string
}

export type ViewSourceBoardMembership = {
  versionToken?: string
  value?: string | string[]
}

export type ViewSourceBoardMembershipInput = {
  store: KnowledgeStore
  cardId: string
  fieldKey: string
}

export type ViewSourceBoardMembershipWriteInput = ViewSourceBoardMembershipInput & {
  fieldSchemaStore?: FieldSchemaStore
  space: string
  versionToken?: string
  value: string | null
  principal?: string
}

/** Callable mutation adapter for a source that owns board membership. Reader
 * intent alone never makes a board movable, and the generic move service never
 * assumes how a source reads or persists that membership. */
export type ViewSourceBoardMoveAdapter = {
  fieldKey(options: unknown): string | null
  readMembership(input: ViewSourceBoardMembershipInput): Promise<ViewSourceBoardMembership>
  writeMembership(input: ViewSourceBoardMembershipWriteInput): Promise<{ versionToken: string }>
}

export type ViewSourceHandler<
  Context extends ViewSourceExecutionContext = ViewSourceExecutionContext,
> = {
  readonly kind: string
  readonly boardMove?: ViewSourceBoardMoveAdapter
  planIdentity?(input: ViewSourcePlanIdentityInput): unknown
  captureIdentity?(input: ViewSourcePlanIdentityInput): unknown
  capture(input: ViewSourceCaptureInput): Promise<Context>
  prepare(input: ViewSourcePrepareInput<Context>): Promise<PreparedView>
  window(
    prepared: PreparedView,
    input: { group?: string; offset: number; limit: number },
    schema?: FieldSchemaSnapshot,
  ): { total: number; rows: ViewRow[] }
}

export type AnyViewSourceHandler = ViewSourceHandler<ViewSourceExecutionContext>

export type ViewSourceRegistry = {
  readonly kinds: readonly string[]
  get(kind: string): AnyViewSourceHandler | undefined
}

export const createViewSourceRegistry = (
  handlers: readonly AnyViewSourceHandler[],
): ViewSourceRegistry => {
  const byKind = new Map<string, AnyViewSourceHandler>()

  for (const handler of handlers) {
    const kind = handler.kind.trim()

    if (!kind) {
      throw new Error('view source kind must be non-empty')
    }
    if (byKind.has(kind)) {
      throw new Error(`duplicate view source kind: ${kind}`)
    }
    byKind.set(kind, handler)
  }
  const kinds = Object.freeze([...byKind.keys()])

  return Object.freeze({
    kinds,
    get: (kind: string) => byKind.get(kind),
  })
}

export const presentCapabilities = (
  capabilities: ViewMutationCapabilities,
): ViewMutationCapabilities | undefined => {
  const present = {
    ...(capabilities.move ? { move: true as const } : {}),
    ...(capabilities.editOptions ? { editOptions: true as const } : {}),
  }

  return Object.keys(present).length ? present : undefined
}

export const viewCacheScope = (space: string, principal: string): string =>
  JSON.stringify([space, principal])
