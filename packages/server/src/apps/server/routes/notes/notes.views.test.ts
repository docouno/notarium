import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FIELD_TYPE } from '@notarium/contract'
import { InMemoryStore } from '@notarium/engine-memory'

import { SYSTEM_PRINCIPAL } from '../../../../services/authz'
import { createInMemoryFieldSchemaStore } from '../../../../services/fields'
import type { ApiRouteCtx } from '../_shared'
import { notesRoutes } from './notes'

const carrier = `\`\`\`nota
version: 1
source:
  kind: notes
  scope: space
  filter:
    op: and
    nodes:
      - op: or
        ns: note
        key: kind
        values: [{ kind: eq, value: task }]
views:
  - name: Tasks
    type: board
    options: { groupBy: note.status }
\`\`\``

describe('notes view discovery', () => {
  let app: FastifyInstance
  let store: InMemoryStore
  const projects = { listForSpace: vi.fn(async () => []) }

  beforeEach(async () => {
    projects.listForSpace.mockClear()
    app = Fastify()
    app.addHook('preHandler', async (request) => {
      request.principal = SYSTEM_PRINCIPAL
      request.spaceId = 'space-1'
    })
    store = new InMemoryStore({
      space: 'space-1',
      notes: [
        {
          id: 'board',
          title: 'Board',
          filePath: 'board.md',
          content: carrier,
          frontmatter: 'view: board',
        },
        {
          id: 'a',
          title: 'A',
          filePath: 'a.md',
          content: 'A',
          frontmatter: 'kind: task\nstatus: todo',
        },
        {
          id: 'marker-only',
          title: 'Marker only',
          filePath: 'marker-only.md',
          content: 'Useful ordinary prose.',
          frontmatter: 'view: board',
        },
      ],
    })
    const fieldSchemaStore = createInMemoryFieldSchemaStore()

    fieldSchemaStore.seed('space-1', {
      version: 1,
      fields: [
        {
          key: 'status',
          type: FIELD_TYPE.enum,
          values: [{ key: 'todo' }, { key: 'done' }],
        },
      ],
    })
    await notesRoutes(app, {
      spaceStoreFor: async () => store,
      projects,
      fieldSchemaStore,
    } as unknown as ApiRouteCtx)
  })

  afterEach(async () => app.close())

  it('keeps the marker cheap unless the Feed explicitly requests a summary', async () => {
    const ordinary = await app.inject({ method: 'GET', url: '/api/s/space-1/notes?limit=50' })
    const ordinaryBoard = ordinary.json().notes.find((note: { id: string }) => note.id === 'board')

    expect(ordinaryBoard).toMatchObject({ viewType: 'board' })
    expect(ordinaryBoard).not.toHaveProperty('viewSummary')
    expect(projects.listForSpace).not.toHaveBeenCalled()

    const feed = await app.inject({
      method: 'GET',
      url: '/api/s/space-1/notes?limit=50&viewSummary=1',
    })
    const feedBoard = feed.json().notes.find((note: { id: string }) => note.id === 'board')

    expect(feed.statusCode).toBe(200)
    expect(feedBoard).toMatchObject({
      viewType: 'board',
      viewSummary: { status: 'ready', text: '2 columns · 1 card' },
    })
    expect(
      feed.json().notes.find((note: { id: string }) => note.id === 'marker-only'),
    ).not.toHaveProperty('viewSummary')
    expect(projects.listForSpace).toHaveBeenCalledTimes(1)
  })
})
