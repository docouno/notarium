// Context sets (#209) end to end over the production buildApp: a NAMED, reusable,
// CROSS-SPACE collection of note refs, attached to a scope. What it pins down:
//   - CRUD homed in a space (membership gates it) + cross-space item refs.
//   - Attach to a PROJECT → the set's items ride the project agent-context AND
//     start_session(project).project.alwaysLoad (one shared curation).
//   - Honest per-reader DEGRADATION: a member of the project but NOT of the item's
//     home space gets the set with its inaccessible items DROPPED (the set stands).
//   - Attach to PERSONAL → the set rides /api/me/agent-context + profile.alwaysLoad.
//   - ownership ≥ attachment: a personal-homed set is REFUSED on a shared project.
//   - Delete cascades its attachments.

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
          id: 'conv-a',
          title: 'Front Conventions',
          class: 'user-doc',
          filePath: 'front.md',
          content: 'use hooks',
        },
        {
          id: 'conv-b',
          title: 'API Conventions',
          class: 'user-doc',
          filePath: 'api.md',
          content: 'rest first',
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
      // nina is in conventions but NOT product — sees a conventions-homed set but must not
      // learn the handle of a product project it's attached to (attachment-leak reader).
      { username: 'nina', password: 'nina-password-1', displayName: 'Nina' },
    ],
    members: [
      { space: 'conventions', username: 'sam', role: 'owner' },
      { space: 'product', username: 'sam', role: 'owner' },
      { space: 'sam-personal', username: 'sam', role: 'owner' },
      { space: 'product', username: 'mallory', role: 'owner' },
      { space: 'evan-space', username: 'evan', role: 'owner' },
      { space: 'conventions', username: 'nina', role: 'reader' },
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

/** Create a set in `homeSpace`, add the given {space,noteId} items, return its id. */
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
    const r = await send('POST', `/api/s/${homeSpace}/context-sets/${id}/items`, cookie, {
      space,
      noteId,
    })
    expect(r.statusCode).toBe(200)
  }

  return id
}

const PROJECT = 'proj-product-web'

describe('context sets (#209)', () => {
  it('a shared set attached to a project rides the project agent-context AND start_session, for a member', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const bearer = await patFor(cookie)
    const setId = await makeSet(cookie, 'conventions', 'Front', [
      ['conventions', 'conv-a'],
      ['conventions', 'conv-b'],
    ])
    expect(
      (await send('PUT', `/api/s/product/projects/${PROJECT}/context-sets/${setId}`, cookie))
        .statusCode,
    ).toBe(200)

    const ctx = await getJson(`/api/s/product/projects/${PROJECT}/agent-context`, cookie)
    const sets = ctx.sets as Array<{
      id: string
      name: string
      items: Array<{ noteId: string; loaded: boolean; space: string }>
    }>
    expect(sets).toHaveLength(1)
    expect(sets[0].name).toBe('Front')
    expect(sets[0].items.map((i) => i.noteId).sort()).toEqual(['conv-a', 'conv-b'])
    expect(sets[0].items.every((i) => i.loaded && i.space === 'conventions')).toBe(true)

    // start_session(project) folds the loaded set items into project.alwaysLoad (one curation).
    const ss = await startSession(bearer, { project: 'product/web' })
    const always = (ss.project as { alwaysLoad: Array<{ noteId: string }> }).alwaysLoad.map(
      (p) => p.noteId,
    )
    expect(always).toContain('conv-a')
    expect(always).toContain('conv-b')
  })

  it('DEGRADES per reader: a member of the project but NOT the set’s home space gets the set with its items dropped', async () => {
    const sam = await loginCookie('sam', 'sam-password-1')
    const setId = await makeSet(sam, 'conventions', 'Front', [['conventions', 'conv-a']])
    await send('PUT', `/api/s/product/projects/${PROJECT}/context-sets/${setId}`, sam)

    const mallory = await loginCookie('mallory', 'mallory-password-1')
    const mBearer = await patFor(mallory)
    const ctx = await getJson(`/api/s/product/projects/${PROJECT}/agent-context`, mallory)
    const sets = ctx.sets as Array<{ items: unknown[]; homeSpace: string; name: string }>
    // The set is still attached (visible), but conv-a is inaccessible to mallory → dropped.
    expect(sets).toHaveLength(1)
    expect(sets[0].items).toHaveLength(0)
    // …and its home-space slug is blanked for her (she isn't a conventions member and can
    // never CRUD it there) — no cross-space slug leak (#209). The name still shows (the set
    // is deliberately attached to her project).
    expect(sets[0].homeSpace).toBe('')
    expect(sets[0].name).toBe('Front')
    // …and it never reaches her agent bundle either.
    const ss = await startSession(mBearer, { project: 'product/web' })
    const always = (ss.project as { alwaysLoad: Array<{ noteId: string }> }).alwaysLoad.map(
      (p) => p.noteId,
    )
    expect(always).not.toContain('conv-a')
  })

  it('a set attached to MY personal scope rides /api/me/agent-context and the profile alwaysLoad', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const bearer = await patFor(cookie)
    const setId = await makeSet(cookie, 'sam-personal', 'My Canon Set', [
      ['sam-personal', 'mine-a'],
    ])
    expect((await send('PUT', `/api/me/context-sets/${setId}`, cookie)).statusCode).toBe(200)

    const ctx = await getJson('/api/me/agent-context', cookie)
    const sets = ctx.sets as Array<{ items: Array<{ noteId: string }> }>
    expect(sets.flatMap((s) => s.items.map((i) => i.noteId))).toContain('mine-a')

    const ss = await startSession(bearer, {})
    const always = (ss.profile as { alwaysLoad: Array<{ noteId: string }> }).alwaysLoad.map(
      (p) => p.noteId,
    )
    expect(always).toContain('mine-a')
  })

  it('ownership ≥ attachment: a PERSONAL-homed set is REFUSED on a shared project (400)', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const setId = await makeSet(cookie, 'sam-personal', 'Private', [])
    const r = await send('PUT', `/api/s/product/projects/${PROJECT}/context-sets/${setId}`, cookie)
    expect(r.statusCode).toBe(400)
    // and the personal flag is surfaced in the management list.
    const list = await getJson('/api/context-sets', cookie)
    const mine = (list.sets as Array<{ id: string; personal: boolean }>).find((s) => s.id === setId)
    expect(mine?.personal).toBe(true)
  })

  it('deleting a set cascades its attachment — it vanishes from the project agent-context', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const setId = await makeSet(cookie, 'conventions', 'Front', [['conventions', 'conv-a']])
    await send('PUT', `/api/s/product/projects/${PROJECT}/context-sets/${setId}`, cookie)
    expect(
      (await send('DELETE', `/api/s/conventions/context-sets/${setId}`, cookie)).statusCode,
    ).toBe(200)

    const ctx = await getJson(`/api/s/product/projects/${PROJECT}/agent-context`, cookie)
    expect(ctx.sets as unknown[]).toHaveLength(0)
    const list = await getJson('/api/context-sets', cookie)
    expect((list.sets as Array<{ id: string }>).some((s) => s.id === setId)).toBe(false)
  })

  it('a non-member cannot create a set in a space they cannot write (404/anti-enum)', async () => {
    const mallory = await loginCookie('mallory', 'mallory-password-1')
    // mallory is not a member of conventions → the space-scoped route 404s.
    const r = await send('POST', '/api/s/conventions/context-sets', mallory, { name: 'X' })
    expect(r.statusCode).toBe(404)
  })

  it('cross-space DETACH is refused: a writer of another space cannot strip a project attachment via a mismatched URL space (404)', async () => {
    const sam = await loginCookie('sam', 'sam-password-1')
    const setId = await makeSet(sam, 'conventions', 'Front', [['conventions', 'conv-a']])
    expect(
      (await send('PUT', `/api/s/product/projects/${PROJECT}/context-sets/${setId}`, sam))
        .statusCode,
    ).toBe(200)

    // evan writes his OWN space but not product; he aims the product project id at his own URL
    // space. The handler must re-check proj.space === req.spaceId and refuse (404), not detach.
    const evan = await loginCookie('evan', 'evan-password-1')
    const r = await send(
      'DELETE',
      `/api/s/evan-space/projects/${PROJECT}/context-sets/${setId}`,
      evan,
    )
    expect(r.statusCode).toBe(404)

    // The attachment survives — the set still rides the project agent-context.
    const ctx = await getJson(`/api/s/product/projects/${PROJECT}/agent-context`, sam)
    expect((ctx.sets as Array<{ id: string }>).some((s) => s.id === setId)).toBe(true)
  })

  it('the agent-context scope view exposes the set home SLUG (not the internal space id) so pult CRUD resolves', async () => {
    // On a meta-DB host (the fake mints freshNoteId space ids ≠ slug) the pult addresses set
    // delete/remove/add through sets[].homeSpace as the /api/s/:space URL segment — so it MUST
    // be the slug, matching describeContextSet and item.space (regression guard for r1 fix #4).
    const sam = await loginCookie('sam', 'sam-password-1')
    const setId = await makeSet(sam, 'conventions', 'Front', [['conventions', 'conv-a']])
    await send('PUT', `/api/s/product/projects/${PROJECT}/context-sets/${setId}`, sam)

    const projCtx = await getJson(`/api/s/product/projects/${PROJECT}/agent-context`, sam)
    const projSet = (projCtx.sets as Array<{ id: string; homeSpace: string }>)[0]
    expect(projSet.homeSpace).toBe('conventions') // the SLUG, not the opaque space id

    // Address a real delete through that homeSpace (as the web does) — it must resolve, not 404.
    const del = await send('DELETE', `/api/s/${projSet.homeSpace}/context-sets/${projSet.id}`, sam)
    expect(del.statusCode).toBe(200)

    // Same for a PERSONAL-homed set on /api/me/agent-context.
    const personalSetId = await makeSet(sam, 'sam-personal', 'Mine', [['sam-personal', 'mine-a']])
    await send('PUT', `/api/me/context-sets/${personalSetId}`, sam)
    const meCtx = await getJson('/api/me/agent-context', sam)
    expect((meCtx.sets as Array<{ id: string; homeSpace: string }>)[0].homeSpace).toBe(
      'sam-personal',
    )
  })

  it('management view DEGRADES the attachment list: a home-space member cannot see the handle of an attached project in a space they cannot read', async () => {
    // sam (conventions + product) homes a set in conventions and attaches it to the product
    // project. nina (conventions only) lists the set but must NOT learn the product project's
    // handle — the attachment drops out, like an unreachable item title nulls (#209 leak fix).
    const sam = await loginCookie('sam', 'sam-password-1')
    const setId = await makeSet(sam, 'conventions', 'Front', [['conventions', 'conv-a']])
    await send('PUT', `/api/s/product/projects/${PROJECT}/context-sets/${setId}`, sam)
    // sam sees the product attachment (he's a product member).
    const samList = await getJson('/api/context-sets', sam)
    const samSet = (
      samList.sets as Array<{ id: string; attachments: Array<{ kind: string; label: string }> }>
    ).find((s) => s.id === setId)
    expect(
      samSet?.attachments.some((a) => a.kind === 'project' && a.label.includes('product')),
    ).toBe(true)

    const nina = await loginCookie('nina', 'nina-password-1')
    const ninaList = await getJson('/api/context-sets', nina)
    const ninaSet = (
      ninaList.sets as Array<{
        id: string
        attachments: Array<{ kind: string; label: string; id: string }>
      }>
    ).find((s) => s.id === setId)
    expect(ninaSet).toBeTruthy() // nina sees the set (conventions member)
    // …but the product-project attachment is redacted out entirely (no handle, no id leak).
    expect(ninaSet?.attachments.filter((a) => a.kind === 'project')).toEqual([])
  })

  it('management view DEGRADES per reader: an unreachable item keeps its ref with title=null (not dropped)', async () => {
    // A set homed in PRODUCT with a cross-space item from CONVENTIONS. sam (member of both)
    // can add it; mallory (member of product, NOT conventions) lists the set but cannot reach
    // the item — describeContextSet must RETAIN the ref and null its title (an honest "no
    // access" row), UNLIKE the agent-context path which DROPS inaccessible items entirely.
    const sam = await loginCookie('sam', 'sam-password-1')
    const setId = await makeSet(sam, 'product', 'Mixed', [['conventions', 'conv-a']])

    const mallory = await loginCookie('mallory', 'mallory-password-1')
    const list = await getJson('/api/context-sets', mallory)
    const set = (
      list.sets as Array<{
        id: string
        items: Array<{ noteId: string; title: string | null; space: string | null }>
      }>
    ).find((s) => s.id === setId)
    expect(set).toBeTruthy()
    expect(set?.items).toHaveLength(1) // ref RETAINED (not dropped)
    expect(set?.items[0].noteId).toBe('conv-a')
    expect(set?.items[0].title).toBeNull() // title nulled — honest no-access
    expect(set?.items[0].space).toBeNull() // …and the home-space slug nulled too — no leak
  })
})
