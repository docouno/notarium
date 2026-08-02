// Space soft-archive / restore / permanent purge (#110), executable HTTP contract over
// the e2e fake. An archived space stops being served by construction (dropped from
// /api/spaces, its slug-scoped routes 404) while its registry row survives so a restore
// brings it back whole; permanent purge is id-addressed, gated on the space being
// already archived and a slug-confirm match, and frees the handle for reuse. No auth
// here — the none-mode system principal passes space:manage, so this pins the wire
// mechanics (the role gate is the #10/#111 packs' job).
//
// The archivable space ('gone') is minted at RUNTIME, not declared in the fixture: a
// config-pinned space (slug frozen by env) is deliberately NOT archivable (#110), and
// every fixture-declared space is config-pinned — only a runtime-minted space is.

import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp, type Fixture } from './app.js'

const fixture = (): Fixture => ({
  now: '2026-06-12T12:00:00.000Z',
  capabilities: { spaceCreate: true },
  spaces: [
    {
      slug: 'keep',
      displayName: 'Keep',
      notes: [
        {
          title: 'Keep Note',
          filePath: 'keep.md',
          modifiedAt: '2026-06-10T00:00:00.000Z',
          createdAt: '2026-06-01T00:00:00.000Z',
          tags: [],
          content: '# Keep Note',
        },
      ],
    },
  ],
})

let app: FastifyInstance
beforeEach(async () => {
  app = await createApp(fixture())
})

const get = (url: string): Promise<LightMyRequestResponse> => app.inject({ method: 'GET', url })
const post = (url: string, payload?: object): Promise<LightMyRequestResponse> =>
  app.inject({ method: 'POST', url, payload })
const del = (url: string, payload?: object): Promise<LightMyRequestResponse> =>
  app.inject({ method: 'DELETE', url, payload })

const slugs = async (url: string): Promise<string[]> =>
  ((await get(url)).json().spaces as Array<{ slug: string }>).map((s) => s.slug).sort()
const archived = async () =>
  (await get('/api/spaces/archived')).json().spaces as Array<{
    id: string
    slug: string
    archivedAt?: string
    archivedBy?: { kind: string; name: string | null; mine: boolean } | null
  }>

/** Mint the runtime, archivable space 'gone' (slug derived from the name). */
const mintGone = async (): Promise<string> => {
  const res = await post('/api/spaces', { displayName: 'Gone' })
  expect(res.statusCode).toBe(201)
  expect(res.json().slug).toBe('gone')
  return res.json().id as string
}

describe('space soft-archive (#110)', () => {
  it('refuses to archive a config-pinned space (its slug is env-frozen)', async () => {
    expect((await del('/api/s/keep')).statusCode).toBe(400)
    expect(await slugs('/api/spaces')).toEqual(['keep'])
  })

  it('archive drops the space from /api/spaces, 404s its routes, lists it as archived', async () => {
    await mintGone()
    expect((await del('/api/s/gone')).statusCode).toBe(200)
    // Gone from the served list; its slug-scoped surfaces 404 (not served).
    expect(await slugs('/api/spaces')).toEqual(['keep'])
    expect((await get('/api/s/gone/notes')).statusCode).toBe(404)
    expect((await get('/api/s/gone/tree')).statusCode).toBe(404)
    // Present in the archived listing, carrying archivedAt + a resolved "deleted by"
    // Author (#13 — none-mode's lone principal is the viewer themselves).
    const arch = await archived()
    expect(arch.map((s) => s.slug)).toEqual(['gone'])
    expect(arch[0].archivedAt).toBeTruthy()
    expect(arch[0].archivedBy).toMatchObject({ kind: 'user', mine: true })
  })

  it('an archived space is NOT mutable through routes that bypass the store (rename, projects) — 404 (#110)', async () => {
    await mintGone()
    await del('/api/s/gone') // archive
    // These routes don't go through spaces.store() (the data/SSE chokepoint that 404s an
    // archived space) — they'd otherwise rename / mark-as-project a deleted space. The
    // invariant is enforced at the authz slug→id resolver: an archived slug resolves to
    // null → hard 404 before the handler, even for the none-mode system principal.
    expect(
      (await app.inject({ method: 'PATCH', url: '/api/s/gone', payload: { displayName: 'Back?' } }))
        .statusCode,
    ).toBe(404)
    expect((await post('/api/s/gone/projects', { path: 'whatever' })).statusCode).toBe(404)
    // It stayed archived and unchanged — the rejected calls didn't un-archive or rename it.
    const arch = await archived()
    expect(arch.map((s) => s.slug)).toEqual(['gone'])
  })

  it('restore brings the whole space back, served again', async () => {
    const id = await mintGone()
    await del('/api/s/gone')
    expect((await post(`/api/spaces/${id}/restore`)).statusCode).toBe(200)
    expect(await slugs('/api/spaces')).toEqual(['gone', 'keep'])
    expect((await get('/api/s/gone/notes')).statusCode).toBe(200)
    expect(await archived()).toEqual([])
  })

  it('restore-many is best-effort: restores several archived spaces in one request, stale ids are reported', async () => {
    const gone = await mintGone()
    const lost = await post('/api/spaces', { displayName: 'Lost' })
    expect(lost.statusCode).toBe(201)
    await del('/api/s/gone')
    await del('/api/s/lost')

    const res = await post('/api/spaces/restore-many', {
      ids: [gone, 'no-such-id', lost.json().id as string],
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      ok: true,
      restored: [
        { id: gone, slug: 'gone' },
        { id: lost.json().id, slug: 'lost' },
      ],
      failed: [{ id: 'no-such-id', reason: 'not_found' }],
    })
    expect(await slugs('/api/spaces')).toEqual(['gone', 'keep', 'lost'])
    expect(await archived()).toEqual([])
  })

  it('the slug is held while archived — a new same-named space gets a soft suffix', async () => {
    await mintGone()
    await del('/api/s/gone')
    const created = await post('/api/spaces', { displayName: 'Gone' }) // server derives slug 'gone'
    expect(created.statusCode).toBe(201)
    expect(created.json().slug).toBe('gone-2') // 'gone' is reserved by the archived space
  })

  it('purge refuses a live space, demands a matching confirm, then erases and frees the slug', async () => {
    const id = await mintGone()
    // A live space cannot be purged — archive is the mandatory safety stop.
    expect((await del(`/api/spaces/${id}`, { confirm: 'gone' })).statusCode).toBe(409)
    await del('/api/s/gone') // archive first
    // A mismatched / missing confirm is refused.
    expect((await del(`/api/spaces/${id}`, { confirm: 'nope' })).statusCode).toBe(400)
    expect((await del(`/api/spaces/${id}`, {})).statusCode).toBe(400)
    // The matching confirm purges it for good.
    expect((await del(`/api/spaces/${id}`, { confirm: 'gone' })).statusCode).toBe(200)
    expect(await archived()).toEqual([])
    expect(await slugs('/api/spaces')).toEqual(['keep'])
    // The slug is free again — a fresh 'gone' takes it with no suffix.
    const created = await post('/api/spaces', { displayName: 'Gone' })
    expect(created.statusCode).toBe(201)
    expect(created.json().slug).toBe('gone')
  })

  it('an unknown / non-archived id answers 404 on restore', async () => {
    const id = await mintGone()
    expect((await post('/api/spaces/no-such-id/restore')).statusCode).toBe(404)
    // A LIVE space id is not restorable (it isn't archived) — same 404.
    expect((await post(`/api/spaces/${id}/restore`)).statusCode).toBe(404)
  })
})
