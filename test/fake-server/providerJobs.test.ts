import type { FastifyInstance } from 'fastify'
import { readFileSync } from 'node:fs'
import { createServer, type RequestListener, type Server } from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { PROVIDER_CALL_OUTCOME, PROVIDER_DELIVERY_STATE } from '@notarium/contract'
import type { JobsPersistence } from '@notarium/server'

import { createApp, fakeUserId, type Fixture } from './app'
import { InMemoryProviderCallLog } from './providerCallLog'
import { type InMemorySpaces } from './spaces'

const SECRET = 'sk-local-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const servers: Server[] = []
let app: FastifyInstance | undefined

const listen = async (handler: RequestListener): Promise<number> => {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return (server.address() as AddressInfo).port
}

const waitFor = async <T>(read: () => Promise<T | null>, timeoutMs = 10_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs

  for (;;) {
    const value = await read()

    if (value !== null) {
      return value
    }
    if (Date.now() >= deadline) {
      throw new Error('provider job wait timed out')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const json = (response: Parameters<RequestListener>[1], status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

const streamOk = (
  response: Parameters<RequestListener>[1],
  chunks: string[] = ['ok'],
  usage: Record<string, unknown> | null = null,
): void => {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const text of chunks) {
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`,
    )
  }
  response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
  if (usage) {
    response.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`)
  }
  response.end('data: [DONE]\n\n')
}

const fixture = (port: number): Fixture => ({
  spaces: [{ slug: 'main', displayName: 'Main', notes: [] }],
  capabilities: { providers: true },
  providerPrivateOrigins: [`http://provider.test:${port}`],
  providerRuntime: {
    transport: { lookup: async () => [{ address: '127.0.0.1', family: 4 }] },
  },
  auth: {
    users: [{ username: 'alice', password: 'alice-password-1', admin: true }],
    members: [{ space: 'main', username: 'alice', role: 'owner' }],
  },
})

afterEach(async () => {
  await app?.close()
  app = undefined
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

const login = async (instance: FastifyInstance) => {
  const response = await instance.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: 'alice', password: 'alice-password-1' },
  })
  expect(response.statusCode).toBe(200)
  return (response.headers['set-cookie'] as string).split(';')[0]
}

const setup = async (
  port: number,
  options: {
    callLog?: InMemoryProviderCallLog
    scheduler?: { enterInteractive(): void; exitInteractive(): void }
  } = {},
) => {
  let jobs!: JobsPersistence
  let spaces!: InMemorySpaces
  let spaceId = ''
  const callLog = options.callLog ?? new InMemoryProviderCallLog()
  app = await createApp(fixture(port), {
    providerCallLog: callLog,
    scheduler: options.scheduler,
    onJobsPersistence: (value) => {
      jobs = value
    },
    onSpacesPersistence: (value) => {
      spaces = value
    },
    onProviderPersistence: (_providers, idOf) => {
      spaceId = idOf('main')
    },
  })
  const cookie = await login(app)
  const credentialResponse = await app.inject({
    method: 'POST',
    url: '/api/providers/credentials',
    headers: { cookie },
    payload: {
      name: 'Local key',
      kind: 'bearer',
      secret: SECRET,
      origin: `http://provider.test:${port}`,
      injection: { header: '', prefix: 'Bearer ' },
    },
  })
  expect(credentialResponse.statusCode).toBe(200)
  const credentialId = credentialResponse.json().credential.id as string
  const resourceResponse = await app.inject({
    method: 'POST',
    url: '/api/providers/resources',
    headers: { cookie },
    payload: {
      name: 'Local model',
      wire: 'openai-compatible',
      baseUrl: `http://provider.test:${port}/api/v1`,
      allowPrivateNetwork: true,
      credentialId,
      models: [{ name: 'local/model', capabilities: ['completion'] }],
    },
  })
  expect(resourceResponse.statusCode).toBe(200)
  const resourceId = resourceResponse.json().resource.id as string
  const offered = await app.inject({
    method: 'POST',
    url: '/api/providers/attachments',
    headers: { cookie },
    payload: { resourceId, targetKind: 'space', targetId: spaceId },
  })
  expect(offered.statusCode).toBe(200)
  const attachmentId = offered.json().view.attachment.id as string
  const accepted = await app.inject({
    method: 'POST',
    url: `/api/providers/attachments/${attachmentId}/accept`,
    headers: { cookie },
    payload: { resourceEpoch: 0, credentialEpoch: 0 },
  })
  expect(accepted.statusCode).toBe(200)

  const enqueue = async (over: Record<string, unknown> = {}) => {
    const response = await app!.inject({
      method: 'POST',
      url: '/api/__test/providers/jobs',
      payload: { space: 'main', resourceId, model: 'local/model', ...over },
    })
    expect(response.statusCode).toBe(202)
    return response.json().id as string
  }
  const terminal = (id: string) =>
    waitFor(async () => {
      const row = await jobs.get(id)
      return row && ['succeeded', 'failed', 'canceled'].includes(row.status) ? row : null
    })

  return {
    app,
    callLog,
    cookie,
    credentialId,
    enqueue,
    jobs,
    resourceId,
    spaceId,
    spaces,
    terminal,
  }
}

describe('provider durable-job fake driver', () => {
  it('streams usage through the real executor and keeps every persisted job field secret-free', async () => {
    let authorization = ''
    const port = await listen((request, response) => {
      authorization = request.headers.authorization ?? ''
      streamOk(response, ['answer ', SECRET.slice(0, 18), SECRET.slice(18)], {
        prompt_tokens: 3,
        completion_tokens: 2,
        total_tokens: 5,
        reasoning_tokens: null,
        cached_tokens: null,
        cost: null,
        is_byok: null,
        cost_details: null,
      })
    })
    const world = await setup(port)
    const id = await world.enqueue()
    const row = await world.terminal(id)

    expect(authorization).toBe(`Bearer ${SECRET}`)
    expect(row).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      phase: 'done',
      result: {
        kind: 'chat',
        text: 'answer [redacted]',
        usage: { totalTokens: 5 },
      },
      error: null,
    })
    for (const field of [row.params, row.result, row.error, row.phase]) {
      expect(JSON.stringify(field)).not.toContain(SECRET)
      expect(JSON.stringify(field)).not.toContain(`Bearer ${SECRET}`)
    }
    expect(world.callLog.snapshot()).toMatchObject([
      {
        jobId: id,
        jobCallKey: 'reply',
        attemptNo: 1,
        outcome: PROVIDER_CALL_OUTCOME.ok,
        usage: { totalTokens: 5 },
      },
    ])
  })

  it('retries only a classified rate-limit response and reuses the same jobCallKey', async () => {
    let requests = 0
    const port = await listen((_request, response) => {
      requests += 1
      if (requests === 1) {
        response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' })
        response.end(
          JSON.stringify({
            error: { message: 'slow down', metadata: { error_type: 'rate_limit_exceeded' } },
          }),
        )
        return
      }
      streamOk(response)
    })
    const world = await setup(port)
    const id = await world.enqueue()
    const row = await world.terminal(id)

    expect(row).toMatchObject({ status: 'succeeded', attempts: 2, error: null })
    expect(requests).toBe(2)
    expect(world.callLog.snapshot()).toMatchObject([
      { jobId: id, jobCallKey: 'reply', attemptNo: 1, retrySafe: true },
      { jobId: id, jobCallKey: 'reply', attemptNo: 2, outcome: PROVIDER_CALL_OUTCOME.ok },
    ])
  })

  it('makes an answered fallback terminal and never persists the echoed credential', async () => {
    let requests = 0
    const port = await listen((_request, response) => {
      requests += 1
      json(response, 500, { error: { message: `unknown failure for ${SECRET}` } })
    })
    const world = await setup(port)
    const id = await world.enqueue()
    const row = await world.terminal(id)

    expect(row).toMatchObject({ status: 'failed', attempts: 1, error: 'fallback' })
    expect(requests).toBe(1)
    expect(JSON.stringify(row)).not.toContain(SECRET)
  })

  it('turns an ambiguous re-claim into outcome-unknown without a second request', async () => {
    let requests = 0
    const port = await listen((_request, response) => {
      requests += 1
      streamOk(response)
    })
    const callLog = new InMemoryProviderCallLog()
    const world = await setup(port, { callLog })
    await callLog.intent({
      id: 'call-before-crash',
      owner: fakeUserId('alice'),
      principal: 'ui',
      agent: null,
      resourceId: world.resourceId,
      credentialId: world.credentialId,
      host: `provider.test:${port}`,
      spaces: [world.spaceId],
      job: { jobId: 'job-reclaimed', jobCallKey: 'reply' },
      createdAt: '2026-08-25T00:00:00.000Z',
    })
    const id = await world.enqueue({ jobId: 'job-reclaimed' })
    const row = await world.terminal(id)

    expect(row).toMatchObject({
      status: 'failed',
      attempts: 1,
      error: PROVIDER_CALL_OUTCOME.outcomeUnknown,
    })
    expect(requests).toBe(0)
    expect(callLog.snapshot()).toHaveLength(1)
  })

  it('rechecks the live scope at execution and does not call an archived target', async () => {
    let requests = 0
    const port = await listen((_request, response) => {
      requests += 1
      streamOk(response)
    })
    const world = await setup(port)
    const id = await world.enqueue({ delayMs: 100, maxAttempts: 1 })
    const current = await world.spaces.getById(world.spaceId)
    await world.spaces.upsert({
      ...current!,
      archivedAt: '2026-08-25T01:00:00.000Z',
      archivedBy: `user:${fakeUserId('alice')}`,
    })
    const row = await world.terminal(id)

    expect(row).toMatchObject({ status: 'failed', attempts: 1, error: 'policy-denied' })
    expect(requests).toBe(0)
    expect(world.callLog.snapshot()).toEqual([])
  })

  it('aborts an in-flight upstream request when the durable job is canceled', async () => {
    let started!: () => void
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let closed!: () => void
    const requestClosed = new Promise<void>((resolve) => {
      closed = resolve
    })
    const port = await listen((_request, response) => {
      response.on('close', closed)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: `started-${'x'.repeat(100)}` } }] })}\n\n`,
      )
      started()
    })
    const world = await setup(port)
    const id = await world.enqueue()
    await requestStarted
    await world.jobs.cancel(id, new Date().toISOString())
    const row = await world.terminal(id)
    await Promise.race([
      requestClosed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('upstream stayed open')), 5_000),
      ),
    ])

    expect(row).toMatchObject({ status: 'canceled', attempts: 1, error: null })
    expect(world.callLog.snapshot()[0]).toMatchObject({
      deliveryState: PROVIDER_DELIVERY_STATE.mayHaveSent,
      retrySafe: false,
    })
  })

  it('uses a separate client-close AbortController on the long-lived fake stream route', async () => {
    let started!: () => void
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let closed!: () => void
    const requestClosed = new Promise<void>((resolve) => {
      closed = resolve
    })
    const scheduler = {
      enters: 0,
      exits: 0,
      enterInteractive() {
        this.enters += 1
      },
      exitInteractive() {
        this.exits += 1
      },
    }
    const port = await listen((_request, response) => {
      response.on('close', closed)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"content":"started"}}]}\n\n')
      started()
    })
    const world = await setup(port, { scheduler })
    const entersBefore = scheduler.enters
    await world.app.listen({ port: 0, host: '127.0.0.1' })
    const address = world.app.server.address() as AddressInfo
    const body = JSON.stringify({
      space: 'main',
      resourceId: world.resourceId,
      model: 'local/model',
    })
    const socket = net.connect(address.port, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    socket.write(
      `POST /api/__test/providers/stream HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    )
    await requestStarted
    socket.destroy()
    await Promise.race([
      requestClosed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('upstream stayed open')), 5_000),
      ),
    ])

    expect(scheduler.enters).toBe(entersBefore)
    expect(scheduler.exits).toBe(entersBefore)
  }, 15_000)

  it('does not register the fake provider kind in the production composition root', () => {
    const source = readFileSync(
      new URL('../../packages/server/src/apps/server/server.ts', import.meta.url),
      'utf8',
    )
    expect(source).not.toContain('__test-provider-call')
    expect(source).not.toContain('runProviderJobCall')
  })
})
