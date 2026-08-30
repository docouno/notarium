import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { performance } from 'node:perf_hooks'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { PROVIDER_DELIVERY_STATE } from '@notarium/contract'

import { PROVIDER_TRANSPORT_ERROR } from './consts'
import { ProviderTransport } from './transport'
import type { ProviderConnectorFactory, ProviderLookup } from './types'

const loopbackLookup: ProviderLookup = async () => [{ address: '127.0.0.1', family: 4 }]

const collect = async (body: AsyncIterable<Uint8Array>): Promise<string> => {
  const chunks: Uint8Array[] = []

  for await (const chunk of body) {
    chunks.push(chunk)
  }

  return Buffer.concat(chunks).toString('utf8')
}

const deferred = <T = void>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const servers: Server[] = []

const listen = async (handler: RequestListener): Promise<{ server: Server; port: number }> => {
  const server = createServer(handler)

  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  return { server, port: (server.address() as AddressInfo).port }
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

describe('provider transport', () => {
  it('pins a locally resolved host while preserving the original Host header', async () => {
    let host = ''
    const { port } = await listen((req, response) => {
      host = req.headers.host ?? ''
      response.end('ok')
    })
    const origin = `http://provider.test:${port}`
    const transport = new ProviderTransport(new Set([origin]), { lookup: loopbackLookup })

    const result = await transport.request(
      {
        principalId: 'owner-1',
        target: `${origin}/v1/chat`,
        trustedOrigin: origin,
        allowPrivateNetwork: true,
        method: 'POST',
        body: '{}',
        stream: false,
        signal: new AbortController().signal,
      },
      ({ body }) => collect(body),
    )

    expect(result).toBe('ok')
    expect(host).toBe(`provider.test:${port}`)
  })

  it('uses the address profile for null timeouts and an explicit override when present', async () => {
    const { port } = await listen((_req, response) => response.end('ok'))
    const origin = `http://provider.test:${port}`
    const transport = new ProviderTransport(new Set([origin]), {
      lookup: loopbackLookup,
      limits: { localFirstByteMs: 1_000, localCallMs: 2_000 },
    })
    const request = (callTimeoutMs: number | null) =>
      transport.request(
        {
          principalId: 'owner-1',
          target: `${origin}/v1/chat`,
          trustedOrigin: origin,
          allowPrivateNetwork: true,
          method: 'POST',
          body: '{}',
          stream: false,
          firstByteTimeoutMs: null,
          callTimeoutMs,
          signal: new AbortController().signal,
        },
        async ({ body, effectiveCallTimeoutMs }) => ({
          body: await collect(body),
          effectiveCallTimeoutMs,
        }),
      )

    await expect(request(null)).resolves.toEqual({ body: 'ok', effectiveCallTimeoutMs: 2_000 })
    await expect(request(750)).resolves.toEqual({ body: 'ok', effectiveCallTimeoutMs: 750 })
  })

  it('passes public HTTPS policy without granting public HTTP', async () => {
    let connectedHost = ''

    const connectorFactory: ProviderConnectorFactory = () => (options, callback) => {
      connectedHost = options.hostname
      callback(new Error('test connector stopped before network'), null)
    }
    const lookup: ProviderLookup = async () => [{ address: '203.0.113.10', family: 4 }]
    const httpsTransport = new ProviderTransport(new Set(), { lookup, connectorFactory })

    await expect(
      httpsTransport.request(
        {
          principalId: 'owner-1',
          target: 'https://api.vendor.test/v1/chat',
          trustedOrigin: 'https://api.vendor.test',
          allowPrivateNetwork: false,
          method: 'POST',
          stream: false,
          signal: new AbortController().signal,
        },
        ({ body }) => collect(body),
      ),
    ).rejects.toMatchObject({
      code: PROVIDER_TRANSPORT_ERROR.networkError,
      deliveryState: PROVIDER_DELIVERY_STATE.notSent,
    })
    expect(connectedHost).toBe('api.vendor.test')

    const httpTransport = new ProviderTransport(new Set(), { lookup, connectorFactory })
    await expect(
      httpTransport.request(
        {
          principalId: 'owner-1',
          target: 'http://api.vendor.test/v1/chat',
          trustedOrigin: 'http://api.vendor.test',
          allowPrivateNetwork: false,
          method: 'POST',
          stream: false,
          signal: new AbortController().signal,
        },
        ({ body }) => collect(body),
      ),
    ).rejects.toMatchObject({ code: PROVIDER_TRANSPORT_ERROR.policyDenied })
  })

  it.each(['198.18.0.1', 'fec0::1'])(
    'requires exact private admission for special-use unicast %s',
    async (address) => {
      const origin = 'https://api.vendor.test'
      const lookup: ProviderLookup = async () => [
        { address, family: address.includes(':') ? 6 : 4 },
      ]
      const denied = new ProviderTransport(new Set(), { lookup })

      await expect(
        denied.admit({
          target: `${origin}/v1/chat`,
          trustedOrigin: origin,
          allowPrivateNetwork: false,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: PROVIDER_TRANSPORT_ERROR.policyDenied })

      const admitted = new ProviderTransport(new Set([origin]), { lookup })
      await expect(
        admitted.admit({
          target: `${origin}/v1/chat`,
          trustedOrigin: origin,
          allowPrivateNetwork: true,
          signal: new AbortController().signal,
        }),
      ).resolves.toBe('private')
    },
  )

  it.each(['0.0.0.0', '224.0.0.1', '::', 'ff02::1'])(
    'always denies non-unicast address %s even with private admission',
    async (address) => {
      const origin = 'https://api.vendor.test'
      const transport = new ProviderTransport(new Set([origin]), {
        lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
      })

      await expect(
        transport.admit({
          target: `${origin}/v1/chat`,
          trustedOrigin: origin,
          allowPrivateNetwork: true,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: PROVIDER_TRANSPORT_ERROR.policyDenied })
    },
  )

  it('checks embedded IPv4 semantics without rewriting the pinned NAT64 address', async () => {
    let pinned = ''

    const connectorFactory: ProviderConnectorFactory =
      ({ addresses }) =>
      (_options, callback) => {
        pinned = addresses[0].address
        callback(new Error('test connector stopped before network'), null)
      }
    const transport = new ProviderTransport(new Set(), {
      lookup: async () => [{ address: '64:ff9b::203.0.113.10', family: 6 }],
      connectorFactory,
    })

    await expect(
      transport.request(
        {
          principalId: 'owner-1',
          target: 'https://api.vendor.test/v1/chat',
          trustedOrigin: 'https://api.vendor.test',
          allowPrivateNetwork: false,
          method: 'POST',
          stream: false,
          signal: new AbortController().signal,
        },
        ({ body }) => collect(body),
      ),
    ).rejects.toMatchObject({ code: PROVIDER_TRANSPORT_ERROR.networkError })
    expect(pinned).toBe('64:ff9b::203.0.113.10')
  })

  it('requires both exact operator admission and resource opt-in for private targets', async () => {
    let connectorCalls = 0

    const connectorFactory: ProviderConnectorFactory = () => (_options, callback) => {
      connectorCalls += 1
      callback(new Error('stop'), null)
    }
    const base = {
      principalId: 'owner-1',
      target: 'http://provider.test:11434/api/tags',
      trustedOrigin: 'http://provider.test:11434',
      method: 'GET',
      stream: false,
      signal: new AbortController().signal,
    } as const

    for (const [origins, optIn] of [
      [new Set<string>(), true],
      [new Set(['http://provider.test:11435']), true],
      [new Set(['https://provider.test:11434']), true],
      [new Set(['http://provider.test:11434']), false],
    ] as const) {
      const transport = new ProviderTransport(origins, { lookup: loopbackLookup, connectorFactory })

      await expect(
        transport.request({ ...base, allowPrivateNetwork: optIn }, ({ body }) => collect(body)),
      ).rejects.toMatchObject({ code: PROVIDER_TRANSPORT_ERROR.policyDenied })
    }
    expect(connectorCalls).toBe(0)

    const admitted = new ProviderTransport(new Set(['http://provider.test:11434']), {
      lookup: loopbackLookup,
      connectorFactory,
    })
    await expect(
      admitted.request({ ...base, allowPrivateNetwork: true }, ({ body }) => collect(body)),
    ).rejects.toMatchObject({ code: PROVIDER_TRANSPORT_ERROR.networkError })
    expect(connectorCalls).toBe(1)
  })

  it('denies another target origin, mixed classes, and always-denied metadata', async () => {
    let connectorCalls = 0

    const connectorFactory: ProviderConnectorFactory = () => (_options, callback) => {
      connectorCalls += 1
      callback(new Error('stop'), null)
    }
    const request = (transport: ProviderTransport, overrides: Record<string, unknown> = {}) =>
      transport.request(
        {
          principalId: 'owner-1',
          target: 'http://provider.test:11434/api/tags',
          trustedOrigin: 'http://provider.test:11434',
          allowPrivateNetwork: true,
          method: 'GET',
          stream: false,
          signal: new AbortController().signal,
          ...overrides,
        },
        ({ body }) => collect(body),
      )
    const admitted = new Set(['http://provider.test:11434'])

    await expect(
      request(new ProviderTransport(admitted, { lookup: loopbackLookup, connectorFactory }), {
        target: 'http://provider.test:11435/api/tags',
      }),
    ).rejects.toMatchObject({ code: PROVIDER_TRANSPORT_ERROR.policyDenied })

    const mixed: ProviderLookup = async () => [
      { address: '127.0.0.1', family: 4 },
      { address: '203.0.113.10', family: 4 },
    ]
    await expect(
      request(new ProviderTransport(admitted, { lookup: mixed, connectorFactory })),
    ).rejects.toMatchObject({ code: PROVIDER_TRANSPORT_ERROR.policyDenied })

    const metadata: ProviderLookup = async () => [{ address: '::ffff:168.63.129.16', family: 6 }]
    await expect(
      request(new ProviderTransport(admitted, { lookup: metadata, connectorFactory })),
    ).rejects.toMatchObject({ code: PROVIDER_TRANSPORT_ERROR.policyDenied })
    expect(connectorCalls).toBe(0)
  })

  it('treats an unresolved hostname as fail-closed policy, not private admission', async () => {
    const transport = new ProviderTransport(new Set(['http://missing.test:11434']), {
      lookup: async () => {
        throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' })
      },
    })

    await expect(
      transport.request(
        {
          principalId: 'owner-1',
          target: 'http://missing.test:11434/api/tags',
          trustedOrigin: 'http://missing.test:11434',
          allowPrivateNetwork: true,
          method: 'GET',
          stream: false,
          signal: new AbortController().signal,
        },
        ({ body }) => collect(body),
      ),
    ).rejects.toMatchObject({ code: PROVIDER_TRANSPORT_ERROR.policyDenied })
  })

  it('does not follow redirects', async () => {
    let redirectedHits = 0
    const redirected = await listen((_req, response) => {
      redirectedHits += 1
      response.end('followed')
    })
    const source = await listen((_req, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${redirected.port}/stolen` })
      response.end()
    })
    const origin = `http://provider.test:${source.port}`
    const transport = new ProviderTransport(new Set([origin]), { lookup: loopbackLookup })

    await expect(
      transport.request(
        {
          principalId: 'owner-1',
          target: `${origin}/redirect`,
          trustedOrigin: origin,
          allowPrivateNetwork: true,
          method: 'GET',
          stream: false,
          signal: new AbortController().signal,
        },
        ({ body }) => collect(body),
      ),
    ).rejects.toMatchObject({ code: PROVIDER_TRANSPORT_ERROR.redirectDenied })
    expect(redirectedHits).toBe(0)
  })

  it('caps outgoing bodies and user-controlled headers before connecting', async () => {
    let connectorCalls = 0

    const connectorFactory: ProviderConnectorFactory = () => (_options, callback) => {
      connectorCalls += 1
      callback(new Error('stop'), null)
    }
    const base = {
      principalId: 'owner-1',
      target: 'http://provider.test:11434/api/tags',
      trustedOrigin: 'http://provider.test:11434',
      allowPrivateNetwork: true,
      method: 'POST',
      stream: false,
      signal: new AbortController().signal,
    } as const
    const create = (limits: {
      requestBytes?: number
      headerCount?: number
      headerBytes?: number
    }) =>
      new ProviderTransport(new Set(['http://provider.test:11434']), {
        lookup: loopbackLookup,
        connectorFactory,
        limits,
      })

    await expect(
      create({ requestBytes: 4 }).request({ ...base, body: '12345' }, ({ body }) => collect(body)),
    ).rejects.toMatchObject({ code: PROVIDER_TRANSPORT_ERROR.requestTooLarge })
    await expect(
      create({ headerCount: 1 }).request({ ...base, headers: { one: '1', two: '2' } }, ({ body }) =>
        collect(body),
      ),
    ).rejects.toMatchObject({ code: PROVIDER_TRANSPORT_ERROR.headersTooLarge })
    await expect(
      create({ headerBytes: 4 }).request({ ...base, headers: { name: 'value' } }, ({ body }) =>
        collect(body),
      ),
    ).rejects.toMatchObject({ code: PROVIDER_TRANSPORT_ERROR.headersTooLarge })
    await expect(
      create({}).request({ ...base, headers: { Host: 'evil.test' } }, ({ body }) => collect(body)),
    ).rejects.toMatchObject({ code: PROVIDER_TRANSPORT_ERROR.invalidRequest })
    expect(connectorCalls).toBe(0)
  })

  it('counts response limits after decompression', async () => {
    const expanded = 'x'.repeat(1024)
    const compressed = gzipSync(expanded)
    const { port } = await listen((_req, response) => {
      response.writeHead(200, {
        'content-encoding': 'gzip',
        'content-length': compressed.byteLength,
      })
      response.end(compressed)
    })
    const origin = `http://provider.test:${port}`
    const transport = new ProviderTransport(new Set([origin]), {
      lookup: loopbackLookup,
      limits: { nonStreamResponseBytes: 128 },
    })

    await expect(
      transport.request(
        {
          principalId: 'owner-1',
          target: `${origin}/bomb`,
          trustedOrigin: origin,
          allowPrivateNetwork: true,
          method: 'GET',
          stream: false,
          signal: new AbortController().signal,
        },
        ({ body }) => collect(body),
      ),
    ).rejects.toMatchObject({ code: PROVIDER_TRANSPORT_ERROR.responseTooLarge })
  })

  it('caps a chunked body with no Content-Length', async () => {
    const { port } = await listen((_req, response) => {
      response.write(Buffer.alloc(256, 1))
    })
    const origin = `http://provider.test:${port}`
    const transport = new ProviderTransport(new Set([origin]), {
      lookup: loopbackLookup,
      limits: { nonStreamResponseBytes: 128, localCallMs: 500 },
    })

    await expect(
      transport.request(
        {
          principalId: 'owner-1',
          target: `${origin}/endless`,
          trustedOrigin: origin,
          allowPrivateNetwork: true,
          method: 'GET',
          stream: false,
          signal: new AbortController().signal,
        },
        ({ body }) => collect(body),
      ),
    ).rejects.toMatchObject({ code: PROVIDER_TRANSPORT_ERROR.responseTooLarge })
  })

  it('distinguishes first-byte and total-call timeouts', async () => {
    const firstByte = await listen((_req, response) => {
      response.flushHeaders()
    })
    const firstOrigin = `http://provider.test:${firstByte.port}`
    const firstTransport = new ProviderTransport(new Set([firstOrigin]), {
      lookup: loopbackLookup,
      limits: { localFirstByteMs: 20, localCallMs: 200 },
    })

    await expect(
      firstTransport.request(
        {
          principalId: 'owner-1',
          target: `${firstOrigin}/slow-first-byte`,
          trustedOrigin: firstOrigin,
          allowPrivateNetwork: true,
          method: 'GET',
          stream: true,
          signal: new AbortController().signal,
        },
        ({ body }) => collect(body),
      ),
    ).rejects.toMatchObject({
      code: PROVIDER_TRANSPORT_ERROR.firstByteTimeout,
      deliveryState: PROVIDER_DELIVERY_STATE.mayHaveSent,
    })

    const total = await listen((_req, response) => {
      response.write('first')
    })
    const totalOrigin = `http://provider.test:${total.port}`
    const totalTransport = new ProviderTransport(new Set([totalOrigin]), {
      lookup: loopbackLookup,
      limits: { localFirstByteMs: 100, localCallMs: 25 },
    })

    await expect(
      totalTransport.request(
        {
          principalId: 'owner-1',
          target: `${totalOrigin}/endless`,
          trustedOrigin: totalOrigin,
          allowPrivateNetwork: true,
          method: 'GET',
          stream: true,
          signal: new AbortController().signal,
        },
        ({ body }) => collect(body),
      ),
    ).rejects.toMatchObject({
      code: PROVIDER_TRANSPORT_ERROR.callTimeout,
      deliveryState: PROVIDER_DELIVERY_STATE.mayHaveSent,
    })
  })

  it('returns on caller abort during lookup without starting connect', async () => {
    const pending = deferred<readonly { address: string; family: 4 }[]>()
    const controller = new AbortController()
    let connectorCalls = 0
    const transport = new ProviderTransport(new Set(['http://provider.test:11434']), {
      lookup: () => pending.promise,
      connectorFactory: () => (_options, callback) => {
        connectorCalls += 1
        callback(new Error('stop'), null)
      },
    })
    const call = transport.request(
      {
        principalId: 'owner-1',
        target: 'http://provider.test:11434/api/tags',
        trustedOrigin: 'http://provider.test:11434',
        allowPrivateNetwork: true,
        method: 'GET',
        stream: false,
        signal: controller.signal,
      },
      ({ body }) => collect(body),
    )

    controller.abort(new Error('tab closed'))
    await expect(call).rejects.toMatchObject({ code: PROVIDER_TRANSPORT_ERROR.canceled })
    expect(connectorCalls).toBe(0)
  })

  it('applies the first-byte budget to lookup as part of the network pipeline', async () => {
    const transport = new ProviderTransport(new Set(['http://provider.test:11434']), {
      lookup: async () => new Promise(() => {}),
      limits: { localFirstByteMs: 20, localCallMs: 100 },
    })

    await expect(
      transport.request(
        {
          principalId: 'owner-1',
          target: 'http://provider.test:11434/api/tags',
          trustedOrigin: 'http://provider.test:11434',
          allowPrivateNetwork: true,
          method: 'GET',
          stream: false,
          signal: new AbortController().signal,
        },
        ({ body }) => collect(body),
      ),
    ).rejects.toMatchObject({ code: PROVIDER_TRANSPORT_ERROR.firstByteTimeout })
  })

  it('passes caller abort into connect and does not wait for a connector timeout', async () => {
    const controller = new AbortController()
    const entered = deferred()

    const connectorFactory: ProviderConnectorFactory =
      ({ signal }) =>
      (_options, callback) => {
        entered.resolve()
        signal.addEventListener('abort', () => callback(signal.reason as Error, null), {
          once: true,
        })
      }
    const transport = new ProviderTransport(new Set(['http://provider.test:11434']), {
      lookup: loopbackLookup,
      connectorFactory,
    })
    const call = transport.request(
      {
        principalId: 'owner-1',
        target: 'http://provider.test:11434/api/tags',
        trustedOrigin: 'http://provider.test:11434',
        allowPrivateNetwork: true,
        method: 'GET',
        stream: false,
        signal: controller.signal,
      },
      ({ body }) => collect(body),
    )

    await entered.promise
    controller.abort(new Error('tab closed'))
    await expect(call).rejects.toMatchObject({ code: PROVIDER_TRANSPORT_ERROR.canceled })
  })

  it('closes the upstream body when the caller aborts mid-stream', async () => {
    const upstreamClosed = deferred()
    const { port } = await listen((_req, response) => {
      response.once('close', () => upstreamClosed.resolve())
      response.write('first')
    })
    const origin = `http://provider.test:${port}`
    const controller = new AbortController()
    const transport = new ProviderTransport(new Set([origin]), { lookup: loopbackLookup })
    const call = transport.request(
      {
        principalId: 'owner-1',
        target: `${origin}/stream`,
        trustedOrigin: origin,
        allowPrivateNetwork: true,
        method: 'GET',
        stream: true,
        signal: controller.signal,
      },
      async ({ body }) => {
        for await (const chunk of body) {
          expect(chunk.byteLength).toBeGreaterThan(0)
          controller.abort(new Error('tab closed'))
        }
      },
    )

    await expect(call).rejects.toMatchObject({ code: PROVIDER_TRANSPORT_ERROR.canceled })
    await upstreamClosed.promise
  })

  it('limits concurrent calls per principal and removes an aborted waiter', async () => {
    const pending: Array<(error: Error, socket: null) => void> = []
    let connectorCalls = 0

    const connectorFactory: ProviderConnectorFactory = () => (_options, callback) => {
      connectorCalls += 1
      pending.push((error, socket) => callback(error, socket))
    }
    const transport = new ProviderTransport(new Set(['http://provider.test:11434']), {
      lookup: loopbackLookup,
      connectorFactory,
      limits: { concurrentPerPrincipal: 4 },
    })
    const controllers = Array.from({ length: 5 }, () => new AbortController())
    const calls = controllers.map((controller) =>
      transport
        .request(
          {
            principalId: 'owner-1',
            target: 'http://provider.test:11434/api/tags',
            trustedOrigin: 'http://provider.test:11434',
            allowPrivateNetwork: true,
            method: 'GET',
            stream: false,
            signal: controller.signal,
          },
          ({ body }) => collect(body),
        )
        .catch((error) => error),
    )

    await expect.poll(() => connectorCalls).toBe(4)
    controllers[4].abort(new Error('queued call canceled'))
    await expect(calls[4]).resolves.toMatchObject({ code: PROVIDER_TRANSPORT_ERROR.canceled })
    expect(connectorCalls).toBe(4)
    for (const finish of pending) {
      finish(new Error('stop'), null)
    }
    await Promise.all(calls.slice(0, 4))
  })

  it('counts concurrency wait inside the call deadline and bounds the queue', async () => {
    const connectorFactory: ProviderConnectorFactory =
      ({ signal }) =>
      (_options, callback) => {
        signal.addEventListener('abort', () => callback(signal.reason as Error, null), {
          once: true,
        })
      }
    const transport = new ProviderTransport(new Set(['http://provider.test:11434']), {
      lookup: loopbackLookup,
      connectorFactory,
      limits: {
        concurrentPerPrincipal: 1,
        queuedPerPrincipal: 1,
        localFirstByteMs: 100,
        localCallMs: 50,
      },
    })
    const request = () =>
      transport.request(
        {
          principalId: 'owner-1',
          target: 'http://provider.test:11434/api/tags',
          trustedOrigin: 'http://provider.test:11434',
          allowPrivateNetwork: true,
          method: 'GET',
          stream: false,
          signal: new AbortController().signal,
        },
        ({ body }) => collect(body),
      )
    const startedAt = performance.now()
    const active = request().catch((error) => error)
    const queued = request().catch((error) => error)
    const overflow = request().catch((error) => error)

    await expect(overflow).resolves.toMatchObject({ code: PROVIDER_TRANSPORT_ERROR.callTimeout })
    await expect(queued).resolves.toMatchObject({ code: PROVIDER_TRANSPORT_ERROR.callTimeout })
    expect(performance.now() - startedAt).toBeLessThan(90)
    await active
  })
})
