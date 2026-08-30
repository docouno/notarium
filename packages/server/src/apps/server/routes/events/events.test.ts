import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { acquireEventSubscriptions, eventsRoutes } from './events'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })

  return { promise, resolve }
}

const apps: ReturnType<typeof Fastify>[] = []
const READY_STATUS = {
  scan: { phase: 'ready', startedAt: null, readyAt: null, error: null },
  delta: { cursor: null, lastPollAt: null, lastChangeAt: null, intervalMs: 0 },
  engine: { indexing: 'unknown' },
  counts: null,
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

const routeHarness = async ({
  boot,
  subscribe,
  registerSse,
  authenticate = async () => ({
    principal: {
      id: 'user:alice',
      username: 'alice',
      admin: false,
      scope: 'write' as const,
      grants: new Map([['active-id', 'owner' as const]]),
      spaces: null,
      system: false,
    },
    viaCookie: true,
  }),
}: {
  boot: Promise<{ syncStatus(): Promise<Record<string, unknown>> }>
  subscribe: (space: string, listener: (event: unknown) => void) => Promise<() => void>
  registerSse: (handle: { close(): void }) => () => void
  authenticate?: () => Promise<{
    principal: {
      id: string
      username: string
      admin: boolean
      scope: 'write'
      grants: Map<string, 'owner'>
      spaces: null
      system: false
    }
    viaCookie: true
  } | null>
}) => {
  const app = Fastify()

  apps.push(app)
  app.addHook('preHandler', async (req) => {
    Object.assign(req, {
      spaceId: 'active-id',
      principal: { id: 'user:alice', username: 'alice', admin: false, grants: [] },
    })
  })
  await eventsRoutes(app, {
    spaces: {
      has: () => true,
      resolveId: () => null,
      subscribe,
    },
    auth: { mode: 'password', authenticate, registerSse },
    spaceStoreFor: () => boot,
  } as unknown as Parameters<typeof eventsRoutes>[1])
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()

  if (!address || typeof address === 'string') {
    throw new Error('event route test server did not bind a TCP port')
  }

  return `http://127.0.0.1:${address.port}/api/s/active/events`
}

describe('event subscription acquisition', () => {
  it('rolls back every acquired bus when a later space fails', async () => {
    const releaseA = vi.fn()
    const failure = new Error('foreign store failed to boot')

    await expect(
      acquireEventSubscriptions(['active', 'foreign'], async (space) => {
        if (space === 'foreign') {
          throw failure
        }

        return releaseA
      }),
    ).rejects.toBe(failure)
    expect(releaseA).toHaveBeenCalledOnce()
  })

  it('releases the just-acquired bus when revoke closes setup in flight', async () => {
    const release = vi.fn()
    let closed = false

    await expect(
      acquireEventSubscriptions(
        ['active'],
        async () => {
          closed = true
          return release
        },
        () => closed,
      ),
    ).rejects.toThrow('closed during subscription setup')
    expect(release).toHaveBeenCalledOnce()
  })

  it('registers the complete SSE handle before the first lazy store boot settles', async () => {
    const boot = deferred<{ syncStatus(): Promise<Record<string, unknown>> }>()
    const subscribe = vi.fn(async () => vi.fn())
    let handle: { close(): void } | null = null
    const registerSse = vi.fn((next: { close(): void }) => {
      handle = next
      return vi.fn()
    })
    const url = await routeHarness({ boot: boot.promise, subscribe, registerSse })
    const responsePromise = fetch(url)

    await vi.waitFor(() => expect(registerSse).toHaveBeenCalledOnce())
    expect(subscribe).not.toHaveBeenCalled()
    ;(handle as { close(): void } | null)?.close()
    boot.resolve({ syncStatus: async () => READY_STATUS })

    const response = await responsePromise

    await expect(response.text()).resolves.toBe('')
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('emits ready only after every authorised bus acquisition completes', async () => {
    const acquisition = deferred<() => void>()
    const subscribe = vi.fn(() => acquisition.promise)
    const url = await routeHarness({
      boot: Promise.resolve({ syncStatus: async () => READY_STATUS }),
      subscribe,
      registerSse: () => vi.fn(),
    })
    let settled = false
    const responsePromise = fetch(url).then((result) => {
      settled = true
      return result
    })

    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(settled).toBe(false)
    acquisition.resolve(vi.fn())
    const response = await responsePromise
    const reader = response.body!.getReader()
    const chunk = await reader.read()

    expect(new TextDecoder().decode(chunk.value)).toContain('event: ready')
    await reader.cancel()
  })

  it('revalidates a revoke that completed after preHandler but before registration', async () => {
    const subscribe = vi.fn(async () => vi.fn())
    const registerSse = vi.fn(() => vi.fn())
    const url = await routeHarness({
      boot: Promise.resolve({ syncStatus: async () => READY_STATUS }),
      subscribe,
      registerSse,
      authenticate: async () => null,
    })
    const response = await fetch(url)

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('')
    expect(registerSse).toHaveBeenCalledOnce()
    expect(subscribe).not.toHaveBeenCalled()
  })
})
