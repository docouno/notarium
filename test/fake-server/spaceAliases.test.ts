import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { createApp, type Fixture } from './app.js'

const fixture: Fixture = {
  spaces: [
    {
      slug: 'work',
      displayName: 'Work',
      aliases: ['research', 'shared-history'],
      notes: [],
    },
    {
      slug: 'research',
      displayName: 'Research',
      aliases: ['library', 'shared-history'],
      notes: [],
    },
  ],
  auth: {
    users: [{ username: 'bob', password: 'seed-pass', displayName: 'Bob' }],
    // Bob holds only research. Effectiveness must still be computed against
    // hidden work before the anti-enumeration membership filter is applied.
    members: [{ space: 'research', username: 'bob', role: 'owner' }],
  },
}

let app: FastifyInstance | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('space alias wire boundary', () => {
  it('projects only effective aliases through spaces and auth session', async () => {
    app = await createApp(fixture, { passwordVerifier: async () => true })
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'bob', password: 'seed-pass' },
    })
    expect(login.statusCode).toBe(200)
    const setCookie = login.headers['set-cookie']
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0]
    expect(cookie).toBeTruthy()
    const headers = { cookie: cookie as string }

    const listed = (await app.inject({ method: 'GET', url: '/api/spaces', headers })).json()
      .spaces as Array<{
      slug: string
      aliases?: string[]
    }>
    expect(listed).toEqual([expect.objectContaining({ slug: 'research', aliases: ['library'] })])

    const session = (await app.inject({ method: 'GET', url: '/api/auth/session', headers })).json()
    expect(session.me.spaces).toEqual([{ slug: 'research', role: 'owner', aliases: ['library'] }])

    expect(
      (await app.inject({ method: 'GET', url: '/api/s/library/notes', headers })).statusCode,
    ).toBe(200)
    expect(
      (await app.inject({ method: 'GET', url: '/api/s/research/notes', headers })).statusCode,
    ).toBe(200)
    expect(
      (await app.inject({ method: 'GET', url: '/api/s/shared-history/notes', headers })).statusCode,
    ).toBe(404)
  })
})
