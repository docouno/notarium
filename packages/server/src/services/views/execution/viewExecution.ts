import {
  type ViewDefinitionV1,
  ViewDefinitionV1Schema,
  type ViewSourceV1,
  ViewSourceV1Schema,
} from '@notarium/contract'
import {
  compileReaderSummaryView,
  compileReaderView,
  decodeViewRef,
  type KnowledgeStore,
  parseViewDocument,
  type ReaderRegistry,
  sha256Hex,
  type ViewMutationCapabilities,
} from '@notarium/core'

import type { FieldSchemaSnapshot } from '../../fields'
import type { ProjectRecord } from '../../metaDb'
import { presentCapabilities } from '../sourceRegistry'
import type {
  AnyViewSourceHandler,
  PreparedView,
  ReadyReaderView,
  ViewSourceExecutionContext,
  ViewSourceRegistry,
} from '../sourceRegistry'
import { ViewExecutionCancelledError } from './cancelled'
import { ViewSnapshotConflictError } from './errors'

const PLAN_CACHE_MAX_ENTRIES = 64
const PLAN_CACHE_MAX_ROWS = 100_000
const PLAN_IN_FLIGHT_MAX = 64

type CaptureOptions = {
  store: KnowledgeStore
  projects: readonly ProjectRecord[]
  cacheScope?: string
  signal?: AbortSignal
  snapshot?: unknown
  snapshotGeneration?: string
}

export type ViewExecutionRequestContext = CaptureOptions & {
  contexts: Map<string, Promise<ViewSourceExecutionContext>>
}

type CachedPlan = {
  prepared: PreparedView
  rows: number
}

type InFlightPlan = {
  abort: AbortController
  promise: Promise<PreparedView>
  settled: boolean
  users: number
}

const directoryOf = (filePath: string): string => {
  const slash = filePath.lastIndexOf('/')

  return slash < 0 ? '' : filePath.slice(0, slash)
}

export class ViewExecutionService {
  private readonly plans = new Map<string, CachedPlan>()
  private readonly inFlightPlans = new Map<string, InFlightPlan>()
  private readonly storeIds = new WeakMap<KnowledgeStore, number>()
  private nextStoreId = 1
  private cachedRows = 0

  constructor(
    private readonly readers: ReaderRegistry,
    private readonly sources: ViewSourceRegistry,
  ) {}

  requestContext(input: CaptureOptions): ViewExecutionRequestContext {
    return { ...input, contexts: new Map() }
  }

  planIdentity(
    source: ViewSourceV1,
    directory: string,
    projects: readonly ProjectRecord[],
    cacheScope?: string,
  ): unknown {
    const input = { source, directory, projects, cacheScope }

    try {
      return (
        this.sources.get(source.kind)?.planIdentity?.(input) ?? {
          directory,
        }
      )
    } catch {
      return { kind: source.kind, unavailable: true }
    }
  }

  private captureIdentity(
    source: AnyViewSourceHandler,
    definition: ViewSourceV1,
    directory: string,
    projects: readonly ProjectRecord[],
    cacheScope?: string,
  ): unknown {
    const input = { source: definition, directory, projects, cacheScope }

    return (
      source.captureIdentity?.(input) ?? {
        source: definition,
        sourceContext: this.planIdentity(definition, directory, projects, cacheScope),
      }
    )
  }

  private storeId(store: KnowledgeStore): number {
    const existing = this.storeIds.get(store)

    if (existing) {
      return existing
    }
    const id = this.nextStoreId++

    this.storeIds.set(store, id)
    return id
  }

  private planKey(
    store: KnowledgeStore,
    viewRef: string,
    snapshotGeneration: string,
    schemaVersionToken: string | undefined,
    cacheScope?: string,
  ): string {
    return `${this.storeId(store)}\u0000${cacheScope ?? ''}\u0000${viewRef}\u0000${snapshotGeneration}\u0000${schemaVersionToken ?? ''}`
  }

  private cachedPlan(key: string): PreparedView | undefined {
    const cached = this.plans.get(key)

    if (!cached) {
      return undefined
    }
    this.plans.delete(key)
    this.plans.set(key, cached)
    return cached.prepared
  }

  private rememberPlan(key: string, prepared: PreparedView): void {
    if (prepared.status !== 'ready' && prepared.status !== 'incomplete') {
      return
    }
    const rows = prepared.rows?.length ?? 0

    if (rows > PLAN_CACHE_MAX_ROWS) {
      return
    }
    const previous = this.plans.get(key)

    if (previous) {
      this.cachedRows -= previous.rows
      this.plans.delete(key)
    }
    this.plans.set(key, { prepared, rows })
    this.cachedRows += rows

    while (this.plans.size > PLAN_CACHE_MAX_ENTRIES || this.cachedRows > PLAN_CACHE_MAX_ROWS) {
      const oldestKey = this.plans.keys().next().value

      if (!oldestKey) {
        break
      }
      const oldest = this.plans.get(oldestKey)

      this.plans.delete(oldestKey)
      this.cachedRows -= oldest?.rows ?? 0
    }
  }

  private async contextFor(
    source: AnyViewSourceHandler,
    definition: ViewSourceV1,
    directory: string,
    request: ViewExecutionRequestContext,
  ): Promise<ViewSourceExecutionContext> {
    const sourceContext = this.planIdentity(
      definition,
      directory,
      request.projects,
      request.cacheScope,
    )
    const key = await sha256Hex(
      JSON.stringify({
        kind: source.kind,
        identity: this.captureIdentity(
          source,
          definition,
          directory,
          request.projects,
          request.cacheScope,
        ),
        cacheScope: request.cacheScope ?? null,
      }),
    )
    const existing = request.contexts.get(key)

    if (existing) {
      return existing
    }
    const captured = source.capture({
      ...request,
      source: definition,
      directory,
      sourceContext,
      cacheScope: request.cacheScope,
    })

    request.contexts.set(key, captured)
    return captured
  }

  private effectiveCapabilities(
    reader: ViewMutationCapabilities,
    source?: ViewMutationCapabilities,
    handler?: AnyViewSourceHandler,
  ): ViewMutationCapabilities | undefined {
    return presentCapabilities({
      ...(reader.editOptions ? { editOptions: true } : {}),
      ...(reader.move && source?.move && handler?.boardMove ? { move: true } : {}),
    })
  }

  private unavailable(kind: string, generation: string, reader: ReadyReaderView): PreparedView {
    return {
      status: 'invalid',
      diagnostics: [`Source “${kind}” is unavailable.`],
      snapshotGeneration: generation,
      capabilities: this.effectiveCapabilities(reader.mutationCapabilities),
      readerOptions: reader.options,
      sourceKind: kind,
    }
  }

  private waitForPlan(
    promise: Promise<PreparedView>,
    signal: AbortSignal | undefined,
    onAbort: () => void,
  ): Promise<PreparedView> {
    if (!signal) {
      return promise
    }

    return new Promise<PreparedView>((resolve, reject) => {
      let finished = false
      const cleanup = () => signal.removeEventListener('abort', abort)

      const succeed = (prepared: PreparedView) => {
        if (!finished) {
          finished = true
          cleanup()
          resolve(prepared)
        }
      }

      const fail = (error: unknown) => {
        if (!finished) {
          finished = true
          cleanup()
          reject(error)
        }
      }

      const abort = () => {
        if (!finished) {
          finished = true
          cleanup()
          onAbort()
          reject(new ViewExecutionCancelledError())
        }
      }

      void promise.then(succeed, fail)
      if (signal.aborted) {
        abort()
      } else {
        signal.addEventListener('abort', abort, { once: true })
      }
    })
  }

  private async coalescedPlan(
    key: string,
    signal: AbortSignal | undefined,
    factory: (signal: AbortSignal | undefined) => Promise<PreparedView>,
  ): Promise<PreparedView> {
    let entry = this.inFlightPlans.get(key)

    if (entry && (entry.abort.signal.aborted || (!entry.settled && entry.users === 0))) {
      if (this.inFlightPlans.get(key) === entry) {
        this.inFlightPlans.delete(key)
      }
      entry = undefined
    }
    if (!entry && this.inFlightPlans.size >= PLAN_IN_FLIGHT_MAX) {
      return this.waitForPlan(factory(signal), signal, () => {})
    }
    if (!entry) {
      const abort = new AbortController()
      const created: InFlightPlan = {
        abort,
        promise: Promise.resolve({
          status: 'invalid',
          snapshotGeneration: 'unavailable',
        }),
        settled: false,
        users: 0,
      }

      created.promise = factory(abort.signal).finally(() => {
        created.settled = true
        if (this.inFlightPlans.get(key) === created) {
          this.inFlightPlans.delete(key)
        }
      })
      void created.promise.catch(() => {})
      this.inFlightPlans.set(key, created)
      entry = created
    }
    entry.users++
    let released = false

    const release = () => {
      if (released) {
        return
      }
      released = true
      entry!.users--
      if (entry!.users === 0 && !entry!.settled) {
        if (this.inFlightPlans.get(key) === entry) {
          this.inFlightPlans.delete(key)
        }
        entry!.abort.abort()
      }
    }

    try {
      return await this.waitForPlan(entry.promise, signal, release)
    } finally {
      release()
    }
  }

  async prepare(input: {
    store: KnowledgeStore
    source: ViewSourceV1
    view: ViewDefinitionV1
    directory: string
    projects: readonly ProjectRecord[]
    schema?: FieldSchemaSnapshot
    signal?: AbortSignal
    cacheScope?: string
    request?: ViewExecutionRequestContext
    fallbackGeneration?: string
    purpose?: 'view' | 'summary'
  }): Promise<PreparedView> {
    const fallbackGeneration =
      input.request?.snapshotGeneration ?? input.fallbackGeneration ?? 'unavailable'
    const schemaBinding = input.schema
      ? { schemaVersionToken: input.schema.versionToken }
      : undefined
    const reader =
      input.purpose === 'summary'
        ? compileReaderSummaryView(this.readers, input.view)
        : compileReaderView(this.readers, input.view)

    if (reader.status === 'unsupported') {
      return {
        status: 'unsupported',
        diagnostics: [`Unknown reader: ${input.view.type}`],
        snapshotGeneration: fallbackGeneration,
        ...schemaBinding,
      }
    }
    if (reader.status === 'invalid') {
      return {
        status: 'invalid',
        diagnostics: [...reader.diagnostics],
        snapshotGeneration: fallbackGeneration,
        ...schemaBinding,
      }
    }
    const source = this.sources.get(input.source.kind)

    if (!source) {
      return {
        status: 'unsupported',
        diagnostics: [`Unknown source: ${input.source.kind}`],
        snapshotGeneration: fallbackGeneration,
        capabilities: this.effectiveCapabilities(reader.mutationCapabilities),
        readerOptions: reader.options,
        ...schemaBinding,
      }
    }
    const request =
      input.request ??
      this.requestContext({
        store: input.store,
        projects: input.projects,
        signal: input.signal,
        cacheScope: input.cacheScope,
      })

    if (request.store !== input.store) {
      throw new Error('view execution context belongs to another store')
    }
    if (input.cacheScope !== undefined && input.cacheScope !== request.cacheScope) {
      throw new Error('view execution context belongs to another cache scope')
    }
    let context: ViewSourceExecutionContext

    try {
      context = await this.contextFor(source, input.source, input.directory, request)
    } catch (error) {
      if (input.signal?.aborted) {
        throw error
      }

      return {
        ...this.unavailable(input.source.kind, fallbackGeneration, reader),
        ...schemaBinding,
      }
    }
    let prepared: PreparedView

    try {
      prepared = await source.prepare({
        store: input.store,
        source: input.source,
        view: input.view,
        reader,
        directory: input.directory,
        projects: input.projects,
        schema: input.schema,
        signal: input.signal,
        context,
        purpose: input.purpose ?? 'view',
      })
    } catch (error) {
      if (input.signal?.aborted) {
        throw error
      }

      return {
        ...this.unavailable(input.source.kind, context.snapshotGeneration, reader),
        ...schemaBinding,
      }
    }

    return {
      ...prepared,
      schemaVersionToken: input.schema?.versionToken,
      capabilities: this.effectiveCapabilities(
        reader.mutationCapabilities,
        prepared.capabilities,
        source,
      ),
    }
  }

  window(
    prepared: PreparedView,
    input: { group?: string; offset: number; limit: number },
    schema?: FieldSchemaSnapshot,
  ) {
    const source = prepared.sourceKind ? this.sources.get(prepared.sourceKind) : undefined

    if (!source) {
      throw new Error('view source is unavailable')
    }

    return source.window(prepared, input, schema)
  }

  async prepareDraft(input: {
    store: KnowledgeStore
    source: ViewSourceV1
    view: ViewDefinitionV1
    directory: string
    projects: readonly ProjectRecord[]
    schema?: FieldSchemaSnapshot
    signal?: AbortSignal
    snapshotGeneration?: string
    schemaVersionToken?: string
    cacheScope?: string
  }): Promise<PreparedView> {
    if (
      input.snapshotGeneration &&
      (input.schema?.versionToken ?? null) !== (input.schemaVersionToken ?? null)
    ) {
      throw new ViewSnapshotConflictError('view schema changed')
    }
    const fingerprint = await sha256Hex(
      JSON.stringify({
        source: input.source,
        view: input.view,
        sourceContext: this.planIdentity(
          input.source,
          input.directory,
          input.projects,
          input.cacheScope,
        ),
        cacheScope: input.cacheScope ?? null,
      }),
    )
    const reference = `draft:${fingerprint}`

    if (input.snapshotGeneration) {
      const cacheKey = this.planKey(
        input.store,
        reference,
        input.snapshotGeneration,
        input.schemaVersionToken,
        input.cacheScope,
      )
      const cached = this.cachedPlan(cacheKey)

      if (cached) {
        return cached
      }

      return this.coalescedPlan(cacheKey, input.signal, async (signal) => {
        const prepared = await this.prepare({
          store: input.store,
          source: input.source,
          view: input.view,
          directory: input.directory,
          projects: input.projects,
          schema: input.schema,
          signal,
          cacheScope: input.cacheScope,
        })

        if (signal?.aborted) {
          throw new ViewExecutionCancelledError()
        }
        if (prepared.snapshotGeneration !== input.snapshotGeneration) {
          throw new ViewSnapshotConflictError('view snapshot changed')
        }
        this.rememberPlan(cacheKey, prepared)
        return prepared
      })
    }
    const prepared = await this.prepare({
      store: input.store,
      source: input.source,
      view: input.view,
      directory: input.directory,
      projects: input.projects,
      schema: input.schema,
      signal: input.signal,
      cacheScope: input.cacheScope,
    })

    if (input.signal?.aborted) {
      throw new ViewExecutionCancelledError()
    }
    this.rememberPlan(
      this.planKey(
        input.store,
        reference,
        prepared.snapshotGeneration,
        prepared.schemaVersionToken,
        input.cacheScope,
      ),
      prepared,
    )

    return prepared
  }

  private async equivalentPlanKey(input: {
    source: ViewSourceV1
    view: ViewDefinitionV1
    directory: string
    projects: readonly ProjectRecord[]
    schema?: FieldSchemaSnapshot
    cacheScope?: string
  }): Promise<string | null> {
    const reader = compileReaderView(this.readers, input.view)

    if (reader.status !== 'ready' || !this.sources.get(input.source.kind)) {
      return null
    }

    return sha256Hex(
      JSON.stringify({
        source: input.source,
        view: Object.fromEntries(Object.entries(input.view).filter(([key]) => key !== 'name')),
        dataNeeds: reader.dataNeeds,
        sourceContext: this.planIdentity(
          input.source,
          input.directory,
          input.projects,
          input.cacheScope,
        ),
        schema: input.schema?.versionToken ?? null,
        cacheScope: input.cacheScope ?? null,
      }),
    )
  }

  async saved(input: {
    store: KnowledgeStore
    noteId: string
    note?: Awaited<ReturnType<KnowledgeStore['read']>>
    projects: readonly ProjectRecord[]
    schema?: FieldSchemaSnapshot
    signal?: AbortSignal
    cacheScope?: string
  }): Promise<{
    note: Awaited<ReturnType<KnowledgeStore['read']>>
    parsed: ReturnType<typeof parseViewDocument>
    prepared: Map<string, PreparedView>
    snapshotGeneration: string
  }> {
    const note = input.note ?? (await input.store.read(input.noteId))

    if (note.id && note.id !== input.noteId) {
      throw new Error('captured view note belongs to another identity')
    }
    const documentId = note.id ?? input.noteId
    const versionToken = note.versionToken

    if (!versionToken) {
      throw new Error('view note has no version token')
    }
    const parsed = parseViewDocument(note.content, { documentId, versionToken })
    const prepared = new Map<string, PreparedView>()
    const request = this.requestContext({
      store: input.store,
      projects: input.projects,
      signal: input.signal,
      cacheScope: input.cacheScope,
    })
    const equivalentPlans = new Map<string, Promise<PreparedView>>()
    let snapshotGeneration = versionToken

    for (const view of parsed.views) {
      if (!view.viewRef) {
        continue
      }
      const block = parsed.blocks[view.block]
      const source = ViewSourceV1Schema.safeParse(block?.source)
      const definition = ViewDefinitionV1Schema.safeParse(view.definition)
      let result: PreparedView

      if (!source.success || !definition.success || !note.filePath) {
        result = {
          status: 'invalid',
          diagnostics: [
            source.success ? '' : (source.error.issues[0]?.message ?? 'invalid source'),
            definition.success ? '' : (definition.error.issues[0]?.message ?? 'invalid view'),
          ].filter(Boolean),
          snapshotGeneration,
        }
      } else {
        const directory = directoryOf(note.filePath)
        const equivalentKey = await this.equivalentPlanKey({
          source: source.data,
          view: definition.data,
          directory,
          projects: input.projects,
          schema: input.schema,
          cacheScope: input.cacheScope,
        })
        let planned = equivalentKey ? equivalentPlans.get(equivalentKey) : undefined

        if (!planned) {
          planned = this.prepare({
            store: input.store,
            source: source.data,
            view: definition.data,
            directory,
            projects: input.projects,
            schema: input.schema,
            signal: input.signal,
            request,
            fallbackGeneration: versionToken,
            cacheScope: input.cacheScope,
          })
          if (equivalentKey) {
            equivalentPlans.set(equivalentKey, planned)
          }
        }
        result = await planned
        if (input.signal?.aborted) {
          throw new ViewExecutionCancelledError()
        }
        if (snapshotGeneration === versionToken && result.snapshotGeneration !== 'unavailable') {
          snapshotGeneration = result.snapshotGeneration
        }
      }
      if (input.signal?.aborted) {
        throw new ViewExecutionCancelledError()
      }
      prepared.set(view.viewRef, result)
      this.rememberPlan(
        this.planKey(
          input.store,
          view.viewRef,
          result.snapshotGeneration,
          input.schema?.versionToken,
          input.cacheScope,
        ),
        result,
      )
    }

    return { note, parsed, prepared, snapshotGeneration }
  }

  async savedView(input: {
    store: KnowledgeStore
    viewRef: string
    snapshotGeneration: string
    schemaVersionToken?: string
    projects: readonly ProjectRecord[]
    schema?: FieldSchemaSnapshot
    signal?: AbortSignal
    cacheScope?: string
  }): Promise<{
    note: Awaited<ReturnType<KnowledgeStore['read']>>
    parsed: ReturnType<typeof parseViewDocument>
    view: ReturnType<typeof parseViewDocument>['views'][number]
    prepared: PreparedView
  }> {
    const decoded = decodeViewRef(input.viewRef)

    if (!decoded) {
      throw new ViewSnapshotConflictError('stale viewRef')
    }
    const note = await input.store.read(decoded.documentId)

    if (!note.versionToken || note.versionToken !== decoded.versionToken) {
      throw new ViewSnapshotConflictError('stale viewRef')
    }
    if ((input.schema?.versionToken ?? null) !== (input.schemaVersionToken ?? null)) {
      throw new ViewSnapshotConflictError('view schema changed')
    }
    const parsed = parseViewDocument(note.content, {
      documentId: note.id ?? decoded.documentId,
      versionToken: note.versionToken,
    })
    const view = parsed.views.find((candidate) => candidate.viewRef === input.viewRef)

    if (!view || !note.filePath) {
      throw new ViewSnapshotConflictError('stale viewRef')
    }
    const cacheKey = this.planKey(
      input.store,
      input.viewRef,
      input.snapshotGeneration,
      input.schemaVersionToken,
      input.cacheScope,
    )
    const cached = this.cachedPlan(cacheKey)

    if (cached) {
      return { note, parsed, view, prepared: cached }
    }
    const block = parsed.blocks[view.block]
    const source = ViewSourceV1Schema.safeParse(block?.source)
    const definition = ViewDefinitionV1Schema.safeParse(view.definition)

    if (!source.success || !definition.success) {
      throw new ViewSnapshotConflictError('view is not executable')
    }
    const directory = directoryOf(note.filePath)
    const prepared = await this.coalescedPlan(cacheKey, input.signal, async (signal) => {
      const current = await this.prepare({
        store: input.store,
        source: source.data,
        view: definition.data,
        directory,
        projects: input.projects,
        schema: input.schema,
        signal,
        fallbackGeneration: note.versionToken,
        cacheScope: input.cacheScope,
      })

      if (signal?.aborted) {
        throw new ViewExecutionCancelledError()
      }
      if (current.snapshotGeneration !== input.snapshotGeneration) {
        throw new ViewSnapshotConflictError('view snapshot changed')
      }
      this.rememberPlan(cacheKey, current)
      return current
    })

    return { note, parsed, view, prepared }
  }
}
