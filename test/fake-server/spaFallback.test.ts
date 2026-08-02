import type { FastifyInstance } from 'fastify'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createApp, type Fixture } from './app.js'

const RESERVED_STATIC_PATHS = [
  '/api/static-collision.txt',
  '/mcp/static-collision.txt',
  '/oauth/static-collision.txt',
  '/.well-known/static-collision.txt',
]

const fixture = (): Fixture => ({
  spaces: [{ slug: 'main', notes: [] }],
})

const rawRequest = (
  port: number,
  path: string,
  method = 'GET',
): Promise<{ body: string; contentType: string | undefined; statusCode: number | undefined }> =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', method, path, port }, (response) => {
      const chunks: Buffer[] = []

      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        resolve({
          body: Buffer.concat(chunks).toString('utf8'),
          contentType: response.headers['content-type'],
          statusCode: response.statusCode,
        })
      })
    })

    req.on('error', reject)
    req.end()
  })

describe('static SPA perimeter', () => {
  let app: FastifyInstance
  let sandbox: string
  let spaDist: string

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'notarium-spa-perimeter-'))
    spaDist = join(sandbox, 'public')
    await mkdir(spaDist)
    await writeFile(join(spaDist, 'index.html'), '<!doctype html><title>NOTARIUM_SPA</title>')
    await writeFile(join(spaDist, 'public-asset.txt'), 'PUBLIC_STATIC_ASSET')
    await writeFile(join(sandbox, 'secret.txt'), 'NOTARIUM_OUTSIDE_STATIC_ROOT')
    for (const namespace of ['api', 'mcp', 'oauth', '.well-known']) {
      await mkdir(join(spaDist, namespace))
      await writeFile(join(spaDist, namespace, 'static-collision.txt'), 'STATIC_COLLISION')
    }
    app = await createApp(fixture(), { spaDist })
  })

  afterEach(async () => {
    await app.close()
    await rm(sandbox, { recursive: true, force: true })
  })

  it.each(['/', '/n/note-id/slug', '/apiary'])(
    'serves the shell for browser history route %s',
    async (url) => {
      const response = await app.inject({ method: 'GET', url })

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('NOTARIUM_SPA')
    },
  )

  it('serves a body-less HEAD response for a browser history route', async () => {
    const response = await app.inject({ method: 'HEAD', url: '/n/note-id/slug' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.body).toBe('')
  })

  it('lets a real API route reach the application router', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })
  })

  it('still serves an ordinary public static asset', async () => {
    const response = await app.inject({ method: 'GET', url: '/public-asset.txt' })

    expect(response.statusCode).toBe(200)
    expect(response.body).toBe('PUBLIC_STATIC_ASSET')
  })

  it.each(RESERVED_STATIC_PATHS)(
    'never lets a static asset occupy server namespace %s',
    async (url) => {
      const response = await app.inject({ method: 'GET', url })

      expect(response.statusCode).toBe(404)
      expect(response.headers['content-type']).toContain('application/json')
      expect(response.body).not.toContain('STATIC_COLLISION')
    },
  )

  it.each(['POST', 'PUT', 'OPTIONS'] as const)(
    'keeps unknown %s browser routes out of the SPA fallback',
    async (method) => {
      const response = await app.inject({ method, url: '/n/note-id/slug' })

      expect(response.statusCode).toBe(404)
      expect(response.headers['content-type']).toContain('application/json')
      expect(response.json()).toEqual({ error: 'not found' })
    },
  )

  it.each([
    '/api',
    '/api/missing',
    '/api%2Fmissing',
    '/api%252Fmissing',
    '//api//missing',
    '/browser/../api/missing',
    '/browser/%2e%2e/api/missing',
    '/mcp/missing',
    '/oauth/missing',
    '/.well-known/missing',
  ])('never serves the shell across server namespace %s', async (url) => {
    const response = await app.inject({ method: 'GET', url })

    expect(response.statusCode).toBe(404)
    expect(response.body).not.toContain('NOTARIUM_SPA')
  })

  it.each(['/../secret.txt', '/%2e%2e/secret.txt', '/%252e%252e/secret.txt'])(
    'does not expose a file outside the static root through %s',
    async (url) => {
      const response = await app.inject({ method: 'GET', url })

      expect(response.body).not.toContain('NOTARIUM_OUTSIDE_STATIC_ROOT')
    },
  )

  it('answers raw HTTP traversal before @fastify/static can raise Forbidden', async () => {
    await app.listen({ host: '127.0.0.1', port: 0 })
    const port = (app.server.address() as AddressInfo).port

    for (const [path, statusCode] of [
      ['/api%2Fmissing', 404],
      ['/api%252Fmissing', 404],
      ['//api//missing', 404],
      ['/browser/../api/missing', 404],
      ['/browser/%2e%2e/api/missing', 404],
      ['/../secret.txt', 400],
      ['/%2e%2e/secret.txt', 400],
      ['/browser#x/../api/missing', 400],
      ['/#/../api', 400],
      ['/api#/../n', 400],
      ['/api/static-collision.txt', 404],
    ] as const) {
      const response = await rawRequest(port, path)

      expect(response.statusCode, path).toBe(statusCode)
      expect(response.contentType, path).toContain('application/json')
      expect(response.body, path).not.toContain('NOTARIUM_SPA')
      expect(response.body, path).not.toContain('NOTARIUM_OUTSIDE_STATIC_ROOT')
    }
  })

  it('answers non-GET browser routes with raw JSON 404 instead of invoking sendFile', async () => {
    await app.listen({ host: '127.0.0.1', port: 0 })
    const port = (app.server.address() as AddressInfo).port

    for (const method of ['POST', 'PUT', 'OPTIONS']) {
      const response = await rawRequest(port, '/n/note-id/slug', method)

      expect(response.statusCode, method).toBe(404)
      expect(response.contentType, method).toContain('application/json')
      expect(JSON.parse(response.body), method).toEqual({ error: 'not found' })
    }
  })
})
