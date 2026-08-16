// Browser-folder import over the production route composition: many multipart
// entries become one staged ZIP, one durable job and the existing Markdown-tree
// planner/writer. This is the proof that the bridge is not merely a packer unit.

import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { createApp, type Fixture } from './app.js'

const fixture = (): Fixture => ({
  now: '2026-06-20T12:00:00.000Z',
  spaces: [{ slug: 'main', displayName: 'Main', notes: [] }],
})

const BOUNDARY = '----notarium-folder-route-test'

type TreeFile = { path: string; body: string; modifiedAt?: number }

const folderMultipart = (files: TreeFile[], root = '') => {
  const parts: Buffer[] = []
  const fields = {
    bundle: 'markdown-tree',
    format: 'markdown',
    ...(root ? { root } : {}),
    skipExisting: 'true',
  }

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    )
  }
  for (const file of files) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="entry:${file.modifiedAt ?? 0}"; filename="${encodeURIComponent(file.path)}"\r\nContent-Type: application/octet-stream\r\n\r\n${file.body}\r\n`,
      ),
    )
  }
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`))

  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  }
}

type Summary = {
  imported: number
  skipped: number
  failed: number
  ignored?: { count: number; files: string[] }
}

type Job = {
  id: string
  status: string
  result: Summary | null
  error: string | null
  progress: { done: number; total: number | null; phase: string | null }
}

const terminal = new Set(['succeeded', 'failed', 'canceled'])

const waitForJob = async (app: FastifyInstance, job: Job): Promise<Job> => {
  const deadline = Date.now() + 8_000
  let current = job

  while (!terminal.has(current.status)) {
    if (Date.now() > deadline) {
      throw new Error(`folder import ${job.id} stuck at ${current.status}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    current = JSON.parse(
      (await app.inject({ method: 'GET', url: `/api/s/main/jobs/${job.id}` })).payload,
    ) as Job
  }

  return current
}

const notes = async (app: FastifyInstance) =>
  JSON.parse((await app.inject({ method: 'GET', url: '/api/s/main/notes?limit=1000' })).payload)
    .notes as Array<{ title: string; filePath: string; createdAt: string | null }>

const ndjsonDone = (payload: string): Summary | undefined =>
  payload
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Summary & { type: string })
    .find((line) => line.type === 'done')

let app: FastifyInstance | null = null

afterEach(async () => {
  await app?.close()
  app = null
})

describe('browser folder import', () => {
  it('creates one durable job through the existing tree writer', async () => {
    app = await createApp(fixture())
    const response = await app.inject({
      method: 'POST',
      url: '/api/s/main/import',
      ...folderMultipart(
        [
          { path: 'vault/inbox/a.txt', body: '# A\n\nBody.', modifiedAt: 1234 },
          { path: 'vault/deep/b.mdown', body: '# B\n\nBody.' },
          { path: 'vault/__MACOSX/kept.md', body: '# Kept\n\nUser content.' },
          { path: 'vault/__MACOSX/asset.png', body: '' },
          { path: 'vault/asset.png', body: '' },
        ],
        'imported',
      ),
    })

    expect(response.statusCode).toBe(202)
    const final = await waitForJob(app, JSON.parse(response.payload) as Job)

    expect(final.status).toBe('succeeded')
    expect(final.result).toMatchObject({
      imported: 3,
      skipped: 0,
      failed: 0,
      ignored: {
        count: 2,
        files: ['vault/__MACOSX/asset.png', 'vault/asset.png'],
      },
    })
    const listedJobs = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/s/main/jobs?kind=import' })).payload,
    ).jobs as Job[]

    expect(listedJobs).toHaveLength(1)
    const imported = (await notes(app)).sort((a, b) => a.filePath.localeCompare(b.filePath))

    expect(imported.map((note) => note.filePath)).toEqual([
      'imported/vault/__MACOSX/kept.md',
      'imported/vault/deep/b.md',
      'imported/vault/inbox/a.md',
    ])
    expect(imported.find((note) => note.title === 'A')?.createdAt).toBe('1970-01-01T00:00:01.234Z')
  })

  it('keeps the same tree semantics in the synchronous capability fallback', async () => {
    app = await createApp({ ...fixture(), noJobs: true })
    const response = await app.inject({
      method: 'POST',
      url: '/api/s/main/import',
      ...folderMultipart([
        { path: 'vault/a.text', body: '# A\n\nBody.' },
        { path: 'vault/b.md', body: '# B\n\nBody.' },
      ]),
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toMatch(/ndjson/)
    expect(ndjsonDone(response.payload)).toMatchObject({ imported: 2, skipped: 0, failed: 0 })
    expect((await notes(app)).map((note) => note.filePath).sort()).toEqual([
      'vault/a.md',
      'vault/b.md',
    ])
  })

  it('does not enqueue or write when an unsupported placeholder carries bytes', async () => {
    app = await createApp(fixture())
    const response = await app.inject({
      method: 'POST',
      url: '/api/s/main/import',
      ...folderMultipart([{ path: 'vault/asset.png', body: 'malicious body' }]),
    })

    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: string }>().error).toMatch(/must have an empty body/)
    expect(await notes(app)).toEqual([])
    const jobs = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/s/main/jobs?kind=import' })).payload,
    ).jobs as Job[]

    expect(jobs).toEqual([])
  })

  it('rejects an unsafe folder root before staging or enqueue', async () => {
    app = await createApp(fixture())
    const response = await app.inject({
      method: 'POST',
      url: '/api/s/main/import',
      ...folderMultipart([{ path: 'vault/a.md', body: '# A' }], '../unsafe'),
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'bad import root' })
    expect(await notes(app)).toEqual([])
    const jobs = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/s/main/jobs?kind=import' })).payload,
    ).jobs as Job[]

    expect(jobs).toEqual([])
  })
})
