import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FIELD_TYPE } from '@notarium/contract'
import { InMemoryStore } from '@notarium/engine-memory'

import { SYSTEM_PRINCIPAL } from '../../../../services/authz'
import { createInMemoryFieldSchemaStore } from '../../../../services/fields'
import type { ApiRouteCtx } from '../_shared'
import { viewsRoutes } from './views'

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
    options:
      groupBy: note.status
      order:
        kind: manual
        ranks: |-
          ["card-a","a0"]
          ["card-b","a1"]
\`\`\``

describe('board move route', () => {
  let app: FastifyInstance
  let store: InMemoryStore

  beforeEach(async () => {
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
          id: 'card-a',
          title: 'Alpha',
          filePath: 'a.md',
          content: 'Alpha',
          frontmatter: 'kind: task\nstatus: todo',
        },
        {
          id: 'card-b',
          title: 'Beta',
          filePath: 'b.md',
          content: 'Beta',
          frontmatter: 'kind: task\nstatus: doing',
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
          values: [{ key: 'todo' }, { key: 'doing' }, { key: 'done' }],
        },
      ],
    })
    const ctx = {
      noteStore: async () => ({ store, space: 'space-1' }),
      spaceStoreFor: async () => store,
      projects: { listForSpace: async () => [] },
      fieldSchemaStore,
      principalId: () => 'user:test',
    } as unknown as ApiRouteCtx

    await viewsRoutes(app, ctx)
  })

  afterEach(async () => app.close())

  it('resolves the opaque board intent and writes through both note permissions', async () => {
    const manifest = (await app.inject({ method: 'GET', url: '/api/note/views?id=board' })).json()
    const response = await app.inject({
      method: 'POST',
      url: '/api/note/board-move',
      payload: {
        viewRef: manifest.views[0].viewRef,
        cardId: 'card-a',
        to: { kind: 'value', value: 'doing' },
        beforeId: 'card-b',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'moved' })
    expect((await store.read('card-a')).frontmatter.status).toBe('doing')
    expect((await store.read('board')).content).toContain('["card-a",')
  })
})
