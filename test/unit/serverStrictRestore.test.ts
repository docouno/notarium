import type { FastifyInstance } from 'fastify'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RestoreResponseSchema, TrashRestoreManyResponseSchema } from '@notarium/contract'

import { createServer } from '../../packages/server/src/apps/server/server'

let root: string
let app: FastifyInstance | undefined
let spaceSlug: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'notarium-strict-restore-'))
  await Promise.all([
    mkdir(join(root, 'notes'), { recursive: true }),
    mkdir(join(root, 'spaces'), { recursive: true }),
  ])
  app = await createServer({
    spaces: [{ slug: 'main', engine: 'notarium', notesDir: join(root, 'notes') }],
    spacesRoot: join(root, 'spaces'),
    metaDbUrl: `sqlite:${join(root, 'meta.db')}`,
    authMode: 'none',
    engineDataDir: join(root, 'engine'),
    jobsDataDir: join(root, 'jobs'),
    importStagingDir: join(root, 'jobs', 'imports'),
    pollIntervalMs: 0,
    replayKeyring: {
      path: join(root, 'replay-keys'),
      topology: 'canonical-local',
    },
  })
  await app.ready()
  const space = await app.inject({
    method: 'POST',
    url: '/api/spaces',
    payload: { displayName: 'Restore Test Space' },
  })

  expect(space.statusCode).toBe(201)
  spaceSlug = space.json().slug as string
})

afterEach(async () => {
  await app?.close()
  app = undefined
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const createNote = async (title: string, content: string) => {
  const response = await app!.inject({
    method: 'POST',
    url: `/api/s/${spaceSlug}/notes`,
    payload: { title, content },
  })

  expect(response.statusCode).toBe(200)
  return response.json() as { id: string; filePath: string; versionToken: string }
}

describe('strict single-note restore', () => {
  it('restores history exactly and replays one accepted command once', async () => {
    const created = await createNote('Strict History', 'first body\n')
    const firstHistory = await app!.inject({
      method: 'GET',
      url: `/api/note/revisions?id=${created.id}`,
    })
    const sourceRevisionId = firstHistory.json().revisions[0].revisionId as string
    const updated = await app!.inject({
      method: 'POST',
      url: '/api/note',
      payload: {
        originalId: created.id,
        title: 'Strict History',
        content: 'second body\n',
        versionToken: created.versionToken,
      },
    })

    expect(updated.statusCode).toBe(200)
    const current = await app!.inject({ method: 'GET', url: `/api/note?id=${created.id}` })
    expect(current.json().versionToken).toBe(updated.json().versionToken)
    const request = {
      id: created.id,
      revisionId: sourceRevisionId,
      versionToken: current.json().versionToken as string,
      idempotencyKey: 'history-command-a',
    }
    const restored = await app!.inject({
      method: 'POST',
      url: '/api/note/restore',
      payload: request,
    })

    if (restored.statusCode !== 200) {
      throw new Error(`history restore ${restored.statusCode}: ${restored.body}`)
    }
    expect(RestoreResponseSchema.parse(restored.json())).toMatchObject({
      status: 'succeeded',
      id: created.id,
    })
    const firstResult = restored.json()
    const replay = await app!.inject({
      method: 'POST',
      url: '/api/note/restore',
      payload: request,
    })

    expect(replay.statusCode).toBe(200)
    expect(replay.json()).toEqual(firstResult)
    const live = await app!.inject({ method: 'GET', url: `/api/note?id=${created.id}` })

    expect(live.json().content).toContain('first body')
    expect(await readFile(join(root, 'spaces', spaceSlug, created.filePath), 'utf8')).toContain(
      'first body',
    )
    const history = await app!.inject({
      method: 'GET',
      url: `/api/note/revisions?id=${created.id}`,
    })
    expect(
      history.json().revisions.filter((revision: { kind: string }) => revision.kind === 'restore'),
    ).toHaveLength(1)
    const changedPayload = await app!.inject({
      method: 'POST',
      url: '/api/note/restore',
      payload: { ...request, versionToken: 'changed-before-fresh-validation' },
    })

    expect(changedPayload.statusCode).toBe(409)
    expect(changedPayload.json()).toMatchObject({
      status: 'conflict',
      operationId: firstResult.operationId,
      reason: 'idempotency-conflict',
    })
    const archived = await app!.inject({ method: 'DELETE', url: `/api/s/${spaceSlug}` })
    expect(archived.statusCode).toBe(200)
    const archivedReplay = await app!.inject({
      method: 'POST',
      url: '/api/note/restore',
      payload: request,
    })
    expect(archivedReplay.statusCode).toBe(200)
    expect(archivedReplay.json()).toEqual(firstResult)
  })

  it('restores a tombstone to its stable id/path and replays after success', async () => {
    const created = await createNote('Strict Trash', 'recover me\n')
    expect(
      (
        await app!.inject({
          method: 'DELETE',
          url: `/api/note?id=${created.id}`,
        })
      ).statusCode,
    ).toBe(200)
    const trash = await app!.inject({ method: 'GET', url: `/api/s/${spaceSlug}/trash` })
    const item = trash
      .json()
      .items.find((candidate: { noteId: string }) => candidate.noteId === created.id) as {
      revisionId: string
    }
    const request = {
      id: created.id,
      revisionId: item.revisionId,
      idempotencyKey: 'trash-command-a',
    }
    const restored = await app!.inject({
      method: 'POST',
      url: `/api/s/${spaceSlug}/trash/restore`,
      payload: request,
    })

    if (restored.statusCode !== 200) {
      throw new Error(`trash restore ${restored.statusCode}: ${restored.body}`)
    }
    expect(restored.json()).toMatchObject({
      status: 'succeeded',
      id: created.id,
      filePath: created.filePath,
    })
    const replay = await app!.inject({
      method: 'POST',
      url: `/api/s/${spaceSlug}/trash/restore`,
      payload: request,
    })

    expect(replay.statusCode).toBe(200)
    expect(replay.json()).toEqual(restored.json())
    const live = await app!.inject({ method: 'GET', url: `/api/note?id=${created.id}` })
    expect(live.statusCode).toBe(200)
    expect(live.json().content).toContain('recover me')

    const archived = await app!.inject({ method: 'DELETE', url: `/api/s/${spaceSlug}` })
    expect(archived.statusCode).toBe(200)
    const archivedReplay = await app!.inject({
      method: 'POST',
      url: `/api/s/${spaceSlug}/trash/restore`,
      payload: request,
    })

    expect(archivedReplay.statusCode).toBe(200)
    expect(archivedReplay.json()).toEqual(restored.json())
    const freshAfterArchive = await app!.inject({
      method: 'POST',
      url: `/api/s/${spaceSlug}/trash/restore`,
      payload: { ...request, idempotencyKey: 'fresh-after-archive' },
    })
    expect(freshAfterArchive.statusCode).toBe(404)
  })

  it('persists a stale live token as one stable conflict', async () => {
    const created = await createNote('Stale History', 'unchanged body\n')
    const history = await app!.inject({
      method: 'GET',
      url: `/api/note/revisions?id=${created.id}`,
    })
    const request = {
      id: created.id,
      revisionId: history.json().revisions[0].revisionId as string,
      versionToken: 'v3:stale-command-token',
      idempotencyKey: 'stale-history-command',
    }
    const rejected = await app!.inject({
      method: 'POST',
      url: '/api/note/restore',
      payload: request,
    })

    expect(rejected.statusCode).toBe(409)
    expect(RestoreResponseSchema.parse(rejected.json())).toMatchObject({
      status: 'conflict',
      reason: 'version-conflict',
    })
    const replay = await app!.inject({
      method: 'POST',
      url: '/api/note/restore',
      payload: request,
    })
    expect(replay.statusCode).toBe(409)
    expect(replay.json()).toEqual(rejected.json())
  })

  it('never overwrites a new live note occupying a tombstone path', async () => {
    const deleted = await createNote('Occupied Target', 'old note\n')
    await app!.inject({ method: 'DELETE', url: `/api/note?id=${deleted.id}` })
    const trash = await app!.inject({ method: 'GET', url: `/api/s/${spaceSlug}/trash` })
    const tombstone = trash
      .json()
      .items.find((candidate: { noteId: string }) => candidate.noteId === deleted.id) as {
      revisionId: string
    }
    const occupant = await createNote('Occupied Target', 'new occupant\n')

    expect(occupant.filePath).toBe(deleted.filePath)
    const request = {
      id: deleted.id,
      revisionId: tombstone.revisionId,
      idempotencyKey: 'occupied-trash-command',
    }
    const rejected = await app!.inject({
      method: 'POST',
      url: `/api/s/${spaceSlug}/trash/restore`,
      payload: request,
    })

    expect(rejected.statusCode).toBe(409)
    expect(rejected.json()).toMatchObject({
      status: 'conflict',
      reason: 'physical-target-changed',
    })
    const live = await app!.inject({ method: 'GET', url: `/api/note?id=${occupant.id}` })
    expect(live.json().content).toContain('new occupant')
    expect(await readFile(join(root, 'spaces', spaceSlug, occupant.filePath), 'utf8')).toContain(
      'new occupant',
    )
  })
})

describe('resumable strict trash bulk', () => {
  it('freezes explicit order, reports stale ids and rejects changed replay payloads', async () => {
    const a = await createNote('Bulk Alpha', 'alpha\n')
    const b = await createNote('Bulk Beta', 'beta\n')
    await app!.inject({ method: 'DELETE', url: `/api/note?id=${a.id}` })
    await app!.inject({ method: 'DELETE', url: `/api/note?id=${b.id}` })
    const request = {
      ids: [b.id, a.id, b.id, 'already-gone'],
      idempotencyKey: 'bulk-explicit-command',
    }
    const response = await app!.inject({
      method: 'POST',
      url: `/api/s/${spaceSlug}/trash/restore-many`,
      payload: request,
    })

    if (response.statusCode !== 200) {
      throw new Error(`bulk restore ${response.statusCode}: ${response.body}`)
    }
    const completed = TrashRestoreManyResponseSchema.parse(response.json())
    expect(completed).toMatchObject({
      status: 'completed',
      counts: { total: 3, succeeded: 2, conflict: 1 },
      items: [
        { id: b.id, status: 'succeeded' },
        { id: a.id, status: 'succeeded' },
        { id: 'already-gone', status: 'conflict', reason: 'note_not_in_trash' },
      ],
    })
    const replay = await app!.inject({
      method: 'POST',
      url: `/api/s/${spaceSlug}/trash/restore-many`,
      payload: request,
    })
    expect(replay.statusCode).toBe(200)
    expect(replay.json()).toEqual(response.json())

    const changed = await app!.inject({
      method: 'POST',
      url: `/api/s/${spaceSlug}/trash/restore-many`,
      payload: { ids: [a.id, b.id], idempotencyKey: request.idempotencyKey },
    })
    expect(changed.statusCode).toBe(409)
    expect(changed.json()).toMatchObject({
      status: 'conflict',
      operationId: response.json().operationId,
      reason: 'idempotency-conflict',
    })

    const archived = await app!.inject({ method: 'DELETE', url: `/api/s/${spaceSlug}` })
    expect(archived.statusCode).toBe(200)
    const archivedReplay = await app!.inject({
      method: 'POST',
      url: `/api/s/${spaceSlug}/trash/restore-many`,
      payload: request,
    })
    expect(archivedReplay.statusCode).toBe(200)
    expect(archivedReplay.json()).toEqual(response.json())
  })

  it('returns 202 at the dispatch bound and resumes the same parent to completion', async () => {
    const ids: string[] = []

    for (let index = 0; index < 27; index++) {
      const note = await createNote(`Bulk ${String(index).padStart(2, '0')}`, `${index}\n`)
      ids.push(note.id)
      await app!.inject({ method: 'DELETE', url: `/api/note?id=${note.id}` })
    }
    const request = { ids, idempotencyKey: 'bulk-dispatch-command' }
    const running = await app!.inject({
      method: 'POST',
      url: `/api/s/${spaceSlug}/trash/restore-many`,
      payload: request,
    })

    expect(running.statusCode).toBe(202)
    expect(TrashRestoreManyResponseSchema.parse(running.json())).toMatchObject({
      status: 'running',
      counts: { total: 27, succeeded: 25, queued: 2 },
    })
    const completed = await app!.inject({
      method: 'POST',
      url: `/api/s/${spaceSlug}/trash/restore-many`,
      payload: request,
    })

    expect(completed.statusCode).toBe(200)
    expect(TrashRestoreManyResponseSchema.parse(completed.json())).toMatchObject({
      status: 'completed',
      operationId: running.json().operationId,
      counts: { total: 27, succeeded: 27, queued: 0, pending: 0 },
    })
    const trash = await app!.inject({ method: 'GET', url: `/api/s/${spaceSlug}/trash` })
    expect(trash.json().total).toBe(0)
  }, 20_000)
})
