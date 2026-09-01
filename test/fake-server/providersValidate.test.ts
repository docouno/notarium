import type { FastifyInstance } from 'fastify'
import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { createApp, type Fixture } from './app'
import { InMemoryProviderCallLog } from './providerCallLog'

const servers: Server[] = []
let app: FastifyInstance | undefined

const deferred = <T = void>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const listen = async (handler: RequestListener): Promise<number> => {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return (server.address() as AddressInfo).port
}

const json = (response: Parameters<RequestListener>[1], status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

const fixture = (port: number, over: Partial<Fixture> = {}): Fixture => ({
  spaces: [{ slug: 'main', displayName: 'Main', notes: [] }],
  capabilities: { providers: true },
  providerPrivateOrigins: [`http://provider.test:${port}`],
  providerRuntime: { transport: { lookup: async () => [{ address: '127.0.0.1', family: 4 }] } },
  auth: {
    users: [
      { username: 'alice', password: 'alice-password-1', admin: true },
      { username: 'bob', password: 'bob-password-01', admin: true },
    ],
    members: [{ space: 'main', username: 'alice', role: 'owner' }],
  },
  ...over,
})

afterEach(async () => {
  await app?.close()
  app = undefined
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

const login = async (instance: FastifyInstance, username: string, password: string) => {
  const response = await instance.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  })
  expect(response.statusCode).toBe(200)
  return (response.headers['set-cookie'] as string).split(';')[0]
}

const createResource = (
  instance: FastifyInstance,
  cookie: string,
  port: number,
  over: Record<string, unknown> = {},
) =>
  instance.inject({
    method: 'POST',
    url: '/api/providers/resources',
    headers: { cookie },
    payload: {
      name: 'Local runtime',
      wire: 'openai-compatible',
      baseUrl: `http://provider.test:${port}/api/v1`,
      allowPrivateNetwork: true,
      models: [{ name: 'local/model', capabilities: ['completion'] }],
      ...over,
    },
  })

describe('provider validate REST surface', () => {
  it('aborts the upstream call when the response socket closes after a complete body', async () => {
    const upstreamStarted = deferred()
    const upstreamClosed = deferred()
    const port = await listen((request, response) => {
      request.resume()
      upstreamStarted.resolve()
      const fallback = setTimeout(() => {
        if (!response.destroyed) {
          json(response, 200, {
            choices: [{ message: { content: 'late' }, finish_reason: 'stop' }],
          })
        }
      }, 1_000)

      response.once('close', () => {
        clearTimeout(fallback)
        upstreamClosed.resolve()
      })
    })
    app = await createApp(fixture(port))
    const cookie = await login(app, 'alice', 'alice-password-1')
    const id = (await createResource(app, cookie, port)).json().resource.id as string

    await app.listen({ port: 0, host: '127.0.0.1' })
    const apiPort = (app.server.address() as AddressInfo).port
    const controller = new AbortController()
    const call = fetch(`http://127.0.0.1:${apiPort}/api/providers/resources/${id}/validate`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'completion' }),
      signal: controller.signal,
    }).catch((error: unknown) => error)

    await upstreamStarted.promise
    controller.abort(new Error('browser closed after sending the request'))
    await call
    const closedBeforeFallback = await Promise.race([
      upstreamClosed.promise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
    ])

    expect(closedBeforeFallback).toBe(true)
  })

  it('makes a real outbound call and records the outcome by purpose', async () => {
    const seen: string[] = []
    const port = await listen((request, response) => {
      seen.push(`${request.method} ${request.url}`)
      json(response, 200, { choices: [{ message: { content: 'ok' }, finish_reason: 'length' }] })
    })
    app = await createApp(fixture(port))
    const cookie = await login(app, 'alice', 'alice-password-1')
    const id = (await createResource(app, cookie, port)).json().resource.id as string
    const validated = await app.inject({
      method: 'POST',
      url: `/api/providers/resources/${id}/validate`,
      headers: { cookie },
      payload: { capability: 'completion' },
    })

    expect(seen).toEqual(['POST /api/v1/chat/completions'])
    expect(validated.statusCode).toBe(200)
    expect(validated.json()).toMatchObject({
      capability: 'completion',
      saved: true,
      result: { status: 'ready', credentialProven: true, diagnostic: null },
      resource: { lastCheck: { completion: { status: 'ready' } } },
    })
    const reread = await app.inject({
      method: 'GET',
      url: `/api/providers/resources/${id}`,
      headers: { cookie },
    })
    expect(reread.json().resource.lastCheck.completion).toMatchObject({ status: 'ready' })
  })

  it('classifies a corrupted credential as a class, not as a raw 4xx', async () => {
    const port = await listen((_request, response) => {
      json(response, 401, { error: { message: 'No auth credentials found' } })
    })
    app = await createApp(fixture(port))
    const cookie = await login(app, 'alice', 'alice-password-1')
    const id = (await createResource(app, cookie, port)).json().resource.id as string
    const validated = await app.inject({
      method: 'POST',
      url: `/api/providers/resources/${id}/validate`,
      headers: { cookie },
      payload: { capability: 'completion' },
    })

    expect(validated.statusCode).toBe(200)
    expect(validated.json().result).toMatchObject({ status: 'credential-rejected' })
  })

  it('journals both a successful click and the refusal that follows it', async () => {
    const ANSWER = 'the model answered with these exact words'
    let reject = false
    const port = await listen((_request, response) => {
      if (reject) {
        json(response, 401, { error: { message: 'No auth credentials found' } })
        return
      }
      json(response, 200, {
        choices: [{ message: { content: ANSWER }, finish_reason: 'length' }],
      })
    })
    const callLog = new InMemoryProviderCallLog()
    app = await createApp(fixture(port), { providerCallLog: callLog })
    const cookie = await login(app, 'alice', 'alice-password-1')
    const id = (await createResource(app, cookie, port)).json().resource.id as string
    const validate = () =>
      app!.inject({
        method: 'POST',
        url: `/api/providers/resources/${id}/validate`,
        headers: { cookie },
        payload: { capability: 'completion' },
      })

    await validate()
    reject = true
    await validate()

    // Two clicks, two rows — and the second one is the REFUSAL, which the donor
    // genre would not have recorded at all: it wrote only after a handler succeeded.
    expect(callLog.snapshot()).toMatchObject([
      {
        owner: 'alice',
        principal: 'user:alice',
        resourceId: id,
        host: `provider.test:${port}`,
        spaces: [],
        jobId: null,
        deliveryState: 'sent',
        outcome: 'ok',
        retrySafe: false,
      },
      { resourceId: id, deliveryState: 'sent', outcome: 'credential-rejected', retrySafe: false },
    ])
    // The audit of who called what, not a second store of what was said: the answer
    // the provider gave is nowhere in it, because no field could hold it.
    expect(JSON.stringify(callLog.snapshot())).not.toContain(ANSWER)
  })

  it('separates the Notarium window from a provider 429 on the REST wire and journal', async () => {
    let providerLimited = false
    let requests = 0
    const port = await listen((_request, response) => {
      requests += 1
      if (providerLimited) {
        json(response, 429, {
          error: { message: 'slow down', metadata: { error_type: 'rate_limit_exceeded' } },
        })
        return
      }
      json(response, 200, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })
    })
    const callLog = new InMemoryProviderCallLog()
    app = await createApp(fixture(port), { providerCallLog: callLog })
    const cookie = await login(app, 'alice', 'alice-password-1')
    const credential = await app.inject({
      method: 'POST',
      url: '/api/providers/credentials',
      headers: { cookie },
      payload: {
        name: 'Tiny token budget',
        kind: 'bearer',
        secret: 'sk-window-test-value',
        origin: `http://provider.test:${port}`,
        injection: { header: '', prefix: 'Bearer ' },
        rpm: 100,
        tpm: 1,
      },
    })
    const id = (
      await createResource(app, cookie, port, {
        credentialId: credential.json().credential.id,
      })
    ).json().resource.id as string
    const validate = (resourceId: string, signal?: AbortSignal) =>
      app!.inject({
        method: 'POST',
        url: `/api/providers/resources/${resourceId}/validate`,
        headers: { cookie },
        payload: { capability: 'completion' },
        signal,
      })

    const ours = await validate(id)

    expect(ours.statusCode).toBe(200)
    expect(ours.json().result.status).toBe('notarium-rate-limited')
    expect(requests).toBe(0)

    const roomyCredential = await app.inject({
      method: 'POST',
      url: '/api/providers/credentials',
      headers: { cookie },
      payload: {
        name: 'Provider-limited',
        kind: 'bearer',
        secret: 'sk-provider-limit-value',
        origin: `http://provider.test:${port}`,
        injection: { header: '', prefix: 'Bearer ' },
        rpm: 100,
      },
    })
    const roomyId = (
      await createResource(app, cookie, port, {
        name: 'Provider-limited runtime',
        credentialId: roomyCredential.json().credential.id,
      })
    ).json().resource.id as string
    providerLimited = true
    const theirs = await validate(roomyId)

    expect(theirs.statusCode).toBe(200)
    expect(theirs.json().result.status).toBe('provider-rate-limited')
    expect(callLog.snapshot().map((row) => [row.deliveryState, row.outcome])).toEqual([
      ['not-sent', 'notarium-rate-limited'],
      ['sent', 'provider-rate-limited'],
    ])
  })

  it('keeps the credential out of the outcome it persists, and bounds its length', async () => {
    const secret = 'sk-"stand-secret-value-0001'
    const port = await listen((request, response) => {
      // A debugging proxy that echoes request headers in its error body is ordinary
      // behaviour, and `lastCheck` is an INCOMING channel: it is persisted and handed
      // to everyone who can see the resource.
      json(response, 500, {
        error: {
          message: `upstream rejected ${request.headers['x-api-key'] ?? ''}; raw=${secret} ${'x'.repeat(4000)}`,
        },
      })
    })
    app = await createApp(fixture(port))
    const cookie = await login(app, 'alice', 'alice-password-1')
    const credential = await app.inject({
      method: 'POST',
      url: '/api/providers/credentials',
      headers: { cookie },
      payload: {
        name: 'Local key',
        kind: 'bearer',
        secret,
        origin: `http://provider.test:${port}`,
        injection: { header: 'x-api-key', prefix: 'key=' },
      },
    })
    expect(credential.statusCode).toBe(200)
    const created = await app.inject({
      method: 'POST',
      url: '/api/providers/resources',
      headers: { cookie },
      payload: {
        name: 'Local runtime',
        wire: 'openai-compatible',
        baseUrl: `http://provider.test:${port}/api/v1`,
        allowPrivateNetwork: true,
        credentialId: credential.json().credential.id,
        models: [{ name: 'local/model', capabilities: ['completion'] }],
      },
    })
    const id = created.json().resource.id as string
    const validated = await app.inject({
      method: 'POST',
      url: `/api/providers/resources/${id}/validate`,
      headers: { cookie },
      payload: { capability: 'completion' },
    })

    expect(validated.statusCode).toBe(200)
    expect(validated.body).not.toContain(secret)
    expect(validated.body).not.toContain(JSON.stringify(secret).slice(1, -1))
    expect(validated.json().result.diagnostic).toContain('[redacted]')
    // Bounded BEFORE the write, not at display time.
    expect(validated.json().result.diagnostic.length).toBeLessThanOrEqual(512)
    const reread = await app.inject({
      method: 'GET',
      url: `/api/providers/resources/${id}`,
      headers: { cookie },
    })
    expect(reread.body).not.toContain(secret)
    expect(reread.body).not.toContain(JSON.stringify(secret).slice(1, -1))
    expect(reread.json().resource.lastCheck.completion.diagnostic.length).toBeLessThanOrEqual(512)
  })

  it('is unreachable to a write PAT and to a host admin who is not the owner', async () => {
    let requests = 0
    const port = await listen((_request, response) => {
      requests += 1
      json(response, 200, { choices: [{ message: { content: 'ok' }, finish_reason: 'length' }] })
    })
    app = await createApp(fixture(port))
    const cookie = await login(app, 'alice', 'alice-password-1')
    const id = (await createResource(app, cookie, port)).json().resource.id as string
    const pat = await app.inject({
      method: 'POST',
      url: '/api/me/tokens',
      headers: { cookie },
      payload: { name: 'provider-validate', scope: 'write' },
    })
    expect(pat.statusCode).toBe(201)

    // `self:manage` is above any token's ceiling, so the route is session-only
    // without a principal sniff — an agent cannot burn the owner's key.
    const byToken = await app.inject({
      method: 'POST',
      url: `/api/providers/resources/${id}/validate`,
      headers: { authorization: `Bearer ${pat.json().token}` },
      payload: { capability: 'completion' },
    })
    expect(byToken.statusCode).toBe(404)

    const byAdmin = await app.inject({
      method: 'POST',
      url: `/api/providers/resources/${id}/validate`,
      headers: { cookie: await login(app, 'bob', 'bob-password-01') },
      payload: { capability: 'completion' },
    })
    expect(byAdmin.statusCode).toBe(404)
    expect(requests).toBe(0)
  })

  it('refuses an undeclared purpose and a malformed body without calling out', async () => {
    let requests = 0
    const port = await listen((_request, response) => {
      requests += 1
      json(response, 200, { choices: [{ message: { content: 'ok' }, finish_reason: 'length' }] })
    })
    app = await createApp(fixture(port))
    const cookie = await login(app, 'alice', 'alice-password-1')
    const id = (await createResource(app, cookie, port)).json().resource.id as string

    for (const payload of [{ capability: 'embedding' }, { capability: 'nonsense' }, {}]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/providers/resources/${id}/validate`,
        headers: { cookie },
        payload,
      })
      expect(response.statusCode).toBe(400)
    }
    expect(requests).toBe(0)
  })

  it('stops the twenty-first call in the hour with a retry hint', async () => {
    const port = await listen((_request, response) => {
      json(response, 200, { choices: [{ message: { content: 'ok' }, finish_reason: 'length' }] })
    })
    app = await createApp(fixture(port))
    const cookie = await login(app, 'alice', 'alice-password-1')
    const credential = await app.inject({
      method: 'POST',
      url: '/api/providers/credentials',
      headers: { cookie },
      payload: {
        name: 'Room for the host cap',
        kind: 'bearer',
        secret: 'sk-host-cap-test-value',
        origin: `http://provider.test:${port}`,
        injection: { header: '', prefix: 'Bearer ' },
        rpm: 100,
      },
    })
    const id = (
      await createResource(app, cookie, port, {
        credentialId: credential.json().credential.id,
      })
    ).json().resource.id as string
    const call = () =>
      app!.inject({
        method: 'POST',
        url: `/api/providers/resources/${id}/validate`,
        headers: { cookie },
        payload: { capability: 'completion' },
      })

    for (let index = 0; index < 20; index += 1) {
      expect((await call()).statusCode).toBe(200)
    }
    const refused = await call()

    // The non-tariff host ceiling still binds when the credential's own window is roomy.
    expect(refused.statusCode).toBe(429)
    expect(refused.headers['retry-after']).toBeDefined()
    expect(refused.json().result).toBeUndefined()
  })

  it('declares the route long-lived so a slow provider does not starve background work', async () => {
    const port = await listen((_request, response) => {
      json(response, 200, { choices: [{ message: { content: 'ok' }, finish_reason: 'length' }] })
    })
    let enters = 0
    app = await createApp(fixture(port), {
      scheduler: {
        enterInteractive: () => {
          enters += 1
        },
        exitInteractive: () => {},
      },
    })
    const cookie = await login(app, 'alice', 'alice-password-1')
    const id = (await createResource(app, cookie, port)).json().resource.id as string
    const before = enters
    const validated = await app.inject({
      method: 'POST',
      url: `/api/providers/resources/${id}/validate`,
      headers: { cookie },
      payload: { capability: 'completion' },
    })

    expect(validated.statusCode).toBe(200)
    expect(enters).toBe(before)
  })
})
