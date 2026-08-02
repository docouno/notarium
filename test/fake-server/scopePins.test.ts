// Loose cross-space pins (#209) end to end over the production buildApp: a single note
// pinned DIRECTLY into a scope from another space — the sibling of a context set, without
// a name. What it pins down:
//   - Pin a foreign-space note into a PROJECT scope → it rides the project agent-context
//     pins[] (carrying its home `space`) AND start_session(project).project.alwaysLoad.
//   - Pin into MY personal scope → it rides /api/me/agent-context pins[] + profile.alwaysLoad.
//   - Honest per-reader DEGRADATION: a project member who can't reach the note's home
//     space never sees it (dropped from pins[] and the agent bundle), like a set item.
//   - Unpin removes it; anti-enum: you can't pin a note you can't read (404).

import type { FastifyInstance } from 'fastify'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createApp, type Fixture } from './app.js'

const fixture = (): Fixture => ({
  now: '2026-07-07T12:00:00.000Z',
  capabilities: { spaceCreate: true },
  spaces: [
    {
      slug: 'conventions',
      displayName: 'Conventions',
      notes: [
        {
          id: 'conv-sec',
          title: 'Security Baseline',
          class: 'user-doc',
          filePath: 'security.md',
          content: 'lock it down',
        },
      ],
    },
    {
      slug: 'product',
      displayName: 'Product',
      notes: [
        {
          id: 'prod-note',
          title: 'App Note',
          class: 'user-doc',
          filePath: 'web/app.md',
          content: 'the app',
        },
      ],
    },
    {
      slug: 'sam-personal',
      displayName: 'Personal',
      notes: [
        {
          id: 'mine-a',
          title: 'My Canon',
          class: 'user-doc',
          filePath: 'canon.md',
          content: 'personal canon',
        },
      ],
    },
    { slug: 'evan-space', displayName: 'Evan Space', notes: [] },
  ],
  projects: [{ space: 'product', path: 'web' }],
  auth: {
    users: [
      {
        username: 'sam',
        password: 'sam-password-1',
        displayName: 'Sam',
        personalSpace: 'sam-personal',
      },
      // mallory is in product but NOT conventions — the degradation reader.
      { username: 'mallory', password: 'mallory-password-1', displayName: 'Mallory' },
      // evan writes ONLY his own space — the cross-space-detach attacker.
      { username: 'evan', password: 'evan-password-1', displayName: 'Evan' },
    ],
    members: [
      { space: 'conventions', username: 'sam', role: 'owner' },
      { space: 'product', username: 'sam', role: 'owner' },
      { space: 'sam-personal', username: 'sam', role: 'owner' },
      { space: 'product', username: 'mallory', role: 'owner' },
      { space: 'evan-space', username: 'evan', role: 'owner' },
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

const PROJECT = 'proj-product-web'
type PinWire = { noteId: string; loaded: boolean; space?: string }

describe('scope pins (#209)', () => {
  it('a cross-space note pinned into a project rides the project agent-context pins AND start_session, for a member', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const bearer = await patFor(cookie)
    expect(
      (
        await send('PUT', `/api/s/product/projects/${PROJECT}/context-pins`, cookie, {
          space: 'conventions',
          noteId: 'conv-sec',
        })
      ).statusCode,
    ).toBe(200)

    const ctx = await getJson(`/api/s/product/projects/${PROJECT}/agent-context`, cookie)
    const pins = ctx.pins as PinWire[]
    const sec = pins.find((p) => p.noteId === 'conv-sec')
    expect(sec).toBeTruthy()
    expect(sec?.loaded).toBe(true)
    // The cross-space pin carries its HOME space (the UI shows a chip); a same-space pin wouldn't.
    expect(sec?.space).toBe('conventions')

    // start_session(project) folds the loaded pin into project.alwaysLoad (one curation).
    const ss = await startSession(bearer, { project: 'product/web' })
    const always = (ss.project as { alwaysLoad: Array<{ noteId: string }> }).alwaysLoad.map(
      (p) => p.noteId,
    )
    expect(always).toContain('conv-sec')
  })

  it('DEGRADES per reader: a project member who cannot reach the note’s home space never sees the pin', async () => {
    const sam = await loginCookie('sam', 'sam-password-1')
    await send('PUT', `/api/s/product/projects/${PROJECT}/context-pins`, sam, {
      space: 'conventions',
      noteId: 'conv-sec',
    })

    const mallory = await loginCookie('mallory', 'mallory-password-1')
    const mBearer = await patFor(mallory)
    const ctx = await getJson(`/api/s/product/projects/${PROJECT}/agent-context`, mallory)
    // conv-sec lives in conventions, which mallory can't read → the pin drops from her view.
    expect((ctx.pins as PinWire[]).some((p) => p.noteId === 'conv-sec')).toBe(false)
    const ss = await startSession(mBearer, { project: 'product/web' })
    const always = (ss.project as { alwaysLoad: Array<{ noteId: string }> }).alwaysLoad.map(
      (p) => p.noteId,
    )
    expect(always).not.toContain('conv-sec')
  })

  it('a cross-space note pinned into MY personal scope rides /api/me/agent-context and the profile alwaysLoad', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const bearer = await patFor(cookie)
    // conv-sec (from conventions) pinned into sam's personal scope (sam-personal).
    expect(
      (
        await send('PUT', '/api/me/context-pins', cookie, {
          space: 'conventions',
          noteId: 'conv-sec',
        })
      ).statusCode,
    ).toBe(200)

    const ctx = await getJson('/api/me/agent-context', cookie)
    const sec = (ctx.pins as PinWire[]).find((p) => p.noteId === 'conv-sec')
    expect(sec?.space).toBe('conventions')

    const ss = await startSession(bearer, {})
    const always = (ss.profile as { alwaysLoad: Array<{ noteId: string }> }).alwaysLoad.map(
      (p) => p.noteId,
    )
    expect(always).toContain('conv-sec')

    // Unpin removes it from the scope.
    expect((await send('DELETE', '/api/me/context-pins/conv-sec', cookie)).statusCode).toBe(200)
    const after = await getJson('/api/me/agent-context', cookie)
    expect((after.pins as PinWire[]).some((p) => p.noteId === 'conv-sec')).toBe(false)
  })

  it('anti-enum: you cannot pin a note you cannot read (404)', async () => {
    const mallory = await loginCookie('mallory', 'mallory-password-1')
    // mallory can WRITE the product project but can't READ conv-sec (not a conventions member).
    const r = await send('PUT', `/api/s/product/projects/${PROJECT}/context-pins`, mallory, {
      space: 'conventions',
      noteId: 'conv-sec',
    })
    expect(r.statusCode).toBe(404)
  })

  it('cross-space UNPIN is refused: a writer of another space cannot remove a project pin via a mismatched URL space (404)', async () => {
    const sam = await loginCookie('sam', 'sam-password-1')
    expect(
      (
        await send('PUT', `/api/s/product/projects/${PROJECT}/context-pins`, sam, {
          space: 'conventions',
          noteId: 'conv-sec',
        })
      ).statusCode,
    ).toBe(200)

    // evan writes his OWN space but not product; he aims the product project id at his own URL
    // space. The space:write gate passes on evan-space, but the project lives in product → the
    // handler must re-check proj.space === req.spaceId and refuse (anti-enum 404), NOT mutate.
    const evan = await loginCookie('evan', 'evan-password-1')
    const r = await send(
      'DELETE',
      `/api/s/evan-space/projects/${PROJECT}/context-pins/conv-sec`,
      evan,
    )
    expect(r.statusCode).toBe(404)

    // The pin survives for the legitimate reader.
    const ctx = await getJson(`/api/s/product/projects/${PROJECT}/agent-context`, sam)
    expect((ctx.pins as PinWire[]).some((p) => p.noteId === 'conv-sec')).toBe(true)
  })

  it('a note that is BOTH a same-space always-load tag pin AND a loose scope-pin loads exactly ONCE (dedup by id)', async () => {
    const sam = await loginCookie('sam', 'sam-password-1')
    // prod-note lives in the product/web subtree. Tag it always-load (a project tag pin) AND
    // loose-pin the same id into the project (harmless per the route — dedups by id).
    expect(
      (await send('PUT', '/api/note/pin', sam, { id: 'prod-note', pinned: true })).statusCode,
    ).toBe(200)
    expect(
      (
        await send('PUT', `/api/s/product/projects/${PROJECT}/context-pins`, sam, {
          space: 'product',
          noteId: 'prod-note',
        })
      ).statusCode,
    ).toBe(200)

    const ctx = await getJson(`/api/s/product/projects/${PROJECT}/agent-context`, sam)
    const hits = (ctx.pins as PinWire[]).filter((p) => p.noteId === 'prod-note')
    expect(hits).toHaveLength(1) // deduped across the tag + loose channels
  })
})
