import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FieldSchemaConflictResponseSchema, FieldSchemaResponseSchema } from '@notarium/contract'
import { InMemoryStore } from '@notarium/engine-memory'

import { createApp, type Fixture } from './app.js'

const fixture = (): Fixture => ({
  now: '2026-08-21T00:00:00.000Z',
  spaces: [
    {
      slug: 'main',
      notes: [
        {
          id: 'field-note',
          title: 'Field Note',
          filePath: 'field-note.md',
          content: 'body',
          frontmatter: 'due: 2026-09-01',
        },
        {
          id: 'field-date-two',
          title: 'Second date spelling',
          filePath: 'field-date-two.md',
          content: 'body',
          frontmatter: 'due: 2026-09-01T10:00:00Z',
        },
        {
          id: 'prototype-field-note',
          title: 'Prototype field note',
          filePath: 'prototype-field-note.md',
          content: 'body',
          frontmatter: '__proto__: secret',
        },
      ],
      fieldSchema: {
        version: 1,
        fields: [
          {
            key: 'status',
            type: 'enum',
            card: true,
            values: [
              { key: 'todo', label: 'Todo', color: 'slate' },
              { key: 'doing', label: 'Doing', color: 'amber' },
            ],
          },
          { key: 'priority', type: 'number' },
          { key: 'done', type: 'checkbox' },
          { key: 'due', type: 'date' },
        ],
      },
    },
    { slug: 'empty', notes: [] },
  ],
})

describe('space field schema REST surface', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await createApp(fixture())
  })

  afterEach(async () => {
    await app.close()
  })

  it('reads seeded and absent documents through one response contract', async () => {
    const seeded = await app.inject({ method: 'GET', url: '/api/s/main/fields/schema' })
    const empty = await app.inject({ method: 'GET', url: '/api/s/empty/fields/schema' })

    expect(seeded.statusCode).toBe(200)
    expect(FieldSchemaResponseSchema.parse(seeded.json()).fields[0]).toMatchObject({
      key: 'status',
      values: [
        { key: 'todo', label: 'Todo', color: 'slate' },
        { key: 'doing', label: 'Doing', color: 'amber' },
      ],
    })
    expect(FieldSchemaResponseSchema.parse(empty.json()).fields).toEqual([])
  })

  it('separates schema management read-only from note value-write capability', async () => {
    await app.close()
    app = await createApp({
      now: '2026-08-21T00:00:00.000Z',
      spaces: [
        {
          slug: 'future',
          notes: [],
          fieldSchemaRaw: 'version: 2\nfields:\n  - key: status\n    type: text\n',
        },
        {
          slug: 'broken',
          notes: [],
          fieldSchemaRaw: 'version: 1\nfields: nope\n',
        },
      ],
    })
    const future = FieldSchemaResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/s/future/fields/schema' })).json(),
    )
    const broken = FieldSchemaResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/s/broken/fields/schema' })).json(),
    )

    expect(future).toMatchObject({ readOnly: true, valueWrites: true })
    expect(broken).toMatchObject({ readOnly: true, valueWrites: false })
  })

  it('serves an authored own __proto__ as data on the complete detail fields wire', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/note?id=prototype-field-note',
    })
    const detail = response.json() as {
      frontmatter: Record<string, unknown>
      fields: { keys: Record<string, unknown> }
    }

    expect(response.statusCode, response.body).toBe(200)
    expect(Object.hasOwn(detail.frontmatter, '__proto__')).toBe(true)
    expect(detail.frontmatter.__proto__).toBe('secret')
    expect(Object.hasOwn(detail.fields.keys, '__proto__')).toBe(true)
    expect(detail.fields.keys.__proto__).toBe('secret')
  })

  it('filters a declared date day with one bounded predicate and rejects non-date keys', async () => {
    const due = await app.inject({
      method: 'GET',
      url: '/api/s/main/notes?fieldDay=note.due%3A2026-09-01',
    })
    const buckets = await app.inject({
      method: 'GET',
      url: '/api/s/main/notes/buckets?sort=modified&group=day&fieldDay=note.due%3A2026-09-01',
    })
    const wrongType = await app.inject({
      method: 'GET',
      url: '/api/s/main/notes?fieldDay=note.priority%3A2026-09-01',
    })

    expect(due.statusCode, due.body).toBe(200)
    expect(due.json().total).toBe(2)
    expect(buckets.statusCode, buckets.body).toBe(200)
    expect(buckets.json().total).toBe(2)
    expect(
      buckets.json().buckets.reduce((total: number, bucket: { count: number }) => {
        return total + bucket.count
      }, 0),
    ).toBe(2)
    expect(wrongType.statusCode).toBe(400)
    expect(wrongType.json().error).toContain('declared date field')
  })

  it('returns a fresh token, accepts an immediate second save, and rejects a stale twin', async () => {
    const initial = FieldSchemaResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/s/main/fields/schema' })).json(),
    )
    const first = await app.inject({
      method: 'PUT',
      url: '/api/s/main/fields/schema',
      payload: {
        version: 1,
        fields: [{ key: 'owner', type: 'text' }],
        versionToken: initial.versionToken,
      },
    })
    const saved = FieldSchemaResponseSchema.parse(first.json())

    expect(first.statusCode).toBe(200)
    expect(saved.versionToken).not.toBe(initial.versionToken)
    const second = await app.inject({
      method: 'PUT',
      url: '/api/s/main/fields/schema',
      payload: {
        version: 1,
        fields: [{ key: 'priority', type: 'number' }],
        versionToken: saved.versionToken,
      },
    })
    expect(second.statusCode).toBe(200)

    const stale = await app.inject({
      method: 'PUT',
      url: '/api/s/main/fields/schema',
      payload: {
        version: 1,
        fields: [{ key: 'lost', type: 'text' }],
        versionToken: initial.versionToken,
      },
    })
    expect(stale.statusCode).toBe(409)
    expect(FieldSchemaConflictResponseSchema.parse(stale.json())).toMatchObject({
      reason: 'field_schema_conflict',
      current: { fields: [{ key: 'priority', type: 'number' }] },
    })
  })

  it('writes a field patch atomically and returns the fresh note token', async () => {
    const note = (await app.inject({ method: 'GET', url: '/api/note?id=field-note' })).json<{
      versionToken: string
    }>()
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/note/fields',
      payload: {
        id: 'field-note',
        versionToken: note.versionToken,
        fields: { status: 'Doing', priority: '3', done: 'true' },
      },
    })

    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toMatchObject({ ok: true, versionToken: expect.any(String) })
    expect(saved.json().versionToken).not.toBe(note.versionToken)
    expect(
      (await app.inject({ method: 'GET', url: '/api/note?id=field-note' })).json().frontmatter,
    ).toMatchObject({ status: 'Doing', priority: '3', done: 'true' })

    const stale = await app.inject({
      method: 'PUT',
      url: '/api/note/fields',
      payload: { id: 'field-note', versionToken: note.versionToken, fields: { status: 'Todo' } },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().reason).toBe('version_conflict')
  })

  it('saves body and fields in one ordinary editor CAS', async () => {
    const current = (await app.inject({ method: 'GET', url: '/api/note?id=field-note' })).json<{
      versionToken: string
    }>()
    const saved = await app.inject({
      method: 'POST',
      url: '/api/note',
      payload: {
        content: '# Field Note\n\nBody and field changed together.',
        originalId: 'field-note',
        versionToken: current.versionToken,
        fields: { status: 'Doing', priority: '3' },
      },
    })

    expect(saved.statusCode).toBe(200)
    const detail = (await app.inject({ method: 'GET', url: '/api/note?id=field-note' })).json()
    expect(detail.content).toContain('Body and field changed together.')
    expect(detail.frontmatter).toMatchObject({ status: 'Doing', priority: '3' })
  })

  it('marks an ordinary editor field-only Save as derived-content preserving', async () => {
    const current = (await app.inject({ method: 'GET', url: '/api/note?id=field-note' })).json<{
      versionToken: string
    }>()
    const write = vi.spyOn(InMemoryStore.prototype, 'write')

    try {
      const saved = await app.inject({
        method: 'POST',
        url: '/api/note',
        payload: {
          content: '# Field Note\n\nbody',
          originalId: 'field-note',
          versionToken: current.versionToken,
          fields: { status: 'Doing' },
        },
      })

      expect(saved.statusCode).toBe(200)
      expect(write.mock.calls.at(-1)?.[0]).toMatchObject({ derivedContentUnchanged: true })
    } finally {
      write.mockRestore()
    }
  })

  it('creates a note with editor fields in the same first save', async () => {
    const saved = await app.inject({
      method: 'POST',
      url: '/api/s/main/notes',
      payload: {
        content: '# Created with fields\n\nOne save.',
        fields: { status: 'Todo', priority: '5' },
      },
    })

    expect(saved.statusCode).toBe(200)
    const detail = (
      await app.inject({ method: 'GET', url: `/api/note?id=${saved.json().id}` })
    ).json()
    expect(detail.frontmatter).toMatchObject({ status: 'Todo', priority: '5' })
  })

  it('serves complete detail fields and only card-marked values in feed rows', async () => {
    const current = (await app.inject({ method: 'GET', url: '/api/note?id=field-note' })).json<{
      versionToken: string
    }>()
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/note/fields',
      payload: {
        id: 'field-note',
        versionToken: current.versionToken,
        fields: { status: 'Doing', priority: '3', done: 'true' },
      },
    })

    expect(saved.statusCode).toBe(200)
    const detail = (await app.inject({ method: 'GET', url: '/api/note?id=field-note' })).json()
    expect(detail.fields).toMatchObject({
      keys: { status: 'Doing', priority: '3', done: 'true' },
    })
    expect(detail.fields.order).toEqual(expect.arrayContaining(['status', 'priority', 'done']))

    const feed = (
      await app.inject({ method: 'GET', url: '/api/s/main/notes?sort=modified' })
    ).json()
    expect(feed.notes.find((note: { id: string }) => note.id === 'field-note').fields).toEqual({
      status: 'Doing',
    })

    const tree = (
      await app.inject({ method: 'GET', url: '/api/s/main/tree/children?path=' })
    ).json()
    expect(
      tree.notes.find((note: { id: string }) => note.id === 'field-note').fields,
    ).toBeUndefined()
  })

  it('rejects the whole patch when one key is protected and never loses __proto__ silently', async () => {
    const protectedResponse = await app.inject({
      method: 'PUT',
      url: '/api/note/fields',
      payload: { id: 'field-note', fields: { status: 'Doing', tags: 'wrong channel' } },
    })

    expect(protectedResponse.statusCode).toBe(400)
    expect(protectedResponse.json().reason).toBe('protected_field_key')
    expect(
      (await app.inject({ method: 'GET', url: '/api/note?id=field-note' })).json().frontmatter,
    ).not.toHaveProperty('status')

    const proto = await app.inject({
      method: 'PUT',
      url: '/api/note/fields',
      headers: { 'content-type': 'application/json' },
      payload: '{"id":"field-note","fields":{"__proto__":"must not disappear"}}',
    })
    expect(proto.statusCode).toBe(400)
    expect(proto.json()).toMatchObject({ reason: 'invalid_json' })
  })

  it('rejects protected/unsafe keys and accepts every card field within the schema bound', async () => {
    const current = FieldSchemaResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/s/main/fields/schema' })).json(),
    )

    for (const key of ['tags', '&anchor', 'a: b']) {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/s/main/fields/schema',
        payload: {
          version: 1,
          fields: [{ key, type: 'text' }],
          versionToken: current.versionToken,
        },
      })
      expect(response.statusCode, key).toBe(400)
    }
    const cards = await app.inject({
      method: 'PUT',
      url: '/api/s/main/fields/schema',
      payload: {
        version: 1,
        fields: ['a', 'b', 'c'].map((key) => ({ key, type: 'text', card: true })),
        versionToken: current.versionToken,
      },
    })
    expect(cards.statusCode).toBe(200)
    const changed = FieldSchemaResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/s/main/fields/schema' })).json(),
    )
    expect(changed.fields).toEqual(
      ['a', 'b', 'c'].map((key) => ({ key, type: 'text', card: true })),
    )
  })

  it('lets a reader GET the schema and refuses its PUT', async () => {
    await app.close()
    app = await createApp({
      ...fixture(),
      auth: {
        users: [
          { username: 'owner', password: 'owner-pass' },
          { username: 'reader', password: 'reader-pass' },
        ],
        members: [
          { space: 'main', username: 'owner', role: 'owner' },
          { space: 'main', username: 'reader', role: 'reader' },
        ],
      },
    })
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'reader', password: 'reader-pass' },
    })
    const cookie = (login.headers['set-cookie'] as string).split(';')[0]
    const current = await app.inject({
      method: 'GET',
      url: '/api/s/main/fields/schema',
      headers: { cookie },
    })

    expect(current.statusCode).toBe(200)
    const response = FieldSchemaResponseSchema.parse(current.json())
    const denied = await app.inject({
      method: 'PUT',
      url: '/api/s/main/fields/schema',
      headers: { cookie },
      payload: { version: 1, fields: [], versionToken: response.versionToken },
    })
    expect(denied.statusCode).toBe(404)

    const deniedFieldWrite = await app.inject({
      method: 'PUT',
      url: '/api/note/fields',
      headers: { cookie },
      payload: { id: 'field-note', fields: { status: 'Doing' } },
    })
    expect(deniedFieldWrite.statusCode).toBe(404)
  })
})
