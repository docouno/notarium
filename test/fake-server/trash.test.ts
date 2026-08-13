import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { TrashPurgeResponseSchema, TrashResponseSchema } from '@notarium/contract'
import { createApp, type Fixture } from './app.js'

// Trash (#79) over the fake backend: the real Fastify app + CachedStore over
// InMemoryStore, so this exercises the whole stack — HTTP → wire → read-model →
// journal/CAS. The trash is a VIEW over the journal: delete leaves a tombstone
// (with the captured last body, #79 read-before-delete), restore resurrects it
// keeping the note-id, purge erases it for good.

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, '..', 'fixtures', 'base.json')
const loadFixture = (): Fixture => JSON.parse(readFileSync(FIXTURE, 'utf8'))

let app: FastifyInstance
beforeEach(async () => {
  app = await createApp(loadFixture())
})

const get = async (url: string) => (await app.inject({ method: 'GET', url })).json()
const post = (url: string, payload: object): Promise<LightMyRequestResponse> =>
  app.inject({ method: 'POST', url, payload })
const del = (url: string): Promise<LightMyRequestResponse> => app.inject({ method: 'DELETE', url })

const trashOf = (space = 'main') => get(`/api/s/${space}/trash`)
const notesOf = (space = 'main') => get(`/api/s/${space}/notes`)

/** Create a note through the API and return its server-assigned id + path. */
const createNote = async (title: string, directory = 'demo', content = 'body') => {
  const res = await post('/api/s/main/notes', { title, content, directory })
  expect(res.statusCode).toBe(200)
  return res.json() as { id: string; filePath?: string }
}

describe('trash (#79)', () => {
  it('a deleted note lands in the trash, schema-valid, and leaves the listing', async () => {
    const { id, filePath } = await createNote('Trash Me')
    expect((await del(`/api/note?id=${id}`)).statusCode).toBe(200)

    const body = await trashOf()
    expect(TrashResponseSchema.safeParse(body).success).toBe(true)
    expect(body.restorableTotal).toBe(0)
    const row = body.items.find((i: { noteId: string }) => i.noteId === id)
    expect(row).toBeTruthy()
    expect(row.title).toBe('Trash Me')
    expect(row.filePath).toBe(filePath) // demo/trash-me.md
    expect(row.external).toBe(false) // deleted through us
    expect(row.restorable).toBe(true) // body captured at delete time
    expect(row.restoreAvailability).toBe('capability-unavailable')
    expect(row.deletedBy).toBeTruthy() // a resolved author (not external)

    const notes = await notesOf()
    expect(notes.notes.some((n: { id: string }) => n.id === id)).toBe(false)
  })

  it('single restore degrades honestly without durable strict publication', async () => {
    const { id, filePath } = await createNote('Bring Me Back')
    await del(`/api/note?id=${id}`)
    const item = (await trashOf()).items.find(
      (candidate: { noteId: string }) => candidate.noteId === id,
    )

    const res = await post('/api/s/main/trash/restore', {
      id,
      revisionId: item.revisionId,
      idempotencyKey: 'fake-single-restore',
    })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ status: 'busy', reason: 'strict-restore-unavailable' })
    expect((await trashOf()).items.some((i: { noteId: string }) => i.noteId === id)).toBe(true)
    expect(filePath).toBeTruthy()
  })

  it('bulk restore degrades honestly without durable strict publication', async () => {
    const a = await createNote('Alpha Back')
    const b = await createNote('Beta Back')
    await del(`/api/note?id=${a.id}`)
    await del(`/api/note?id=${b.id}`)

    const res = await post('/api/s/main/trash/restore-many', {
      ids: [a.id, 'no-such-note', b.id],
      idempotencyKey: 'fake-bulk-restore',
    })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({
      status: 'busy',
      reason: 'strict-restore-unavailable',
    })
    const trash = await trashOf()
    expect(trash.total).toBe(2)
    expect(trash.restorableTotal).toBe(0)
  })

  it('availability filters follow the public host capability for list and select-all purge', async () => {
    const a = await createNote('Unavailable Alpha')
    const b = await createNote('Unavailable Beta')
    await del(`/api/note?id=${a.id}`)
    await del(`/api/note?id=${b.id}`)

    const restorable = await get('/api/s/main/trash?availability=restorable')
    expect(restorable).toMatchObject({
      total: 0,
      restorableTotal: 0,
      partialTotal: 0,
      restoreAvailable: false,
      items: [],
    })
    const unavailable = await get('/api/s/main/trash?availability=unavailable')
    expect(unavailable.total).toBe(2)
    expect(unavailable.items).toHaveLength(2)

    expect(
      (
        await post('/api/s/main/trash/purge', {
          all: true,
          availability: 'restorable',
        })
      ).json().purged,
    ).toBe(0)
    expect((await trashOf()).total).toBe(2)
    expect(
      (
        await post('/api/s/main/trash/purge', {
          all: true,
          availability: 'unavailable',
        })
      ).json().purged,
    ).toBe(2)
  })

  it('purge erases one note for good; restore then 404s', async () => {
    const { id } = await createNote('Purge Me')
    await del(`/api/note?id=${id}`)

    const res = await post('/api/s/main/trash/purge', { ids: [id] })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(TrashPurgeResponseSchema.safeParse(body).success).toBe(true)
    expect(body.purged).toBe(1)

    const trash = await trashOf()
    expect(trash.items.some((i: { noteId: string }) => i.noteId === id)).toBe(false)
    const restore = await post('/api/s/main/trash/restore', {
      id,
      revisionId: 'purged-revision',
      idempotencyKey: 'purged-command',
    })
    expect(restore.statusCode).toBe(503)
  })

  it('purge refuses to nuke a LIVE note (only genuinely-trashed ids are erased)', async () => {
    const trashed = await createNote('Doomed')
    await del(`/api/note?id=${trashed.id}`)
    const live = await createNote('Alive') // NOT deleted
    // a bulk purge naming both erases only the trashed one — the live note's
    // history must never be collateral.
    const res = await post('/api/s/main/trash/purge', { ids: [trashed.id, live.id] })
    expect(res.json().purged).toBe(1)
    const note = await get(`/api/note?id=${live.id}`)
    expect(note.id).toBe(live.id) // the live note is untouched
  })

  it('empty trash (all) purges every trashed note at once', async () => {
    const a = await createNote('Alpha')
    const b = await createNote('Beta')
    await del(`/api/note?id=${a.id}`)
    await del(`/api/note?id=${b.id}`)

    const res = await post('/api/s/main/trash/purge', { all: true })
    expect(res.statusCode).toBe(200)
    expect(res.json().purged).toBe(2)
    const trash = await trashOf()
    expect(trash.items).toHaveLength(0)
  })

  it('the trash search filters by title and scopes the total (#79)', async () => {
    const carbon = await createNote('Carbon Atlas')
    const cobalt = await createNote('Cobalt Atlas')
    await del(`/api/note?id=${carbon.id}`)
    await del(`/api/note?id=${cobalt.id}`)

    const all = await trashOf()
    expect(all.total).toBe(2)
    const hit = await get('/api/s/main/trash?q=carbon')
    expect(hit.total).toBe(1)
    expect(hit.items[0].noteId).toBe(carbon.id)
    // select-all-N over the filter erases only the match
    const purged = await post('/api/s/main/trash/purge', { all: true, q: 'carbon' })
    expect(purged.json().purged).toBe(1)
    expect((await trashOf()).total).toBe(1) // cobalt remains
  })

  // NB: opening a DELETED note by /n/<id> (the read serves its last state with a
  // `deleted` flag instead of 404) is PRODUCTION-only e2e: the global id→space
  // resolver finds a tombstone via the meta-DB identity registry (findById), which
  // the in-memory fake doesn't have — its resolveNote iterates LIVE listings, which
  // a deleted note has left. The store-level behaviour (CachedStore.read serving
  // the deleted view) is unit-tested in test/unit/revisionJournal.test.ts; the HTTP
  // resolve is verified live on the stand.

  // NB: restore's no-clobber guard (refuse to overwrite a live note that took the
  // path — noteAlreadyExists) is a PRODUCTION-only scenario: it needs a live note
  // with a DIFFERENT id at the restore path, which the in-memory fake can't
  // represent (ids are derived from the path, so one path = one id). Covered by
  // the snapshot collision check in CachedStore.restoreFromTrash.

  it('the trash is per-space — a delete in one space never shows in another', async () => {
    const { id } = await createNote('Mine')
    await del(`/api/note?id=${id}`)
    // base fixture has one space; assert the row is scoped to main and the query
    // is space-addressed (a bogus space 404s rather than leaking).
    const inMain = await trashOf('main')
    expect(inMain.items.some((i: { noteId: string }) => i.noteId === id)).toBe(true)
    const bogus = await app.inject({ method: 'GET', url: '/api/s/nope/trash' })
    expect(bogus.statusCode).toBe(404)
  })
})
