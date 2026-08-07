// Create-an-empty-project guard (#13 C): POST /api/s/<slug>/projects with the
// `create` flag mints a FRESH folder (the marker write mkdir's it), so the route
// gained a three-state guard:
//   create=true  → the folder must NOT exist yet (409 if it does)
//   create absent → the folder MUST already exist (400 if not) — mark-as-project
// The base conformance fake runs WITHOUT a markerStore (the guard is skipped), so
// this guard is exercised here against a minimal in-memory MarkerStore — the only
// production-only piece (the registry row is the shared boundary, #18). Without
// this, the whole `create` branch is dead in the test suite.

import type { FastifyInstance } from 'fastify'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { MarkerStore } from '@notarium/server'

import { createApp, type Fixture } from './app.js'

const fixture = (): Fixture => ({
  now: '2026-06-14T12:00:00.000Z',
  spaces: [{ slug: 'team', displayName: 'Team', notes: [] }],
  auth: {
    users: [{ username: 'alice', password: 'alice-password-1' }],
    members: [{ space: 'team', username: 'alice', role: 'owner' }],
  },
})

/** Minimal in-memory MarkerStore: a `${space}\0${path}` set is "what folders
 *  exist on disk". A marker write mkdir's the folder (adds it), mirroring
 *  localFs. Keyed by the SPACE ID the server addresses it with (#100 phase 4 / #127 — the
 *  fake mints id ≠ slug), so a pre-existing folder is seeded via `seedFolder` AFTER the
 *  app resolved that opaque id, not by the human slug. */
type SeedableMarkerStore = MarkerStore & { seedFolder(space: string, path: string): void }
const inMemoryMarkerStore = (): SeedableMarkerStore => {
  const key = (s: string, p: string) => `${s}\0${p}`
  const exists = new Set<string>()
  const markers = new Map<string, string>()
  return {
    available: () => true,
    folderExists: async (space, path) =>
      path === '' || exists.has(key(space, path)) || markers.has(key(space, path)),
    write: async (space, path, raw) => {
      markers.set(key(space, path), raw)
      exists.add(key(space, path)) // the write mkdir's the folder
    },
    read: async (space, path) => markers.get(key(space, path)) ?? null,
    remove: async (space, path) => {
      markers.delete(key(space, path))
    },
    scan: async () => ({ hits: [], complete: true }),
    seedFolder: (space, path) => {
      exists.add(key(space, path)) // pre-existing folder, keyed by the space's id
    },
  }
}

let app: FastifyInstance
let markerStore: SeedableMarkerStore
let teamId: string

const listen = async (instance: FastifyInstance): Promise<number> => {
  await instance.listen({ port: 0, host: '127.0.0.1' })
  return (instance.server.address() as AddressInfo).port
}

const loginCookie = async (): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'alice', password: 'alice-password-1' },
  })
  return res.headers['set-cookie'] as string
}

const mark = (cookie: string, body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/s/team/projects', headers: { cookie }, payload: body })

beforeEach(async () => {
  markerStore = inMemoryMarkerStore()
  app = await createApp(fixture(), { markerStore })
  await listen(app)
  // 'docs' already exists on disk; the store keys by the space's opaque id (#127),
  // minted inside createApp — resolve it off /api/spaces, then seed (alice owns team).
  const cookie = await loginCookie()
  const spaces = (
    await app.inject({ method: 'GET', url: '/api/spaces', headers: { cookie } })
  ).json().spaces as Array<{ id: string; slug: string }>
  teamId = spaces.find((s) => s.slug === 'team')!.id
  markerStore.seedFolder(teamId, 'docs')
})

afterEach(async () => {
  await app.close()
})

describe('POST /projects create guard (#13 C)', () => {
  it('create=true on a FRESH path mints the project (201) and the marker mkdir’s the folder', async () => {
    const cookie = await loginCookie()
    const res = await mark(cookie, { folderPath: 'roadmap', displayName: 'Roadmap', create: true })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ handle: 'team/roadmap', path: 'roadmap', status: 'active' })
  })

  it('create=true on an EXISTING folder is a 409 conflict (never clobbers/aliases it)', async () => {
    const cookie = await loginCookie()
    const res = await mark(cookie, { folderPath: 'docs', displayName: 'Docs', create: true })
    expect(res.statusCode).toBe(409)
  })

  it('mark (create absent) on a NON-EXISTENT folder is a 400 (mark addresses an existing folder)', async () => {
    const cookie = await loginCookie()
    const res = await mark(cookie, { folderPath: 'ghost' })
    expect(res.statusCode).toBe(400)
  })

  it('mark (create absent) on an EXISTING folder succeeds (201) — the original mark-as-project path', async () => {
    const cookie = await loginCookie()
    const res = await mark(cookie, { folderPath: 'docs', displayName: 'Docs' })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ handle: 'team/docs', path: 'docs' })
  })

  it('a just-created project re-creates as a 409 (the marker write made the folder exist)', async () => {
    const cookie = await loginCookie()
    expect((await mark(cookie, { folderPath: 'plans', create: true })).statusCode).toBe(201)
    expect((await mark(cookie, { folderPath: 'plans', create: true })).statusCode).toBe(409)
  })

  it('create rejects non-portable paths, while an existing legacy folder remains markable', async () => {
    const cookie = await loginCookie()

    for (const folderPath of ['CON', 'NUL', 'foo:bar']) {
      expect((await mark(cookie, { folderPath, create: true })).statusCode).toBe(400)
    }

    markerStore.seedFolder(teamId, 'foo:bar')
    const legacy = await mark(cookie, { folderPath: 'foo:bar', displayName: 'Legacy' })
    expect(legacy.statusCode).toBe(201)
    expect(legacy.json()).toMatchObject({ handle: 'team/legacy', path: 'foo:bar' })
  })
})
