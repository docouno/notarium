import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ATTACHMENT_STATE,
  type AttachmentState,
  PROVIDER_LIST_PAGE_SIZE,
  PROVIDER_STATUS,
} from '@notarium/contract'
import { providerDisclosureOf } from '@notarium/server'
import { createApp, type Fixture } from './app'
import type { InMemoryProviderPersistence } from './providers'

const fixture: Fixture = {
  spaces: [{ slug: 'main', displayName: 'Main', notes: [] }],
  capabilities: { providers: true },
  auth: {
    users: [
      { username: 'alice', password: 'alice-password-1', admin: false },
      { username: 'bob', password: 'bob-password-01', admin: false },
      { username: 'root', password: 'root-password-01', admin: true },
    ],
    members: [
      { space: 'main', username: 'alice', role: 'writer' },
      { space: 'main', username: 'bob', role: 'owner' },
      { space: 'main', username: 'root', role: 'reader' },
    ],
  },
}

describe('provider effective list', () => {
  let app: FastifyInstance
  let providers!: InMemoryProviderPersistence
  let spaceId!: string
  let attachments = 0

  const start = async (over: Partial<Fixture> = {}) => {
    attachments = 0
    app = await createApp(
      { ...fixture, ...over },
      {
        onProviderPersistence: (persistence, idOf) => {
          providers = persistence
          spaceId = idOf('main')
        },
      },
    )
    return app
  }

  afterEach(async () => {
    await app.close()
  })

  const login = async (username: string, password: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username, password },
    })
    expect(response.statusCode).toBe(200)
    return (response.headers['set-cookie'] as string).split(';')[0]
  }

  const createResource = async (cookie: string, payload: Record<string, unknown> = {}) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/providers/resources',
      headers: { cookie },
      payload: {
        name: 'Main resource',
        wire: 'openai-compatible',
        baseUrl: 'https://openrouter.ai/api/v1',
        models: [{ name: 'gpt-4o-mini', capabilities: ['completion'] }],
        headers: { 'X-Tenant-Internal': 'acme' },
        ...payload,
      },
    })
    expect(response.statusCode).toBe(200)
    return response.json().resource.id as string
  }

  /** Vertical 14 ships acceptance; here the state arrives through the facet. */
  const attach = (resourceId: string, state: AttachmentState = ATTACHMENT_STATE.active) => {
    attachments += 1
    return providers.offerProviderAttachment(
      {
        id: `attachment-${attachments}`,
        resourceId,
        targetKind: 'space',
        targetId: spaceId,
        targetSpace: spaceId,
        state,
        resourceEpoch: state === ATTACHMENT_STATE.pending ? null : 0,
        credentialEpoch: null,
        disclosure: null,
        createdAt: '2026-08-25T00:00:00.000Z',
        expiresAt: '2026-09-08T00:00:00.000Z',
      },
      providerDisclosureOf,
    )
  }

  const effective = async (cookie: string) => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/providers/effective',
      headers: { cookie },
    })
    expect(response.statusCode).toBe(200)
    return response.json() as {
      total: number
      items: Array<{ resource: Record<string, unknown>; unusableBecause: string | null }>
    }
  }

  const effectiveOne = (cookie: string, resourceId: string) =>
    app.inject({
      method: 'GET',
      url: `/api/providers/effective/${resourceId}`,
      headers: { cookie },
    })

  const statuses = (cookie: string, ids: string[]) =>
    app.inject({
      method: 'POST',
      url: '/api/providers/resources/statuses',
      headers: { cookie },
      payload: { ids },
    })

  it('gives the owner the whole record and a member only what the resource serves', async () => {
    await start()
    const alice = await login('alice', 'alice-password-1')
    const bob = await login('bob', 'bob-password-01')
    const id = await createResource(alice)
    await attach(id)

    const mine = await effective(alice)
    expect(mine.items).toHaveLength(1)
    expect(mine.items[0]).toMatchObject({
      unusableBecause: null,
      resource: {
        id,
        baseUrl: 'https://openrouter.ai/api/v1',
        modelCount: 1,
        owner: { kind: 'user', name: 'alice', mine: true },
      },
    })

    const theirs = await effective(bob)
    expect(theirs.items).toHaveLength(1)
    const card = theirs.items[0].resource
    // What it serves and who pays: yes. Where it points, and a header name that can
    // be a secret of its own: no.
    expect(card).toMatchObject({
      id,
      name: 'Main resource',
      modelCount: 1,
      addressIsPrivate: false,
      hasCredentials: false,
      owner: { kind: 'user', name: 'alice', mine: false },
    })
    expect(card).not.toHaveProperty('allowPrivateNetwork')
    expect(card).not.toHaveProperty('baseUrl')
    expect(card).not.toHaveProperty('headerNames')
    expect(card).not.toHaveProperty('vendor')
    expect(card).not.toHaveProperty('firstByteTimeoutMs')
    expect(card).not.toHaveProperty('callTimeoutMs')
    expect(JSON.stringify(theirs)).not.toContain('openrouter.ai')
    expect(JSON.stringify(theirs)).not.toContain('acme')

    const mineExact = await effectiveOne(alice, id)
    expect(mineExact.statusCode).toBe(200)
    expect(mineExact.json()).toMatchObject({
      resource: { id, baseUrl: 'https://openrouter.ai/api/v1' },
      unusableBecause: null,
    })
    const theirsExact = await effectiveOne(bob, id)
    expect(theirsExact.statusCode).toBe(200)
    expect(theirsExact.json()).toMatchObject({ resource: { id }, unusableBecause: null })
    expect(theirsExact.json().resource).not.toHaveProperty('baseUrl')
  })

  it('hides an offer nobody accepted and names the reason for one that lapsed', async () => {
    await start()
    const alice = await login('alice', 'alice-password-1')
    const bob = await login('bob', 'bob-password-01')
    const offered = await createResource(alice, { name: 'Offered' })
    const lapsed = await createResource(alice, { name: 'Lapsed' })
    await attach(offered, ATTACHMENT_STATE.pending)
    await attach(lapsed, ATTACHMENT_STATE.awaitingReconsent)

    const theirs = await effective(bob)
    // The proposal is not a weaker grant — until it is accepted it is disclosed on
    // the consent surface and nowhere else.
    expect(theirs.items.map((item) => item.resource.id)).toEqual([lapsed])
    expect(theirs.items[0].unusableBecause).toBe(PROVIDER_STATUS.attachmentNotActive)
    expect(theirs.total).toBe(1)
    expect((await effectiveOne(bob, offered)).statusCode).toBe(404)
    expect((await effectiveOne(bob, 'missing-resource')).statusCode).toBe(404)
  })

  it('collapses a foreign exact id and a missing id to the same response', async () => {
    await start()
    const alice = await login('alice', 'alice-password-1')
    const bob = await login('bob', 'bob-password-01')
    const foreign = await createResource(alice)

    const [hidden, missing] = await Promise.all([
      effectiveOne(bob, foreign),
      effectiveOne(bob, 'missing-resource'),
    ])
    expect(hidden.statusCode).toBe(404)
    expect(missing.statusCode).toBe(404)
    expect(hidden.body).toBe(missing.body)
  })

  it('batches only owned statuses and keeps foreign, missing and addresses off the wire', async () => {
    await start()
    const alice = await login('alice', 'alice-password-1')
    const bob = await login('bob', 'bob-password-01')
    const credential = await app.inject({
      method: 'POST',
      url: '/api/providers/credentials',
      headers: { cookie: bob },
      payload: {
        name: 'Disabled credential',
        kind: 'bearer',
        secret: 'owner-status-secret-value',
        origin: 'https://openrouter.ai',
        injection: { header: '', prefix: 'Bearer ' },
      },
    })
    const credentialId = credential.json().credential.id as string
    await app.inject({
      method: 'PATCH',
      url: `/api/providers/credentials/${credentialId}`,
      headers: { cookie: bob },
      payload: { disabled: true },
    })
    const owned = await createResource(bob, { credentialId })
    const foreign = await createResource(alice)

    const response = await statuses(bob, [foreign, 'missing-resource', owned])
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      items: [{ id: owned, unusableBecause: PROVIDER_STATUS.credentialDisabled }],
    })
    expect(response.body).not.toContain('openrouter.ai')
    expect(response.body).not.toContain('owner-status-secret-value')
    expect((await statuses(bob, [foreign])).body).toBe(
      (await statuses(bob, ['missing-resource'])).body,
    )

    const oversized = await statuses(
      bob,
      Array.from({ length: PROVIDER_LIST_PAGE_SIZE + 1 }, (_, index) => `resource-${index}`),
    )
    expect(oversized.statusCode).toBe(400)
  })

  it('keeps the addressee from a host admin who is not the owner only where it must', async () => {
    await start()
    const alice = await login('alice', 'alice-password-1')
    const root = await login('root', 'root-password-01')
    const id = await createResource(alice)
    await attach(id)

    const seen = await effective(root)
    expect(seen.items[0].resource).toMatchObject({ id, baseUrl: 'https://openrouter.ai/api/v1' })
    // The credential belongs to its owner, admin or not.
    expect(seen.items[0].resource).not.toHaveProperty('credentialId')
    // The reconciliation batch is narrower than effective inventory: host admin is
    // not an ownership bypass, and the response echoes no foreign id or status.
    expect((await statuses(root, [id])).json()).toEqual({ items: [] })
  })

  it('keeps the provider prose about the owner account away from a member', async () => {
    await start()
    const alice = await login('alice', 'alice-password-1')
    const bob = await login('bob', 'bob-password-01')
    const id = await createResource(alice)
    await attach(id)
    // A PUBLIC address: the private-address collapse does not apply here, which is
    // exactly the case where the verbatim body used to travel.
    await providers.providerResources.recordLastCheck({
      resourceId: id,
      capability: 'completion',
      lastCheck: {
        status: 'quota-exhausted',
        checkedAt: '2026-08-25T00:00:00.000Z',
        diagnostic: 'This request needs more credits: org-acme has 0.02 remaining',
        credentialProven: true,
      },
      measurement: null,
      expectedRuntimeEpoch: 0,
      expectedCredentialId: null,
      expectedCredentialRuntimeEpoch: null,
    })

    const mine = await app.inject({
      method: 'GET',
      url: `/api/providers/resources/${id}`,
      headers: { cookie: alice },
    })
    expect(mine.json().resource.lastCheck).toMatchObject({
      completion: {
        status: 'quota-exhausted',
        diagnostic: 'This request needs more credits: org-acme has 0.02 remaining',
      },
    })

    const theirs = await effective(bob)
    // The status still explains why the resource is idle; the provider's sentence
    // about someone else's balance does not travel with it.
    expect(theirs.items[0].resource).not.toHaveProperty('lastCheck')
    expect(JSON.stringify(theirs)).not.toContain('org-acme')
  })

  it('tells a member where the call goes by the derived fact, not by the owner opt-in', async () => {
    await start()
    const alice = await login('alice', 'alice-password-1')
    const bob = await login('bob', 'bob-password-01')
    // Legal and unremarkable: the opt-in is not refused on a public origin, it is
    // simply not what admits one.
    const id = await createResource(alice, { allowPrivateNetwork: true })
    await attach(id)

    const theirs = await effective(bob)
    const card = theirs.items[0].resource
    expect(card.addressIsPrivate).toBe(false)
    expect(card).not.toHaveProperty('allowPrivateNetwork')

    const mine = await effective(alice)
    expect(mine.items[0].resource).toMatchObject({
      addressIsPrivate: false,
    })
    expect(mine.items[0].resource).not.toHaveProperty('allowPrivateNetwork')
    const detail = await app.inject({
      method: 'GET',
      url: `/api/providers/resources/${id}`,
      headers: { cookie: alice },
    })
    expect(detail.json().resource.allowPrivateNetwork).toBe(true)
  })

  it('serves the authless host, whose owner key is the instance rather than a person', async () => {
    await start({ auth: undefined })
    const created = await app.inject({
      method: 'POST',
      url: '/api/providers/resources',
      payload: {
        name: 'Host resource',
        wire: 'openai-compatible',
        baseUrl: 'https://openrouter.ai/api/v1',
        models: [{ name: 'gpt-4o-mini', capabilities: ['completion'] }],
      },
    })
    expect(created.statusCode).toBe(200)
    const id = created.json().resource.id as string
    // A record left by a password-mode past: reachable only through the Space set the
    // system principal gets from the manager, since it is owned by nobody present.
    await providers.providerResources.create(
      {
        id: 'foreign-resource',
        owner: 'alice',
        name: 'Foreign',
        wire: 'openai-compatible',
        baseUrl: 'https://openrouter.ai/api/v1',
        headers: {},
        allowPrivateNetwork: false,
        models: [
          {
            name: 'gpt-4o-mini',
            capabilities: ['completion'],
            dimensions: null,
            statusByCapability: { completion: 'available' },
          },
        ],
        defaultModel: null,
        credentialId: null,
        consentEpoch: 0,
        runtimeEpoch: 0,
        disabledAt: null,
        lastCheck: {},
        firstByteTimeoutMs: null,
        callTimeoutMs: null,
      },
      null,
    )
    providers.injectProviderAttachment({
      id: 'foreign-attachment',
      resourceId: 'foreign-resource',
      targetKind: 'space',
      targetId: spaceId,
      targetSpace: spaceId,
      state: ATTACHMENT_STATE.active,
      resourceEpoch: 0,
      credentialEpoch: null,
      disclosure: null,
      createdAt: '2026-08-25T00:00:00.000Z',
      expiresAt: '2026-09-08T00:00:00.000Z',
    })

    const response = await app.inject({ method: 'GET', url: '/api/providers/effective' })
    expect(response.statusCode).toBe(200)
    const seen = response.json() as {
      items: Array<{ resource: Record<string, unknown>; unusableBecause: string | null }>
    }
    expect(seen.items).toHaveLength(2)
    expect(seen.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          unusableBecause: null,
          resource: expect.objectContaining({
            id,
            owner: { kind: 'system', name: null, mine: true },
          }),
        }),
        // Present, and fail-closed: an authless host has no account rows at all, so a
        // record owned by a named person has nobody who could be asked to re-consent.
        expect.objectContaining({
          unusableBecause: PROVIDER_STATUS.ownerDisabled,
          resource: expect.objectContaining({ id: 'foreign-resource' }),
        }),
      ]),
    )
  })

  it('answers an empty list rather than an error when the host has no resource', async () => {
    await start()
    const bob = await login('bob', 'bob-password-01')

    await expect(effective(bob)).resolves.toEqual({ items: [], total: 0, nextCursor: null })
  })

  it('is unreachable to a token: an agent learns the fact from whoami, never the list', async () => {
    await start()
    const alice = await login('alice', 'alice-password-1')
    const minted = await app.inject({
      method: 'POST',
      url: '/api/me/tokens',
      headers: { cookie: alice },
      payload: { name: 'agent', scope: 'write' },
    })
    expect(minted.statusCode).toBe(201)
    const token = minted.json().token as string

    const response = await app.inject({
      method: 'GET',
      url: '/api/providers/effective',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(404)
    const statusBatch = await app.inject({
      method: 'POST',
      url: '/api/providers/resources/statuses',
      headers: { authorization: `Bearer ${token}` },
      payload: { ids: ['resource-1'] },
    })
    expect(statusBatch.statusCode).toBe(404)
  })

  it('has no route at all when the subsystem is off', async () => {
    await start({ capabilities: { providers: false } })
    const alice = await login('alice', 'alice-password-1')

    const response = await app.inject({
      method: 'GET',
      url: '/api/providers/effective',
      headers: { cookie: alice },
    })
    expect(response.statusCode).toBe(404)
    expect((await statuses(alice, ['resource-1'])).statusCode).toBe(404)
  })
})
