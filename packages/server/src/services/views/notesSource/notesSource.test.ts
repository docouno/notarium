import { describe, expect, it, vi } from 'vitest'
import { FIELD_TYPE, PROJECT_STATUS, VIEW_EXACT_READ_LIMIT } from '@notarium/contract'
import {
  analyzeDocumentState,
  createReaderRegistry,
  type KnowledgeStore,
  type NoteContent,
  type NoteMeta,
  type ReaderDefinition,
} from '@notarium/core'

import type { FieldSchemaSnapshot } from '../../fields'
import type { ProjectRecord } from '../../metaDb'
import { ViewExecutionService } from '../execution'
import { createViewSourceRegistry } from '../sourceRegistry'
import { NotesViewSource, viewSnapshotGeneration } from './notesSource'

const reader: ReaderDefinition<{ groupBy?: string }> = {
  type: 'stub',
  compileOptions: (raw) => {
    const groupBy =
      typeof raw === 'object' &&
      raw != null &&
      typeof (raw as { groupBy?: unknown }).groupBy === 'string'
        ? (raw as { groupBy: string }).groupBy
        : undefined

    return { status: 'ready', options: { groupBy } }
  },
  dataNeeds: (options, view) => ({
    properties: view.fields ?? [],
    ...(options.groupBy ? { groupBy: options.groupBy } : {}),
    window: options.groupBy ? 'group' : 'source',
  }),
  mutationCapabilities: () => ({}),
  project: (data) => data,
}

const project = (path = 'work'): ProjectRecord => ({
  id: 'project-1',
  space: 'space-1',
  path,
  slug: 'work',
  aliases: [],
  pathAliases: [],
  displayName: 'Work',
  status: PROJECT_STATUS.active,
  lastSeen: '2026-08-30T00:00:00.000Z',
  createdAt: '2026-08-30T00:00:00.000Z',
})

const schema: FieldSchemaSnapshot = {
  version: 1,
  versionToken: 'schema-v1',
  status: 'ready',
  fields: [
    {
      key: 'status',
      type: FIELD_TYPE.enum,
      card: true,
      values: [
        { key: 'todo', label: 'To do', color: 'slate' },
        { key: 'doing', label: 'Doing', color: 'blue' },
        { key: 'done', label: 'Done', color: 'green' },
      ],
    },
    { key: 'owner', type: FIELD_TYPE.text, label: 'Owner', card: true },
    { key: 'team', type: FIELD_TYPE.text, label: 'Team' },
  ],
}

const detail = (meta: NoteMeta, frontmatter: string): NoteContent => {
  const state = analyzeDocumentState({
    source: new TextEncoder().encode(`---\n${frontmatter}\n---\n\n${meta.title}`),
    pathFallbackTitle: meta.title,
  })

  return {
    id: meta.id,
    title: meta.title,
    filePath: meta.filePath,
    content: meta.title,
    frontmatter: state.projection?.frontmatter ?? {},
    documentState: state,
    versionToken: `v1:${meta.id}`,
  }
}

const fakeStore = (
  metas: NoteMeta[],
  exact: Record<string, NoteContent>,
): { store: KnowledgeStore; read: ReturnType<typeof vi.fn> } => {
  const read = vi.fn(async (id: string) => {
    const value = exact[id]

    if (!value) {
      throw new Error('not found')
    }

    return value
  })

  return {
    read,
    store: {
      list: async () => metas,
      read,
    } as unknown as KnowledgeStore,
  }
}

const viewExecution = (definition: ReaderDefinition) =>
  new ViewExecutionService(
    createReaderRegistry([definition]),
    createViewSourceRegistry([new NotesViewSource()]),
  )

describe('NotesViewSource', () => {
  it('changes generation for a title change even when mtime is unavailable', async () => {
    const note: NoteMeta = {
      id: 'a',
      title: 'Before',
      filePath: 'a.md',
      modifiedAt: null,
      createdAt: null,
    }

    expect(await viewSnapshotGeneration([note])).not.toBe(
      await viewSnapshotGeneration([{ ...note, title: 'After' }]),
    )
  })

  it('shares AST membership, exact fallback, schema skeleton and per-group windows', async () => {
    const ready: NoteMeta = {
      id: 'a',
      title: 'Alpha',
      filePath: 'work/a.md',
      modifiedAt: '2026-08-30T00:00:00.000Z',
      createdAt: null,
      fields: { keys: { type: 'task', status: 'doing', owner: 'ann' } },
    }
    const ambiguous: NoteMeta = {
      id: 'b',
      title: 'Beta',
      filePath: 'work/b.md',
      modifiedAt: '2026-08-30T00:00:01.000Z',
      createdAt: null,
      fields: { keys: { type: 'task' }, truncatedMore: 2 },
    }
    const outside: NoteMeta = {
      id: 'c',
      title: 'Outside',
      filePath: 'other/c.md',
      modifiedAt: '2026-08-30T00:00:02.000Z',
      createdAt: null,
      fields: { keys: { type: 'task', status: 'todo', owner: 'ann' } },
    }
    const { store, read } = fakeStore([ready, ambiguous, outside], {
      b: detail(ambiguous, 'type: task\nstatus: todo\nowner: ann'),
    })
    const source = viewExecution(reader)
    const prepared = await source.prepare({
      store,
      source: {
        kind: 'notes',
        scope: 'project',
        filter: {
          op: 'and',
          nodes: [{ op: 'or', ns: 'note', key: 'type', values: [{ kind: 'eq', value: 'task' }] }],
        },
      },
      view: {
        name: 'Stub',
        type: 'stub',
        filter: {
          op: 'and',
          nodes: [{ op: 'or', ns: 'note', key: 'owner', values: [{ kind: 'present' }] }],
        },
        fields: ['note.owner'],
        options: { groupBy: 'note.status' },
      },
      directory: 'work/views',
      projects: [project()],
      schema,
    })

    expect(prepared.status).toBe('ready')
    expect(prepared.total).toBe(2)
    expect(read).toHaveBeenCalledTimes(1)
    expect(prepared.execution).toMatchObject({ exactReads: 1, exactRemaining: 0 })
    expect(prepared.groups?.map((group) => [group.value, group.label, group.count])).toEqual([
      ['todo', 'To do', 1],
      ['doing', 'Doing', 1],
      ['done', 'Done', 0],
    ])
    const doing = prepared.groups?.find((group) => group.value === 'doing')

    if (!doing) {
      throw new Error('doing group missing')
    }
    const window = source.window(prepared, { group: doing.key, offset: 0, limit: 100 }, schema)

    expect(window.total).toBe(1)
    expect(window.rows[0]).toMatchObject({
      id: 'a',
      group: { value: 'doing', label: 'Doing', color: 'blue' },
      fields: { owner: { value: 'ann', label: 'ann' } },
    })
  })

  it('adds schema card fields while keeping the grouping field off each card', async () => {
    const note: NoteMeta = {
      id: 'a',
      title: 'Alpha',
      filePath: 'work/a.md',
      modifiedAt: null,
      createdAt: null,
      fields: { keys: { status: 'doing', owner: 'ann', team: 'core' } },
    }
    const { store } = fakeStore([note], {})
    const cardReader: ReaderDefinition<{ groupBy: string }> = {
      type: 'cards',
      compileOptions: () => ({ status: 'ready', options: { groupBy: 'note.status' } }),
      dataNeeds: () => ({
        properties: ['note.status'],
        includeCardFields: true,
        groupBy: 'note.status',
        window: 'group',
      }),
      mutationCapabilities: () => ({}),
      project: (data) => data,
    }
    const source = viewExecution(cardReader)
    const prepared = await source.prepare({
      store,
      source: { kind: 'notes', scope: 'space' },
      view: { name: 'Cards', type: 'cards' },
      directory: '',
      projects: [],
      schema,
    })
    const doing = prepared.groups?.find((group) => group.value === 'doing')

    if (!doing) {
      throw new Error('doing group missing')
    }
    const window = source.window(prepared, { group: doing.key, offset: 0, limit: 100 }, schema)

    expect(prepared.dataNeeds?.properties).toEqual(['note.status', 'note.owner'])
    expect(window.rows[0]?.fields).toEqual({
      owner: { state: 'value', value: 'ann', label: 'ann' },
    })
  })

  it('lets the source remove reader move capability for protected grouping fields', async () => {
    const note: NoteMeta = {
      id: 'a',
      title: 'Alpha',
      filePath: 'work/a.md',
      viewType: 'board',
      modifiedAt: null,
      createdAt: null,
      fields: { keys: {} },
    }
    const { store } = fakeStore([note], {})
    const movingReader: ReaderDefinition<{ groupBy: string }> = {
      type: 'moving',
      compileOptions: () => ({ status: 'ready', options: { groupBy: 'note.view' } }),
      dataNeeds: (options) => ({
        properties: [options.groupBy],
        groupBy: options.groupBy,
        window: 'group',
      }),
      mutationCapabilities: () => ({ move: true }),
      project: (data) => data,
    }
    const source = viewExecution(movingReader)
    const prepared = await source.prepare({
      store,
      source: { kind: 'notes', scope: 'space' },
      view: { name: 'Moving', type: 'moving' },
      directory: '',
      projects: [],
      schema,
    })

    expect(prepared.status).toBe('ready')
    expect(prepared.capabilities).toBeUndefined()
  })

  it('caps exact reads and exposes an incomplete state instead of silently dropping truth', async () => {
    const metas = Array.from({ length: VIEW_EXACT_READ_LIMIT + 1 }, (_, index): NoteMeta => ({
      id: `n-${index}`,
      title: `Note ${index}`,
      filePath: `work/n-${index}.md`,
      modifiedAt: '2026-08-30T00:00:00.000Z',
      createdAt: null,
      fields: { keys: {}, truncatedMore: 1 },
    }))
    const exact = Object.fromEntries(metas.map((meta) => [meta.id!, detail(meta, 'status: doing')]))
    const { store, read } = fakeStore(metas, exact)
    const source = viewExecution(reader)
    const request = {
      store,
      source: {
        kind: 'notes' as const,
        scope: 'space' as const,
        filter: {
          op: 'and' as const,
          nodes: [
            {
              op: 'or' as const,
              ns: 'note' as const,
              key: 'status',
              values: [{ kind: 'eq' as const, value: 'doing' }],
            },
          ],
        },
      },
      view: { name: 'Stub', type: 'stub' },
      directory: '',
      projects: [project('')],
    }
    const execution = source.requestContext({ store, projects: [project('')] })
    const first = await source.prepare({ ...request, request: execution })

    expect(first.status).toBe('incomplete')
    expect(first.execution).toMatchObject({
      exactFallbackTruncated: true,
      exactReads: VIEW_EXACT_READ_LIMIT,
      exactRemaining: 1,
    })
    const second = await source.prepare({
      ...request,
      view: { ...request.view, fields: ['note.owner'] },
      request: execution,
    })

    expect(second.execution?.exactCacheHits).toBe(VIEW_EXACT_READ_LIMIT)
    expect(read).toHaveBeenCalledTimes(VIEW_EXACT_READ_LIMIT)
  })

  it('keeps undeclared scalar and structural states open-world in fixed order', async () => {
    const values: Array<NoteMeta['fields']> = [
      { keys: { status: '2' } },
      { keys: { status: '10' } },
      { keys: { status: '' } },
      { keys: { status: [] } },
      { keys: {}, unreadable: ['status'] },
      { keys: {} },
    ]
    const metas = values.map((fields, index): NoteMeta => ({
      id: `s-${index}`,
      title: `State ${index}`,
      filePath: `s-${index}.md`,
      modifiedAt: null,
      createdAt: null,
      fields,
    }))
    const { store } = fakeStore(metas, {})
    const source = viewExecution(reader)
    const prepared = await source.prepare({
      store,
      source: { kind: 'notes', scope: 'space' },
      view: { name: 'Stub', type: 'stub', options: { groupBy: 'note.status' } },
      directory: '',
      projects: [],
    })

    expect(prepared.groups?.map((group) => [group.value, group.state, group.label])).toEqual([
      ['10', 'value', '10'],
      ['2', 'value', '2'],
      [undefined, 'absent', 'No value'],
      ['', 'empty-string', 'Empty'],
      [[], 'empty-list', 'Empty'],
      [undefined, 'unreadable', 'Unreadable'],
    ])
  })

  it('truncates a pathological grouping explicitly while keeping exact totalGroups', async () => {
    const metas = Array.from({ length: 513 }, (_, index): NoteMeta => ({
      id: `g-${index}`,
      title: `Group ${index}`,
      filePath: `g-${index}.md`,
      modifiedAt: null,
      createdAt: null,
      fields: { keys: { status: `value-${String(index).padStart(3, '0')}` } },
    }))
    const { store } = fakeStore(metas, {})
    const source = viewExecution(reader)
    const prepared = await source.prepare({
      store,
      source: { kind: 'notes', scope: 'space' },
      view: { name: 'Stub', type: 'stub', options: { groupBy: 'note.status' } },
      directory: '',
      projects: [],
    })

    expect(prepared.groups).toHaveLength(512)
    expect(prepared.totalGroups).toBe(513)
    expect(prepared.groupsTruncated).toBe(true)
  })

  it('keeps a 10k board on skeleton plus one bounded column window', async () => {
    const metas = Array.from({ length: 10_000 }, (_, index): NoteMeta => ({
      id: `scale-${index}`,
      title: `Task ${String(index).padStart(5, '0')}`,
      filePath: `work/task-${index}.md`,
      modifiedAt: null,
      createdAt: null,
      fields: { keys: { status: `s${index % 10}` } },
    }))
    const { store, read } = fakeStore(metas, {})
    const source = viewExecution(reader)
    const prepared = await source.prepare({
      store,
      source: { kind: 'notes', scope: 'space' },
      view: { name: 'Stub', type: 'stub', options: { groupBy: 'note.status' } },
      directory: '',
      projects: [],
    })
    const first = prepared.groups?.find((group) => group.value === 's0')

    if (!first) {
      throw new Error('s0 group missing')
    }
    const window = source.window(prepared, { group: first.key, offset: 0, limit: 100 })

    expect(prepared.total).toBe(10_000)
    expect(prepared.groups).toHaveLength(10)
    expect(first.count).toBe(1_000)
    expect(window.total).toBe(1_000)
    expect(window.rows).toHaveLength(100)
    expect(read).not.toHaveBeenCalled()
  })
})
