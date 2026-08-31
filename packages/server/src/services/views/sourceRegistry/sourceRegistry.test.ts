import { describe, expect, it, vi } from 'vitest'
import { createReaderRegistry, type KnowledgeStore, type ReaderDefinition } from '@notarium/core'

import { ViewExecutionService } from '../execution'
import {
  createViewSourceRegistry,
  type PreparedView,
  type ViewSourceCaptureInput,
  type ViewSourceExecutionContext,
  type ViewSourceHandler,
} from './sourceRegistry'

const reader: ReaderDefinition = {
  type: 'stub-reader',
  compileOptions: () => ({ status: 'ready', options: {} }),
  dataNeeds: () => ({ properties: [], window: 'source' }),
  mutationCapabilities: () => ({}),
  project: (data) => data,
}

describe('view source registry', () => {
  it('dispatches by the persisted source tag without a generic source branch', async () => {
    const capture = vi.fn(async (): Promise<ViewSourceExecutionContext> => ({
      snapshotGeneration: 'source-generation',
    }))
    const prepare = vi.fn(async (): Promise<PreparedView> => ({
      status: 'ready',
      total: 7,
      rows: [],
      snapshotGeneration: 'source-generation',
      sourceKind: 'stub-source',
    }))
    const handler: ViewSourceHandler = {
      kind: 'stub-source',
      capture,
      prepare,
      window: () => ({ total: 0, rows: [] }),
    }
    const sources = createViewSourceRegistry([handler])
    const execution = new ViewExecutionService(createReaderRegistry([reader]), sources)
    const store = {} as KnowledgeStore
    const prepared = await execution.prepare({
      store,
      source: { kind: 'stub-source' },
      view: { name: 'Stub', type: 'stub-reader' },
      directory: '',
      projects: [],
      schema: { version: 1, versionToken: 'schema-v1', status: 'ready', fields: [] },
    })

    expect(prepared).toMatchObject({
      status: 'ready',
      total: 7,
      schemaVersionToken: 'schema-v1',
    })
    expect(capture).toHaveBeenCalledTimes(1)
    expect(prepare).toHaveBeenCalledTimes(1)

    const unsupported = await execution.prepare({
      store,
      source: { kind: 'later-source' },
      view: { name: 'Stub', type: 'stub-reader' },
      directory: '',
      projects: [],
    })

    expect(unsupported).toMatchObject({
      status: 'unsupported',
      diagnostics: ['Unknown source: later-source'],
    })
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('refuses duplicate source tags', () => {
    const handler = {
      kind: 'same',
      capture: async () => ({ snapshotGeneration: 'generation' }),
      prepare: async () => ({ status: 'ready', snapshotGeneration: 'generation' }) as PreparedView,
      window: () => ({ total: 0, rows: [] }),
    } satisfies ViewSourceHandler

    expect(() => createViewSourceRegistry([handler, handler])).toThrow('duplicate view source kind')
  })

  it('captures distinct configurations of one source kind independently', async () => {
    const capture = vi.fn(async (input: ViewSourceCaptureInput) => ({
      snapshotGeneration: `generation:${String(input.source.variant)}`,
    }))
    const handler = {
      kind: 'configured',
      capture,
      prepare: async (input) => ({
        status: 'ready' as const,
        snapshotGeneration: input.context.snapshotGeneration,
        sourceKind: 'configured',
      }),
      window: () => ({ total: 0, rows: [] }),
    } satisfies ViewSourceHandler
    const execution = new ViewExecutionService(
      createReaderRegistry([reader]),
      createViewSourceRegistry([handler]),
    )
    const store = {} as KnowledgeStore
    const request = execution.requestContext({ store, projects: [], cacheScope: 'space-1' })
    const first = await execution.prepare({
      store,
      source: { kind: 'configured', variant: 'one' },
      view: { name: 'First', type: 'stub-reader' },
      directory: 'one',
      projects: [],
      request,
    })
    const second = await execution.prepare({
      store,
      source: { kind: 'configured', variant: 'two' },
      view: { name: 'Second', type: 'stub-reader' },
      directory: 'two',
      projects: [],
      request,
    })

    expect(first.snapshotGeneration).toBe('generation:one')
    expect(second.snapshotGeneration).toBe('generation:two')
    expect(capture).toHaveBeenCalledTimes(2)
    expect(capture.mock.calls[0]?.[0]).toMatchObject({ cacheScope: 'space-1', directory: 'one' })
  })

  it('does not advertise reader move without a source mutation adapter', async () => {
    const movingReader: ReaderDefinition = {
      ...reader,
      mutationCapabilities: () => ({ move: true }),
    }
    const handler = {
      kind: 'future',
      capture: async () => ({ snapshotGeneration: 'future-generation' }),
      prepare: async () => ({
        status: 'ready' as const,
        snapshotGeneration: 'future-generation',
        sourceKind: 'future',
      }),
      window: () => ({ total: 0, rows: [] }),
    } satisfies ViewSourceHandler
    const execution = new ViewExecutionService(
      createReaderRegistry([movingReader]),
      createViewSourceRegistry([handler]),
    )
    const store = {
      read: async () => ({
        id: 'view',
        title: 'Future',
        filePath: 'future.md',
        content: `\`\`\`nota
version: 1
source: { kind: future }
views:
  - name: Future
    type: stub-reader
\`\`\``,
        frontmatter: { view: 'stub-reader' },
        versionToken: 'v1:view',
      }),
    } as unknown as KnowledgeStore
    const saved = await execution.saved({
      store,
      noteId: 'view',
      projects: [],
    })
    const prepared = saved.prepared.get(saved.parsed.views[0]!.viewRef!)!

    expect(prepared.status).toBe('ready')
    expect(prepared.capabilities).toBeUndefined()
  })

  it('advertises move only when the source installs a callable board adapter', async () => {
    const movingReader: ReaderDefinition = {
      ...reader,
      mutationCapabilities: () => ({ move: true }),
    }
    const fieldKey = vi.fn((options: unknown) => {
      void options
      return 'status'
    })
    const readMembership = vi.fn(async () => ({ versionToken: 'v1:card', value: 'todo' }))
    const writeMembership = vi.fn(async () => ({ versionToken: 'v2:card' }))
    const handler = {
      kind: 'movable',
      boardMove: { fieldKey, readMembership, writeMembership },
      capture: async () => ({ snapshotGeneration: 'generation' }),
      prepare: async () => ({
        status: 'ready' as const,
        snapshotGeneration: 'generation',
        sourceKind: 'movable',
        capabilities: { move: true },
      }),
      window: () => ({ total: 0, rows: [] }),
    } satisfies ViewSourceHandler
    const execution = new ViewExecutionService(
      createReaderRegistry([movingReader]),
      createViewSourceRegistry([handler]),
    )
    const prepared = await execution.prepare({
      store: {} as KnowledgeStore,
      source: { kind: 'movable' },
      view: { name: 'Movable', type: 'stub-reader' },
      directory: '',
      projects: [],
    })

    expect(prepared.capabilities).toEqual({ move: true })
    expect(handler.boardMove.fieldKey({ groupBy: 'note.status' })).toBe('status')
    expect(fieldKey).toHaveBeenCalledTimes(1)
    expect(readMembership).not.toHaveBeenCalled()
    expect(writeMembership).not.toHaveBeenCalled()
  })
})
