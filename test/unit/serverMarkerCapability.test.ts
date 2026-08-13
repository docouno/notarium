// The composition root's half of the marker capability (#332), through the real
// production assembly. `createMarkerStore` takes the runtime fact as an OPTIONAL
// option and falls back to probing for it, so `server.ts` stating the fact
// itself — `{ anchoredWritesAvailable: true }` — is a one-word change that no
// unit test of the store can see: those build their own store. Pinned here, the
// only place where the server's own wiring is the subject.
// canon: docs/projects.md#the-notariummeta-marker-schema-parser-pin

import type { FastifyInstance } from 'fastify'
import type * as nodeFs from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Only `openSync` is wrapped, and only `/proc/self/fd` is answered differently:
// the probe opens that directory first, so refusing it is the whole simulation
// of a host whose runtime cannot anchor a marker write. Every other open — and
// the server performs many during boot — reaches the real one.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeFs>()

  return { ...actual, openSync: vi.fn(actual.openSync) }
})

const { openSync } = await import('node:fs')
const { createServer } = await import('../../packages/server/src/apps/server/server')
const actualFs = await vi.importActual<typeof nodeFs>('node:fs')

const openSyncMock = vi.mocked(openSync)
const apps: FastifyInstance[] = []
let root: string

/** A server whose runtime refuses `/proc/self/fd`, built exactly as production
 *  builds one. The refusal has to be in place before `createServer`, because the
 *  store settles the fact once, at construction. */
const bootWithoutAnchor = async (): Promise<FastifyInstance> => {
  await mkdir(join(root, 'main', 'docs'), { recursive: true })
  openSyncMock.mockImplementation(((path: nodeFs.PathLike, ...rest: never[]) => {
    if (String(path) === '/proc/self/fd') {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }

    return (actualFs.openSync as (...args: never[]) => number)(path as never, ...rest)
  }) as never)

  return bootReal()
}

const bootReal = async (): Promise<FastifyInstance> => {
  const app = await createServer({
    spaces: [{ slug: 'main', engine: 'notarium' as const, notesDir: join(root, 'main') }],
    metaDbUrl: `sqlite:${join(root, 'meta.db')}`,
    authMode: 'none',
    engineDataDir: join(root, 'engine'),
    jobsDataDir: join(root, 'jobs'),
    importStagingDir: join(root, 'jobs', 'imports'),
    pollIntervalMs: 0,
  })

  await app.ready()
  apps.push(app)
  return app
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nt-marker-capability-'))
})
afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close()
  }
  // Reset alone would leave a stub answering `undefined` to every open, which the
  // next boot needs for far more than the probe.
  openSyncMock.mockReset().mockImplementation(actualFs.openSync)
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('createServer — marker capability comes from the runtime (#332)', () => {
  it('refuses to mark a folder as a project on a host that cannot anchor the write', async () => {
    const app = await bootWithoutAnchor()

    const marked = await app.inject({
      method: 'POST',
      url: '/api/s/main/projects',
      payload: { folderPath: 'docs', displayName: 'Docs' },
    })

    // 404, not 500: the route gates on `available()` and answers before the
    // registry is touched — the honest refusal this task exists to produce.
    expect(marked.statusCode).toBe(404)
  })

  it('marks one on the same assembly when the runtime does provide the anchor', async () => {
    await mkdir(join(root, 'main', 'docs'), { recursive: true })
    const app = await bootReal()

    const marked = await app.inject({
      method: 'POST',
      url: '/api/s/main/projects',
      payload: { folderPath: 'docs', displayName: 'Docs' },
    })

    // The negative case above must not be able to pass by accident — a payload
    // this route would reject anyway, or a space it cannot see, would give 404
    // on any host at all.
    expect(marked.statusCode).toBe(201)
  })
})
