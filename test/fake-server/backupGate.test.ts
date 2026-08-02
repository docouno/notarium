import type { FastifyInstance } from 'fastify'
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

afterEach(async () => {
  await app.close()
})

describe('online-backup HTTP mutation lifecycle', () => {
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
