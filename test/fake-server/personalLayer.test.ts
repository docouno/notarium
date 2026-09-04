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
import { createHash, randomBytes } from 'node:crypto'
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
const structured = (r: Rpc): Record<string, unknown> =>
  (r.result?.structuredContent as Record<string, unknown>) ?? {}
const toolText = (r: Rpc): string =>
  ((r.result?.content as Array<{ text: string }>) ?? []).map((c) => c.text).join('\n')

const loginCookie = async (username: string, password: string): Promise<string> => {
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: username, password },
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
    // Provenance: an agent (PAT) wrote it — `pat:<userId>:<id>`, kind 'write'.
    const sam = await getJson('/api/me', cookie)
    expect(cat.principal).toMatch(new RegExp(`^pat:${sam.id}:`))
    expect(cat.kind).toBe('write')

    // The user OWNS it: openable/editable by id (direct read is not scoped).
    const detail = await getJson(`/api/note?id=${encodeURIComponent(cat.noteId)}`, cookie)
    expect(detail.class).toBe('agent-memory')
    expect(detail.content).toContain('Prefers concise')
  })

  it('accepts the shared display order without changing the default audit route', async () => {
    const bearer = await patFor('sam', 'sam-password-1')

    for (const category of ['bravo', 'alpha', 'charlie']) {
      await callTool('remember_about_user', { observation: category, category }, bearer)
    }
    const cookie = await loginCookie('sam', 'sam-password-1')
    const dflt = await getJson('/api/me/memory', cookie)
    const titleAsc = await getJson('/api/me/memory?sort=title&dir=asc', cookie)
    const titleDesc = await getJson('/api/me/memory?sort=title&dir=desc', cookie)

    expect(dflt.categories.map((c: { category: string }) => c.category)).toEqual([
      'charlie',
      'alpha',
      'bravo',
    ])
    expect(titleAsc.categories.map((c: { category: string }) => c.category)).toEqual([
      'alpha',
      'bravo',
      'charlie',
    ])
    expect(titleDesc.categories.map((c: { category: string }) => c.category)).toEqual([
      'charlie',
      'bravo',
      'alpha',
    ])
    expect(titleAsc.categories.every((c: { createdAt?: string | null }) => 'createdAt' in c)).toBe(
      true,
    )
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

describe('space narrowing binds the personal domain (#395)', () => {
  const bearerHeaders = (bearer: string) => ({ authorization: `Bearer ${bearer}` })

  /** Mint sam's PAT the Settings way, with an optional space narrowing. */
  const narrowedPat = async (
    spaces: string[] | null,
    scope: 'read' | 'write' = 'read',
  ): Promise<string> => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const created = await app.inject({
      method: 'POST',
      url: '/api/me/tokens',
      headers: { cookie },
      payload: { name: 'narrowed', scope, ...(spaces ? { spaces } : {}) },
    })
    expect(created.statusCode).toBe(201)
    return created.json().token as string
  }

  /** Fill the personal domain with a profile always-load note AND one memory category,
   *  so an "empty" read below proves the narrowing hid real content, not an empty box. */
  const seedPersonal = async (): Promise<string> => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const write = await patFor('sam', 'sam-password-1') // non-narrowed write PAT
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/me/profile',
      headers: { cookie },
      payload: { content: 'Always: answer in RU.' },
    })
    expect(saved.statusCode).toBe(200)
    const mem = await callTool(
      'remember_about_user',
      { observation: 'Prefers concise summaries.', category: 'preferences', summary: 'RU.' },
      write,
    )
    expect(isError(mem)).toBe(false)
    return cookie
  }

  const slugsOf = (list: Array<{ slug: string }>): string[] => list.map((s) => s.slug).sort()

  it('reads the personal domain empty and never leaks its address', async () => {
    await seedPersonal()
    const pat = await narrowedPat(['main']) // narrowed to the WORK space, away from personal
    const h = bearerHeaders(pat)

    // Positive control: the token is live and reaches the work space. Without it every
    // assertion below stays green with the vertical unimplemented.
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: h })).statusCode).toBe(200)

    // Five content surfaces — honest empty.
    expect(
      (await app.inject({ method: 'GET', url: '/api/me/memory', headers: h })).json().categories,
    ).toEqual([])
    const ac = (
      await app.inject({ method: 'GET', url: '/api/me/agent-context', headers: h })
    ).json()
    expect(ac.pins).toEqual([])
    expect(ac.memory).toEqual([])
    expect(
      (await app.inject({ method: 'GET', url: '/api/me/profile', headers: h })).json(),
    ).toMatchObject({
      content: '',
      noteId: null,
      displayName: 'Sam',
    })
    const ssProfile = structured(await callTool('start_session', {}, pat)).profile as {
      alwaysLoad: unknown[]
      memory: unknown[]
    }
    expect(ssProfile.alwaysLoad).toEqual([])
    expect(ssProfile.memory).toEqual([])

    // Two address surfaces — the personal slug is gone by BOTH keys, and the me/spaces
    // lists match (their divergence was itself the leak).
    const me = (await app.inject({ method: 'GET', url: '/api/me', headers: h })).json()
    expect(me.personalSpace).toBeNull()
    const meSlugs = slugsOf(me.spaces)
    expect(meSlugs).not.toContain('sam-personal')
    const apiSpaces = slugsOf(
      (await app.inject({ method: 'GET', url: '/api/spaces', headers: h })).json().spaces,
    )
    expect(meSlugs).toEqual(apiSpaces)
    const session = (
      await app.inject({ method: 'GET', url: '/api/auth/session', headers: h })
    ).json()
    expect(session.me.personalSpace).toBeNull()
    expect(slugsOf(session.me.spaces)).not.toContain('sam-personal')

    // Three self-scoped audit surfaces — closed by the ceiling.
    for (const url of [
      '/api/me/agent-audit',
      '/api/me/agent-sessions',
      '/api/me/agent-sessions/all',
    ]) {
      expect((await app.inject({ method: 'GET', url, headers: h })).statusCode).toBe(404)
    }
  })

  it('a non-narrowed token still reaches the personal domain, but the audit ceiling closes it', async () => {
    await seedPersonal()
    const pat = await narrowedPat(null) // non-narrowed read
    const h = bearerHeaders(pat)

    const me = (await app.inject({ method: 'GET', url: '/api/me', headers: h })).json()
    expect(me.personalSpace).toBe('sam-personal')
    expect(slugsOf(me.spaces)).toContain('sam-personal')
    expect(
      (await app.inject({ method: 'GET', url: '/api/me/memory', headers: h })).json().categories
        .length,
    ).toBeGreaterThan(0)

    // Audit is closed by the ceiling (self:manage), not by narrowing — a non-narrowed PAT hits it too.
    for (const url of [
      '/api/me/agent-audit',
      '/api/me/agent-sessions',
      '/api/me/agent-sessions/all',
    ]) {
      expect((await app.inject({ method: 'GET', url, headers: h })).statusCode).toBe(404)
    }
  })

  it('a token narrowed to INCLUDE the personal domain sees it, like the cookie', async () => {
    const cookie = await seedPersonal()
    const pat = await narrowedPat(['main', 'sam-personal'])
    const h = bearerHeaders(pat)

    const me = (await app.inject({ method: 'GET', url: '/api/me', headers: h })).json()
    expect(me.personalSpace).toBe('sam-personal')
    expect(slugsOf(me.spaces)).toContain('sam-personal')
    expect(
      (await app.inject({ method: 'GET', url: '/api/me/memory', headers: h })).json().categories
        .length,
    ).toBeGreaterThan(0)

    // Cookie baseline is untouched.
    const meCookie = (
      await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })
    ).json()
    expect(meCookie.personalSpace).toBe('sam-personal')
    expect(slugsOf(meCookie.spaces)).toContain('sam-personal')
  })

  it('the cookie session still reaches the audit surfaces (ceiling passes a manage cred)', async () => {
    const cookie = await seedPersonal()

    for (const url of [
      '/api/me/agent-audit',
      '/api/me/agent-sessions',
      '/api/me/agent-sessions/all',
    ]) {
      expect((await app.inject({ method: 'GET', url, headers: { cookie } })).statusCode).toBe(200)
    }
  })

  it('a narrowed write is refused for the RIGHT reason: narrowing, not a false degraded-domain', async () => {
    await seedPersonal() // sam-personal exists → the ONLY honest reason is the narrowing
    const pat = await narrowedPat(['main'], 'write')
    const r = await callTool(
      'remember_about_user',
      { observation: 'x', category: 'preferences', summary: 'y' },
      pat,
    )
    expect(isError(r)).toBe(true)
    expect(toolText(r)).toContain('your token is not scoped to your personal memory domain.')
    expect(toolText(r)).not.toContain('this host cannot provision')
  })

  it('a narrowed OAuth access token is bound too (not just a PAT)', async () => {
    const cookie = await seedPersonal()
    // DCR → consent (cookie) narrowed to main → code → token.
    const reg = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'C' },
    })
    const clientId = reg.json().client_id as string
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const base = {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      scope: 'read write offline_access',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }
    const authz = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: new URLSearchParams({ ...base, decision: 'approve', 'space:main': 'on' }).toString(),
    })
    expect(authz.statusCode).toBe(302)
    const code = new URL(authz.headers.location as string).searchParams.get('code') as string
    const tok = (
      await app.inject({
        method: 'POST',
        url: '/oauth/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
          client_id: clientId,
          code_verifier: verifier,
        }).toString(),
      })
    ).json()
    const h = bearerHeaders(tok.access_token as string)

    const me = (await app.inject({ method: 'GET', url: '/api/me', headers: h })).json()
    expect(me.personalSpace).toBeNull()
    expect(slugsOf(me.spaces)).not.toContain('sam-personal')
    const ac = (
      await app.inject({ method: 'GET', url: '/api/me/agent-context', headers: h })
    ).json()
    expect(ac.pins).toEqual([])
    expect(ac.memory).toEqual([])
  })
})

describe('degraded personal domain still refuses by the true reason (#395)', () => {
  it('a non-narrowed write on a static host without a personal domain gets the degraded reason', async () => {
    await app.close()
    app = await createApp({
      now: '2026-06-14T12:00:00.000Z',
      capabilities: { spaceCreate: false }, // engine cannot mint namespaces → degrade to first space
      spaces: [{ slug: 'main', displayName: 'Main', notes: [] }],
      auth: {
        users: [{ username: 'sam', password: 'sam-password-1', displayName: 'Sam' }],
        members: [{ space: 'main', username: 'sam', role: 'owner' }],
      },
    })
    port = await listen(app)
    const write = await patFor('sam', 'sam-password-1') // non-narrowed
    const r = await callTool(
      'remember_about_user',
      { observation: 'x', category: 'preferences', summary: 'y' },
      write,
    )
    expect(isError(r)).toBe(true)
    // The pair with the narrowed-write test above pins the guard ORDER: narrowing first,
    // degraded second. A non-narrowed cred on a genuinely degraded domain must still hear
    // the degraded reason.
    expect(toolText(r)).toContain('this host cannot provision a private memory domain for you')
  })
})
