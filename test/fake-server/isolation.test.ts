// The two-space isolation pack (#16 — isolation-surfaces.md §7, executable):
// space A carries a marker note with a unique token, space B must never see it
// through ANY reading surface. Today there is one all-access principal, so the
// per-id surfaces legitimately serve both spaces — the "B's principal can't
// read A at all" leg arrives with #10 on this same scaffold; what THIS pack
// pins is the by-construction isolation of every space-scoped surface plus the
// traversal and capability fences.
//
// Note paths are unique across spaces on purpose: the fake engine derives
// `fake-<slugged-path>` ids from paths alone (see app.ts).

import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp, type Fixture } from './app.js'

const MARKER = 'xyzzy-isolation-7741'

const fixture = (): Fixture => ({
  now: '2026-06-12T12:00:00.000Z',
  spaces: [
    {
      slug: 'alpha',
      displayName: 'Alpha',
      notes: [
        {
          title: 'Alpha Marker',
          filePath: 'secrets/alpha-marker.md',
          modifiedAt: '2026-06-10T00:00:00.000Z',
          createdAt: '2026-06-01T00:00:00.000Z',
          tags: ['secret'],
          content: `# Alpha Marker\n\nsecret token ${MARKER}. Links to [[Alpha Buddy]].`,
        },
        {
          title: 'Alpha Buddy',
          filePath: 'secrets/alpha-buddy.md',
          modifiedAt: '2026-06-10T00:00:00.000Z',
          createdAt: '2026-06-02T00:00:00.000Z',
          tags: [],
          content: '# Alpha Buddy\n\nplain.',
        },
      ],
    },
    {
      slug: 'beta',
      displayName: 'Beta',
      notes: [
        {
          title: 'Beta Note',
          filePath: 'work/beta-note.md',
          modifiedAt: '2026-06-09T00:00:00.000Z',
          createdAt: '2026-06-03T00:00:00.000Z',
          tags: [],
          // The wiki-link names A's marker by its exact title — it must stay a
          // ghost in B, never resolve across the boundary.
          content: '# Beta Note\n\nMentions [[Alpha Marker]] by name.',
        },
      ],
    },
  ],
})

let app: FastifyInstance
beforeEach(async () => {
  app = await createApp(fixture())
})

const get = async (url: string) => (await app.inject({ method: 'GET', url })).json()
const post = (url: string, payload: object): Promise<LightMyRequestResponse> =>
  app.inject({ method: 'POST', url, payload })

describe('two-space isolation: B never sees A (space-scoped surfaces)', () => {
  it('lists, tree and counts in beta carry no alpha note', async () => {
    const notes = await get('/api/s/beta/notes')
    expect(notes.total).toBe(1)
    expect(JSON.stringify(notes)).not.toContain(MARKER)
    expect(JSON.stringify(notes)).not.toContain('alpha-marker')

    const tree = await get('/api/s/beta/tree')
    expect(tree.stats.total).toBe(1) // counts are data too — they must not leak
    expect(tree.folders.map((f: { path: string }) => f.path)).toEqual(['work'])

    const buckets = await get('/api/s/beta/notes/buckets?group=day&sort=created')
    expect(buckets.total).toBe(1)
  })

  it('search in beta does not find the alpha marker', async () => {
    const hits = await get(`/api/s/beta/search?q=${MARKER}`)
    expect(hits.results).toEqual([])
    const byTitle = await get('/api/s/beta/search?q=Alpha Marker')

    // Only B's own note (which mentions the words) may answer — never A's.
    for (const r of byTitle.results) {
      expect(r.filePath).not.toContain('alpha-marker')
    }
  })

  it('the beta graph has no alpha nodes/edges; the cross-space wiki-link stays a ghost', async () => {
    const g = await get('/api/s/beta/graph')
    const real = g.nodes.filter((n: { ghost: boolean }) => !n.ghost)
    expect(real.map((n: { id: string }) => n.id)).toEqual(['fake-work-beta-note'])
    // [[Alpha Marker]] from B must NOT resolve into A's note — it is a ghost
    // with prefill, exactly like any unwritten target.
    const ghost = g.nodes.find((n: { ghost: boolean }) => n.ghost)
    expect(ghost).toBeTruthy()
    expect(ghost.prefillTitle).toBe('Alpha Marker')
    expect(g.links.every((l: { target: string }) => l.target !== 'fake-secrets-alpha-marker')).toBe(
      true,
    )
  })

  it('SSE: a beta subscriber gets no events from writes in alpha', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as { port: number }
    const ctrl = new AbortController()
    const res = await fetch(`http://127.0.0.1:${port}/api/s/beta/events`, { signal: ctrl.signal })
    const reader = res.body!.getReader()
    await reader.read() // initial status snapshot

    const save = await fetch(`http://127.0.0.1:${port}/api/s/alpha/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Alpha Fresh', directory: 'secrets', content: 'new' }),
    })
    expect(save.status).toBe(200)

    // The write above DID emit on alpha's bus; beta's stream must stay silent —
    // race the reader against a generous timer.
    const next = await Promise.race([
      reader.read().then((r) => new TextDecoder().decode(r.value)),
      new Promise<string>((resolve) => setTimeout(() => resolve('SILENT'), 400)),
    ])
    ctrl.abort()
    expect(next).toBe('SILENT')
  })

  it('SSE: one active socket can explicitly multiplex a readable foreign space', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as { port: number }
    const ctrl = new AbortController()
    const res = await fetch(`http://127.0.0.1:${port}/api/s/beta/events?watch=alpha`, {
      signal: ctrl.signal,
    })
    const reader = res.body!.getReader()
    await reader.read()

    const save = await fetch(`http://127.0.0.1:${port}/api/s/alpha/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Alpha Watched', directory: 'secrets', content: 'new' }),
    })
    expect(save.status).toBe(200)

    const next = await Promise.race([
      reader.read().then((result) => new TextDecoder().decode(result.value)),
      new Promise<string>((resolve) => setTimeout(() => resolve('SILENT'), 1_000)),
    ])
    expect(next).not.toBe('SILENT')
    expect(next).toContain('changed')
    const foreignRemainder = await Promise.race([
      reader.read().then((result) => new TextDecoder().decode(result.value)),
      new Promise<string>((resolve) => setTimeout(() => resolve('SILENT'), 400)),
    ])

    expect(foreignRemainder).toBe('SILENT')
    ctrl.abort()
  })

  it('a fresh note in alpha is invisible to beta but visible to alpha', async () => {
    await post('/api/s/alpha/notes', { title: 'Alpha Fresh', directory: 'secrets', content: 'x' })
    const alpha = await get('/api/s/alpha/notes')
    expect(alpha.notes.some((n: { title: string }) => n.title === 'Alpha Fresh')).toBe(true)
    const beta = await get('/api/s/beta/notes')
    expect(beta.notes.some((n: { title: string }) => n.title === 'Alpha Fresh')).toBe(false)
  })
})

describe('per-id surfaces: the registry is the space arbiter', () => {
  it('GET /api/note resolves a note from each space by id alone (space-free /n/<id>)', async () => {
    const a = await get('/api/note?id=fake-secrets-alpha-marker')
    expect(a.id).toBe('fake-secrets-alpha-marker')
    const b = await get('/api/note?id=fake-work-beta-note')
    expect(b.id).toBe('fake-work-beta-note')
  })

  it('an unknown id answers 404 — same shape as "no access" will be (#10)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/note?id=fake-no-such' })
    expect(res.statusCode).toBe(404)
  })

  it('a previews batch spanning spaces serves each id from its own space; unknown ids are silently absent', async () => {
    const res = await post('/api/previews', {
      ids: ['fake-secrets-alpha-marker', 'fake-work-beta-note', 'fake-ghost-id'],
    })
    expect(res.statusCode).toBe(200)
    const { previews } = res.json()
    expect(previews['fake-secrets-alpha-marker'].snippet).toContain(MARKER)
    expect(previews['fake-work-beta-note']).toBeTruthy()
    expect(previews['fake-ghost-id']).toBeUndefined()
  })
})

describe('traversal fences (our boundary, before any engine)', () => {
  it.each([
    ['../outside', 400],
    ['/etc', 400],
    ['a/../../b', 400],
  ])('create with directory %s → %i', async (directory, status) => {
    const res = await post('/api/s/alpha/notes', { title: 'Esc', directory, content: 'x' })
    expect(res.statusCode).toBe(status)
  })

  it('note move with a traversal destination → 400', async () => {
    const res = await post('/api/move', {
      id: 'fake-secrets-alpha-marker',
      destinationPath: '../outside/marker.md',
    })
    expect(res.statusCode).toBe(400)
  })

  it('folder move with traversal in either side → 400', async () => {
    expect(
      (await post('/api/s/alpha/move-folder', { path: '../secrets', destinationPath: 'x' }))
        .statusCode,
    ).toBe(400)
    expect(
      (await post('/api/s/alpha/move-folder', { path: 'secrets', destinationPath: '/abs' }))
        .statusCode,
    ).toBe(400)
  })
})

describe('space management capability', () => {
  it('a static host (no createSpace) hides creation as 404', async () => {
    const res = await post('/api/spaces', { slug: 'gamma' })
    expect(res.statusCode).toBe(404)
  })

  it('a namespace-owning host mints a space and serves it immediately', async () => {
    const capable = await createApp({ ...fixture(), capabilities: { spaceCreate: true } })
    const created = await capable.inject({
      method: 'POST',
      url: '/api/spaces',
      payload: { slug: 'gamma', displayName: 'Gamma' },
    })
    expect(created.statusCode).toBe(201)
    const list = (await capable.inject({ method: 'GET', url: '/api/spaces' })).json()
    expect(list.spaces.some((s: { slug: string }) => s.slug === 'gamma')).toBe(true)
    const notes = (await capable.inject({ method: 'GET', url: '/api/s/gamma/notes' })).json()
    expect(notes).toEqual({ notes: [], total: 0 })
    // The slug is also a path segment, so it MUST stay traversal-safe. Create now
    // SANITISES its input through slugify (#123) rather than 400-ing it — a path-traversal
    // attempt is neutralised to a safe handle (`../up` → `up`), never written to disk as
    // given. The security property (no `/`, no `..` in the handle/notesDir) is what holds.
    const junk = await capable.inject({
      method: 'POST',
      url: '/api/spaces',
      payload: { slug: '../up' },
    })
    expect(junk.statusCode).toBe(201)
    expect(junk.json().slug).toMatch(/^[a-z0-9_-]+$/)
    expect(junk.json().slug).not.toContain('..')
    // Input that sanitises to nothing (no name to derive a handle from) is still refused.
    const empty = await capable.inject({
      method: 'POST',
      url: '/api/spaces',
      payload: { slug: '///' },
    })
    expect(empty.statusCode).toBe(400)
    await capable.close()
  })
})
