// The personal layer (#13) end to end: the AGENT writes memory and the HUMAN
// reads/audits it, and the human curates the always-load profile. Runs over the
// production buildApp — the REST self-corner (/api/me/*) AND the MCP gateway
// (/mcp) — with only the engine + persistence swapped (#18). The contrast the
// pack pins is the trust story: what an agent (PAT) recorded surfaces to the
// human with #12 provenance, while the human's own profile note is NOT "memory".
//
// /mcp runs over a REAL socket (the official SDK transport); the self-corner is
// inject() with the session cookie — the same two credential paths a deployment
// sees (an agent's bearer PAT vs a human's UI session).

import type { FastifyInstance } from 'fastify'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createApp, type Fixture } from './app.js'

const fixture = (): Fixture => ({
  now: '2026-06-14T12:00:00.000Z',
  // The engine owns namespaces here, so a fresh user can mint a personal domain
  // on first profile save (the mint path below).
  capabilities: { spaceCreate: true },
  spaces: [
    { slug: 'main', displayName: 'Main', notes: [] },
    // sam's personal domain, pre-seeded but empty — nothing remembered yet.
    { slug: 'sam-personal', displayName: 'Personal', notes: [] },
  ],
  auth: {
    users: [
      {
        username: 'sam',
        password: 'sam-password-1',
        displayName: 'Sam',
        personalSpace: 'sam-personal',
      },
      // nova has NO personal domain — exercises the empty read + first-save mint.
      { username: 'nova', password: 'nova-password-1', displayName: 'Nova' },
    ],
    members: [
      { space: 'main', username: 'sam', role: 'owner' },
      { space: 'sam-personal', username: 'sam', role: 'owner' },
      { space: 'main', username: 'nova', role: 'reader' },
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

type Rpc = { result?: Record<string, unknown>; error?: { code: number; message: string } }

const callTool = async (
  name: string,
  args: Record<string, unknown>,
  bearer: string,
): Promise<Rpc> => {
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
      params: { name, arguments: args },
    }),
  })
  return res.status === 200 ? ((await res.json()) as Rpc) : ({} as Rpc)
}
const isError = (r: Rpc): boolean => Boolean(r.result?.isError)

const loginCookie = async (username: string, password: string): Promise<string> => {
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  })
  expect(login.statusCode).toBe(200)
  return (login.headers['set-cookie'] as string).split(';')[0]
}

const patFor = async (username: string, password: string): Promise<string> => {
  const cookie = await loginCookie(username, password)
  const created = await app.inject({
    method: 'POST',
    url: '/api/me/tokens',
    headers: { cookie },
    payload: { name: 'write-token', scope: 'write' },
  })
  expect(created.statusCode).toBe(201)
  return created.json().token as string
}

const getJson = async (url: string, cookie: string) =>
  (await app.inject({ method: 'GET', url, headers: { cookie } })).json()

describe('personal layer (#13): memory audit', () => {
  it('a fresh personal domain has an empty memory feed', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const res = await app.inject({ method: 'GET', url: '/api/me/memory', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json().categories).toEqual([])
  })

  it('memory the agent recorded surfaces to the human with #12 provenance', async () => {
    const bearer = await patFor('sam', 'sam-password-1')
    const w = await callTool(
      'remember_about_user',
      {
        observation: 'Prefers concise, structured summaries.',
        category: 'preferences',
        summary: 'Language: RU.',
      },
      bearer,
    )
    expect(isError(w)).toBe(false)

    const cookie = await loginCookie('sam', 'sam-password-1')
    const mem = await getJson('/api/me/memory', cookie)
    expect(mem.categories).toHaveLength(1)
    const cat = mem.categories[0]
    expect(cat.category).toBe('preferences')
    expect(cat.summary).toBe('Language: RU.')
    // Provenance: an agent (PAT) wrote it — `pat:<user>:<id>`, kind 'write'.
    expect(cat.principal).toMatch(/^pat:sam:/)
    expect(cat.kind).toBe('write')

    // The user OWNS it: openable/editable by id (direct read is not scoped).
    const detail = await getJson(`/api/note?id=${encodeURIComponent(cat.noteId)}`, cookie)
    expect(detail.class).toBe('agent-memory')
    expect(detail.content).toContain('Prefers concise')
  })

  it('the memory feed never exposes the personal-domain slug', async () => {
    const bearer = await patFor('sam', 'sam-password-1')
    await callTool('remember_about_user', { observation: 'x', category: 'identity' }, bearer)
    const cookie = await loginCookie('sam', 'sam-password-1')
    const raw = (await app.inject({ method: 'GET', url: '/api/me/memory', headers: { cookie } }))
      .body
    expect(raw).not.toContain('sam-personal')
  })
})

describe('personal layer (#13): profile', () => {
  it('the profile round-trips content + display name, and is NOT memory', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')

    const before = await getJson('/api/me/profile', cookie)
    expect(before.content).toBe('')
    expect(before.noteId).toBe(null)
    expect(before.displayName).toBe('Sam')

    const put = await app.inject({
      method: 'PUT',
      url: '/api/me/profile',
      headers: { cookie },
      payload: { content: '# About me\n\nI build things.', displayName: 'Samuel' },
    })
    expect(put.statusCode).toBe(200)
    const saved = put.json()
    expect(saved.content).toContain('I build things')
    expect(saved.displayName).toBe('Samuel')
    expect(saved.noteId).toBeTruthy()
    expect(JSON.stringify(saved)).not.toContain('sam-personal')

    const after = await getJson('/api/me/profile', cookie)
    expect(after.content).toContain('I build things')
    expect(after.noteId).toBe(saved.noteId)

    // The display name rename reflects on the principal record.
    expect((await getJson('/api/me', cookie)).displayName).toBe('Samuel')

    // The profile note is the reserved `profile` class (#159), not agent-memory —
    // it must NOT appear in the memory audit feed.
    const mem = await getJson('/api/me/memory', cookie)
    expect(mem.categories.some((c: { category: string }) => /profile/i.test(c.category))).toBe(
      false,
    )
  })

  it('the saved profile is hidden from the personal space — tree, graph AND search (#159)', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')

    // Save through the real path (writeProfileNote → targetClass:'profile').
    const put = await app.inject({
      method: 'PUT',
      url: '/api/me/profile',
      headers: { cookie },
      payload: { content: '# About me\n\nfundamentalbuilder marker.', displayName: 'Sam' },
    })
    expect(put.statusCode).toBe(200)
    const space = (await getJson('/api/me', cookie)).personalSpace as string
    expect(space).toBeTruthy()

    // The bug: a visible `Profile` row in the root. The fix: the note's class
    // keeps it out of every discovery surface — notes window, tree, graph.
    const notes = await getJson(`/api/s/${space}/notes?preview=1`, cookie)
    expect(notes.notes.some((n: { title: string }) => n.title === 'Profile')).toBe(false)
    expect(notes.total).toBe(0)

    const tree = await getJson(`/api/s/${space}/tree`, cookie)
    expect(tree.stats.total).toBe(0)
    expect(tree.folders.some((f: { path: string }) => f.path.startsWith('.notarium'))).toBe(false)

    const graph = await getJson(`/api/s/${space}/graph`, cookie)
    expect(graph.nodes.length).toBe(0)

    // And out of user search too — the user reaches it from Settings, not by
    // searching their notes (the profile's content marker finds nothing).
    const search = await getJson(`/api/s/${space}/search?q=fundamentalbuilder`, cookie)
    expect(search.results.some((r: { title: string }) => r.title === 'Profile')).toBe(false)
  })

  it('a read never mints a personal domain; the first save does', async () => {
    const cookie = await loginCookie('nova', 'nova-password-1')

    // Peek-only reads on a user with no personal domain: empty, no side effect.
    expect((await getJson('/api/me/profile', cookie)).noteId).toBe(null)
    expect((await getJson('/api/me/memory', cookie)).categories).toEqual([])
    expect((await getJson('/api/me', cookie)).personalSpace).toBe(null)

    const put = await app.inject({
      method: 'PUT',
      url: '/api/me/profile',
      headers: { cookie },
      payload: { content: 'hello' },
    })
    expect(put.statusCode).toBe(200)
    // The save minted the domain.
    expect((await getJson('/api/me', cookie)).personalSpace).toBeTruthy()
    expect((await getJson('/api/me/profile', cookie)).content).toBe('hello')
  })
})
