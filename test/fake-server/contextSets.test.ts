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
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REQUEST_TIMING_HEADER } from '@notarium/contract'

import { createApp, type Fixture } from './app.js'
import { InMemoryContextSets } from './contextSets'

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
        {
          id: 'conv-overview',
          title: 'Conventions',
          class: 'user-doc',
          filePath: 'handbook/index.md',
          content: 'how this folder fits together',
        },
        // A HIDDEN class sitting on the reserved basename: a memory category that slugs
        // to `index`. It is nobody's cover, and the audit page must not label it as one.
        {
          id: 'conv-memory-index',
          title: 'index',
          class: 'agent-memory',
          filePath: '.notarium/memory/index.md',
          content: 'remembered, not authored',
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
        // A cover mallory CAN read: the folder-page role has to survive the projection
        // built for a reader outside the set's home space.
        {
          id: 'prod-overview',
          title: 'Guides',
          class: 'user-doc',
          filePath: 'guides/index.md',
          content: 'what lives under guides',
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

const postJsonInTwoChunks = async (
  path: string,
  cookie: string,
  payload: unknown,
  pauseMs: number,
  serverReceived: Promise<void>,
): Promise<{
  body: string
  headers: Record<string, string | string[] | undefined>
  status: number
}> => {
  const body = JSON.stringify(payload)
  const splitAt = Math.floor(body.length / 2)

  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          cookie,
          'content-length': Buffer.byteLength(body),
          'content-type': 'application/json',
        },
      },
      (response) => {
        const chunks: Buffer[] = []

        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          resolve({
            body: Buffer.concat(chunks).toString('utf8'),
            headers: response.headers,
            status: response.statusCode ?? 0,
          })
        })
      },
    )

    request.on('error', reject)
    request.on('socket', (socket) => socket.setNoDelay(true))
    request.flushHeaders()
    request.write(body.slice(0, splitAt), (error) => {
      if (error) {
        reject(error)
        return
      }
      void serverReceived
        .then(() => new Promise((done) => setTimeout(done, pauseMs)))
        .then(() => request.end(body.slice(splitAt)), reject)
    })
  })
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
    payload: { identifier: username, password },
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

  it('marks a readable folder page carried by a context set', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const setId = await makeSet(cookie, 'conventions', 'Overview', [
      ['conventions', 'conv-overview'],
    ])
    expect(
      (await send('PUT', `/api/s/product/projects/${PROJECT}/context-sets/${setId}`, cookie))
        .statusCode,
    ).toBe(200)

    const ctx = await getJson(`/api/s/product/projects/${PROJECT}/agent-context`, cookie)
    const item = (
      ctx.sets as Array<{
        items: Array<{ noteId: string; folderPage?: true }>
      }>
    )[0].items[0]
    expect(item).toMatchObject({ noteId: 'conv-overview', folderPage: true })
  })

  it('names the folder-page role on the audit page too, and stays silent on a degraded row', async () => {
    const sam = await loginCookie('sam', 'sam-password-1')
    const setId = await makeSet(sam, 'product', 'Paged covers', [
      ['conventions', 'conv-overview'],
      ['product', 'prod-overview'],
      ['conventions', 'conv-memory-index'],
    ])
    const page = await app.inject({
      method: 'GET',
      url: `/api/s/product/context-sets/${setId}/items?offset=0&limit=3`,
      headers: { cookie: sam },
    })

    expect(page.statusCode).toBe(200)
    // The audit page is the SECOND source of rows for one expanded set. If it stayed
    // silent, the same cover would be chipped above the curation stop and plain below it.
    expect(page.json()).toEqual({
      total: 3,
      items: [
        {
          sourceIndex: 0,
          noteId: 'conv-overview',
          title: 'Conventions',
          space: 'conventions',
          folderPage: true,
        },
        {
          sourceIndex: 1,
          noteId: 'prod-overview',
          title: 'Guides',
          space: 'product',
          folderPage: true,
        },
        // The reserved basename inside a hidden mount is a memory category, not a cover —
        // the same question the MCP marker asks, answered by the same predicate.
        {
          sourceIndex: 2,
          noteId: 'conv-memory-index',
          title: 'index',
          space: 'conventions',
        },
      ],
    })

    // …and a row the reader cannot reach says nothing about its role either way.
    const mallory = await loginCookie('mallory', 'mallory-password-1')
    const degraded = await app.inject({
      method: 'GET',
      url: `/api/s/product/context-sets/${setId}/items?offset=0&limit=1`,
      headers: { cookie: mallory },
    })

    expect(degraded.json()).toEqual({
      total: 3,
      items: [{ sourceIndex: 0, noteId: 'conv-overview', title: null, space: null }],
    })
  })

  it('answers the folder-page question on the audit page without body facts too', async () => {
    await app.close()
    let factlessReads = 0

    app = await createApp(fixture(), {
      configureWorld: ({ slug, store }) => {
        if (slug !== 'conventions') {
          return
        }
        // A host whose fact accelerator is absent — or whose scan ended in `error`, where
        // CachedStore.noteFacts answers `{}` — sends EVERY reachable row down the live-read
        // fallback. That is the configuration in which an unmarked audit page would come
        // back silently, so the fallback answers the same question as the fast path.
        vi.spyOn(store, 'noteFacts').mockImplementation(async () => {
          factlessReads += 1
          return {}
        })
      },
    })
    port = await listen(app)

    const sam = await loginCookie('sam', 'sam-password-1')
    const setId = await makeSet(sam, 'product', 'Factless', [
      ['conventions', 'conv-overview'],
      ['conventions', 'conv-memory-index'],
    ])
    const page = await app.inject({
      method: 'GET',
      url: `/api/s/product/context-sets/${setId}/items?offset=0&limit=2`,
      headers: { cookie: sam },
    })

    expect(page.statusCode).toBe(200)
    expect(page.json()).toEqual({
      total: 2,
      items: [
        {
          sourceIndex: 0,
          noteId: 'conv-overview',
          title: 'Conventions',
          space: 'conventions',
          folderPage: true,
        },
        { sourceIndex: 1, noteId: 'conv-memory-index', title: 'index', space: 'conventions' },
      ],
    })
    // The rows above are what the FAST path would answer too, so assert the stand was
    // actually factless. Without this the test would quietly degrade into a duplicate of
    // its neighbour the day the stub stops binding the store the route reads.
    expect(factlessReads).toBeGreaterThan(0)
  })

  it('keeps the folder-page role in the projection built for a reader outside the set home', async () => {
    const sam = await loginCookie('sam', 'sam-password-1')
    const setId = await makeSet(sam, 'conventions', 'Covers', [
      ['conventions', 'conv-overview'],
      ['product', 'prod-overview'],
    ])
    await send('PUT', `/api/s/product/projects/${PROJECT}/context-sets/${setId}`, sam)

    const mallory = await loginCookie('mallory', 'mallory-password-1')
    const ctx = await getJson(`/api/s/product/projects/${PROJECT}/agent-context`, mallory)
    const set = (
      ctx.sets as Array<{
        homeSpace: string
        items: Array<{ noteId: string; folderPage?: true; sourceIndex?: number }>
      }>
    )[0]

    // The hidden-home branch rebuilds every row field by field instead of spreading it, so
    // the role has to be carried deliberately. The raw coordinate must NOT be.
    expect(set.homeSpace).toBe('')
    expect(set.items).toEqual([
      expect.objectContaining({ noteId: 'prod-overview', folderPage: true }),
    ])
    expect(set.items[0].sourceIndex).toBeUndefined()
  })

  it('DEGRADES per reader without exposing raw coordinates from the hidden home', async () => {
    const sam = await loginCookie('sam', 'sam-password-1')
    const setId = await makeSet(sam, 'conventions', 'Front', [
      ['conventions', 'conv-a'],
      ['product', 'prod-note'],
    ])
    await send('PUT', `/api/s/product/projects/${PROJECT}/context-sets/${setId}`, sam)

    const mallory = await loginCookie('mallory', 'mallory-password-1')
    const mBearer = await patFor(mallory)
    const ctx = await getJson(`/api/s/product/projects/${PROJECT}/agent-context`, mallory)
    const sets = ctx.sets as Array<{
      items: Array<{ noteId: string; order: number; sourceIndex?: number }>
      homeSpace: string
      name: string
      itemsTotal?: number
      itemsCursor?: number
    }>
    // The set is still attached and its product note is visible, but conv-a is
    // inaccessible. The surviving row gets a dense visible order, not raw index 1.
    expect(sets).toHaveLength(1)
    expect(sets[0].items).toEqual([expect.objectContaining({ noteId: 'prod-note', order: 0 })])
    // …and its home-space slug is blanked for her (she isn't a conventions member and can
    // never CRUD it there) — no cross-space slug leak (#209). The name still shows (the set
    // is deliberately attached to her project).
    expect(sets[0].homeSpace).toBe('')
    expect(sets[0].name).toBe('Front')
    expect(sets[0].itemsTotal).toBeUndefined()
    expect(sets[0].itemsCursor).toBeUndefined()
    expect(sets[0].items.some((item) => item.sourceIndex !== undefined)).toBe(false)
    // …and it never reaches her agent bundle either.
    const ss = await startSession(mBearer, { project: 'product/web' })
    const always = (ss.project as { alwaysLoad: Array<{ noteId: string }> }).alwaysLoad.map(
      (p) => p.noteId,
    )
    expect(always).not.toContain('conv-a')
    expect(always).toContain('prod-note')
    expect(ss.truncated).toBe(true)
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

  it('management view keeps raw membership without resolving presentation', async () => {
    // A set homed in PRODUCT with a cross-space item from CONVENTIONS. sam (member of both)
    // can add it; mallory (member of product, NOT conventions) lists the set but cannot reach
    // the item — the manager keeps only the stored ref and does not resolve an access oracle.
    const sam = await loginCookie('sam', 'sam-password-1')
    const setId = await makeSet(sam, 'product', 'Mixed', [['conventions', 'conv-a']])

    const mallory = await loginCookie('mallory', 'mallory-password-1')
    const list = await getJson('/api/context-sets', mallory)
    const set = (
      list.sets as Array<{
        id: string
        items: Array<{ noteId: string }>
      }>
    ).find((s) => s.id === setId)
    expect(set).toBeTruthy()
    expect(set?.items).toHaveLength(1) // ref RETAINED (not dropped)
    expect(set?.items[0].noteId).toBe('conv-a')
    expect(set?.items[0]).toEqual({ noteId: 'conv-a' })
  })

  it('paginates raw membership before bounded presentation and degrades inaccessible rows', async () => {
    const sam = await loginCookie('sam', 'sam-password-1')
    const setId = await makeSet(sam, 'product', 'Paged', [
      ['conventions', 'conv-a'],
      ['product', 'prod-note'],
    ])
    const page = await app.inject({
      method: 'GET',
      url: `/api/s/product/context-sets/${setId}/items?offset=0&limit=1`,
      headers: { cookie: sam },
    })
    expect(page.statusCode).toBe(200)
    expect(page.json()).toEqual({
      total: 2,
      items: [
        {
          sourceIndex: 0,
          noteId: 'conv-a',
          title: 'Front Conventions',
          space: 'conventions',
        },
      ],
    })

    const mallory = await loginCookie('mallory', 'mallory-password-1')
    const degraded = await app.inject({
      method: 'GET',
      url: `/api/s/product/context-sets/${setId}/items?offset=0&limit=1`,
      headers: { cookie: mallory },
    })
    expect(degraded.json()).toEqual({
      total: 2,
      items: [{ sourceIndex: 0, noteId: 'conv-a', title: null, space: null }],
    })
  })

  it('does not build a second whole-space inventory after slicing an item page', async () => {
    await app.close()
    let conventionLists = 0

    app = await createApp(fixture(), {
      configureWorld: ({ slug, store }) => {
        if (slug !== 'conventions') {
          return
        }
        const list = store.list.bind(store)

        vi.spyOn(store, 'list').mockImplementation(async (...args) => {
          conventionLists += 1
          return list(...args)
        })
      },
    })
    port = await listen(app)
    const sam = await loginCookie('sam', 'sam-password-1')
    const setId = await makeSet(sam, 'product', 'Bounded page', [['conventions', 'conv-a']])

    conventionLists = 0
    const page = await app.inject({
      method: 'GET',
      url: `/api/s/product/context-sets/${setId}/items?offset=0&limit=1`,
      headers: { cookie: sam },
    })

    expect(page.statusCode).toBe(200)
    // The fake has no global identity registry, so noteStore pays its documented one-list
    // fallback. The page presenter must not add metaNoteAccess's second full inventory.
    expect(conventionLists).toBe(1)
  })

  it('adds a mixed batch in one request with private failures and raw response items', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const setId = await makeSet(cookie, 'product', 'Bulk', [])
    const added = await app.inject({
      method: 'POST',
      url: `/api/s/product/context-sets/${setId}/add-many`,
      headers: { cookie },
      payload: {
        items: [
          { space: 'conventions', noteId: 'conv-a' },
          { space: 'conventions', noteId: 'conv-b' },
          { space: 'conventions', noteId: 'unknown' },
        ],
      },
    })
    expect(added.statusCode).toBe(200)
    const serverStartedAt = Number(added.headers[REQUEST_TIMING_HEADER.STARTED_AT])
    const serverEndedAt = Number(added.headers[REQUEST_TIMING_HEADER.ENDED_AT])

    expect(serverStartedAt).toBeGreaterThan(0)
    expect(serverEndedAt).toBeGreaterThan(serverStartedAt)
    expect(added.json()).toMatchObject({
      ok: true,
      added: ['conv-a', 'conv-b'],
      failed: [{ id: 'unknown', reason: 'not_found', error: 'Note is unavailable' }],
      set: { items: [{ noteId: 'conv-a' }, { noteId: 'conv-b' }] },
    })

    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/s/product/context-sets/${setId}/add-many`,
      headers: { cookie },
      // A forged/wrong hint cannot become authority; the global fallback still
      // resolves the readable note and keeps the idempotent result.
      payload: { items: [{ space: 'product', noteId: 'conv-a' }] },
    })
    expect(duplicate.json()).toMatchObject({ added: [], failed: [] })
  })

  it('starts bulk liveness timing before the request body finishes parsing', async () => {
    const cookie = await loginCookie('sam', 'sam-password-1')
    const setId = await makeSet(cookie, 'product', 'Timed bulk', [])
    const pauseMs = 80
    // Do not start the pause at the client write call: the kernel may buffer that
    // tiny first chunk. The server's request event proves Fastify has received the
    // headers and can enter its onRequest hook before we hold the remaining bytes.
    const serverReceived = new Promise<void>((resolve) =>
      app.server.once('request', () => resolve()),
    )
    const response = await postJsonInTwoChunks(
      `/api/s/product/context-sets/${setId}/add-many`,
      cookie,
      { items: [{ space: 'conventions', noteId: 'conv-a' }] },
      pauseMs,
      serverReceived,
    )

    expect(response.status).toBe(200)
    const serverStartedAt = Number(response.headers[REQUEST_TIMING_HEADER.STARTED_AT])
    const serverEndedAt = Number(response.headers[REQUEST_TIMING_HEADER.ENDED_AT])

    expect(JSON.parse(response.body)).toMatchObject({ ok: true, added: ['conv-a'] })
    expect(serverEndedAt - serverStartedAt).toBeGreaterThanOrEqual(pauseMs / 2)
  })

  it('collapses inaccessible, unknown, and deleted bulk refs to one failure shape', async () => {
    const sam = await loginCookie('sam', 'sam-password-1')
    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/note?id=prod-note',
      headers: { cookie: sam },
    })
    expect(removed.statusCode).toBe(200)
    const mallory = await loginCookie('mallory', 'mallory-password-1')
    const setId = await makeSet(mallory, 'product', 'Private failures', [])
    const response = await app.inject({
      method: 'POST',
      url: `/api/s/product/context-sets/${setId}/add-many`,
      headers: { cookie: mallory },
      payload: {
        items: [
          { space: 'conventions', noteId: 'conv-a' },
          { space: 'product', noteId: 'unknown' },
          { space: 'product', noteId: 'prod-note' },
        ],
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().failed).toEqual(
      ['conv-a', 'unknown', 'prod-note'].map((id) => ({
        id,
        reason: 'not_found',
        error: 'Note is unavailable',
      })),
    )
  })

  it('ignores hint spellings without allocating a whole-space inventory', async () => {
    await app.close()
    let conventionLists = 0

    app = await createApp(fixture(), {
      configureWorld: ({ slug, store }) => {
        if (slug !== 'conventions') {
          return
        }
        const list = store.list.bind(store)

        vi.spyOn(store, 'list').mockImplementation(async (...args) => {
          conventionLists += 1
          return list(...args)
        })
      },
    })
    port = await listen(app)
    const cookie = await loginCookie('sam', 'sam-password-1')
    const setId = await makeSet(cookie, 'product', 'Hint aliases', [])
    conventionLists = 0
    const response = await app.inject({
      method: 'POST',
      url: `/api/s/product/context-sets/${setId}/add-many`,
      headers: { cookie },
      payload: {
        items: [
          { space: 'CONVENTIONS!', noteId: 'conv-a' },
          { space: 'conventions', noteId: 'conv-b' },
        ],
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ added: ['conv-a', 'conv-b'], failed: [] })
    // This meta-DB-less fake pays one documented exact-id list fallback per input.
    // Production resolves both through O(1) identity rows; neither path builds a Map/Set copy.
    expect(conventionLists).toBe(2)
  })

  it('removes every conflict returned by an attempt and retries valid refs once', async () => {
    await app.close()
    class ConflictingContextSets extends InMemoryContextSets {
      attempts: string[][] = []

      override async addItems(id: string, refs: readonly { space: string; noteId: string }[]) {
        this.attempts.push(refs.map((ref) => ref.noteId))

        if (this.attempts.length === 1) {
          return { set: null, added: [], conflicts: ['conv-b'] }
        }

        return super.addItems(id, refs)
      }
    }
    const facet = new ConflictingContextSets()
    app = await createApp(fixture(), { contextSets: facet })
    port = await listen(app)
    const cookie = await loginCookie('sam', 'sam-password-1')
    const setId = await makeSet(cookie, 'product', 'Conflict retry', [])
    const response = await app.inject({
      method: 'POST',
      url: `/api/s/product/context-sets/${setId}/add-many`,
      headers: { cookie },
      payload: {
        items: [
          { space: 'conventions', noteId: 'conv-a' },
          { space: 'conventions', noteId: 'conv-b' },
        ],
      },
    })

    expect(response.statusCode).toBe(200)
    expect(facet.attempts).toEqual([['conv-a', 'conv-b'], ['conv-a']])
    expect(response.json()).toMatchObject({
      added: ['conv-a'],
      failed: [
        {
          id: 'conv-b',
          reason: 'conflict',
          error: 'Reference changed while the set was updated',
        },
      ],
      set: { items: [{ noteId: 'conv-a' }] },
    })
  })

  it('fails closed when a bulk identity conflict cannot name progress', async () => {
    await app.close()
    const facet = new InMemoryContextSets()

    vi.spyOn(facet, 'addItems').mockRejectedValue(
      Object.assign(new Error('identity changed'), { isConflict: true }),
    )
    app = await createApp(fixture(), { contextSets: facet })
    port = await listen(app)
    const cookie = await loginCookie('sam', 'sam-password-1')
    const setId = await makeSet(cookie, 'product', 'Unnameable conflict', [])
    const response = await app.inject({
      method: 'POST',
      url: `/api/s/product/context-sets/${setId}/add-many`,
      headers: { cookie },
      payload: { items: [{ space: 'conventions', noteId: 'conv-a' }] },
    })

    expect(response.statusCode).toBe(409)
    expect((await facet.getSet(setId))?.items).toEqual([])
  })

  it('keeps the real CachedStore fact path bounded across 1000 door refs', async () => {
    const run = async (count: number) => {
      await app.close()
      const seeded = fixture()
      const conventions = seeded.spaces.find((space) => space.slug === 'conventions')!
      const ids = Array.from(
        { length: count },
        (_, index) => `door-${String(index).padStart(4, '0')}`,
      )

      conventions.notes.push(
        ...ids.map((id, index) => ({
          id,
          title: `Door note ${index}`,
          class: 'user-doc' as const,
          filePath: `door/note-${String(index).padStart(4, '0')}.md`,
          content: 'bounded fact path',
        })),
      )
      const facet = new InMemoryContextSets()
      const factIds: string[] = []
      let factCalls = 0
      let fullReads = 0

      app = await createApp(seeded, {
        contextSets: facet,
        configureWorld: ({ slug, engine, store }) => {
          if (slug !== 'conventions') {
            return
          }
          const noteFacts = store.noteFacts!.bind(store)
          const read = engine.read.bind(engine)

          vi.spyOn(store, 'noteFacts').mockImplementation(async (requested) => {
            factCalls += 1
            factIds.push(...requested)
            return noteFacts(requested)
          })
          vi.spyOn(engine, 'read').mockImplementation(async (...args) => {
            fullReads += 1
            return read(...args)
          })
        },
        seedContextSets: async ({ contextSets, projectIdOf, spaceIdOf }) => {
          const setId = 'door-bounded-set'
          const homeSpace = spaceIdOf('conventions')

          await contextSets.createSet({
            id: setId,
            homeSpace,
            name: 'Door bounded set',
            items: ids.map((noteId) => ({ space: homeSpace, noteId })),
            createdAt: '2026-07-07T12:00:00.000Z',
          })
          await contextSets.attach({
            setId,
            targetKind: 'project',
            targetId: await projectIdOf('product', 'web'),
            targetSpace: spaceIdOf('product'),
            createdAt: '2026-07-07T12:00:00.000Z',
          })
        },
      })
      port = await listen(app)
      const cookie = await loginCookie('sam', 'sam-password-1')

      factCalls = 0
      factIds.length = 0
      fullReads = 0
      const preview = await getJson(`/api/s/product/projects/${PROJECT}/agent-context`, cookie)
      const afterPreview = { factCalls, factIds: [...factIds], fullReads }

      await getJson('/api/context-sets', cookie)
      const reordered = await send(
        'PUT',
        '/api/s/conventions/context-sets/door-bounded-set/order',
        cookie,
        { noteIds: ids },
      )
      expect(reordered.statusCode).toBe(200)
      expect({ factCalls, factIds, fullReads }).toEqual(afterPreview)

      return { preview, expectedFactIds: ids.slice(0, 250), ...afterPreview }
    }
    const oversized = await run(1_000)

    expect(oversized.factCalls).toBe(250)
    expect(oversized.factIds).toEqual(oversized.expectedFactIds)
    expect(oversized.fullReads).toBe(0)
    expect(oversized.preview.sets[0]).toMatchObject({
      itemsLoaded: 250,
      itemsCursor: 250,
      trimmed: true,
    })
  }, 20_000)

  it('seeds an injected context facet after identities and repeats it after reset', async () => {
    await app.close()
    const facet = new InMemoryContextSets()
    let seedCalls = 0
    let engineReads = 0

    app = await createApp(fixture(), {
      contextSets: facet,
      configureWorld: ({ slug, engine }) => {
        if (slug !== 'conventions') {
          return
        }
        const read = engine.read.bind(engine)
        vi.spyOn(engine, 'read').mockImplementation(async (...args) => {
          engineReads += 1
          return read(...args)
        })
      },
      seedContextSets: async ({ contextSets, projectIdOf, noteIdAt, spaceIdOf }) => {
        seedCalls += 1
        const setId = 'seeded-context-set'
        await contextSets.createSet({
          id: setId,
          homeSpace: spaceIdOf('conventions'),
          name: 'Seeded',
          items: [
            {
              space: spaceIdOf('conventions'),
              noteId: await noteIdAt('conventions', 'front.md'),
            },
          ],
          createdAt: '2026-07-07T12:00:00.000Z',
        })
        await contextSets.attach({
          setId,
          targetKind: 'project',
          targetId: await projectIdOf('product', 'web'),
          targetSpace: spaceIdOf('product'),
          createdAt: '2026-07-07T12:00:00.000Z',
        })
      },
    })
    port = await listen(app)
    const cookie = await loginCookie('sam', 'sam-password-1')
    const first = await getJson(`/api/s/product/projects/${PROJECT}/agent-context`, cookie)

    expect(first.sets[0]).toMatchObject({ id: 'seeded-context-set', itemsLoaded: 1 })
    expect(engineReads).toBe(0)
    await getJson('/api/context-sets', cookie)
    const duplicate = await send(
      'POST',
      '/api/s/conventions/context-sets/seeded-context-set/items',
      cookie,
      { space: 'conventions', noteId: 'conv-a' },
    )
    expect(duplicate.statusCode).toBe(200)
    expect(duplicate.json().set.items).toEqual([{ noteId: 'conv-a' }])
    // Single-add still performs its one input authorization read; the raw mutation
    // response does not walk the existing membership again.
    expect(engineReads).toBe(1)
    await app.inject({ method: 'POST', url: '/api/__test/reset', payload: {} })
    const resetCookie = await loginCookie('sam', 'sam-password-1')
    const second = await getJson(`/api/s/product/projects/${PROJECT}/agent-context`, resetCookie)
    expect(second.sets[0]).toMatchObject({ id: 'seeded-context-set', itemsLoaded: 1 })
    expect(seedCalls).toBe(2)
  })
})
