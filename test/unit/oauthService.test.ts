import { describe, expect, it } from 'vitest'
import { createOAuthService, type OAuthClientRecord, type OAuthError } from '@notarium/server'

import { InMemoryOAuthPersistence } from '../fake-server/oauthPersistence'

describe('OAuth registration guards', () => {
  it('admits at most two registrations into persistence concurrently', async () => {
    let entered = 0
    let signalEntered!: () => void
    let release!: () => void
    const bothEntered = new Promise<void>((resolve) => {
      signalEntered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    class SlowPersistence extends InMemoryOAuthPersistence {
      override async upsertPendingClient(
        ...args: Parameters<InMemoryOAuthPersistence['upsertPendingClient']>
      ): Promise<boolean> {
        entered++
        if (entered === 2) {
          signalEntered()
        }
        await gate
        return super.upsertPendingClient(...args)
      }
    }

    const oauth = createOAuthService({ store: new SlowPersistence() })
    const register = (suffix: string) =>
      oauth.registerClient({
        redirectUris: [`https://client.example/${suffix}`],
        ip: '192.0.2.1',
      })
    const first = register('one')
    const second = register('two')
    await bothEntered

    try {
      await expect(register('three')).rejects.toMatchObject({
        code: 'temporarily_unavailable',
        status: 429,
      } satisfies Partial<OAuthError>)
    } finally {
      release()
    }
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
  })

  it('bounds and coalesces pre-auth CIMD metadata work', async () => {
    let entered = 0
    let signalEntered!: () => void
    let release!: () => void
    const bothEntered = new Promise<void>((resolve) => {
      signalEntered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const store = new InMemoryOAuthPersistence()
    const activeId = 'https://active.example/metadata.json'
    await store.upsertClient({
      clientId: activeId,
      kind: 'cimd',
      redirectUris: ['https://client.example/callback'],
      clientName: 'Existing integration',
      createdAt: '2020-01-01T00:00:00.000Z',
      lastSeen: '2020-01-01T00:00:00.000Z',
      activatedAt: '2020-01-01T00:00:00.000Z',
    })
    const oauth = createOAuthService({
      store,
      fetchClientMetadata: async (clientId) => {
        entered++
        if (entered === 2) {
          signalEntered()
        }
        await gate
        return {
          client_id: clientId,
          redirect_uris: ['https://client.example/callback'],
        }
      },
    })
    const one = 'https://one.example/metadata.json'
    const first = oauth.resolveClient(one, '192.0.2.1')
    const duplicate = oauth.resolveClient(one, '192.0.2.1')
    const second = oauth.resolveClient('https://two.example/metadata.json', '192.0.2.1')
    await bothEntered
    // Existing integrations use a separate bounded refresh lane: saturated
    // new-client admission must not introduce a grandfathered 429.
    const active = oauth.resolveClient(activeId, '192.0.2.1')

    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(entered).toBe(3)
      await expect(
        oauth.resolveClient('https://three.example/metadata.json', '192.0.2.1'),
      ).rejects.toMatchObject({
        code: 'temporarily_unavailable',
        status: 429,
      } satisfies Partial<OAuthError>)
    } finally {
      release()
    }
    await expect(Promise.all([first, duplicate, second, active])).resolves.toHaveLength(4)
    expect(entered).toBe(3)
  })

  it('queues ordinary activated CIMD overlap without using stale metadata', async () => {
    const store = new InMemoryOAuthPersistence()
    const ids = ['one', 'two', 'three'].map((id) => `https://${id}.example/active.json`)

    for (const clientId of ids) {
      await store.upsertClient({
        clientId,
        kind: 'cimd',
        redirectUris: ['https://client.example/callback'],
        clientName: 'Existing integration',
        createdAt: '2020-01-01T00:00:00.000Z',
        lastSeen: '2020-01-01T00:00:00.000Z',
        activatedAt: '2020-01-01T00:00:00.000Z',
      })
    }
    let entered = 0
    let signalBoth!: () => void
    let release!: () => void
    const bothEntered = new Promise<void>((resolve) => {
      signalBoth = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const oauth = createOAuthService({
      store,
      fetchClientMetadata: async (clientId) => {
        entered++
        if (entered === 2) {
          signalBoth()
        }
        await gate
        return {
          client_id: clientId,
          redirect_uris: ['https://client.example/callback'],
        }
      },
    })
    const refreshes = ids.map((clientId) => oauth.resolveClient(clientId, '192.0.2.1'))
    await bothEntered

    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(entered).toBe(2)
    } finally {
      release()
    }

    await expect(Promise.all(refreshes)).resolves.toHaveLength(3)
    expect(entered).toBe(3)
  })

  it('fails closed when the bounded activated-CIMD refresh queue is full', async () => {
    const store = new InMemoryOAuthPersistence()
    const ids = Array.from({ length: 19 }, (_, index) => `https://active-${index}.example/cimd`)

    for (const clientId of ids) {
      await store.upsertClient({
        clientId,
        kind: 'cimd',
        redirectUris: ['https://client.example/callback'],
        clientName: 'Existing integration',
        createdAt: '2020-01-01T00:00:00.000Z',
        lastSeen: '2020-01-01T00:00:00.000Z',
        activatedAt: '2020-01-01T00:00:00.000Z',
      })
    }
    let entered = 0
    let signalBoth!: () => void
    let release!: () => void
    const bothEntered = new Promise<void>((resolve) => {
      signalBoth = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const oauth = createOAuthService({
      store,
      fetchClientMetadata: async (clientId) => {
        entered++
        if (entered === 2) {
          signalBoth()
        }
        await gate
        return {
          client_id: clientId,
          redirect_uris: ['https://client.example/callback'],
        }
      },
    })
    const admitted = ids.slice(0, 18).map((clientId) => oauth.resolveClient(clientId))
    await bothEntered

    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      await expect(oauth.resolveClient(ids[18])).rejects.toMatchObject({
        code: 'temporarily_unavailable',
        status: 503,
      } satisfies Partial<OAuthError>)
    } finally {
      release()
    }
    await expect(Promise.all(admitted)).resolves.toHaveLength(18)
  })

  it('reports a full pending registry as retryable for a new CIMD client', async () => {
    const store = new InMemoryOAuthPersistence()
    store.upsertPendingClient = async () => false
    const clientId = 'https://client.example/full-registry.json'
    const oauth = createOAuthService({
      store,
      fetchClientMetadata: async () => ({
        client_id: clientId,
        redirect_uris: ['https://client.example/callback'],
      }),
    })

    await expect(oauth.resolveClient(clientId, '192.0.2.1')).rejects.toMatchObject({
      code: 'temporarily_unavailable',
      status: 429,
    } satisfies Partial<OAuthError>)
  })

  it('does not activate an abandoned pending registration after its 24h lease', async () => {
    const store = new InMemoryOAuthPersistence()
    const abandoned: OAuthClientRecord = {
      clientId: 'ntcli_abandoned',
      kind: 'dcr',
      redirectUris: ['https://client.example/callback'],
      clientName: null,
      createdAt: '2026-07-20T11:59:59.000Z',
      lastSeen: '2026-07-20T11:59:59.000Z',
      activatedAt: null,
    }
    await store.upsertClient(abandoned)
    const oauth = createOAuthService({
      store,
      now: () => new Date('2026-07-21T12:00:00.000Z'),
    })

    await expect(oauth.resolveClient(abandoned.clientId)).rejects.toMatchObject({
      code: 'invalid_client',
    } satisfies Partial<OAuthError>)
  })

  it('does not serve an expired pending CIMD client from a recently touched cache row', async () => {
    const store = new InMemoryOAuthPersistence()
    const clientId = 'https://client.example/oauth-metadata.json'
    await store.upsertClient({
      clientId,
      kind: 'cimd',
      redirectUris: ['https://client.example/callback'],
      clientName: 'Old pending client',
      createdAt: '2026-07-20T11:00:00.000Z',
      lastSeen: '2026-07-21T11:30:00.000Z',
      activatedAt: null,
    })
    let fetches = 0
    const oauth = createOAuthService({
      store,
      now: () => new Date('2026-07-21T12:00:00.000Z'),
      fetchClientMetadata: async () => {
        fetches++
        return {
          client_id: clientId,
          redirect_uris: ['https://client.example/callback'],
          client_name: 'Renewed pending client',
        }
      },
    })

    await expect(oauth.resolveClient(clientId)).resolves.toMatchObject({
      clientName: 'Renewed pending client',
      createdAt: '2026-07-21T12:00:00.000Z',
    })
    expect(fetches).toBe(1)
  })

  it('keeps the previous redirect envelope for an activated CIMD refresh', async () => {
    const store = new InMemoryOAuthPersistence()
    const clientId = 'https://client.example/activated-metadata.json'
    const redirects = Array.from(
      { length: 33 },
      (_, index) => `https://client.example/callback/${index}`,
    )
    await store.upsertClient({
      clientId,
      kind: 'cimd',
      redirectUris: redirects,
      clientName: 'Existing CIMD integration',
      createdAt: '2026-07-19T12:00:00.000Z',
      lastSeen: '2026-07-19T12:00:00.000Z',
      activatedAt: '2026-07-19T12:00:00.000Z',
    })
    const oauth = createOAuthService({
      store,
      now: () => new Date('2026-07-21T12:00:00.000Z'),
      fetchClientMetadata: async () => ({
        client_id: clientId,
        redirect_uris: redirects,
        client_name: 'Existing CIMD integration',
      }),
    })

    await expect(oauth.resolveClient(clientId, '192.0.2.1')).resolves.toMatchObject({
      redirectUris: redirects,
      activatedAt: '2026-07-19T12:00:00.000Z',
    })
  })

  it('keeps the original pending lease across fake-persistence metadata refreshes', async () => {
    const store = new InMemoryOAuthPersistence()
    await store.upsertPendingClient(
      {
        clientId: 'https://client.example/lease.json',
        kind: 'cimd',
        redirectUris: ['https://client.example/callback'],
        clientName: 'Initial metadata',
        createdAt: '2026-07-20T00:00:00.000Z',
        lastSeen: '2026-07-20T00:00:00.000Z',
        activatedAt: null,
      },
      10,
      '2026-07-19T00:00:00.000Z',
    )
    await store.upsertPendingClient(
      {
        clientId: 'https://client.example/lease.json',
        kind: 'cimd',
        redirectUris: ['https://client.example/new-callback'],
        clientName: 'Refreshed metadata',
        createdAt: '2026-07-21T00:00:00.000Z',
        lastSeen: '2026-07-21T00:00:00.000Z',
        activatedAt: null,
      },
      10,
      '2026-07-19T00:00:00.000Z',
    )

    expect((await store.getClient('https://client.example/lease.json'))?.createdAt).toBe(
      '2026-07-20T00:00:00.000Z',
    )
    expect(
      await store.activateClient(
        'https://client.example/lease.json',
        '2026-07-21T12:00:00.000Z',
        '2026-07-20T06:00:00.000Z',
      ),
    ).toBe(false)
  })

  it('does not let revoked fake-persistence credentials pin expired pending quota', async () => {
    const store = new InMemoryOAuthPersistence()
    const oldClient: OAuthClientRecord = {
      clientId: 'ntcli_revoked',
      kind: 'dcr',
      redirectUris: ['https://client.example/old'],
      clientName: null,
      createdAt: '2026-07-20T00:00:00.000Z',
      lastSeen: '2026-07-20T00:00:00.000Z',
      activatedAt: null,
    }
    await store.upsertClient(oldClient)
    await store.insertAccess({
      id: 'access',
      tokenHash: 'hash',
      username: 'alice',
      clientId: oldClient.clientId,
      scope: 'read',
      spaces: null,
      expiresAt: '2026-08-01T00:00:00.000Z',
      refreshId: null,
      revokedAt: '2026-07-20T01:00:00.000Z',
      createdAt: '2026-07-20T00:00:00.000Z',
      lastUsedAt: null,
    })

    await expect(
      store.upsertPendingClient(
        {
          ...oldClient,
          clientId: 'ntcli_fresh',
          createdAt: '2026-07-22T00:00:00.000Z',
          lastSeen: '2026-07-22T00:00:00.000Z',
        },
        1,
        '2026-07-21T00:00:00.000Z',
      ),
    ).resolves.toBe(true)
    await expect(store.getClient(oldClient.clientId)).resolves.toBeNull()
  })
})
