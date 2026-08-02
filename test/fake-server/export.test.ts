// Base export (#17) end to end over the production buildApp (#18): GET
// /api/s/:space/export streams a ZIP of the space's note files. Pins the whole
// contract surface — the archive holds one entry per note at its filePath, the
// raw on-disk file form (frontmatter + body, round-trippable); `frontmatter=strip`
// cuts the YAML block; `scope` is the visibility axis (default `user` drops the
// agent-memory mount, `all` is a full backup); `folder` narrows to a subtree; and
// an unknown space 404s like every space-scoped route (anti-enumeration). The fake
// reconstructs each file from its snapshot, so this asserts SHAPE, not byte-parity.

import AdmZip from 'adm-zip'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createApp, type Fixture } from './app.js'

const fixture = (): Fixture => ({
  now: '2026-06-20T12:00:00.000Z',
  spaces: [
    {
      slug: 'main',
      displayName: 'Main',
      notes: [
        {
          title: 'Doc A',
          filePath: 'docs/a.md',
          content: '# Doc A\n\nalpha body token',
          tags: ['x'],
        },
        { title: 'Root Note', filePath: 'root.md', content: '# Root Note\n\nroot body token' },
        {
          id: 'fake-mem-export',
          title: 'Agent Memory',
          filePath: '.notarium/memory/m.md',
          class: 'agent-memory',
          content: '# Agent Memory\n\nprivate memory token',
        },
      ],
    },
  ],
})

let app: FastifyInstance
beforeEach(async () => {
  app = await createApp(fixture())
})
afterEach(async () => {
  await app.close()
})

/** GET the export and unzip its bytes into a path→text map. */
const exportZip = async (query = '', space = 'main') => {
  const res = await app.inject({ method: 'GET', url: `/api/s/${space}/export${query}` })
  expect(res.statusCode).toBe(200)
  expect(res.headers['content-type']).toBe('application/zip')
  const zip = new AdmZip(res.rawPayload)
  const files: Record<string, string> = {}

  for (const e of zip.getEntries()) {
    files[e.entryName] = e.getData().toString('utf8')
  }

  return { res, files }
}

describe('base export (#17): GET /api/s/:space/export', () => {
  it('streams a named ZIP of the user notes — raw file form, agent-memory excluded by default', async () => {
    const { res, files } = await exportZip()
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="main-notes-\d{4}-\d\d-\d\d\.zip"/,
    )
    // One entry per USER note, keyed by filePath; the hidden mount is not swept.
    expect(Object.keys(files).sort()).toEqual(['docs/a.md', 'root.md'])
    // The raw file: a frontmatter block (round-trippable) + the body.
    expect(files['docs/a.md']).toMatch(/^---/)
    expect(files['docs/a.md']).toContain('alpha body token')
    expect(files['docs/a.md']).toContain('notarium-id:')
  })

  it('scope=all adds the agent-memory mount (full backup)', async () => {
    const { files } = await exportZip('?scope=all')
    expect(Object.keys(files).sort()).toEqual(['.notarium/memory/m.md', 'docs/a.md', 'root.md'])
    expect(files['.notarium/memory/m.md']).toContain('private memory token')
  })

  it('frontmatter=strip drops the YAML block, keeping the body', async () => {
    const { files } = await exportZip('?frontmatter=strip')
    expect(files['docs/a.md']).not.toMatch(/^---/)
    expect(files['docs/a.md']).not.toContain('notarium-id:')
    expect(files['docs/a.md']).toContain('alpha body token')
  })

  it('folder=docs narrows to one subtree', async () => {
    const { files } = await exportZip('?folder=docs')
    expect(Object.keys(files)).toEqual(['docs/a.md'])
  })

  it('an unknown space 404s like every space-scoped route', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/s/nope/export' })
    expect(res.statusCode).toBe(404)
  })
})

// Async export via the durable job layer (#105 [JOBS][A]) — the fake wires the real
// runner over an in-memory jobs facet + a tmp artifact store, so enqueue → background
// build → poll status → Range download all run the production code.
describe('async export (#105): POST /export + jobs + download', () => {
  /** Enqueue, then poll the status endpoint until the job is terminal. */
  const runJob = async (body: object = {}, space = 'main') => {
    const enq = await app.inject({
      method: 'POST',
      url: `/api/s/${space}/export`,
      payload: body,
    })
    expect(enq.statusCode).toBe(202)
    const job = enq.json() as { id: string; status: string }
    expect(['pending', 'running', 'succeeded']).toContain(job.status)
    for (let i = 0; i < 50; i++) {
      const res = await app.inject({ method: 'GET', url: `/api/s/${space}/jobs/${job.id}` })
      expect(res.statusCode).toBe(200)
      const cur = res.json() as { status: string }

      if (cur.status === 'succeeded' || cur.status === 'failed' || cur.status === 'canceled') {
        return cur as {
          id: string
          status: string
          artifact: { name: string; bytes: number } | null
        }
      }
      await new Promise((r) => setTimeout(r, 30))
    }
    throw new Error('job did not finish')
  }

  it('enqueues, builds the archive, and serves it for download', async () => {
    const job = await runJob({ scope: 'user', frontmatter: 'keep' })
    expect(job.status).toBe('succeeded')
    expect(job.artifact).toBeTruthy()
    expect(job.artifact?.name).toMatch(/main-notes-\d{4}-\d\d-\d\d\.zip/)

    const dl = await app.inject({ method: 'GET', url: `/api/s/main/jobs/${job.id}/download` })
    expect(dl.statusCode).toBe(200)
    expect(dl.headers['content-type']).toBe('application/zip')
    expect(dl.headers['accept-ranges']).toBe('bytes')
    const zip = new AdmZip(dl.rawPayload)
    const names = zip
      .getEntries()
      .map((e) => e.entryName)
      .sort()
    // Same entries as the sync export (agent-memory excluded by default).
    expect(names).toEqual(['docs/a.md', 'root.md'])
  })

  it('honours folder= and scope=all like the sync path', async () => {
    const folderJob = await runJob({ folder: 'docs' })
    const dl1 = await app.inject({
      method: 'GET',
      url: `/api/s/main/jobs/${folderJob.id}/download`,
    })
    expect(new AdmZip(dl1.rawPayload).getEntries().map((e) => e.entryName)).toEqual(['docs/a.md'])

    const allJob = await runJob({ scope: 'all' })
    const dl2 = await app.inject({ method: 'GET', url: `/api/s/main/jobs/${allJob.id}/download` })
    expect(
      new AdmZip(dl2.rawPayload)
        .getEntries()
        .map((e) => e.entryName)
        .sort(),
    ).toEqual(['.notarium/memory/m.md', 'docs/a.md', 'root.md'])
  })

  it('serves a byte range (206) for resumed downloads', async () => {
    const job = await runJob()
    const full = await app.inject({ method: 'GET', url: `/api/s/main/jobs/${job.id}/download` })
    const size = Number(full.headers['content-length'])
    expect(size).toBeGreaterThan(0)
    const part = await app.inject({
      method: 'GET',
      url: `/api/s/main/jobs/${job.id}/download`,
      headers: { range: 'bytes=0-9' },
    })
    expect(part.statusCode).toBe(206)
    expect(part.headers['content-range']).toBe(`bytes 0-9/${size}`)
    expect(part.rawPayload.length).toBe(10)
  })

  it('lists the space jobs', async () => {
    const job = await runJob()
    const res = await app.inject({ method: 'GET', url: '/api/s/main/jobs' })
    expect(res.statusCode).toBe(200)
    const { jobs } = res.json() as { jobs: Array<{ id: string }> }
    expect(jobs.some((j) => j.id === job.id)).toBe(true)
  })

  it('an unknown space 404s the enqueue', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/s/nope/export', payload: {} })
    expect(res.statusCode).toBe(404)
  })

  it('a missing job 404s the status', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/s/main/jobs/nope' })
    expect(res.statusCode).toBe(404)
  })

  it('download honours suffix range, If-Range (mis)match, an unsatisfiable range, and a non-bytes unit', async () => {
    const job = await runJob()
    const base = `/api/s/main/jobs/${job.id}/download`
    const full = await app.inject({ method: 'GET', url: base })
    const size = Number(full.headers['content-length'])
    const etag = full.headers['etag'] as string
    expect(size).toBeGreaterThan(10)

    // Suffix range: the last 5 bytes.
    const suffix = await app.inject({ method: 'GET', url: base, headers: { range: 'bytes=-5' } })
    expect(suffix.statusCode).toBe(206)
    expect(suffix.headers['content-range']).toBe(`bytes ${size - 5}-${size - 1}/${size}`)
    expect(suffix.rawPayload.length).toBe(5)

    // If-Range with a STALE validator → serve the whole file (200), never a corrupt slice.
    const stale = await app.inject({
      method: 'GET',
      url: base,
      headers: { range: 'bytes=0-4', 'if-range': '"wrong"' },
    })
    expect(stale.statusCode).toBe(200)
    expect(stale.rawPayload.length).toBe(size)

    // If-Range that MATCHES the current ETag → the partial is served.
    const fresh = await app.inject({
      method: 'GET',
      url: base,
      headers: { range: 'bytes=0-4', 'if-range': etag },
    })
    expect(fresh.statusCode).toBe(206)
    expect(fresh.rawPayload.length).toBe(5)

    // A well-formed but unsatisfiable range → 416 with Content-Range */size.
    const unsat = await app.inject({
      method: 'GET',
      url: base,
      headers: { range: `bytes=${size + 10}-${size + 20}` },
    })
    expect(unsat.statusCode).toBe(416)
    expect(unsat.headers['content-range']).toBe(`bytes */${size}`)

    // A non-bytes unit → ignore the Range and serve 200 full (RFC 7233 §3.1), not 416.
    const other = await app.inject({ method: 'GET', url: base, headers: { range: 'items=0-9' } })
    expect(other.statusCode).toBe(200)
    expect(other.rawPayload.length).toBe(size)
  })

  it('rejects a traversing folder param with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/s/main/export',
      payload: { folder: '../escape' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('cancel on an already-finished job is a no-op that returns its terminal status', async () => {
    const job = await runJob()
    const res = await app.inject({ method: 'POST', url: `/api/s/main/jobs/${job.id}/cancel` })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { status: string }).status).toBe('succeeded')
  })
})

// Capability degradation (#105): a host with NO durable job layer (no meta-DB) 404s the
// async routes so the client falls back to the synchronous streaming export (#17).
describe('async export degradation (#105): no durable jobs', () => {
  let noJobsApp: FastifyInstance
  beforeEach(async () => {
    noJobsApp = await createApp({ ...fixture(), noJobs: true })
  })
  afterEach(async () => {
    await noJobsApp.close()
  })

  it('404s enqueue, list and download, but the sync streaming export still works', async () => {
    const enq = await noJobsApp.inject({ method: 'POST', url: '/api/s/main/export', payload: {} })
    expect(enq.statusCode).toBe(404)
    expect((enq.json() as { error: string }).error).toBe('jobs_unavailable')

    const list = await noJobsApp.inject({ method: 'GET', url: '/api/s/main/jobs' })
    expect(list.statusCode).toBe(404)

    const dl = await noJobsApp.inject({ method: 'GET', url: '/api/s/main/jobs/whatever/download' })
    expect(dl.statusCode).toBe(404)

    // The synchronous fallback (#17) is unaffected.
    const sync = await noJobsApp.inject({ method: 'GET', url: '/api/s/main/export' })
    expect(sync.statusCode).toBe(200)
    expect(sync.headers['content-type']).toBe('application/zip')
  })
})

// Job ownership (#105): an export job's status/artifact/error is the enqueuer's own data
// — a fellow space member (even a reader with space:read) must 404 on it and never see it
// listed. Password-mode fixture with two members of one space.
describe('async export ownership (#105): a job is private to its principal', () => {
  const authFixture = (): Fixture => ({
    now: '2026-06-20T12:00:00.000Z',
    spaces: [
      {
        slug: 'main',
        displayName: 'Main',
        notes: [{ title: 'Doc A', filePath: 'docs/a.md', content: '# Doc A\n\nbody' }],
      },
    ],
    auth: {
      users: [
        { username: 'sam', password: 'sam-password-1', displayName: 'Sam' },
        { username: 'dana', password: 'dana-password-1', displayName: 'Dana' },
      ],
      members: [
        { space: 'main', username: 'sam', role: 'owner' },
        { space: 'main', username: 'dana', role: 'reader' },
      ],
    },
  })

  let ownApp: FastifyInstance
  beforeEach(async () => {
    ownApp = await createApp(authFixture())
  })
  afterEach(async () => {
    await ownApp.close()
  })

  const loginCookie = async (username: string, password: string): Promise<string> => {
    const login = await ownApp.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username, password },
    })
    expect(login.statusCode).toBe(200)
    return (login.headers['set-cookie'] as string).split(';')[0]
  }

  const runJobAs = async (cookie: string) => {
    const enq = await ownApp.inject({
      method: 'POST',
      url: '/api/s/main/export',
      headers: { cookie },
      payload: {},
    })
    expect(enq.statusCode).toBe(202)
    const { id } = enq.json() as { id: string }

    for (let i = 0; i < 50; i++) {
      const res = await ownApp.inject({
        method: 'GET',
        url: `/api/s/main/jobs/${id}`,
        headers: { cookie },
      })
      expect(res.statusCode).toBe(200)
      const cur = res.json() as { status: string }

      if (['succeeded', 'failed', 'canceled'].includes(cur.status)) {
        return id
      }
      await new Promise((r) => setTimeout(r, 30))
    }
    throw new Error('job did not finish')
  }

  it('a fellow member 404s on the owner’s job status / download / cancel and never sees it listed', async () => {
    const sam = await loginCookie('sam', 'sam-password-1')
    const dana = await loginCookie('dana', 'dana-password-1')
    const jobId = await runJobAs(sam)

    // dana (a reader with space:read, so authz passes) is NOT the job's principal → 404
    // on every job-scoped route (anti-enumeration, same as an unknown id).
    for (const url of [`/api/s/main/jobs/${jobId}`, `/api/s/main/jobs/${jobId}/download`]) {
      expect(
        (await ownApp.inject({ method: 'GET', url, headers: { cookie: dana } })).statusCode,
      ).toBe(404)
    }
    expect(
      (
        await ownApp.inject({
          method: 'POST',
          url: `/api/s/main/jobs/${jobId}/cancel`,
          headers: { cookie: dana },
        })
      ).statusCode,
    ).toBe(404)

    // The "your exports" list is principal-scoped: dana sees none of sam's, sam sees own.
    const danaList = (
      await ownApp.inject({ method: 'GET', url: '/api/s/main/jobs', headers: { cookie: dana } })
    ).json() as { jobs: Array<{ id: string }> }
    expect(danaList.jobs.some((j) => j.id === jobId)).toBe(false)
    const samList = (
      await ownApp.inject({ method: 'GET', url: '/api/s/main/jobs', headers: { cookie: sam } })
    ).json() as { jobs: Array<{ id: string }> }
    expect(samList.jobs.some((j) => j.id === jobId)).toBe(true)

    // sam owns it → 200 + a downloadable artifact.
    const owner = await ownApp.inject({
      method: 'GET',
      url: `/api/s/main/jobs/${jobId}`,
      headers: { cookie: sam },
    })
    expect(owner.statusCode).toBe(200)
    expect((owner.json() as { status: string }).status).toBe('succeeded')
  })
})
