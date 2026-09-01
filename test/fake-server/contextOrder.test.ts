// Context order (#210) end to end over the production buildApp: the user's per-scope
// pin+set order, and a set's own item order. What it pins down:
//   - PUT /api/me/context-order replaces the personal scope order; the agent-context pins
//     & sets come back with the new `order`, AND start_session loads them in that order
//     (a set dragged above a pin loads FIRST) — the pult == the agent's bundle.
//   - PUT …/context-sets/:id/order reorders a set's items (a home-space write).
//   - PUT …/projects/:pid/context-order reorders a project scope, independent of personal.

import type { FastifyInstance } from 'fastify'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createApp, type Fixture } from './app.js'

const fixture = (): Fixture => ({
  now: '2026-07-08T12:00:00.000Z',
  capabilities: { spaceCreate: true },
  spaces: [
    {
      slug: 'home',
      displayName: 'Home',
      notes: [
        { id: 'h1', title: 'Home One', class: 'user-doc', filePath: 'h1.md', content: 'home one' },
        { id: 'h2', title: 'Home Two', class: 'user-doc', filePath: 'h2.md', content: 'home two' },
      ],
    },
    {
      slug: 'conventions',
      displayName: 'Conventions',
      notes: [
        {
          id: 'c1',
          title: 'Conv One',
          class: 'user-doc',
          filePath: 'guides/index.md',
          content: 'conv one',
        },
        { id: 'c2', title: 'Conv Two', class: 'user-doc', filePath: 'c2.md', content: 'conv two' },
        {
          id: 'c3',
          title: 'Conv Three',
          class: 'user-doc',
          filePath: 'c3.md',
          content: 'conv three',
        },
      ],
    },
    {
      slug: 'product',
      displayName: 'Product',
      notes: [
        {
          id: 'p1',
          title: 'Prod One',
          class: 'user-doc',
          filePath: 'web/p1.md',
          content: 'prod one',
        },
        {
          id: 'p2',
          title: 'Prod Two',
          class: 'user-doc',
          filePath: 'web/p2.md',
          content: 'prod two',
        },
      ],
    },
  ],
  projects: [{ space: 'product', path: 'web' }],
  auth: {
    users: [
      { username: 'sam', password: 'sam-password-1', displayName: 'Sam', personalSpace: 'home' },
    ],
    members: [
      { space: 'home', username: 'sam', role: 'owner' },
      { space: 'conventions', username: 'sam', role: 'owner' },
      { space: 'product', username: 'sam', role: 'owner' },
    ],
  },
})

let app: FastifyInstance
let port: number

const listen = async (instance: FastifyInstance): Promise<number> => {
  await instance.listen({ port: 0, host: '127.0.0.1' })
  return (instance.server.address() as AddressInfo).port
}

beforeEach(async () => {
  app = await createApp(fixture())
  port = await listen(app)
})
afterEach(async () => {
  await app.close()
})

const loginCookie = async (username: string, password: string): Promise<string> => {
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  })
  expect(login.statusCode).toBe(200)
  return (login.headers['set-cookie'] as string).split(';')[0]
}

const patFor = async (cookie: string): Promise<string> => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/me/tokens',
    headers: { cookie },
    payload: { name: 't', scope: 'write' },
  })
  expect(created.statusCode).toBe(201)
  return created.json().token as string
}
const getJson = async (url: string, cookie: string) =>
  (await app.inject({ method: 'GET', url, headers: { cookie } })).json()
const send = (
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  cookie: string,
  body?: unknown,
) =>
  app.inject({ method, url, headers: { cookie }, payload: (body ?? {}) as Record<string, unknown> })

type Rpc = { result?: { structuredContent?: Record<string, unknown> } }
const startSession = async (
  bearer: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'start_session', arguments: args },
    }),
  })
  return ((await res.json()) as Rpc).result?.structuredContent ?? {}
}

const makeSet = async (
  cookie: string,
  homeSpace: string,
  name: string,
  items: Array<[string, string]>,
): Promise<string> => {
  const created = await send('POST', `/api/s/${homeSpace}/context-sets`, cookie, { name })
  expect(created.statusCode).toBe(200)
  const id = created.json().set.id as string

  for (const [space, noteId] of items) {
    expect(
      (
        await send('POST', `/api/s/${homeSpace}/context-sets/${id}/items`, cookie, {
          space,
          noteId,
        })
      ).statusCode,
    ).toBe(200)
  }

  return id
}

const PROJECT = 'proj-product-web'

type PinView = { noteId: string; order: number }
type SetView = { id: string; order: number; items: Array<{ noteId: string; order: number }> }

describe('context order (#210)', () => {
  it('reorders the personal pin+set list — a set dragged ABOVE the pins loads first in start_session', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const bearer = await patFor(cookie)
    // Two same-space tag pins (home) + a cross-space set attached to personal.
    expect(
      (await send('PUT', '/api/note/pin', cookie, { id: 'h1', pinned: true })).statusCode,
    ).toBe(200)
    expect(
      (await send('PUT', '/api/note/pin', cookie, { id: 'h2', pinned: true })).statusCode,
    ).toBe(200)
    const setId = await makeSet(cookie, 'conventions', 'Canon', [
      ['conventions', 'c1'],
      ['conventions', 'c2'],
    ])
    expect((await send('PUT', `/api/me/context-sets/${setId}`, cookie)).statusCode).toBe(200)

    // Default: pins first (h1, h2), then the set.
    const before = await getJson('/api/me/agent-context', cookie)
    const pinsBefore = (before.pins as PinView[])
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((p) => p.noteId)
    expect(pinsBefore).toEqual(['h1', 'h2'])
    expect((before.sets as SetView[])[0].order).toBe(2)

    // Drag the set to the TOP, and swap the two pins: [set, h2, h1].
    const reorder = await send('PUT', '/api/me/context-order', cookie, {
      entries: [
        { kind: 'set', ref: setId },
        { kind: 'pin', ref: 'h2' },
        { kind: 'pin', ref: 'h1' },
      ],
    })
    expect(reorder.statusCode).toBe(200)

    const after = await getJson('/api/me/agent-context', cookie)
    const setAfter = (after.sets as SetView[])[0]
    const pinsAfter = after.pins as PinView[]
    expect(setAfter.order).toBe(0)
    expect(pinsAfter.find((p) => p.noteId === 'h2')?.order).toBe(1)
    expect(pinsAfter.find((p) => p.noteId === 'h1')?.order).toBe(2)

    // The AGENT bundle reflects the same order: the set's items load FIRST, then h2, then h1.
    const session = await startSession(bearer, {})
    const profile = session.profile as { alwaysLoad: Array<{ noteId: string }> }
    expect(profile.alwaysLoad.map((n) => n.noteId)).toEqual(['c1', 'c2', 'h2', 'h1'])
  })

  it('keeps the folder-page marker when an ordered set wins dedup against a loose pin', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const setId = await makeSet(cookie, 'conventions', 'Canon', [['conventions', 'c1']])
    expect((await send('PUT', `/api/me/context-sets/${setId}`, cookie)).statusCode).toBe(200)
    expect(
      (
        await send('PUT', '/api/me/context-pins', cookie, {
          space: 'conventions',
          noteId: 'c1',
        })
      ).statusCode,
    ).toBe(200)
    expect(
      (
        await send('PUT', '/api/me/context-order', cookie, {
          entries: [
            { kind: 'set', ref: setId },
            { kind: 'pin', ref: 'c1' },
          ],
        })
      ).statusCode,
    ).toBe(200)

    const ctx = await getJson('/api/me/agent-context', cookie)
    expect((ctx.pins as PinView[]).some((pin) => pin.noteId === 'c1')).toBe(false)
    expect(
      (
        ctx.sets as Array<{
          items: Array<{ noteId: string; folderPage?: true }>
        }>
      )[0].items,
    ).toEqual([expect.objectContaining({ noteId: 'c1', folderPage: true })])
  })

  it('reorders the ITEMS inside a set (a home-space write) — the item order follows on the wire', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const setId = await makeSet(cookie, 'conventions', 'Canon', [
      ['conventions', 'c1'],
      ['conventions', 'c2'],
      ['conventions', 'c3'],
    ])
    expect((await send('PUT', `/api/me/context-sets/${setId}`, cookie)).statusCode).toBe(200)

    const reorder = await send('PUT', `/api/s/conventions/context-sets/${setId}/order`, cookie, {
      noteIds: ['c3', 'c1', 'c2'],
    })
    expect(reorder.statusCode).toBe(200)

    const ctx = await getJson('/api/me/agent-context', cookie)
    const set = (ctx.sets as SetView[])[0]
    expect(set.items.map((i) => i.noteId)).toEqual(['c3', 'c1', 'c2'])
    // Each item carries its within-set index as `order`.
    expect(set.items.map((i) => i.order)).toEqual([0, 1, 2])
  })

  it('reorders a PROJECT scope independently of the personal order', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const bearer = await patFor(cookie)
    // Two project tag pins (product/web) + one personal tag pin.
    expect(
      (await send('PUT', '/api/note/pin', cookie, { id: 'p1', pinned: true })).statusCode,
    ).toBe(200)
    expect(
      (await send('PUT', '/api/note/pin', cookie, { id: 'p2', pinned: true })).statusCode,
    ).toBe(200)
    expect(
      (await send('PUT', '/api/note/pin', cookie, { id: 'h1', pinned: true })).statusCode,
    ).toBe(200)

    // Drag p2 above p1 in the PROJECT scope.
    expect(
      (
        await send('PUT', `/api/s/product/projects/${PROJECT}/context-order`, cookie, {
          entries: [
            { kind: 'pin', ref: 'p2' },
            { kind: 'pin', ref: 'p1' },
          ],
        })
      ).statusCode,
    ).toBe(200)

    const ctx = await getJson(`/api/s/product/projects/${PROJECT}/agent-context`, cookie)
    const pins = ctx.pins as PinView[]
    expect(pins.find((p) => p.noteId === 'p2')?.order).toBe(0)
    expect(pins.find((p) => p.noteId === 'p1')?.order).toBe(1)

    // start_session(project) loads the project pins in the new order (p2 before p1).
    const session = await startSession(bearer, { project: 'product/web' })
    const project = session.project as { alwaysLoad: Array<{ noteId: string }> }
    expect(project.alwaysLoad.map((n) => n.noteId)).toEqual(['p2', 'p1'])
  })
})
