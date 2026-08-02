// GET /api/about end to end over the production buildApp. Pins: the
// base payload (build + search capability) is valid and visible to any signed-in
// caller; the admin block (runtime, embedder, deployment shape) is gated —
// present for a host admin (and the none-mode system principal), null for a
// non-admin; an unauthenticated caller is refused in password mode. The fake has
// no real embedder, so it reports FTS honestly, and authMode follows the fixture.

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { HostAboutResponseSchema } from '@notarium/contract'

import { createApp, type Fixture } from './app.js'

const noneFixture = (): Fixture => ({
  now: '2026-06-20T12:00:00.000Z',
  spaces: [
    { slug: 'main', displayName: 'Main', notes: [] },
    { slug: 'work', displayName: 'Work', notes: [] },
  ],
})

const passwordFixture = (): Fixture => ({
  now: '2026-06-20T12:00:00.000Z',
  spaces: [{ slug: 'main', displayName: 'Main', notes: [] }],
  auth: {
    users: [
      { username: 'root', password: 'root-password-1', admin: true },
      { username: 'bob', password: 'bob-password-1' },
    ],
    members: [{ space: 'main', username: 'bob', role: 'reader' }],
  },
})

let app: FastifyInstance
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

const about = async (headers: Record<string, string> = {}) => {
  const res = await app.inject({ method: 'GET', url: '/api/about', headers })
  return { res, body: () => HostAboutResponseSchema.parse(res.json()) }
}

describe('/api/about', () => {
  describe('mode none (system principal)', () => {
    beforeEach(async () => {
      app = await createApp(noneFixture())
    })

    it('returns a contract-valid base: build + FTS-only search capability', async () => {
      const { res, body } = await about()
      expect(res.statusCode).toBe(200)
      const a = body() // HostAboutResponseSchema.parse throws if the wire drifts
      expect(typeof a.build.version).toBe('string')
      // The in-memory fake wires no embedder → honest FTS, no graph channel.
      expect(a.search).toMatchObject({ mode: 'fts', vector: false, graphBoost: false })
    })

    it('reports no source revision outside a release build rather than inventing one', async () => {
      // This run is unbundled (tsx), so there is no released revision to point at.
      // A plausible-looking link here would send an operator to source that is not
      // what they are running. canon: docs/release.md#identity
      expect((await about()).body().build.source).toBeNull()
    })

    it('serves the full identity of a released image, source link included', async () => {
      await app.close()
      const revision = 'a83069798e70dd55e2201c3f4fb2f82c1413e211'
      app = await createApp({
        ...noneFixture(),
        build: {
          version: '0.1.0',
          commit: revision.slice(0, 7),
          builtAt: '2026-07-23T10:00:00Z',
          source: `https://github.com/docouno/notarium/tree/${revision}`,
        },
      })
      expect((await about()).body().build).toEqual({
        version: '0.1.0',
        commit: 'a830697',
        builtAt: '2026-07-23T10:00:00Z',
        source: `https://github.com/docouno/notarium/tree/${revision}`,
      })
    })

    it('exposes the admin block to the none-mode system principal (runtime + engines)', async () => {
      const a = (await about()).body()
      expect(a.admin).not.toBeNull()
      expect(a.admin?.runtime.node).toBe(process.version)
      expect(a.admin?.embedder).toBeNull() // no embedder in the fake
      expect(a.admin?.authMode).toBe('none')
      expect(a.admin?.uptimeSeconds).toBeGreaterThanOrEqual(0)
      expect(a.admin?.spaces.map((s) => s.slug).sort()).toEqual(['main', 'work'])
      expect(a.admin?.spaces.every((s) => s.engine === 'notarium')).toBe(true)
    })

    it('admin spaces reflect a space minted at runtime (live list, not a boot snapshot)', async () => {
      await app.close() // drop the beforeEach app; this case needs spaceCreate
      app = await createApp({ ...noneFixture(), capabilities: { spaceCreate: true } })
      const created = await app.inject({
        method: 'POST',
        url: '/api/spaces',
        payload: { slug: 'fresh' },
      })
      expect(created.statusCode).toBe(201)
      const a = (await about()).body()
      expect(a.admin?.spaces.map((s) => s.slug).sort()).toEqual(['fresh', 'main', 'work'])
      expect(a.admin?.spaces.find((s) => s.slug === 'fresh')?.engine).toBe('notarium')
    })
  })

  describe('mode password (admin gate)', () => {
    beforeEach(async () => {
      app = await createApp(passwordFixture())
    })

    it('refuses an unauthenticated caller', async () => {
      const { res } = await about()
      expect(res.statusCode).toBe(401)
    })

    it('gives an admin the deployment block with the honest auth mode', async () => {
      const cookie = await loginCookie('root', 'root-password-1')
      const a = (await about({ cookie })).body()
      expect(a.admin).not.toBeNull()
      expect(a.admin?.authMode).toBe('password')
      expect(a.admin?.runtime.node).toBe(process.version)
    })

    it('hides the deployment block from a non-admin (base still present)', async () => {
      const cookie = await loginCookie('bob', 'bob-password-1')
      const a = (await about({ cookie })).body()
      expect(a.admin).toBeNull()
      expect(typeof a.build.version).toBe('string') // base info still flows
      expect(a.search.mode).toBe('fts')
    })
  })
})
