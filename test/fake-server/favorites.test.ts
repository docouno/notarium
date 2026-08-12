import type { FastifyInstance } from 'fastify'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  BucketsResponseSchema,
  FavoriteMutationResponseSchema,
  FavoritesResponseSchema,
  NotesResponseSchema,
  ProjectsResponseSchema,
  TreeResponseSchema,
} from '@notarium/contract'

import { createApp, type Fixture } from './app.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, '..', 'fixtures', 'base.json')
const loadFixture = (): Fixture => JSON.parse(readFileSync(FIXTURE, 'utf8'))

let app: FastifyInstance

beforeEach(async () => {
  app = await createApp(loadFixture())
})

afterEach(async () => {
  await app.close()
})

const get = async (url: string) => (await app.inject({ method: 'GET', url })).json()

describe('favorites (#42)', () => {
  it('pins a note by stable id and drives the Feed favorite facet', async () => {
    const notes = await get('/api/s/main/notes')
    expect(NotesResponseSchema.safeParse(notes).success).toBe(true)
    const carbon = notes.notes.find((n: { title: string }) => n.title === 'Carbon')
    expect(carbon?.id).toBeTruthy()

    const put = await app.inject({
      method: 'PUT',
      url: '/api/s/main/favorites',
      payload: { kind: 'note', id: carbon.id },
    })
    expect(put.statusCode).toBe(200)
    expect(FavoriteMutationResponseSchema.safeParse(put.json()).success).toBe(true)

    const favorites = await get('/api/s/main/favorites')
    expect(FavoritesResponseSchema.safeParse(favorites).success).toBe(true)
    expect(favorites.items).toHaveLength(1)
    expect(favorites.items[0]).toMatchObject({
      kind: 'note',
      id: carbon.id,
      note: { title: 'Carbon' },
    })

    const filtered = await get('/api/s/main/notes?favorite=1')
    expect(NotesResponseSchema.safeParse(filtered).success).toBe(true)
    expect(filtered.total).toBe(1)
    expect(filtered.notes[0].id).toBe(carbon.id)

    const buckets = await get('/api/s/main/notes/buckets?favorite=1&sort=modified&group=month')
    expect(BucketsResponseSchema.safeParse(buckets).success).toBe(true)
    expect(buckets.total).toBe(1)

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/s/main/favorites/note/${carbon.id}`,
    })
    expect(del.statusCode).toBe(200)
    expect((await get('/api/s/main/favorites')).total).toBe(0)
    expect((await get('/api/s/main/notes?favorite=1')).total).toBe(0)
  })

  it('pins projects by project id and plain folders by lazily minted folder id', async () => {
    const folder = await app.inject({
      method: 'POST',
      url: '/api/s/main/folders',
      payload: { path: 'ideas' },
    })
    expect(folder.statusCode).toBe(200)

    const folderPut = await app.inject({
      method: 'PUT',
      url: '/api/s/main/favorites',
      payload: { kind: 'folder', path: 'ideas' },
    })
    expect(folderPut.statusCode).toBe(200)
    const folderFavorite = folderPut.json()
    expect(FavoriteMutationResponseSchema.safeParse(folderFavorite).success).toBe(true)
    expect(folderFavorite.item).toMatchObject({ kind: 'folder', folder: { path: 'ideas' } })
    expect(folderFavorite.item.id).toMatch(/^[A-Za-z0-9_-]{12}$/)

    const treeAfterFolder = await get('/api/s/main/tree')
    expect(TreeResponseSchema.safeParse(treeAfterFolder).success).toBe(true)
    expect(treeAfterFolder.folders.find((f: { path: string }) => f.path === 'ideas')?.id).toBe(
      folderFavorite.item.id,
    )

    const mark = await app.inject({
      method: 'POST',
      url: '/api/s/main/projects',
      payload: { folderPath: 'demo' },
    })
    expect(mark.statusCode).toBe(201)
    const project = mark.json()
    expect(ProjectsResponseSchema.safeParse({ projects: [project] }).success).toBe(true)

    const projectPut = await app.inject({
      method: 'PUT',
      url: '/api/s/main/favorites',
      payload: { kind: 'project', id: project.id },
    })
    expect(projectPut.statusCode).toBe(200)
    expect(FavoriteMutationResponseSchema.safeParse(projectPut.json()).success).toBe(true)

    const favorites = await get('/api/s/main/favorites')
    expect(FavoritesResponseSchema.safeParse(favorites).success).toBe(true)
    expect(favorites.items.map((i: { kind: string }) => i.kind).sort()).toEqual([
      'folder',
      'project',
    ])
    expect(favorites.items.find((i: { kind: string }) => i.kind === 'folder')).toMatchObject({
      id: folderFavorite.item.id,
      folder: { path: 'ideas' },
    })
    expect(favorites.items.find((i: { kind: string }) => i.kind === 'project')).toMatchObject({
      id: project.id,
      project: { path: 'demo', displayName: 'demo' },
    })
  })

  // Favorite a plain folder, then mark THAT SAME folder as a project — the shared
  // identity row flips folder→project keeping the id, so the stored kind='folder'
  // favorite no longer resolves as a folder. Helper returns the adopted id.
  const favoriteThenMark = async (): Promise<string> => {
    await app.inject({ method: 'POST', url: '/api/s/main/folders', payload: { path: 'ideas' } })
    const put = await app.inject({
      method: 'PUT',
      url: '/api/s/main/favorites',
      payload: { kind: 'folder', path: 'ideas' },
    })
    expect(put.statusCode).toBe(200)
    const folderId = put.json().item.id as string
    expect(folderId).toMatch(/^[A-Za-z0-9_-]{12}$/)
    const mark = await app.inject({
      method: 'POST',
      url: '/api/s/main/projects',
      payload: { folderPath: 'ideas' },
    })
    expect(mark.statusCode).toBe(201)
    expect(mark.json().id).toBe(folderId) // project adopts the folder identity
    return folderId
  }

  it('keeps a folder favorite alive when its folder is marked as a project, and un-favorites by entity id despite the KIND MISMATCH', async () => {
    const folderId = await favoriteThenMark()

    // The favorite must NOT vanish — it surfaces as a PROJECT favorite for the same id.
    const afterMark = await get('/api/s/main/favorites')
    expect(FavoritesResponseSchema.safeParse(afterMark).success).toBe(true)
    expect(afterMark.items).toHaveLength(1)
    expect(afterMark.items[0]).toMatchObject({
      kind: 'project',
      id: folderId,
      project: { path: 'ideas' },
    })

    // DELETE with the SURFACED kind ('project') while the STORED row is STILL 'folder'
    // (NO intervening re-favorite): only the kind-agnostic removeByEntity clears it —
    // a kind-specific delete('project', id) would miss the stored 'folder' row.
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/s/main/favorites/project/${folderId}`,
    })
    expect(del.statusCode).toBe(200)
    expect((await get('/api/s/main/favorites')).total).toBe(0)
  })

  it('re-favoriting a folder-turned-project stays a single row (idempotent per entity)', async () => {
    const folderId = await favoriteThenMark()

    // Re-favoriting the now-project must NOT create a second row alongside the stored
    // 'folder' row — `add` clears the entity's other kinds inside its own transaction.
    const rePut = await app.inject({
      method: 'PUT',
      url: '/api/s/main/favorites',
      payload: { kind: 'project', id: folderId },
    })
    expect(rePut.statusCode).toBe(200)
    const favorites = await get('/api/s/main/favorites')
    expect(favorites.items).toHaveLength(1)
    expect(favorites.total).toBe(1)
    expect(favorites.items[0]).toMatchObject({ kind: 'project', id: folderId })
  })
})
