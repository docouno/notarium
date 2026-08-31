import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FIELD_TYPE } from '@notarium/contract'
import {
  createReaderRegistry,
  type KnowledgeStore,
  liveSyncStatus,
  type NoteContent,
  type NoteMeta,
  type ReaderDefinition,
} from '@notarium/core'

import { SYSTEM_PRINCIPAL } from '../../../../services/authz'
import type { FieldSchemaSnapshot } from '../../../../services/fields'
import type { ProjectRecord } from '../../../../services/metaDb'
import type { ApiRouteCtx } from '../_shared'
import { viewsRoutes } from './views'

const reader: ReaderDefinition<{ groupBy?: string }> = {
  type: 'stub',
  compileOptions: (raw) => ({
    status: 'ready',
    options: {
      groupBy:
        typeof raw === 'object' && raw != null
          ? ((raw as { groupBy?: string }).groupBy ?? undefined)
          : undefined,
    },
  }),
  dataNeeds: (options, view) => ({
    properties: view.fields ?? [],
    ...(options.groupBy ? { groupBy: options.groupBy } : {}),
    window: options.groupBy ? 'group' : 'source',
  }),
  mutationCapabilities: () => ({ move: true }),
  project: (data) => data,
}

const carrier = [
  'Sprint.',
  '',
  '```nota',
  'version: 1',
  'source:',
  '  kind: notes',
  '  scope: space',
  'views:',
  '  - name: Stub',
  '    type: stub',
  '    fields: [note.owner]',
  '    options: { groupBy: note.status }',
  '```',
].join('\n')

const metas: NoteMeta[] = [
  {
    id: 'view-note',
    title: 'Sprint',
    filePath: 'work/sprint.md',
    viewType: 'stub',
    modifiedAt: '2026-08-30T00:00:00.000Z',
    createdAt: null,
    fields: { keys: {} },
  },
  {
    id: 'task-a',
    title: 'Task A',
    filePath: 'work/a.md',
    modifiedAt: '2026-08-30T00:00:01.000Z',
    createdAt: null,
    fields: { keys: { status: 'doing', owner: 'ann' } },
  },
]

const details: Record<string, NoteContent> = {
  'view-note': {
    id: 'view-note',
    title: 'Sprint',
    filePath: 'work/sprint.md',
    content: carrier,
    frontmatter: { view: 'stub' },
    versionToken: 'v1:view-note',
  },
  'task-a': {
    id: 'task-a',
    title: 'Task A',
    filePath: 'work/a.md',
    content: 'Task A',
    frontmatter: { status: 'doing', owner: 'ann' },
    versionToken: 'v1:task-a',
  },
}

const list = vi.fn(async () => metas)
const store = {
  list,
  read: async (id: string) => details[id]!,
  syncStatus: async () => liveSyncStatus(),
} as unknown as KnowledgeStore

const schema: FieldSchemaSnapshot = {
  version: 1,
  versionToken: 'schema-v1',
  status: 'ready',
  fields: [
    {
      key: 'status',
      type: FIELD_TYPE.enum,
      values: [
        { key: 'doing', label: 'Doing', color: 'blue' },
        { key: 'done', label: 'Done', color: 'green' },
      ],
    },
  ],
}

describe('view routes', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    list.mockClear()
    app = Fastify()
    app.addHook('preHandler', async (request) => {
      request.principal = SYSTEM_PRINCIPAL
      request.spaceId = ((request.params as { space?: string }).space ?? 'space-1') as string
    })
    const ctx = {
      noteStore: async () => ({ store, space: 'space-1' }),
      spaceStoreFor: async () => store,
      projects: { listForSpace: async () => [] as ProjectRecord[] },
      fieldSchemaStore: { read: async () => schema },
      viewReaders: createReaderRegistry([reader]),
    } as unknown as ApiRouteCtx

    await viewsRoutes(app, ctx)
  })

  afterEach(async () => app.close())

  it('serves a saved manifest and an opaque per-group window', async () => {
    const manifestResponse = await app.inject({
      method: 'GET',
      url: '/api/note/views?id=view-note',
    })

    expect(manifestResponse.statusCode).toBe(200)
    const manifest = manifestResponse.json()
    expect(manifest).toMatchObject({
      documentId: 'view-note',
      marker: 'stub',
      primaryType: 'stub',
      views: [{ status: 'ready', total: 2, capabilities: { move: true } }],
    })
    const view = manifest.views[0]
    const doing = view.groups.find((group: { value?: string }) => group.value === 'doing')
    const windowResponse = await app.inject({
      method: 'POST',
      url: '/api/note/view-window',
      payload: {
        viewRef: view.viewRef,
        snapshotGeneration: view.snapshotGeneration,
        schemaVersionToken: view.schemaVersionToken,
        group: doing.key,
        offset: 0,
        limit: 50,
      },
    })

    expect(windowResponse.statusCode).toBe(200)
    expect(windowResponse.json()).toMatchObject({
      viewRef: view.viewRef,
      total: 1,
      rows: [
        {
          id: 'task-a',
          group: { value: 'doing', label: 'Doing' },
          fields: { owner: { value: 'ann' } },
        },
      ],
    })
    const parallelWindows = await Promise.all(
      Array.from({ length: 9 }, () =>
        app.inject({
          method: 'POST',
          url: '/api/note/view-window',
          payload: {
            viewRef: view.viewRef,
            snapshotGeneration: view.snapshotGeneration,
            schemaVersionToken: view.schemaVersionToken,
            group: doing.key,
            offset: 0,
            limit: 50,
          },
        }),
      ),
    )

    expect(parallelWindows.every((response) => response.statusCode === 200)).toBe(true)
    expect(list).toHaveBeenCalledTimes(1)

    const mixed = await app.inject({
      method: 'POST',
      url: '/api/note/view-window',
      payload: {
        viewRef: view.viewRef,
        snapshotGeneration: 'different-generation',
        schemaVersionToken: view.schemaVersionToken,
        group: doing.key,
        offset: 0,
        limit: 50,
      },
    })

    expect(mixed.statusCode).toBe(409)
    expect(mixed.json()).toMatchObject({ error: 'view snapshot changed' })
    expect(list).toHaveBeenCalledTimes(2)

    const mixedSchema = await app.inject({
      method: 'POST',
      url: '/api/note/view-window',
      payload: {
        viewRef: view.viewRef,
        snapshotGeneration: view.snapshotGeneration,
        schemaVersionToken: 'schema-v2',
        group: doing.key,
        offset: 0,
        limit: 50,
      },
    })

    expect(mixedSchema.statusCode).toBe(409)
    expect(mixedSchema.json()).toMatchObject({ error: 'view schema changed' })
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('executes a bounded read-only draft query in the route space', async () => {
    const draft = {
      context: { kind: 'draft' as const, directory: 'work' },
      source: { kind: 'notes', scope: 'space' as const },
      view: {
        name: 'Stub',
        type: 'stub',
        fields: ['note.owner'],
        options: { groupBy: 'note.status' },
      },
    }
    const response = await app.inject({
      method: 'POST',
      url: '/api/s/space-1/view-query',
      payload: {
        ...draft,
        window: { offset: 0, limit: 10 },
      },
    })

    expect(response.statusCode).toBe(200)
    const manifest = response.json()

    expect(manifest).toMatchObject({ draft: true, total: 2 })
    expect(list).toHaveBeenCalledTimes(1)

    for (const group of manifest.groups.slice(0, 2)) {
      const window = await app.inject({
        method: 'POST',
        url: '/api/s/space-1/view-query',
        payload: {
          ...draft,
          snapshotGeneration: manifest.snapshotGeneration,
          schemaVersionToken: manifest.schemaVersionToken,
          window: { group: group.key, offset: 0, limit: 10 },
        },
      })

      expect(window.statusCode).toBe(200)
      expect(window.json().snapshotGeneration).toBe(manifest.snapshotGeneration)
    }
    expect(list).toHaveBeenCalledTimes(1)
  })
})
