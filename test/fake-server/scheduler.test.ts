// #196: the process-global background scheduler's interactive signal is fed by
// buildApp's request-lifecycle hooks. This pins the enter/exit BALANCE through the
// REAL production buildApp (the #18 target form): a normal 2xx, a 404, and a
// client-aborted request all return the shared count to 0; a `longLived` route is
// never counted. The abort case is the one `onResponse` alone would leak (fastify
// fires `onRequestAbort` instead of `onResponse` on a mid-handler disconnect), so it
// is exercised over a real socket — it is the exact scenario the #196 fix guards.

import type { FastifyInstance } from 'fastify'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { buildCaseWorld } from '../cases/build.js'
import { caseToFixture } from '../cases/toFixture.js'
import { createApp, type Fixture } from './app.js'

const spyScheduler = () => {
  let count = 0
  let enters = 0
  let exits = 0
  return {
    signal: {
      enterInteractive: () => {
        enters++
        count++
      },
      exitInteractive: () => {
        exits++
        count--
      },
    },
    get count() {
      return count
    },
    get enters() {
      return enters
    },
    get exits() {
      return exits
    },
  }
}

const fixture = (): Fixture => ({
  now: '2026-06-20T12:00:00.000Z',
  spaces: [{ slug: 'w', displayName: 'W', notes: [] }],
})

let app: FastifyInstance
afterEach(async () => {
  await app.close()
})

describe('#196 scheduler interactive-signal wiring (buildApp hooks)', () => {
  it('balances enter/exit on a normal 2xx request', async () => {
    const s = spyScheduler()
    app = await createApp(fixture(), { scheduler: s.signal })
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(s.enters).toBe(1)
    expect(s.exits).toBe(1)
    expect(s.count).toBe(0)
  })

  it('balances on a 404 (onResponse still fires)', async () => {
    const s = spyScheduler()
    app = await createApp(fixture(), { scheduler: s.signal })
    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' })
    expect(res.statusCode).toBe(404)
    expect(s.enters).toBeGreaterThanOrEqual(1)
    expect(s.count).toBe(0) // enter balanced by exit even on the not-found path
  })

  it('does NOT count a longLived route', async () => {
    const s = spyScheduler()
    app = await createApp(fixture(), { scheduler: s.signal })
    // A fast route marked longLived stands in for the real streams (SSE/import/export)
    // which can't be injected cleanly — the hook keys on config.longLived, not on the
    // handler shape, so this exercises the exclusion path faithfully.
    app.get(
      '/api/__test/ll',
      { config: { authz: { public: true }, longLived: true } },
      async () => ({ ok: true }),
    )
    const res = await app.inject({ method: 'GET', url: '/api/__test/ll' })
    expect(res.statusCode).toBe(200)
    expect(s.enters).toBe(0)
    expect(s.count).toBe(0)
  })

  it('keeps the real agent trace export outside the interactive count', async () => {
    const s = spyScheduler()
    const seeded = caseToFixture(
      buildCaseWorld('agent-telemetry-detailed', { now: '2026-08-30T12:00:00.000Z' }),
    )
    app = await createApp(seeded, { scheduler: s.signal })
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'sergey', password: 'sergey' },
    })
    const cookie = login.cookies.map((item) => `${item.name}=${item.value}`).join('; ')
    const session = seeded.agentSessions?.find((item) =>
      seeded.agentCalls?.some((call) => call.sessionId === item.id && call.outcome),
    )
    expect(session).toBeDefined()
    const entersBefore = s.enters
    const response = await app.inject({
      method: 'GET',
      url: `/api/me/agent-sessions/${session!.id}/export`,
      headers: { cookie },
    })

    expect(response.statusCode).toBe(200)
    expect(s.enters).toBe(entersBefore)
    expect(s.count).toBe(0)
  })

  // The abort case must be a POST WITH A BODY — the shape that actually leaked: fastify
  // fires neither onResponse nor onRequestAbort for a body-consumed request aborted
  // mid-handler (the /api/previews scroll-away case). A GET (no body) would balance via
  // onRequestAbort and give false confidence, so this deliberately mirrors /api/previews.
  it('balances a client-aborted POST-with-body (the /api/previews leak the fix guards)', async () => {
    const s = spyScheduler()
    app = await createApp(fixture(), { scheduler: s.signal })
    // A slow POST that PARSES its JSON body (so the body is fully consumed before the
    // handler blocks), then the socket is destroyed mid-handler.
    app.post('/api/__test/slow', { config: { authz: { public: true } } }, async (req) => {
      void (req.body as unknown) // force body parse
      await new Promise((r) => setTimeout(r, 2000))
      return { ok: true }
    })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const addr = app.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    const sock = net.connect(port, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', () => resolve())
      sock.once('error', reject)
    })
    const body = JSON.stringify({ ids: ['a', 'b'] })
    sock.write(
      `POST /api/__test/slow HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    )
    // Let onRequest fire, the body be fully received, and the handler start blocking.
    await new Promise((r) => setTimeout(r, 200))
    expect(s.enters).toBe(1)
    expect(s.count).toBe(1) // in flight, body already consumed

    sock.destroy() // client abort mid-handler

    // reply.raw 'close' must release the mark even though neither onResponse nor
    // onRequestAbort fires for this shape. Poll until balanced.
    const t0 = Date.now()

    while (s.count !== 0 && Date.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(s.count).toBe(0)
  })
})
