import type { FastifyInstance } from 'fastify'
import { createServer, type Server } from 'node:http'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { createMutationGate } from '../../packages/server/src/libs/mutationGate'
import { createApp, type Fixture } from './app.js'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const fixture = (): Fixture => ({
  now: '2026-06-20T12:00:00.000Z',
  spaces: [{ slug: 'w', displayName: 'W', notes: [] }],
})

const providerFixture = (port: number): Fixture => ({
  ...fixture(),
  capabilities: { providers: true },
  providerPrivateOrigins: [`http://provider.test:${port}`],
  providerRuntime: { transport: { lookup: async () => [{ address: '127.0.0.1', family: 4 }] } },
  auth: {
    users: [{ username: 'alice', password: 'alice-password-1', admin: true }],
    members: [{ space: 'w', username: 'alice', role: 'owner' }],
  },
})

const connectPost = async (app: FastifyInstance, path: string): Promise<net.Socket> => {
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const socket = net.connect(port, '127.0.0.1')

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const body = '{}'
  socket.write(
    `POST ${path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  )
  return socket
}

let app: FastifyInstance
const providers: Server[] = []

afterEach(async () => {
  await app.close()
  for (const server of providers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

describe('online-backup HTTP mutation lifecycle', () => {
  it('exempts the real long provider route in both gate hooks, and nothing beside it', async () => {
    const gate = createMutationGate()
    const providerReached = deferred()
    const providerRelease = deferred()
    const mutationStarted = deferred()
    const mutationDone = deferred()
    const provider = createServer(async (_request, response) => {
      providerReached.resolve()
      await providerRelease.promise
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
    })
    providers.push(provider)
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
    const port = (provider.address() as net.AddressInfo).port
    app = await createApp(providerFixture(port), { mutationGate: gate })
    // A stand-in only for the HELD side: `POST` on a resource id is not a real
    // route, and the point is that the exemption is a per-route list rather than a
    // prefix over the provider family.
    app.post('/api/providers/resources/:id', { config: { authz: { public: true } } }, async () => {
      mutationStarted.resolve()
      await mutationDone.promise
      return { ok: true }
    })
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { identifier: 'alice', password: 'alice-password-1' },
    })
    const cookie = (login.headers['set-cookie'] as string).split(';')[0]
    const created = await app.inject({
      method: 'POST',
      url: '/api/providers/resources',
      headers: { cookie },
      payload: {
        name: 'Local runtime',
        wire: 'openai-compatible',
        baseUrl: `http://provider.test:${port}/api/v1`,
        allowPrivateNetwork: true,
        models: [{ name: 'local/model', capabilities: ['completion'] }],
      },
    })
    expect(created.statusCode).toBe(200)
    const id = created.json().resource.id as string

    const validating = app.inject({
      method: 'POST',
      url: `/api/providers/resources/${id}/validate`,
      headers: { cookie },
      payload: { capability: 'completion' },
    })
    await providerReached.promise
    // The provider is still thinking, and a checkpoint sails through: this is the
    // whole point of the exemption — a 120 s local call must not freeze every
    // mutation on the instance, nor make `make backup` fail as if it were broken.
    await expect(gate.checkpoint(async () => {})).resolves.toBeUndefined()
    providerRelease.resolve()
    await expect(validating).resolves.toMatchObject({ statusCode: 200 })

    const mutating = app.inject({
      method: 'POST',
      url: `/api/providers/resources/${id}`,
    })
    await mutationStarted.promise
    let checkpointRan = false
    const checkpoint = gate.checkpoint(async () => {
      checkpointRan = true
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(checkpointRan).toBe(false)
    mutationDone.resolve()
    await checkpoint
    await mutating
    expect(checkpointRan).toBe(true)
  })

  it('holds the gate until an aborted request handler actually settles', async () => {
    const gate = createMutationGate()
    const handlerStarted = deferred()
    const handlerDone = deferred()
    const order: string[] = []
    app = await createApp(fixture(), { mutationGate: gate })
    app.post('/api/__test/backup-slow', { config: { authz: { public: true } } }, async () => {
      handlerStarted.resolve()
      await handlerDone.promise
      order.push('handler')
      return { ok: true }
    })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const socket = await connectPost(app, '/api/__test/backup-slow')
    await handlerStarted.promise
    socket.destroy()

    const checkpoint = gate.checkpoint(async () => {
      order.push('checkpoint')
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(order).toEqual([])
    handlerDone.resolve()
    await checkpoint
    expect(order).toEqual(['handler', 'checkpoint'])
  })

  it('removes a disconnected request that was still waiting for admission', async () => {
    const gate = createMutationGate()
    const checkpointStarted = deferred()
    const checkpointDone = deferred()
    let handlerRan = false
    app = await createApp(fixture(), { mutationGate: gate })
    app.post('/api/__test/backup-wait', { config: { authz: { public: true } } }, async () => {
      handlerRan = true
      return { ok: true }
    })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const checkpoint = gate.checkpoint(async () => {
      checkpointStarted.resolve()
      await checkpointDone.promise
    })
    await checkpointStarted.promise
    const socket = await connectPost(app, '/api/__test/backup-wait')

    await new Promise((resolve) => setTimeout(resolve, 25))
    socket.destroy()
    await new Promise((resolve) => setTimeout(resolve, 25))
    checkpointDone.resolve()
    await checkpoint
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(handlerRan).toBe(false)
    await expect(gate.checkpoint(async () => {})).resolves.toBeUndefined()
  })
})
