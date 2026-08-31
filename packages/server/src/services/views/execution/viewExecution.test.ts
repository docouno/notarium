import { describe, expect, it, vi } from 'vitest'
import { VIEW_EXACT_READ_LIMIT } from '@notarium/contract'
import {
  analyzeDocumentState,
  createReaderRegistry,
  type KnowledgeStore,
  type NoteContent,
  type NoteMeta,
  parseViewDocument,
  type ReaderDefinition,
} from '@notarium/core'

import { NotesViewSource } from '../notesSource'
import { createViewSourceRegistry, type ViewSourceHandler } from '../sourceRegistry'
import { ViewExecutionService } from './viewExecution'

const reader: ReaderDefinition = {
  type: 'stub',
  compileOptions: () => ({ status: 'ready', options: {} }),
  dataNeeds: (_options, view) => ({ properties: view.fields ?? [], window: 'source' }),
  mutationCapabilities: () => ({}),
  project: (data) => data,
}

const carrier = `\`\`\`nota
version: 1
source: { kind: notes, scope: space }
views:
  - name: First
    type: stub
    fields: [note.status]
  - name: Second
    type: stub
    fields: [note.status]
    options: { presentationOrder: second }
\`\`\``

const controlledCarrier = `\`\`\`nota
version: 1
source: { kind: controlled }
views:
  - name: Controlled
    type: stub
\`\`\``

const controlledFixture = (handler: ViewSourceHandler) => {
  const store = {
    read: vi.fn(async () => ({
      id: 'view',
      title: 'View',
      filePath: 'view.md',
      content: controlledCarrier,
      frontmatter: { view: 'stub' },
      versionToken: 'v1:view',
    })),
  } as unknown as KnowledgeStore
  const parsed = parseViewDocument(controlledCarrier, {
    documentId: 'view',
    versionToken: 'v1:view',
  })

  return {
    store,
    viewRef: parsed.views[0]!.viewRef!,
    execution: new ViewExecutionService(
      createReaderRegistry([reader]),
      createViewSourceRegistry([handler]),
    ),
  }
}

const exactNote = (meta: NoteMeta): NoteContent => {
  const documentState = analyzeDocumentState({
    source: new TextEncoder().encode('---\nstatus: doing\n---\nBody'),
    pathFallbackTitle: meta.title,
  })

  return {
    id: meta.id,
    title: meta.title,
    filePath: meta.filePath,
    content: 'Body',
    frontmatter: { status: 'doing' },
    documentState,
    versionToken: `v1:${meta.id}`,
  }
}

describe('ViewExecutionService', () => {
  it('captures one corpus and shares one physical exact-read budget across a saved document', async () => {
    const metas = Array.from({ length: VIEW_EXACT_READ_LIMIT + 44 }, (_, index): NoteMeta => ({
      id: `task-${index}`,
      title: `Task ${index}`,
      filePath: `task-${index}.md`,
      modifiedAt: '2026-08-30T00:00:00.000Z',
      createdAt: null,
      fields: { keys: {}, truncatedMore: 1 },
    }))
    const list = vi.fn(async () => metas)
    const read = vi.fn(async (id: string): Promise<NoteContent> => {
      if (id === 'view') {
        return {
          id,
          title: 'View',
          filePath: 'view.md',
          content: carrier,
          frontmatter: { view: 'stub' },
          versionToken: 'v1:view',
        }
      }
      const meta = metas.find((candidate) => candidate.id === id)

      if (!meta) {
        throw new Error('not found')
      }

      return exactNote(meta)
    })
    const store = { list, read } as unknown as KnowledgeStore
    const source = new NotesViewSource()
    const prepare = vi.spyOn(source, 'prepare')
    const execution = new ViewExecutionService(
      createReaderRegistry([reader]),
      createViewSourceRegistry([source]),
    )
    const saved = await execution.saved({ store, noteId: 'view', projects: [] })
    const prepared = [...saved.prepared.values()]

    expect(list).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledTimes(1 + VIEW_EXACT_READ_LIMIT)
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(new Set(prepared.map((view) => view.snapshotGeneration))).toHaveLength(1)
    expect(prepared[0]?.execution).toMatchObject({
      exactReads: VIEW_EXACT_READ_LIMIT,
      exactCacheHits: 0,
      exactRemaining: 44,
      exactFallbackTruncated: true,
    })

    const addressed = saved.parsed.views[1]!
    const addressedPlan = saved.prepared.get(addressed.viewRef!)!
    const exactReads = () => read.mock.calls.filter(([id]) => id !== 'view').length
    const seededWindows = await Promise.all(
      Array.from({ length: 5 }, () =>
        execution.savedView({
          store,
          viewRef: addressed.viewRef!,
          snapshotGeneration: addressedPlan.snapshotGeneration,
          projects: [],
        }),
      ),
    )

    expect(seededWindows.every(({ prepared: plan }) => plan.status === 'incomplete')).toBe(true)
    expect(
      seededWindows.every(
        ({ prepared: plan }) => execution.window(plan, { offset: 0, limit: 10 }).rows.length === 10,
      ),
    ).toBe(true)
    expect(list).toHaveBeenCalledTimes(1)
    expect(exactReads()).toBe(VIEW_EXACT_READ_LIMIT)
    expect(prepare).toHaveBeenCalledTimes(2)
    const coldSource = new NotesViewSource()
    const coldPrepare = vi.spyOn(coldSource, 'prepare')
    const coldExecution = new ViewExecutionService(
      createReaderRegistry([reader]),
      createViewSourceRegistry([coldSource]),
    )

    await Promise.all(
      Array.from({ length: 10 }, () =>
        coldExecution.savedView({
          store,
          viewRef: addressed.viewRef!,
          snapshotGeneration: addressedPlan.snapshotGeneration,
          projects: [],
        }),
      ),
    )

    expect(coldPrepare).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('prepares ten equivalent 10k views once inside one saved manifest', async () => {
    const metas = Array.from({ length: 10_000 }, (_, index): NoteMeta => ({
      id: `task-${index}`,
      title: `Task ${index}`,
      filePath: `task-${index}.md`,
      modifiedAt: null,
      createdAt: null,
      fields: { keys: { status: `s${index % 10}` } },
    }))
    const content = `\`\`\`nota
version: 1
source: { kind: notes, scope: space }
views:
${Array.from(
  { length: 10 },
  (_, index) => `  - name: View ${index}\n    type: stub\n    fields: [note.status]`,
).join('\n')}
\`\`\``
    const list = vi.fn(async () => metas)
    const store = {
      list,
      read: vi.fn(async () => ({
        id: 'view',
        title: 'View',
        filePath: 'view.md',
        content,
        frontmatter: { view: 'stub' },
        versionToken: 'v1:view',
      })),
    } as unknown as KnowledgeStore
    const source = new NotesViewSource()
    const prepare = vi.spyOn(source, 'prepare')
    const execution = new ViewExecutionService(
      createReaderRegistry([reader]),
      createViewSourceRegistry([source]),
    )
    const saved = await execution.saved({ store, noteId: 'view', projects: [] })

    expect(saved.prepared.size).toBe(10)
    expect(list).toHaveBeenCalledTimes(1)
    expect(prepare).toHaveBeenCalledTimes(1)
  })

  it('binds hidden exact truth to version witnesses without overwriting an old plan', async () => {
    const meta: NoteMeta = {
      id: 'task',
      title: 'Task',
      filePath: 'task.md',
      modifiedAt: '2026-08-30T00:00:00.000Z',
      createdAt: null,
      fields: { keys: {}, truncatedMore: 1 },
    }
    const content = `\`\`\`nota
version: 1
source: { kind: notes, scope: space }
views:
  - name: Exact
    type: stub
    fields: [note.status]
\`\`\``
    let status = 'doing'
    let version = 'v1:task'
    const store = {
      list: vi.fn(async () => [meta]),
      read: vi.fn(async (id: string): Promise<NoteContent> => {
        if (id === 'view') {
          return {
            id,
            title: 'View',
            filePath: 'view.md',
            content,
            frontmatter: { view: 'stub' },
            versionToken: 'v1:view',
          }
        }
        const documentState = analyzeDocumentState({
          source: new TextEncoder().encode(`---\nstatus: ${status}\n---\nBody`),
          pathFallbackTitle: 'Task',
        })

        return {
          id,
          title: 'Task',
          filePath: 'task.md',
          content: 'Body',
          frontmatter: { status },
          documentState,
          versionToken: version,
        }
      }),
    } as unknown as KnowledgeStore
    const createExecution = () =>
      new ViewExecutionService(
        createReaderRegistry([reader]),
        createViewSourceRegistry([new NotesViewSource()]),
      )
    const warm = createExecution()
    const first = await warm.saved({ store, noteId: 'view', projects: [] })
    const view = first.parsed.views[0]!
    const firstPlan = first.prepared.get(view.viewRef!)!

    status = 'done'
    version = 'v2:task'
    const old = await warm.savedView({
      store,
      viewRef: view.viewRef!,
      snapshotGeneration: firstPlan.snapshotGeneration,
      projects: [],
    })

    expect(
      warm.window(old.prepared, { offset: 0, limit: 10 }).rows[0]?.fields?.status,
    ).toMatchObject({ value: 'doing' })
    const refreshed = await warm.saved({ store, noteId: 'view', projects: [] })
    const refreshedPlan = refreshed.prepared.get(refreshed.parsed.views[0]!.viewRef!)!
    const retained = await warm.savedView({
      store,
      viewRef: view.viewRef!,
      snapshotGeneration: firstPlan.snapshotGeneration,
      projects: [],
    })

    expect(refreshedPlan.snapshotGeneration).not.toBe(firstPlan.snapshotGeneration)
    expect(
      warm.window(retained.prepared, { offset: 0, limit: 10 }).rows[0]?.fields?.status,
    ).toMatchObject({ value: 'doing' })

    const cold = createExecution()

    await expect(
      cold.savedView({
        store,
        viewRef: view.viewRef!,
        snapshotGeneration: firstPlan.snapshotGeneration,
        projects: [],
      }),
    ).rejects.toThrow('view snapshot changed')
    const second = await cold.saved({ store, noteId: 'view', projects: [] })
    const secondPlan = second.prepared.get(second.parsed.views[0]!.viewRef!)!

    expect(secondPlan.snapshotGeneration).not.toBe(firstPlan.snapshotGeneration)
  })

  it('keeps a failing source local while a healthy sibling view prepares', async () => {
    const content = `\`\`\`nota
version: 1
source: { kind: failing }
views:
  - name: Failing
    type: stub
\`\`\`

\`\`\`nota
version: 1
source: { kind: healthy }
views:
  - name: Healthy
    type: stub
\`\`\``
    const failing = {
      kind: 'failing',
      capture: async () => {
        throw new Error('raw backend secret')
      },
      prepare: async () => {
        throw new Error('unreachable')
      },
      window: () => ({ total: 0, rows: [] }),
    } satisfies ViewSourceHandler
    const healthy = {
      kind: 'healthy',
      capture: async () => ({ snapshotGeneration: 'healthy-generation' }),
      prepare: async () => ({
        status: 'ready' as const,
        total: 3,
        rows: [],
        snapshotGeneration: 'healthy-generation',
        sourceKind: 'healthy',
      }),
      window: () => ({ total: 0, rows: [] }),
    } satisfies ViewSourceHandler
    const store = {
      read: vi.fn(async () => ({
        id: 'view',
        title: 'View',
        filePath: 'view.md',
        content,
        frontmatter: { view: 'stub' },
        versionToken: 'v1:view',
      })),
    } as unknown as KnowledgeStore
    const execution = new ViewExecutionService(
      createReaderRegistry([reader]),
      createViewSourceRegistry([failing, healthy]),
    )
    const saved = await execution.saved({
      store,
      noteId: 'view',
      projects: [],
      schema: { version: 1, versionToken: 'schema-v1', status: 'ready', fields: [] },
    })
    const results = saved.parsed.views.map((view) => saved.prepared.get(view.viewRef!)!)

    expect(results[0]).toMatchObject({
      status: 'invalid',
      diagnostics: ['Source “failing” is unavailable.'],
      schemaVersionToken: 'schema-v1',
    })
    expect(results[0]?.diagnostics?.join(' ')).not.toContain('secret')
    expect(results[1]).toMatchObject({
      status: 'ready',
      total: 3,
      schemaVersionToken: 'schema-v1',
    })
  })

  it('partitions prepared plans by caller cache scope', async () => {
    const content = `\`\`\`nota
version: 1
source: { kind: notes, scope: space }
views:
  - name: Scoped
    type: stub
\`\`\``
    const list = vi.fn(async () => [] as NoteMeta[])
    const store = {
      list,
      read: vi.fn(async () => ({
        id: 'view',
        title: 'View',
        filePath: 'view.md',
        content,
        frontmatter: { view: 'stub' },
        versionToken: 'v1:view',
      })),
    } as unknown as KnowledgeStore
    const execution = new ViewExecutionService(
      createReaderRegistry([reader]),
      createViewSourceRegistry([new NotesViewSource()]),
    )
    const saved = await execution.saved({
      store,
      noteId: 'view',
      projects: [],
      cacheScope: 'space-1:principal-1',
    })
    const view = saved.parsed.views[0]!
    const prepared = saved.prepared.get(view.viewRef!)!

    await execution.savedView({
      store,
      viewRef: view.viewRef!,
      snapshotGeneration: prepared.snapshotGeneration,
      projects: [],
      cacheScope: 'space-1:principal-1',
    })
    await execution.savedView({
      store,
      viewRef: view.viewRef!,
      snapshotGeneration: prepared.snapshotGeneration,
      projects: [],
      cacheScope: 'space-1:principal-2',
    })

    expect(list).toHaveBeenCalledTimes(2)
  })

  it('does not coalesce views that differ through an open extension key', async () => {
    const content = `\`\`\`nota
version: 1
source: { kind: notes, scope: space }
views:
  - name: First
    type: stub
    extension: one
  - name: Second
    type: stub
    extension: two
\`\`\``
    const store = {
      list: vi.fn(async () => [] as NoteMeta[]),
      read: vi.fn(async () => ({
        id: 'view',
        title: 'View',
        filePath: 'view.md',
        content,
        frontmatter: { view: 'stub' },
        versionToken: 'v1:view',
      })),
    } as unknown as KnowledgeStore
    const source = new NotesViewSource()
    const prepare = vi.spyOn(source, 'prepare')
    const execution = new ViewExecutionService(
      createReaderRegistry([reader]),
      createViewSourceRegistry([source]),
    )

    await execution.saved({ store, noteId: 'view', projects: [] })

    expect(prepare).toHaveBeenCalledTimes(2)
  })

  it('does not cache an aborted incomplete cold plan', async () => {
    let prepares = 0
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const handler = {
      kind: 'controlled',
      capture: async () => ({ snapshotGeneration: 'generation' }),
      prepare: async (input) => {
        prepares++
        if (prepares === 1) {
          markStarted()
          await new Promise<void>((resolve) => {
            if (input.signal?.aborted) {
              resolve()
            } else {
              input.signal?.addEventListener('abort', () => resolve(), { once: true })
            }
          })
          return {
            status: 'incomplete' as const,
            snapshotGeneration: 'generation',
            sourceKind: 'controlled',
          }
        }

        return {
          status: 'ready' as const,
          total: 1,
          rows: [],
          snapshotGeneration: 'generation',
          sourceKind: 'controlled',
        }
      },
      window: () => ({ total: 0, rows: [] }),
    } satisfies ViewSourceHandler
    const fixture = controlledFixture(handler)
    const abort = new AbortController()
    const cancelled = fixture.execution.savedView({
      store: fixture.store,
      viewRef: fixture.viewRef,
      snapshotGeneration: 'generation',
      projects: [],
      signal: abort.signal,
    })

    await started
    abort.abort()
    await expect(cancelled).rejects.toThrow('view execution cancelled')
    const healthy = await fixture.execution.savedView({
      store: fixture.store,
      viewRef: fixture.viewRef,
      snapshotGeneration: 'generation',
      projects: [],
    })

    expect(healthy.prepared.status).toBe('ready')
    expect(prepares).toBe(2)
  })

  it('stamps a custom source plan with the framework schema token used by its window', async () => {
    const handler = {
      kind: 'controlled',
      capture: async () => ({ snapshotGeneration: 'generation' }),
      prepare: async () => ({
        status: 'ready' as const,
        total: 0,
        rows: [],
        snapshotGeneration: 'generation',
        sourceKind: 'controlled',
      }),
      window: () => ({ total: 0, rows: [] }),
    } satisfies ViewSourceHandler
    const fixture = controlledFixture(handler)
    const schema = { version: 1, versionToken: 'schema-v1', status: 'ready' as const, fields: [] }
    const saved = await fixture.execution.saved({
      store: fixture.store,
      noteId: 'view',
      projects: [],
      schema,
    })
    const prepared = saved.prepared.get(saved.parsed.views[0]!.viewRef!)!

    expect(prepared.schemaVersionToken).toBe('schema-v1')
    await expect(
      fixture.execution.savedView({
        store: fixture.store,
        viewRef: fixture.viewRef,
        snapshotGeneration: prepared.snapshotGeneration,
        schemaVersionToken: prepared.schemaVersionToken,
        projects: [],
        schema,
      }),
    ).resolves.toMatchObject({ prepared: { schemaVersionToken: 'schema-v1' } })
  })

  it('does not let a new caller join an abandoned in-flight plan', async () => {
    let prepares = 0
    let markStarted!: () => void
    let releaseOld!: () => void
    let markOldReturned!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve
    })
    const oldReturned = new Promise<void>((resolve) => {
      markOldReturned = resolve
    })
    const handler = {
      kind: 'controlled',
      capture: async () => ({ snapshotGeneration: 'generation' }),
      prepare: async () => {
        prepares++
        if (prepares === 1) {
          markStarted()
          await oldGate
          markOldReturned()
          return {
            status: 'ready' as const,
            total: 999,
            rows: [],
            snapshotGeneration: 'generation',
            sourceKind: 'controlled',
          }
        }

        return {
          status: 'ready' as const,
          total: 1,
          rows: [],
          snapshotGeneration: 'generation',
          sourceKind: 'controlled',
        }
      },
      window: () => ({ total: 0, rows: [] }),
    } satisfies ViewSourceHandler
    const fixture = controlledFixture(handler)
    const abort = new AbortController()
    const abandoned = fixture.execution.savedView({
      store: fixture.store,
      viewRef: fixture.viewRef,
      snapshotGeneration: 'generation',
      projects: [],
      signal: abort.signal,
    })

    await started
    abort.abort()
    await expect(abandoned).rejects.toThrow('view execution cancelled')
    const healthy = await fixture.execution.savedView({
      store: fixture.store,
      viewRef: fixture.viewRef,
      snapshotGeneration: 'generation',
      projects: [],
    })

    expect(healthy.prepared.status).toBe('ready')
    expect(prepares).toBe(2)
    releaseOld()
    await oldReturned
    await new Promise<void>((resolve) => setImmediate(resolve))
    const retained = await fixture.execution.savedView({
      store: fixture.store,
      viewRef: fixture.viewRef,
      snapshotGeneration: 'generation',
      projects: [],
    })

    expect(retained.prepared.total).toBe(1)
    expect(prepares).toBe(2)
  })

  it('lets remaining waiters finish when one coalesced caller cancels', async () => {
    let prepares = 0
    let markStarted!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const handler = {
      kind: 'controlled',
      capture: async () => ({ snapshotGeneration: 'generation' }),
      prepare: async () => {
        prepares++
        markStarted()
        await gate
        return {
          status: 'ready' as const,
          total: 1,
          rows: [],
          snapshotGeneration: 'generation',
          sourceKind: 'controlled',
        }
      },
      window: () => ({ total: 0, rows: [] }),
    } satisfies ViewSourceHandler
    const fixture = controlledFixture(handler)
    const abort = new AbortController()
    const cancelled = fixture.execution.savedView({
      store: fixture.store,
      viewRef: fixture.viewRef,
      snapshotGeneration: 'generation',
      projects: [],
      signal: abort.signal,
    })

    await started
    const remaining = fixture.execution.savedView({
      store: fixture.store,
      viewRef: fixture.viewRef,
      snapshotGeneration: 'generation',
      projects: [],
    })

    await new Promise<void>((resolve) => setImmediate(resolve))
    abort.abort()
    await expect(cancelled).rejects.toThrow('view execution cancelled')
    release()
    await expect(remaining).resolves.toMatchObject({ prepared: { status: 'ready' } })
    expect(prepares).toBe(1)
  })
})
