import type { FastifyInstance } from 'fastify'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ATTACHMENT_STATE } from '@notarium/contract'

import { createApp, type Fixture } from './app'
import type { InMemoryProviderPersistence } from './providers'

const deferred = <T = void>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

let lookupCalls = 0

const fixture: Fixture = {
  now: '2026-08-25T12:00:00.000Z',
  spaces: [{ slug: 'main', displayName: 'Main', notes: [] }],
  capabilities: { providers: true },
  providerRuntime: {
    transport: {
      lookup: async () => {
        lookupCalls += 1
        return [{ address: '203.0.113.10', family: 4 }]
      },
    },
  },
  auth: {
    users: [
      { username: 'alice', password: 'alice-password-1', admin: false },
      { username: 'bob', password: 'bob-password-01', admin: false },
      { username: 'carol', password: 'carol-password-1', admin: false },
    ],
    members: [
      { space: 'main', username: 'alice', role: 'writer' },
      { space: 'main', username: 'bob', role: 'owner' },
      { space: 'main', username: 'carol', role: 'reader' },
    ],
  },
}

describe('provider attachment lifecycle REST surface', () => {
  let app: FastifyInstance
  let spaceId: string
  let providers: InMemoryProviderPersistence

  beforeEach(async () => {
    lookupCalls = 0
    app = await createApp(fixture, {
      onProviderPersistence: (persistence, idOf) => {
        providers = persistence
        spaceId = idOf('main')
      },
    })
  })

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

  const createCredential = async (cookie: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/providers/credentials',
      headers: { cookie },
      payload: {
        name: 'OpenRouter',
        kind: 'bearer',
        secret: 'sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        origin: 'https://openrouter.ai',
        injection: { header: '', prefix: 'Bearer ' },
      },
    })
    expect(response.statusCode).toBe(200)
    return response.json().credential.id as string
  }

  const createResource = async (
    cookie: string,
    input: { name?: string; baseUrl?: string; credentialId?: string | null } = {},
  ) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/providers/resources',
      headers: { cookie },
      payload: {
        name: input.name ?? 'Main resource',
        wire: 'openai-compatible',
        baseUrl: input.baseUrl ?? 'https://openrouter.ai/api/v1',
        credentialId: input.credentialId ?? null,
        purposes: ['chat'],
        models: [{ name: 'gpt-4o-mini', dimensions: null, status: 'available' }],
      },
    })
    expect(response.statusCode).toBe(200)
    return response.json().resource.id as string
  }

  const offer = (cookie: string, resourceId: string) =>
    app.inject({
      method: 'POST',
      url: '/api/providers/attachments',
      headers: { cookie },
      payload: { resourceId, targetKind: 'space', targetId: spaceId },
    })

  const accept = (
    cookie: string,
    attachmentId: string,
    resourceEpoch: number,
    credentialEpoch: number | null,
  ) =>
    app.inject({
      method: 'POST',
      url: `/api/providers/attachments/${attachmentId}/accept`,
      headers: { cookie },
      payload: { resourceEpoch, credentialEpoch },
    })

  const detail = (cookie: string, attachmentId: string) =>
    app.inject({
      method: 'GET',
      url: `/api/providers/attachments/${attachmentId}`,
      headers: { cookie },
    })

  it('keeps offer owner-side and accept/detach manager-side with idempotent acceptance', async () => {
    const alice = await login('alice', 'alice-password-1')
    const bob = await login('bob', 'bob-password-01')
    const credentialId = await createCredential(alice)
    const resourceId = await createResource(alice, { credentialId })
    const offered = await offer(alice, resourceId)
    expect(offered.statusCode).toBe(200)
    expect(offered.json()).toMatchObject({
      view: {
        attachment: { state: ATTACHMENT_STATE.pending },
        currentEpochs: { resourceEpoch: 0, credentialEpoch: 0 },
        currentDisclosure: { baseUrl: 'https://openrouter.ai/api/v1' },
        diff: { before: null, changed: true },
      },
    })
    const attachmentId = offered.json().view.attachment.id as string

    const writerList = await app.inject({
      method: 'GET',
      url: '/api/s/main/providers/attachments',
      headers: { cookie: alice },
    })
    expect(writerList.statusCode).toBe(404)
    expect((await accept(alice, attachmentId, 0, 0)).statusCode).toBe(404)
    expect((await detail(alice, attachmentId)).statusCode).toBe(404)

    const accepted = await accept(bob, attachmentId, 0, 0)
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json()).toMatchObject({
      outcome: 'accepted',
      view: { attachment: { state: ATTACHMENT_STATE.active } },
    })
    const repeated = await accept(bob, attachmentId, 0, 0)
    expect(repeated.statusCode).toBe(200)
    expect(repeated.json().outcome).toBe('already-active')
    const reviewed = await detail(bob, attachmentId)
    expect(reviewed.statusCode).toBe(200)
    expect(reviewed.json()).toMatchObject({
      view: { attachment: { id: attachmentId }, currentDisclosure: { targetSpace: spaceId } },
    })
    expect((await detail(bob, 'missing-attachment')).statusCode).toBe(404)

    const offeredAgain = await offer(alice, resourceId)
    expect(offeredAgain.statusCode).toBe(409)
    expect(offeredAgain.json()).toMatchObject({ reason: 'already-attached' })

    const detached = await app.inject({
      method: 'DELETE',
      url: `/api/providers/attachments/${attachmentId}`,
      headers: { cookie: bob },
    })
    expect(detached.statusCode).toBe(200)
    const empty = await app.inject({
      method: 'GET',
      url: '/api/s/main/providers/attachments',
      headers: { cookie: bob },
    })
    expect(empty.json()).toMatchObject({ items: [], total: 0 })
  })

  it('keeps inert saves active, suspends address changes, and returns a usable diff', async () => {
    const alice = await login('alice', 'alice-password-1')
    const bob = await login('bob', 'bob-password-01')
    const resourceId = await createResource(alice)
    const attachmentId = (await offer(alice, resourceId)).json().view.attachment.id as string
    expect((await accept(bob, attachmentId, 0, null)).statusCode).toBe(200)

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/providers/resources/${resourceId}`,
      headers: { cookie: alice },
      payload: { name: 'Renamed' },
    })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json().resource.consentEpoch).toBe(0)

    const redirected = await app.inject({
      method: 'PATCH',
      url: `/api/providers/resources/${resourceId}`,
      headers: { cookie: alice },
      payload: { baseUrl: 'https://openrouter.ai/api/v2' },
    })
    expect(redirected.statusCode).toBe(200)
    expect(redirected.json().resource.consentEpoch).toBe(1)

    const listed = await app.inject({
      method: 'GET',
      url: '/api/s/main/providers/attachments',
      headers: { cookie: bob },
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json()).toMatchObject({
      items: [
        {
          attachment: { state: ATTACHMENT_STATE.awaitingReconsent },
        },
      ],
    })
    expect(listed.json().items[0]).not.toHaveProperty('diff')
    expect(listed.json().items[0]).not.toHaveProperty('currentDisclosure')
    expect(JSON.stringify(listed.json())).not.toContain('openrouter.ai')
    const reviewed = await detail(bob, attachmentId)
    expect(reviewed.statusCode).toBe(200)
    expect(reviewed.json()).toMatchObject({
      view: {
        diff: {
          before: { baseUrl: 'https://openrouter.ai/api/v1' },
          after: { baseUrl: 'https://openrouter.ai/api/v2' },
          changed: true,
        },
      },
    })

    const stale = await accept(bob, attachmentId, 0, null)
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toMatchObject({
      reason: 'epoch-conflict',
      view: { currentDisclosure: { baseUrl: 'https://openrouter.ai/api/v2' } },
    })
    const current = await accept(bob, attachmentId, 1, null)
    expect(current.statusCode).toBe(200)
    expect(current.json()).toMatchObject({ outcome: 'accepted' })
  })

  it('keeps a pending offer pending while its displayed addressee changes', async () => {
    const alice = await login('alice', 'alice-password-1')
    const bob = await login('bob', 'bob-password-01')
    const resourceId = await createResource(alice)
    const attachmentId = (await offer(alice, resourceId)).json().view.attachment.id as string
    await app.inject({
      method: 'PATCH',
      url: `/api/providers/resources/${resourceId}`,
      headers: { cookie: alice },
      payload: { baseUrl: 'https://openrouter.ai/api/v2' },
    })
    const listed = await app.inject({
      method: 'GET',
      url: '/api/s/main/providers/attachments',
      headers: { cookie: bob },
    })
    expect(listed.json()).toMatchObject({
      items: [
        {
          attachment: { state: ATTACHMENT_STATE.pending },
        },
      ],
    })
    expect((await detail(bob, attachmentId)).json()).toMatchObject({
      view: { currentDisclosure: { baseUrl: 'https://openrouter.ai/api/v2' } },
    })
  })

  it('keeps an expired pending offer out of both list and lazy detail', async () => {
    const alice = await login('alice', 'alice-password-1')
    const bob = await login('bob', 'bob-password-01')
    const resourceId = await createResource(alice)
    const attachmentId = (await offer(alice, resourceId)).json().view.attachment.id as string
    const record = await providers.providerAttachments.get(attachmentId)
    providers.injectProviderAttachment({
      ...record!,
      expiresAt: '2026-08-25T11:59:59.999Z',
    })

    const listed = await app.inject({
      method: 'GET',
      url: '/api/s/main/providers/attachments',
      headers: { cookie: bob },
    })
    expect(listed.json()).toMatchObject({ items: [], total: 0, nextCursor: null })
    expect((await detail(bob, attachmentId)).statusCode).toBe(404)
    expect((await accept(bob, attachmentId, 0, null)).statusCode).toBe(409)
  })

  it('retargets a complete reference set and refuses foreign or partial attempts', async () => {
    const alice = await login('alice', 'alice-password-1')
    const bob = await login('bob', 'bob-password-01')
    const credentialId = await createCredential(alice)
    const first = await createResource(alice, { name: 'First', credentialId })
    const second = await createResource(alice, {
      name: 'Second',
      baseUrl: 'https://openrouter.ai/ollama/v1',
      credentialId,
    })
    const attachmentId = (await offer(alice, first)).json().view.attachment.id as string
    expect((await accept(bob, attachmentId, 0, 0)).statusCode).toBe(200)
    const payload = {
      origin: 'https://provider-next.example',
      resources: [
        { id: first, baseUrl: 'https://provider-next.example/api/v1' },
        { id: second, baseUrl: 'https://provider-next.example/ollama/v1' },
      ],
    }

    const foreign = await app.inject({
      method: 'POST',
      url: `/api/providers/credentials/${credentialId}/retarget`,
      headers: { cookie: bob },
      payload,
    })
    expect(foreign.statusCode).toBe(404)

    const partial = await app.inject({
      method: 'POST',
      url: `/api/providers/credentials/${credentialId}/retarget`,
      headers: { cookie: alice },
      payload: { ...payload, resources: payload.resources.slice(0, 1) },
    })
    expect(partial.statusCode).toBe(409)
    expect(partial.json().references).toHaveLength(2)

    const retargeted = await app.inject({
      method: 'POST',
      url: `/api/providers/credentials/${credentialId}/retarget`,
      headers: { cookie: alice },
      payload,
    })
    expect(retargeted.statusCode).toBe(200)
    expect(lookupCalls).toBe(1)
    const retargetedBody = retargeted.json() as {
      credential: Record<string, unknown>
      resources: Array<{ id: string; baseUrl: string; consentEpoch: number }>
    }
    expect(retargetedBody.credential).toMatchObject({
      origin: 'https://provider-next.example',
      consentEpoch: 1,
      runtimeEpoch: 1,
    })
    const resourcesById = new Map(
      retargetedBody.resources.map((resource) => [resource.id, resource]),
    )
    expect(resourcesById.get(first)).toMatchObject({
      baseUrl: 'https://provider-next.example/api/v1',
      consentEpoch: 1,
    })
    expect(resourcesById.get(second)).toMatchObject({
      baseUrl: 'https://provider-next.example/ollama/v1',
      consentEpoch: 1,
    })
    const attachments = await app.inject({
      method: 'GET',
      url: '/api/s/main/providers/attachments',
      headers: { cookie: bob },
    })
    expect(attachments.json()).toMatchObject({
      items: [
        {
          attachment: { id: attachmentId, state: ATTACHMENT_STATE.awaitingReconsent },
        },
      ],
    })
    expect((await detail(bob, attachmentId)).json()).toMatchObject({
      view: { diff: { changed: true } },
    })
  })

  it('aborts retarget admission when the response socket closes after a complete body', async () => {
    await app.close()
    const lookupStarted = deferred()
    let lookupAborted = false

    app = await createApp(
      {
        ...fixture,
        providerRuntime: {
          transport: {
            lookup: async (_hostname, signal) => {
              lookupStarted.resolve()
              await new Promise<void>((_resolve, reject) => {
                signal.addEventListener(
                  'abort',
                  () => {
                    lookupAborted = true
                    reject(signal.reason)
                  },
                  { once: true },
                )
              })
              return []
            },
          },
        },
      },
      {
        onProviderPersistence: (_providers, idOf) => {
          spaceId = idOf('main')
        },
      },
    )
    const alice = await login('alice', 'alice-password-1')
    const credentialId = await createCredential(alice)
    const resourceId = await createResource(alice, { credentialId })

    await app.listen({ port: 0, host: '127.0.0.1' })
    const apiPort = (app.server.address() as AddressInfo).port
    const controller = new AbortController()
    const call = fetch(
      `http://127.0.0.1:${apiPort}/api/providers/credentials/${credentialId}/retarget`,
      {
        method: 'POST',
        headers: { cookie: alice, 'content-type': 'application/json' },
        body: JSON.stringify({
          origin: 'https://provider-next.example',
          resources: [
            {
              id: resourceId,
              baseUrl: 'https://provider-next.example/api/v1',
              detachCredential: false,
            },
          ],
        }),
        signal: controller.signal,
      },
    ).catch((error: unknown) => error)

    await lookupStarted.promise
    controller.abort(new Error('browser closed after sending the request'))
    await call
    await expect.poll(() => lookupAborted).toBe(true)

    const credential = await app.inject({
      method: 'GET',
      url: `/api/providers/credentials/${credentialId}`,
      headers: { cookie: alice },
    })
    expect(credential.json().credential.origin).toBe('https://openrouter.ai')
  })

  it('removes only a departing resource owner grants and rejects an old accept id', async () => {
    const alice = await login('alice', 'alice-password-1')
    const bob = await login('bob', 'bob-password-01')
    const resourceId = await createResource(alice)
    const attachmentId = (await offer(alice, resourceId)).json().view.attachment.id as string
    await accept(bob, attachmentId, 0, null)

    const removeUnrelated = await app.inject({
      method: 'DELETE',
      url: '/api/s/main/members/carol',
      headers: { cookie: bob },
    })
    expect(removeUnrelated.statusCode).toBe(200)
    const beforeOwnerLeaves = await app.inject({
      method: 'GET',
      url: '/api/s/main/providers/attachments',
      headers: { cookie: bob },
    })
    expect(beforeOwnerLeaves.json().total).toBe(1)

    const removeOwner = await app.inject({
      method: 'DELETE',
      url: '/api/s/main/members/alice',
      headers: { cookie: bob },
    })
    expect(removeOwner.statusCode).toBe(200)
    const afterOwnerLeaves = await app.inject({
      method: 'GET',
      url: '/api/s/main/providers/attachments',
      headers: { cookie: bob },
    })
    expect(afterOwnerLeaves.json()).toMatchObject({ items: [], total: 0 })
    expect((await accept(bob, attachmentId, 0, null)).statusCode).toBe(404)
  })

  it('cascades resource delete and leaves the old attachment id unreachable', async () => {
    const alice = await login('alice', 'alice-password-1')
    const bob = await login('bob', 'bob-password-01')
    const resourceId = await createResource(alice)
    const attachmentId = (await offer(alice, resourceId)).json().view.attachment.id as string
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/providers/resources/${resourceId}`,
      headers: { cookie: alice },
    })
    expect(removed.statusCode).toBe(200)
    expect((await accept(bob, attachmentId, 0, null)).statusCode).toBe(404)
  })

  it('bounds a full attachment page and loads the later page without disclosure duplication', async () => {
    const bob = await login('bob', 'bob-password-01')
    const models = Array.from({ length: 200 }, (_, index) => ({
      name: `model-${String(index).padStart(3, '0')}`,
      dimensions: null,
      status: 'available' as const,
    }))

    for (let index = 0; index < 101; index += 1) {
      const suffix = String(index).padStart(3, '0')
      providers.injectProviderResource({
        id: `scale-resource-${suffix}`,
        owner: 'alice',
        name: `Scale resource ${suffix}`,
        wire: 'openai-compatible',
        baseUrl: 'https://provider.example/v1',
        headers: {},
        allowPrivateNetwork: false,
        purposes: ['chat'],
        models,
        defaultModel: null,
        credentialId: null,
        consentEpoch: 0,
        runtimeEpoch: 0,
        disabledAt: null,
        lastCheck: {},
        firstByteTimeoutMs: null,
        callTimeoutMs: null,
      })
      providers.injectProviderAttachment({
        id: `scale-attachment-${suffix}`,
        resourceId: `scale-resource-${suffix}`,
        targetKind: 'space',
        targetId: spaceId,
        targetSpace: spaceId,
        state: ATTACHMENT_STATE.active,
        resourceEpoch: 0,
        credentialEpoch: null,
        disclosure: {
          targetSpace: spaceId,
          resourceOwner: 'alice',
          baseUrl: 'https://provider.example/v1',
          purposes: ['chat'],
          models,
          allowPrivateNetwork: false,
          headerNames: [],
        },
        createdAt: '2026-08-25T00:00:00.000Z',
        expiresAt: '2027-01-01T00:00:00.000Z',
      })
    }

    const first = await app.inject({
      method: 'GET',
      url: '/api/s/main/providers/attachments',
      headers: { cookie: bob },
    })
    expect(first.statusCode).toBe(200)
    const firstPage = first.json() as {
      items: Array<{ attachment: { id: string }; resource: { modelCount: number } }>
      total: number
      nextCursor: string | null
    }
    expect(firstPage.items).toHaveLength(100)
    expect(firstPage.total).toBe(101)
    expect(firstPage.nextCursor).not.toBeNull()
    expect(Buffer.byteLength(first.body)).toBeLessThan(100_000)
    expect(first.body).not.toContain('provider.example')
    expect(first.body).not.toContain('model-000')
    expect(firstPage.items[0]?.resource.modelCount).toBe(200)

    const later = await app.inject({
      method: 'GET',
      url: `/api/s/main/providers/attachments?cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
      headers: { cookie: bob },
    })
    const laterPage = later.json() as typeof firstPage
    expect(laterPage.items).toHaveLength(1)
    expect(laterPage.total).toBe(101)
    expect(laterPage.nextCursor).toBeNull()
    expect(laterPage.items[0]?.attachment.id).not.toBe(firstPage.items.at(-1)?.attachment.id)
  })
})
