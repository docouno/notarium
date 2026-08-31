import { describe, expect, it, vi } from 'vitest'
import { FIELD_TYPE, VIEW_SUMMARY_BATCH_MAX } from '@notarium/contract'
import {
  analyzeDocumentState,
  boardReaderDefinition,
  createReaderRegistry,
  type KnowledgeStore,
  type NoteContent,
  type NoteMeta,
  type ReaderDefinition,
} from '@notarium/core'

import type { FieldSchemaSnapshot } from '../../fields'
import { NotesViewSource, viewSnapshotGeneration } from '../notesSource'
import { createViewSourceRegistry, type ViewSourceHandler } from '../sourceRegistry'
import type { ViewProjectionAdapter } from '../viewProjection'
import { ViewSummaryService } from './viewSummary'

const carrier = (second = false, rankSeed?: string) => `\`\`\`nota
version: 1
source: { kind: notes, scope: space }
views:
  - name: Tasks
    type: board
    options:
      groupBy: note.status
${rankSeed ? `      order:\n        kind: manual\n        ranks: |-\n          ["${rankSeed}","a0"]\n` : ''}
${second ? '  - name: Later\n    type: unknown-reader\n' : ''}\`\`\``

const schema: FieldSchemaSnapshot = {
  version: 1,
  versionToken: 'schema-v1',
  status: 'ready',
  fields: [
    {
      key: 'status',
      type: FIELD_TYPE.enum,
      values: [{ key: 'todo' }, { key: 'done' }],
    },
  ],
}

const card = (id: string, status: string): NoteMeta => ({
  id,
  title: id,
  filePath: `${id}.md`,
  modifiedAt: '2026-08-30T00:00:00.000Z',
  createdAt: null,
  fields: { keys: { status } },
})

const viewDetail = (id: string, content: string): NoteContent => ({
  id,
  title: id,
  filePath: `${id}.md`,
  content,
  frontmatter: { view: 'board' },
  versionToken: `v1:${id}`,
})

describe('ViewSummaryService', () => {
  it('summarizes only the primary view and prefixes a multiple-view carrier', async () => {
    const snapshot = [card('a', 'todo'), card('b', 'done')]
    const details = {
      one: viewDetail('one', carrier()),
      multiple: viewDetail('multiple', carrier(true)),
      stale: viewDetail('stale', 'ordinary prose'),
    }
    const read = vi.fn(async (id: string) => details[id as keyof typeof details])
    const store = { list: vi.fn(async () => snapshot), read } as unknown as KnowledgeStore
    const service = new ViewSummaryService(createReaderRegistry([boardReaderDefinition]))
    const summaries = await service.batch({
      store,
      noteIds: ['one', 'multiple', 'stale'],
      projects: [],
      schema,
      snapshot,
    })

    expect(summaries.get('one')).toEqual({ status: 'ready', text: '2 columns · 2 cards' })
    expect(summaries.get('multiple')).toEqual({
      status: 'ready',
      text: '2 views · primary: 2 columns · 2 cards',
    })
    expect(summaries.has('stale')).toBe(false)
    expect(store.list).not.toHaveBeenCalled()
  })

  it('caps one request at 100 unique view documents', async () => {
    const snapshot: NoteMeta[] = []
    const read = vi.fn(async (id: string) => viewDetail(id, 'ordinary prose'))
    const store = { list: vi.fn(async () => snapshot), read } as unknown as KnowledgeStore
    const service = new ViewSummaryService(createReaderRegistry([boardReaderDefinition]))
    const summaries = await service.batch({
      store,
      noteIds: Array.from({ length: VIEW_SUMMARY_BATCH_MAX + 1 }, (_, index) => `view-${index}`),
      projects: [],
      snapshot,
    })

    expect(summaries.size).toBe(0)
    expect(read).toHaveBeenCalledTimes(VIEW_SUMMARY_BATCH_MAX)
  })

  it('never reuses a summary across stores with identical ids and generations', async () => {
    const snapshot: NoteMeta[] = [
      {
        id: 'task',
        title: 'Task',
        filePath: 'task.md',
        modifiedAt: '2026-08-30T00:00:00.000Z',
        createdAt: null,
        fields: { keys: {}, truncatedMore: 1 },
      },
    ]
    const filtered = `\`\`\`nota
version: 1
source:
  kind: notes
  scope: space
  filter:
    op: and
    nodes:
      - op: or
        ns: note
        key: status
        values: [{ kind: eq, value: todo }]
views:
  - name: Tasks
    type: board
    options: { groupBy: note.status }
\`\`\``
    const storeWith = (status: string) =>
      ({
        list: vi.fn(async () => snapshot),
        read: vi.fn(async (id: string): Promise<NoteContent> => {
          if (id === 'view') {
            return viewDetail(id, filtered)
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
            versionToken: `v1:${status}`,
          }
        }),
      }) as unknown as KnowledgeStore
    const firstStore = storeWith('todo')
    const secondStore = storeWith('done')
    const service = new ViewSummaryService(createReaderRegistry([boardReaderDefinition]))
    const input = {
      noteIds: ['view'],
      projects: [],
      schema,
      snapshot,
      snapshotGeneration: 'same-generation',
    }
    const first = await service.batch({ ...input, store: firstStore })
    const second = await service.batch({ ...input, store: secondStore })

    expect(first.get('view')?.text).toContain('1 card')
    expect(second.get('view')?.text).toContain('0 cards')
  })

  it('partitions cacheable source summaries by store identity', async () => {
    const summaryReader: ReaderDefinition = {
      type: 'summary',
      compileOptions: () => ({ status: 'ready', options: {} }),
      dataNeeds: () => ({ properties: [], window: 'source' }),
      summaryDataNeeds: () => ({ properties: [], window: 'source' }),
      mutationCapabilities: () => ({}),
      project: (data) => ({ data }),
    }
    const adapter: ViewProjectionAdapter = {
      summary: (projection) =>
        `${(projection as { data: { total?: number } }).data.total ?? 0} rows`,
      prose: () => 'Summary',
      structured: () => ({ kind: 'summary' }),
    }
    const totals = new WeakMap<KnowledgeStore, number>()
    const handler = {
      kind: 'store-shaped',
      capture: async () => ({ snapshotGeneration: 'same-generation' }),
      prepare: async (input) => ({
        status: 'ready' as const,
        total: totals.get(input.store) ?? 0,
        rows: [],
        snapshotGeneration: 'same-generation',
        sourceKind: 'store-shaped',
      }),
      window: () => ({ total: 0, rows: [] }),
    } satisfies ViewSourceHandler
    const document: NoteContent = {
      id: 'view',
      title: 'View',
      filePath: 'view.md',
      content: `\`\`\`nota
version: 1
source: { kind: store-shaped }
views:
  - name: Summary
    type: summary
\`\`\``,
      frontmatter: { view: 'summary' },
      versionToken: 'v1:view',
    }
    const store = () =>
      ({
        list: vi.fn(async () => []),
        read: vi.fn(async () => document),
      }) as unknown as KnowledgeStore
    const firstStore = store()
    const secondStore = store()

    totals.set(firstStore, 1)
    totals.set(secondStore, 2)
    const service = new ViewSummaryService(
      createReaderRegistry([summaryReader]),
      { summary: adapter },
      createViewSourceRegistry([handler]),
    )
    const input = {
      noteIds: ['view'],
      projects: [],
      snapshot: [] as NoteMeta[],
      snapshotGeneration: 'same-generation',
    }
    const first = await service.batch({ ...input, store: firstStore })
    const second = await service.batch({ ...input, store: secondStore })

    expect(first.get('view')?.text).toBe('1 rows')
    expect(second.get('view')?.text).toBe('2 rows')
  })

  it('retries an incomplete exact summary without a generation change', async () => {
    const snapshot: NoteMeta[] = [
      {
        id: 'task',
        title: 'Task',
        filePath: 'task.md',
        modifiedAt: null,
        createdAt: null,
        fields: { keys: {}, truncatedMore: 1 },
      },
    ]
    let unavailable = true
    const store = {
      list: vi.fn(async () => snapshot),
      read: vi.fn(async (id: string): Promise<NoteContent> => {
        if (id === 'view') {
          return viewDetail(id, carrier())
        }
        if (unavailable) {
          throw new Error('temporary exact read failure')
        }
        const documentState = analyzeDocumentState({
          source: new TextEncoder().encode('---\nstatus: todo\n---\nBody'),
          pathFallbackTitle: 'Task',
        })

        return {
          id,
          title: 'Task',
          filePath: 'task.md',
          content: 'Body',
          frontmatter: { status: 'todo' },
          documentState,
          versionToken: 'v1:task',
        }
      }),
    } as unknown as KnowledgeStore
    const service = new ViewSummaryService(createReaderRegistry([boardReaderDefinition]))
    const input = {
      store,
      noteIds: ['view'],
      projects: [],
      schema,
      snapshot,
      snapshotGeneration: 'same-generation',
    }
    const first = await service.batch(input)

    unavailable = false
    const recovered = await service.batch(input)

    expect(first.has('view')).toBe(false)
    expect(recovered.get('view')?.text).toContain('1 card')
  })

  it('counts summary groups without title ordering or retaining source rows', async () => {
    let titleReads = 0
    const snapshot = Array.from({ length: 1_000 }, (_, index) => {
      const meta = {
        id: `task-${index}`,
        title: '',
        filePath: `task-${index}.md`,
        modifiedAt: null,
        createdAt: null,
        fields: { keys: { status: `s${index % 10}` } },
      } satisfies NoteMeta

      Object.defineProperty(meta, 'title', {
        enumerable: true,
        get: () => {
          titleReads++
          return `Task ${index}`
        },
      })
      return meta
    })
    const store = {
      list: vi.fn(async () => snapshot),
      read: vi.fn(async (id: string) => viewDetail(id, carrier())),
    } as unknown as KnowledgeStore
    const source = new NotesViewSource()
    const prepare = vi.spyOn(source, 'prepare')
    const service = new ViewSummaryService(
      createReaderRegistry([boardReaderDefinition]),
      undefined,
      createViewSourceRegistry([source]),
    )
    const summaries = await service.batch({
      store,
      noteIds: ['view'],
      projects: [],
      snapshot,
      snapshotGeneration: 'supplied-generation',
    })
    const prepared = await prepare.mock.results[0]!.value

    expect(summaries.get('view')?.text).toBe('10 columns · 1000 cards')
    expect(titleReads).toBe(0)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(prepared.groups).toHaveLength(10)
    expect(prepared).not.toHaveProperty('rows')
    expect(prepared).not.toHaveProperty('rowBuckets')
  })

  it('omits one failed source summary while keeping a healthy sibling', async () => {
    const summaryReader: ReaderDefinition = {
      type: 'summary',
      compileOptions: () => ({ status: 'ready', options: {} }),
      dataNeeds: () => ({ properties: [], window: 'source' }),
      summaryDataNeeds: () => ({ properties: [], window: 'source' }),
      mutationCapabilities: () => ({}),
      project: (data) => ({ data }),
    }
    const adapter: ViewProjectionAdapter = {
      summary: (projection) =>
        `${(projection as { data: { total?: number } }).data.total ?? 0} rows`,
      prose: () => 'Summary',
      structured: () => ({ kind: 'summary' }),
    }
    let outage = true
    const failing = {
      kind: 'failing',
      capture: async () => {
        if (outage) {
          throw new Error('raw source failure')
        }

        return { snapshotGeneration: 'shared-generation' }
      },
      prepare: async () => ({
        status: 'ready' as const,
        total: 4,
        rows: [],
        snapshotGeneration: 'shared-generation',
        sourceKind: 'failing',
      }),
      window: () => ({ total: 0, rows: [] }),
    } satisfies ViewSourceHandler
    const healthy = {
      kind: 'healthy',
      capture: async () => ({ snapshotGeneration: 'healthy-generation' }),
      prepare: async () => ({
        status: 'ready' as const,
        total: 2,
        rows: [],
        snapshotGeneration: 'healthy-generation',
        sourceKind: 'healthy',
      }),
      window: () => ({ total: 0, rows: [] }),
    } satisfies ViewSourceHandler
    const document = (id: string, kind: string): NoteContent => ({
      id,
      title: id,
      filePath: `${id}.md`,
      content: `\`\`\`nota
version: 1
source: { kind: ${kind} }
views:
  - name: Summary
    type: summary
\`\`\``,
      frontmatter: { view: 'summary' },
      versionToken: `v1:${id}`,
    })
    const store = {
      list: vi.fn(async () => []),
      read: vi.fn(async (id: string) => document(id, id)),
    } as unknown as KnowledgeStore
    const service = new ViewSummaryService(
      createReaderRegistry([summaryReader]),
      { summary: adapter },
      createViewSourceRegistry([failing, healthy]),
    )
    const summaries = await service.batch({
      store,
      noteIds: ['failing', 'healthy'],
      projects: [],
      snapshot: [],
      snapshotGeneration: 'shared-generation',
    })

    expect(summaries.has('failing')).toBe(false)
    expect(summaries.get('healthy')).toEqual({ status: 'ready', text: '2 rows' })
    outage = false
    const recovered = await service.batch({
      store,
      noteIds: ['failing'],
      projects: [],
      snapshot: [],
      snapshotGeneration: 'shared-generation',
    })

    expect(recovered.get('failing')).toEqual({ status: 'ready', text: '4 rows' })
  })

  it('reuses one 10k snapshot and cached primary projections for 50 view documents', async () => {
    const snapshot = Array.from({ length: 10_000 }, (_, index) =>
      card(`task-${index}`, `status-${index % 10}`),
    )
    const generation = await viewSnapshotGeneration(snapshot)
    const noteIds = Array.from({ length: 50 }, (_, index) => `view-${index}`)
    const read = vi.fn(async (id: string) => ({
      ...viewDetail(id, carrier(false, id)),
      filePath: `folder-${id}/${id}.md`,
    }))
    const store = {
      list: vi.fn(async () => {
        throw new Error('the supplied batch snapshot must be reused')
      }),
      read,
    } as unknown as KnowledgeStore
    const compile = vi.spyOn(boardReaderDefinition, 'compileOptions')
    const prepare = vi.spyOn(NotesViewSource.prototype, 'prepare')
    const service = new ViewSummaryService(createReaderRegistry([boardReaderDefinition]))
    const input = {
      store,
      noteIds,
      projects: [],
      snapshot,
      snapshotGeneration: generation,
    }
    const first = await service.batch(input)
    const compileCount = compile.mock.calls.length
    const second = await service.batch(input)

    expect(first.size).toBe(50)
    expect(new Set([...first.values()].map((summary) => summary.text))).toEqual(
      new Set(['10 columns · 10000 cards']),
    )
    expect(second).toEqual(first)
    expect(compile.mock.calls.length).toBe(compileCount)
    expect(store.list).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledTimes(100)
    expect(prepare).toHaveBeenCalledTimes(1)

    const changedSnapshot = [
      { ...snapshot[0]!, fields: { keys: { status: 'status-10' } } },
      ...snapshot.slice(1),
    ]
    const changed = await service.batch({
      ...input,
      noteIds: [noteIds[0]!],
      snapshot: changedSnapshot,
      snapshotGeneration: await viewSnapshotGeneration(changedSnapshot),
    })

    expect(changed.get(noteIds[0]!)).toEqual({
      status: 'ready',
      text: '11 columns · 10000 cards',
    })
    expect(compile.mock.calls.length).toBeGreaterThan(compileCount)
    expect(prepare).toHaveBeenCalledTimes(2)
  }, 20_000)
})
