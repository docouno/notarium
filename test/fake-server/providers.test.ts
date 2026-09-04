import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createApp, type Fixture } from './app'

const fixture: Fixture = {
  spaces: [{ slug: 'main', displayName: 'Main', notes: [] }],
  capabilities: { providers: true },
  auth: {
    users: [
      { username: 'alice', password: 'alice-password-1', admin: true },
      { username: 'bob', password: 'bob-password-01', admin: true },
    ],
    members: [
      { space: 'main', username: 'alice', role: 'owner' },
      { space: 'main', username: 'bob', role: 'owner' },
    ],
  },
}

describe('provider resource REST surface', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await createApp(fixture)
  })

  afterEach(async () => {
    await app.close()
  })

  const login = async (username: string, password: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: username, password },
    })
    expect(response.statusCode).toBe(200)
    return (response.headers['set-cookie'] as string).split(';')[0]
  }

  const createResource = (cookie: string, payload: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/providers/resources',
      headers: { cookie },
      payload: {
        name: 'Main resource',
        wire: 'openai-compatible',
        baseUrl: 'https://openrouter.ai/api/v1',
        models: [{ name: 'gpt-4o-mini', capabilities: ['completion'] }],
        headers: { 'X-Api-Key': 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz' },
        ...payload,
      },
    })

  const createCredential = (cookie: string, payload: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/providers/credentials',
      headers: { cookie },
      payload: {
        name: 'OpenRouter',
        kind: 'bearer',
        secret: 'sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        origin: 'https://openrouter.ai',
        injection: { header: '', prefix: 'Bearer ' },
        ...payload,
      },
    })

  it('keeps credential inventory owner-only and secret-free', async () => {
    const alice = await login('alice', 'alice-password-1')
    const bob = await login('bob', 'bob-password-01')
    const created = await createCredential(alice)
    expect(created.statusCode).toBe(200)
    const id = created.json().credential.id as string
    expect(created.body).not.toContain('sk-or-v1')

    const listed = await app.inject({
      method: 'GET',
      url: '/api/providers/credentials',
      headers: { cookie: alice },
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json()).toMatchObject({ total: 1, items: [{ id, name: 'OpenRouter' }] })
    expect(listed.body).not.toContain('sk-or-v1')

    const detail = await app.inject({
      method: 'GET',
      url: `/api/providers/credentials/${id}`,
      headers: { cookie: alice },
    })
    expect(detail.statusCode).toBe(200)
    expect(detail.json()).toMatchObject({
      credential: { id, name: 'OpenRouter' },
      references: [],
    })
    expect(detail.body).not.toContain('sk-or-v1')

    const foreign = await app.inject({
      method: 'GET',
      url: `/api/providers/credentials/${id}`,
      headers: { cookie: bob },
    })
    const missing = await app.inject({
      method: 'GET',
      url: '/api/providers/credentials/missing',
      headers: { cookie: bob },
    })
    expect(foreign.statusCode).toBe(404)
    expect(foreign.body).toBe(missing.body)
  })

  it('patches and deletes an unreferenced credential without exposing replacement bytes', async () => {
    const cookie = await login('alice', 'alice-password-1')
    const created = await createCredential(cookie, { name: 'Disposable' })
    expect(created.statusCode).toBe(200)
    const id = created.json().credential.id as string
    const replacement = 'replacement-secret-value'
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/providers/credentials/${id}`,
      headers: { cookie },
      payload: { name: 'Disposable renamed', secret: replacement, rpm: 12 },
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json()).toMatchObject({
      credential: {
        id,
        name: 'Disposable renamed',
        rpm: 12,
        runtimeEpoch: 1,
        consentEpoch: 0,
      },
      references: [],
    })
    expect(patched.body).not.toContain(replacement)
    expect(patched.body).not.toContain('v1.')

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/providers/credentials/${id}`,
      headers: { cookie },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toEqual({ ok: true })

    const deletedAgain = await app.inject({
      method: 'DELETE',
      url: `/api/providers/credentials/${id}`,
      headers: { cookie },
    })
    expect(deletedAgain.statusCode).toBe(404)

    const patchedMissing = await app.inject({
      method: 'PATCH',
      url: `/api/providers/credentials/${id}`,
      headers: { cookie },
      payload: { name: 'Gone' },
    })
    expect(patchedMissing.statusCode).toBe(404)
  })

  it('maps malformed, invalid-origin, and duplicate credential writes at the route boundary', async () => {
    const cookie = await login('alice', 'alice-password-1')
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/providers/credentials',
      headers: { cookie },
      payload: { name: 'Missing fields' },
    })
    expect(malformed.statusCode).toBe(400)

    const created = await createCredential(cookie, { name: 'Unique route name' })
    expect(created.statusCode).toBe(200)
    const invalidOrigin = await app.inject({
      method: 'PATCH',
      url: `/api/providers/credentials/${created.json().credential.id}`,
      headers: { cookie },
      payload: { origin: 'not-an-origin' },
    })
    expect(invalidOrigin.statusCode).toBe(400)

    const duplicate = await createCredential(cookie, { name: 'Unique route name' })
    expect(duplicate.statusCode).toBe(409)
  })

  it('rejects immutable kind and incompatible reverse credential mutations', async () => {
    const cookie = await login('alice', 'alice-password-1')
    const createdCredential = await createCredential(cookie)
    const credentialId = createdCredential.json().credential.id as string
    const createdResource = await createResource(cookie, {
      credentialId,
      headers: { 'X-Api-Key': 'manual-value' },
    })
    expect(createdResource.statusCode).toBe(200)
    const resource = createdResource.json().resource as { id: string; name: string }

    const immutable = await app.inject({
      method: 'PATCH',
      url: `/api/providers/credentials/${credentialId}`,
      headers: { cookie },
      payload: { kind: 'header' },
    })
    expect(immutable.statusCode).toBe(400)

    const origin = await app.inject({
      method: 'PATCH',
      url: `/api/providers/credentials/${credentialId}`,
      headers: { cookie },
      payload: { origin: 'https://provider.example' },
    })
    expect(origin.statusCode).toBe(409)
    expect(origin.json().references).toContainEqual({
      kind: 'provider-resource',
      id: resource.id,
      name: resource.name,
    })

    const injection = await app.inject({
      method: 'PATCH',
      url: `/api/providers/credentials/${credentialId}`,
      headers: { cookie },
      payload: { injection: { header: 'x-api-key', prefix: '' } },
    })
    expect(injection.statusCode).toBe(409)
    expect(injection.json().references).toContainEqual({
      kind: 'provider-resource',
      id: resource.id,
      name: resource.name,
    })
  })

  it('returns every live reference instead of cascading credential delete', async () => {
    const cookie = await login('alice', 'alice-password-1')
    const createdCredential = await createCredential(cookie)
    const credentialId = createdCredential.json().credential.id as string
    const first = await createResource(cookie, { credentialId, name: 'First' })
    const second = await createResource(cookie, { credentialId, name: 'Second' })
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/providers/credentials/${credentialId}`,
      headers: { cookie },
    })
    expect(deleted.statusCode).toBe(409)
    expect(deleted.json().references).toEqual([
      {
        kind: 'provider-resource',
        id: first.json().resource.id,
        name: 'First',
      },
      {
        kind: 'provider-resource',
        id: second.json().resource.id,
        name: 'Second',
      },
    ])

    const detail = await app.inject({
      method: 'GET',
      url: `/api/providers/credentials/${credentialId}`,
      headers: { cookie },
    })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().references).toEqual(deleted.json().references)
  })

  it('stores through the real envelope and never returns header values', async () => {
    const cookie = await login('alice', 'alice-password-1')
    const created = await createResource(cookie)
    expect(created.statusCode).toBe(200)
    expect(created.json()).toMatchObject({
      resource: {
        name: 'Main resource',
        headerNames: ['x-api-key'],
        vendor: 'openrouter',
      },
      warnings: ['possible-secret'],
    })
    expect(created.body).not.toContain('sk-ant-api03')

    const listed = await app.inject({
      method: 'GET',
      url: '/api/providers/resources',
      headers: { cookie },
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json()).toMatchObject({
      total: 1,
      nextCursor: null,
      items: [{ modelCount: 1 }],
    })
    expect(listed.json().items[0]).not.toHaveProperty('headerNames')
    expect(listed.body).not.toContain('sk-ant-api03')
  })

  it('patches one write-only header without erasing its neighbours', async () => {
    const cookie = await login('alice', 'alice-password-1')
    const created = await createResource(cookie, {
      headers: {
        'X-Keep': 'keep-secret-value',
        'X-Change': 'old-secret-value',
        'X-Delete': 'delete-secret-value',
      },
    })
    const id = created.json().resource.id as string
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/providers/resources/${id}`,
      headers: { cookie },
      payload: {
        headers: {
          'X-Change': 'new-secret-value',
          'X-Delete': null,
        },
      },
    })

    expect(patched.statusCode).toBe(200)
    expect(patched.json().resource.headerNames).toEqual(['x-change', 'x-keep'])
    for (const secret of [
      'keep-secret-value',
      'old-secret-value',
      'new-secret-value',
      'delete-secret-value',
    ]) {
      expect(patched.body).not.toContain(secret)
    }
  })

  it('does not let another host admin patch the owner resource', async () => {
    const alice = await login('alice', 'alice-password-1')
    const bob = await login('bob', 'bob-password-01')
    const created = await createResource(alice, { headers: {} })
    const id = created.json().resource.id as string
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/providers/resources/${id}`,
      headers: { cookie: bob },
      payload: { name: 'Taken over' },
    })
    expect(patched.statusCode).toBe(404)

    const foreign = await app.inject({
      method: 'GET',
      url: `/api/providers/resources/${id}`,
      headers: { cookie: bob },
    })
    const missing = await app.inject({
      method: 'GET',
      url: '/api/providers/resources/missing',
      headers: { cookie: bob },
    })
    expect(foreign.statusCode).toBe(404)
    expect(foreign.body).toBe(missing.body)
  })

  it('keeps management inventory unreachable to a write PAT', async () => {
    const cookie = await login('alice', 'alice-password-1')
    const pat = await app.inject({
      method: 'POST',
      url: '/api/me/tokens',
      headers: { cookie },
      payload: { name: 'provider-test', scope: 'write' },
    })
    expect(pat.statusCode).toBe(201)
    const listed = await app.inject({
      method: 'GET',
      url: '/api/providers/resources',
      headers: { authorization: `Bearer ${pat.json().token}` },
    })
    expect(listed.statusCode).toBe(404)

    const credential = await createCredential(cookie)
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/providers/credentials/${credential.json().credential.id}`,
      headers: { authorization: `Bearer ${pat.json().token}` },
      payload: { name: 'stolen' },
    })
    expect(patched.statusCode).toBe(404)
  })

  it('rejects unconditional hazards and an unrecognised vendor field', async () => {
    const cookie = await login('alice', 'alice-password-1')
    expect((await createResource(cookie, { headers: { Host: 'example.test' } })).statusCode).toBe(
      400,
    )
    expect(
      (await createResource(cookie, { headers: { 'x-a': 'v\r\nInjected: 1' } })).statusCode,
    ).toBe(400)
    expect((await createResource(cookie, { vendor: 'openrouter' })).statusCode).toBe(400)
  })

  it('keeps direct provider routes unavailable when the subsystem is off', async () => {
    const disabled = await createApp({ ...fixture, capabilities: { providers: false } })

    try {
      const loginResponse = await disabled.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { identifier: 'alice', password: 'alice-password-1' },
      })
      const cookie = (loginResponse.headers['set-cookie'] as string).split(';')[0]
      const listed = await disabled.inject({
        method: 'GET',
        url: '/api/providers/resources',
        headers: { cookie },
      })
      expect(listed.statusCode).toBe(404)

      const credentialRequests = await Promise.all([
        disabled.inject({
          method: 'GET',
          url: '/api/providers/credentials/missing',
          headers: { cookie },
        }),
        disabled.inject({
          method: 'POST',
          url: '/api/providers/credentials',
          headers: { cookie },
          payload: {},
        }),
        disabled.inject({
          method: 'PATCH',
          url: '/api/providers/credentials/missing',
          headers: { cookie },
          payload: { name: 'still off' },
        }),
        disabled.inject({
          method: 'DELETE',
          url: '/api/providers/credentials/missing',
          headers: { cookie },
        }),
        // `validate` is the one route that would otherwise reach the network, so
        // "off means off" has to be proven on it by name, not by family.
        disabled.inject({
          method: 'POST',
          url: '/api/providers/resources/missing/validate',
          headers: { cookie },
          payload: { capability: 'completion' },
        }),
        disabled.inject({
          method: 'DELETE',
          url: '/api/providers/resources/missing',
          headers: { cookie },
        }),
      ])
      expect(credentialRequests.map((response) => response.statusCode)).toEqual([
        404, 404, 404, 404, 404, 404,
      ])
    } finally {
      await disabled.close()
    }
  })
})
