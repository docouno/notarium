import {
  VIEW_SUMMARY_BATCH_MAX,
  type ViewDefinitionV1,
  ViewDefinitionV1Schema,
  type ViewSourceV1,
  ViewSourceV1Schema,
  type ViewSummary,
} from '@notarium/contract'
import {
  compileReaderSummaryView,
  type KnowledgeStore,
  type NoteMeta,
  parseViewDocument,
  type ReaderRegistry,
  sha256Hex,
} from '@notarium/core'

import type { FieldSchemaSnapshot } from '../../fields'
import type { ProjectRecord } from '../../metaDb'
import { type ViewExecutionRequestContext, ViewExecutionService } from '../execution'
import { viewSnapshotGeneration } from '../notesSource'
import { VIEW_PROJECTION_ADAPTERS, VIEW_SOURCE_REGISTRY } from '../registry'
import type { ViewSourceRegistry } from '../sourceRegistry'
import { summarizeReaderView, type ViewProjectionAdapters } from '../viewProjection'

const SUMMARY_CACHE_MAX = 2_048

const directoryOf = (filePath: string): string => {
  const slash = filePath.lastIndexOf('/')

  return slash < 0 ? '' : filePath.slice(0, slash)
}

const countText = (count: number, singular: string, plural: string): string =>
  `${count} ${count === 1 ? singular : plural}`

const readySummary = (views: number, primary: string): ViewSummary => ({
  status: 'ready',
  text: views > 1 ? `${countText(views, 'view', 'views')} · primary: ${primary}` : primary,
})

type PreparedPlan = Awaited<ReturnType<ViewExecutionService['prepare']>>

export class ViewSummaryService {
  private readonly cache = new Map<string, ViewSummary | null>()
  private readonly execution: ViewExecutionService
  private readonly storeIds = new WeakMap<KnowledgeStore, number>()
  private nextStoreId = 1

  constructor(
    private readonly readers: ReaderRegistry,
    private readonly adapters: ViewProjectionAdapters = VIEW_PROJECTION_ADAPTERS,
    sources: ViewSourceRegistry = VIEW_SOURCE_REGISTRY,
  ) {
    this.execution = new ViewExecutionService(readers, sources)
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

  private remember(key: string, summary: ViewSummary | null): ViewSummary | null {
    this.cache.delete(key)
    this.cache.set(key, summary)

    while (this.cache.size > SUMMARY_CACHE_MAX) {
      this.cache.delete(this.cache.keys().next().value!)
    }

    return summary
  }

  private async one(input: {
    store: KnowledgeStore
    note: Awaited<ReturnType<KnowledgeStore['read']>>
    noteId: string
    snapshotGeneration: string
    projects: readonly ProjectRecord[]
    schema?: FieldSchemaSnapshot
    signal?: AbortSignal
    cacheScope?: string
    request: ViewExecutionRequestContext
    plans: Map<string, Promise<PreparedPlan>>
  }): Promise<ViewSummary | null> {
    const note = input.note
    const versionToken = note.versionToken

    if (!versionToken || !note.filePath) {
      return null
    }
    const parsed = parseViewDocument(note.content, {
      documentId: note.id ?? input.noteId,
      versionToken,
    })
    const primary = parsed.blocks[0]?.views[0]
    const block = primary ? parsed.blocks[primary.block] : undefined
    const source = ViewSourceV1Schema.safeParse(block?.source)
    const definition = ViewDefinitionV1Schema.safeParse(primary?.definition)
    const cacheKey = await sha256Hex(
      JSON.stringify({
        document: [input.noteId, versionToken, note.filePath],
        store: this.storeId(input.store),
        cacheScope: input.cacheScope ?? null,
        schema: input.schema?.versionToken ?? null,
        snapshot: input.snapshotGeneration,
        projects: input.projects.map((project) => [project.id, project.path, project.status]),
        source: source.success ? (source.data satisfies ViewSourceV1) : null,
        view: definition.success ? (definition.data satisfies ViewDefinitionV1) : null,
      }),
    )
    const hasCached = this.cache.has(cacheKey)
    const cached = this.cache.get(cacheKey) ?? null

    if (hasCached) {
      this.cache.delete(cacheKey)
      this.cache.set(cacheKey, cached)
      return cached
    }
    if (!primary || !source.success || !definition.success) {
      return this.remember(cacheKey, null)
    }
    const summaryReader = compileReaderSummaryView(this.readers, definition.data)

    if (summaryReader.status !== 'ready') {
      return this.remember(cacheKey, null)
    }
    const planKey = await sha256Hex(
      JSON.stringify({
        source: source.data,
        view: {
          type: definition.data.type,
          filter: definition.data.filter ?? null,
          dataNeeds: summaryReader.dataNeeds,
        },
        sourceContext: this.execution.planIdentity(
          source.data,
          directoryOf(note.filePath),
          input.projects,
          input.cacheScope,
        ),
        schema: input.schema?.versionToken ?? null,
        snapshot: input.snapshotGeneration,
        projects: input.projects.map((project) => [project.id, project.path, project.status]),
        cacheScope: input.cacheScope ?? null,
      }),
    )
    let plan = input.plans.get(planKey)

    if (!plan) {
      plan = this.execution.prepare({
        store: input.store,
        source: source.data,
        view: definition.data,
        directory: directoryOf(note.filePath),
        projects: input.projects,
        schema: input.schema,
        signal: input.signal,
        request: input.request,
        purpose: 'summary',
        cacheScope: input.cacheScope,
      })
      input.plans.set(planKey, plan)
    }
    const prepared = await plan
    const primaryText =
      prepared.status === 'ready'
        ? summarizeReaderView(this.readers, this.adapters, definition.data, {
            groups: prepared.groups,
            total: prepared.total,
          })
        : null

    const summary = primaryText ? readySummary(parsed.views.length, primaryText) : null

    return prepared.status === 'ready' && !(prepared.exactWitnesses?.size ?? 0)
      ? this.remember(cacheKey, summary)
      : summary
  }

  async batch(input: {
    store: KnowledgeStore
    noteIds: readonly string[]
    projects: readonly ProjectRecord[]
    schema?: FieldSchemaSnapshot
    signal?: AbortSignal
    snapshot?: readonly NoteMeta[]
    snapshotGeneration?: string
    cacheScope?: string
  }): Promise<Map<string, ViewSummary>> {
    const noteIds = [...new Set(input.noteIds)].slice(0, VIEW_SUMMARY_BATCH_MAX)

    if (!noteIds.length || input.signal?.aborted) {
      return new Map()
    }
    const snapshot = input.snapshot ?? (await input.store.list())
    const snapshotGeneration = input.snapshotGeneration ?? (await viewSnapshotGeneration(snapshot))
    const request = this.execution.requestContext({
      store: input.store,
      projects: input.projects,
      signal: input.signal,
      snapshot,
      snapshotGeneration,
      cacheScope: input.cacheScope,
    })
    const notes = await Promise.all(
      noteIds.map(async (noteId) => {
        try {
          return await input.store.read(noteId)
        } catch {
          return null
        }
      }),
    )
    const summaries: Array<readonly [string, ViewSummary]> = []
    const plans = new Map<string, Promise<PreparedPlan>>()

    for (const [index, noteId] of noteIds.entries()) {
      if (input.signal?.aborted) {
        break
      }
      const note = notes[index]
      const summary = note
        ? await this.one({
            ...input,
            note,
            noteId,
            snapshotGeneration,
            request,
            plans,
          })
        : null

      if (summary) {
        summaries.push([noteId, summary])
      }
      if ((index + 1) % 8 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }

    return new Map(summaries)
  }
}
