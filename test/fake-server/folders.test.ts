// Folders are first-class (#97): plain (unmarked) folders are durable on-disk,
// the directory channel surfaces empty ones into the tree, a folder delete is a
// single server op, and a space auto-marks its root as a project on first
// provision (item 5). End to end over the production buildApp with only the engine
// + persistence swapped (#18), none-mode so the single principal owns every
// write.

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createApp, type Fixture } from './app.js'

const fixture = (): Fixture => ({
  now: '2026-06-20T12:00:00.000Z',
  capabilities: { spaceCreate: true },
  spaces: [
    {
      slug: 'main',
      displayName: 'Main',
      notes: [
        { title: 'Doc A', filePath: 'docs/a.md', content: 'a' },
        { title: 'Root Note', filePath: 'root.md', content: 'r' },
      ],
    },
  ],
})

let app: FastifyInstance

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })

  return { promise, resolve }
}

beforeEach(async () => {
  app = await createApp(fixture())
})
afterEach(async () => {
  await app.close()
})

type Folder = {
  path: string
  name: string
  count: number
  direct: number
  id?: string
  aliases?: string[]
  pageNoteId?: string
}
const treeFolders = async (space = 'main'): Promise<Folder[]> => {
  const res = await app.inject({ method: 'GET', url: `/api/s/${space}/tree` })
  expect(res.statusCode).toBe(200)
  return res.json().folders as Folder[]
}
const notesIn = async (folder: string, space = 'main'): Promise<{ total: number }> =>
  (await app.inject({ method: 'GET', url: `/api/s/${space}/notes?folder=${folder}` })).json()

describe('folders (#97): create / delete / never-prune', () => {
  it('POST /folders creates a durable EMPTY folder the tree shows with count 0', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/s/main/folders',
      payload: { path: 'ideas' },
    })
    expect(res.statusCode).toBe(200)
    const ideas = (await treeFolders()).find((f) => f.path === 'ideas')
    expect(ideas).toMatchObject({ path: 'ideas', name: 'ideas', count: 0, direct: 0 })
    expect((await notesIn('ideas')).total).toBe(0) // no note materialised
  })

  it('POST /folders nests on slashes (the last segment is the new folder)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/s/main/folders',
      payload: { path: 'a/b/c' },
    })
    expect(res.statusCode).toBe(200)
    const paths = (await treeFolders()).map((f) => f.path)
    expect(paths).toEqual(expect.arrayContaining(['a', 'a/b', 'a/b/c']))
  })

  it('POST /folders on an existing folder is a 409 (no silent overwrite)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/s/main/folders',
      payload: { path: 'docs' },
    })
    expect(res.statusCode).toBe(409)
  })

  it('linearizes two concurrent creates of the same folder as 200 then 409', async () => {
    await app.close()
    const entered = deferred()
    const release = deferred()
    app = await createApp(fixture(), {
      configureWorld: ({ store }) => {
        const makeDir = store.makeDir!.bind(store)
        let first = true

        store.makeDir = async (path, opts) => {
          if (first) {
            first = false
            entered.resolve()
            await release.promise
          }

          return makeDir(path, opts)
        }
      },
    })
    const first = app.inject({
      method: 'POST',
      url: '/api/s/main/folders',
      payload: { path: 'racing-folder' },
    })
    await entered.promise
    const second = app.inject({
      method: 'POST',
      url: '/api/s/main/folders',
      payload: { path: 'racing-folder' },
    })

    expect((await second).statusCode).toBe(200)
    release.resolve()
    expect((await first).statusCode).toBe(409)
  })

  it('DELETE /folders removes the folder AND every note under it, in one call', async () => {
    const del = await app.inject({ method: 'DELETE', url: '/api/s/main/folders?path=docs' })
    expect(del.statusCode).toBe(200)
    expect((await treeFolders()).some((f) => f.path === 'docs')).toBe(false)
    expect((await notesIn('docs')).total).toBe(0)
  })

  it('a folder is NOT pruned when its last note is deleted (never-prune, #97)', async () => {
    const { notes } = (
      await app.inject({ method: 'GET', url: '/api/s/main/notes?folder=docs' })
    ).json()
    await app.inject({ method: 'DELETE', url: `/api/note?id=${notes[0].id}` })
    // The note is gone, but the folder lingers as an (empty) first-class dir.
    expect((await notesIn('docs')).total).toBe(0)
    expect((await treeFolders()).some((f) => f.path === 'docs')).toBe(true)
  })
})

describe('mark-as-project slug (#97/1a)', () => {
  it('derives the slug from the LAST path segment, not the whole path', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/s/main/projects',
      payload: { folderPath: 'team/billing', create: true },
    })
    expect(res.statusCode).toBe(201)
    const row = res.json()
    expect(row.path).toBe('team/billing') // the nested folder is the path
    expect(row.slug).toBe('billing') // …but the slug anchors on the leaf, not 'team-billing'
    expect(row.displayName).toBe('billing')
  })
})

describe('folder identity (#100 phase 3): rename → path-history + stable-URL data', () => {
  it('a rename lazily mints an identity; /tree carries the old path as an alias', async () => {
    // 'docs' (holds Doc A) → 'guides'. A folder move is a rename to a sibling path.
    const res = await app.inject({
      method: 'POST',
      url: '/api/s/main/move-folder',
      payload: { path: 'docs', destinationPath: 'guides' },
    })
    expect(res.statusCode).toBe(200)
    const folders = await treeFolders()
    const guides = folders.find((f) => f.path === 'guides')
    expect(guides).toBeTruthy()
    expect(guides!.aliases).toEqual(['docs']) // the old path → the client's redirect source
    expect(guides!.id).toMatch(/^[A-Za-z0-9_-]{12}$/) // a real lazily-minted folder-id
    // The old path is gone from the LIVE tree (a bookmark to it redirects client-side).
    expect(folders.some((f) => f.path === 'docs')).toBe(false)
  })

  it('accumulates past paths across chained renames', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/s/main/move-folder',
      payload: { path: 'docs', destinationPath: 'a' },
    })
    await app.inject({
      method: 'POST',
      url: '/api/s/main/move-folder',
      payload: { path: 'a', destinationPath: 'b' },
    })
    const b = (await treeFolders()).find((f) => f.path === 'b')
    expect(b!.aliases).toEqual(['docs', 'a'])
    expect(b!.id).toMatch(/^[A-Za-z0-9_-]{12}$/)
  })

  it('a never-moved, never-identified folder carries no id/aliases', async () => {
    const docs = (await treeFolders()).find((f) => f.path === 'docs')
    expect(docs).toBeTruthy()
    expect(docs!.id).toBeUndefined()
    expect(docs!.aliases).toBeUndefined()
  })
})

describe('folder pages (#212): create / resolve / hide-from-children', () => {
  const createPage = (folderPath: string, space = 'main') =>
    app.inject({ method: 'POST', url: `/api/s/${space}/folders/page`, payload: { folderPath } })
  const childrenOf = async (path: string, space = 'main') =>
    (
      await app.inject({ method: 'GET', url: `/api/s/${space}/tree/children?path=${path}` })
    ).json() as {
      notes: Array<{ id: string; title: string; filePath: string }>
    }

  it('POST /folders/page mints the folder identity + writes index.md; the tree carries pageNoteId+id', async () => {
    const res = await createPage('docs')
    expect(res.statusCode).toBe(201)
    const { folderId, pageNoteId, path } = res.json()
    expect(path).toBe('docs')
    expect(folderId).toMatch(/^[A-Za-z0-9_-]{12}$/) // a real lazily-minted folder-id
    expect(pageNoteId).toBeTruthy()
    const docs = (await treeFolders()).find((f) => f.path === 'docs')
    expect(docs!.id).toBe(folderId) // now identified (page-bearing), not just moved
    expect(docs!.pageNoteId).toBe(pageNoteId)
    const rootChildren = await app.inject({ method: 'GET', url: '/api/s/main/tree/children?path=' })
    const docsChild = (rootChildren.json().folders as Folder[]).find((f) => f.path === 'docs')
    expect(docsChild).toMatchObject({ id: folderId, pageNoteId })
  })

  it('rechecks folder existence after a concurrent delete wins the prefix fence', async () => {
    await app.close()
    const entered = deferred()
    const release = deferred()
    app = await createApp(fixture(), {
      configureWorld: ({ store }) => {
        const write = store.write.bind(store)
        let firstPage = true

        store.write = async (input, opts) => {
          if (firstPage && input.fileName === 'index' && !input.originalId) {
            firstPage = false
            entered.resolve()
            await release.promise
          }

          return write(input, opts)
        }
      },
    })
    const page = createPage('docs')
    await entered.promise
    const deletion = await app.inject({
      method: 'DELETE',
      url: '/api/s/main/folders?path=docs',
    })

    expect(deletion.statusCode).toBe(200)
    release.resolve()
    expect((await page).statusCode).toBe(404)
    expect((await treeFolders()).some((folder) => folder.path === 'docs')).toBe(false)
  })

  it('rechecks folder existence after a concurrent move wins the prefix fence', async () => {
    await app.close()
    const entered = deferred()
    const release = deferred()
    app = await createApp(fixture(), {
      configureWorld: ({ store }) => {
        const write = store.write.bind(store)
        let firstPage = true

        store.write = async (input, opts) => {
          if (firstPage && input.fileName === 'index' && !input.originalId) {
            firstPage = false
            entered.resolve()
            await release.promise
          }

          return write(input, opts)
        }
      },
    })
    const page = createPage('docs')
    await entered.promise
    const move = await app.inject({
      method: 'POST',
      url: '/api/s/main/move-folder',
      payload: { path: 'docs', destinationPath: 'guides' },
    })

    expect(move.statusCode).toBe(200)
    release.resolve()
    expect((await page).statusCode).toBe(404)
    const folders = await treeFolders()
    expect(folders.some((folder) => folder.path === 'docs')).toBe(false)
    expect(folders.some((folder) => folder.path === 'guides')).toBe(true)
  })

  it('the page (index.md) is hidden from the folder children but readable directly', async () => {
    const { pageNoteId } = (await createPage('docs')).json()
    const children = await childrenOf('docs')
    expect(children.notes.some((n) => n.filePath.endsWith('/index.md'))).toBe(false) // the cover, not a child
    expect(children.notes.some((n) => n.title === 'Doc A')).toBe(true) // siblings stay
    const note = await app.inject({ method: 'GET', url: `/api/note?id=${pageNoteId}` })
    expect(note.statusCode).toBe(200) // graph/search/direct-address still see it
    expect(note.json().filePath).toBe('docs/index.md')
  })

  it('POST /folders/page can materialise the first authored body directly', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/s/main/folders/page',
      payload: {
        folderPath: 'docs',
        content: '# Docs\n\nSection overview.',
        tags: ['guide'],
        slug: 'docs-home',
      },
    })
    expect(res.statusCode).toBe(201)
    const note = await app.inject({ method: 'GET', url: `/api/note?id=${res.json().pageNoteId}` })
    expect(note.statusCode).toBe(200)
    expect(note.json()).toMatchObject({
      title: 'Docs',
      content: 'Section overview.',
      filePath: 'docs/index.md',
      slug: 'docs-home',
    })
    expect(note.json().frontmatter.tags).toEqual(['guide'])
  })

  it('editing a folder page keeps the reserved index.md basename', async () => {
    const { pageNoteId } = (await createPage('docs')).json()
    const before = await app.inject({ method: 'GET', url: `/api/note?id=${pageNoteId}` })
    expect(before.statusCode).toBe(200)
    const save = await app.inject({
      method: 'POST',
      url: '/api/note',
      payload: {
        originalId: pageNoteId,
        versionToken: before.json().versionToken,
        directory: 'docs',
        content: '# Docs Home\n\nUpdated overview.',
      },
    })
    expect(save.statusCode).toBe(200)
    const after = await app.inject({ method: 'GET', url: `/api/note?id=${pageNoteId}` })
    expect(after.json()).toMatchObject({
      title: 'Docs Home',
      content: 'Updated overview.',
      filePath: 'docs/index.md',
    })
    const children = await childrenOf('docs')
    expect(children.notes.some((n) => n.filePath.endsWith('/index.md'))).toBe(false)
  })

  it('side writes on a folder page also keep the reserved index.md basename', async () => {
    const { pageNoteId } = (await createPage('docs')).json()
    const pin = await app.inject({
      method: 'PUT',
      url: '/api/note/pin',
      payload: { id: pageNoteId, pinned: true },
    })
    expect(pin.statusCode).toBe(200)
    const note = await app.inject({ method: 'GET', url: `/api/note?id=${pageNoteId}` })
    expect(note.json().filePath).toBe('docs/index.md')
    expect(note.json().frontmatter.tags).toContain('always-load')
    const children = await childrenOf('docs')
    expect(children.notes.some((n) => n.filePath.endsWith('/index.md'))).toBe(false)
  })

  it('POST /folders/page refuses an authored empty body before minting identity', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/s/main/folders/page',
      payload: {
        folderPath: 'docs',
        content: '',
      },
    })
    expect(res.statusCode).toBe(400)
    const docs = (await treeFolders()).find((f) => f.path === 'docs')
    expect(docs!.id).toBeUndefined()
    expect(docs!.pageNoteId).toBeUndefined()
    const children = await childrenOf('docs')
    expect(children.notes.some((n) => n.filePath.endsWith('/index.md'))).toBe(false)
  })

  it('POST /folders/page refuses an explicitly empty title before minting identity', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/s/main/folders/page',
      payload: {
        folderPath: 'docs',
        title: '',
      },
    })
    expect(res.statusCode).toBe(400)
    const docs = (await treeFolders()).find((f) => f.path === 'docs')
    expect(docs!.id).toBeUndefined()
    expect(docs!.pageNoteId).toBeUndefined()
  })

  it('a second create on a folder that already has a page is a 409', async () => {
    expect((await createPage('docs')).statusCode).toBe(201)
    expect((await createPage('docs')).statusCode).toBe(409)
  })

  it('create on a non-existent folder is a 404 (no ghost identity minted)', async () => {
    expect((await createPage('nope')).statusCode).toBe(404)
  })

  it('GET /api/folder/:id resolves the folder to its current space + path + page note', async () => {
    const created = (await createPage('docs')).json()
    const res = await app.inject({ method: 'GET', url: `/api/folder/${created.folderId}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      folderId: created.folderId,
      space: 'main',
      path: 'docs',
      pageNoteId: created.pageNoteId,
    })
  })

  it('GET /api/folder/:id 404s an unknown id (anti-enumeration)', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/folder/Zz0000000000' })).statusCode).toBe(
      404,
    )
  })

  it('the durable folder-id survives a rename: /folder/<id> resolves to the NEW path', async () => {
    const created = (await createPage('docs')).json()
    const moved = await app.inject({
      method: 'POST',
      url: '/api/s/main/move-folder',
      payload: { path: 'docs', destinationPath: 'guides' },
    })
    expect(moved.statusCode).toBe(200)
    const res = await app.inject({ method: 'GET', url: `/api/folder/${created.folderId}` })
    expect(res.statusCode).toBe(200)
    expect(res.json().path).toBe('guides') // id stable, path follows the move (resolves like a note id)
  })
})

describe('auto-mark root on first provision (#97 item 5)', () => {
  it('a freshly created space marks its root as a project (handle = the bare space slug)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/spaces',
      payload: { slug: 'fresh', displayName: 'Fresh' },
    })
    expect(created.statusCode).toBe(201)
    const { projects } = (await app.inject({ method: 'GET', url: '/api/s/fresh/projects' })).json()
    const root = (projects as Array<{ path: string; handle: string }>).find((p) => p.path === '')
    expect(root).toBeTruthy()
    expect(root!.handle).toBe('fresh') // a root handle collapses to <space>
  })

  it('the pre-existing default space is NOT auto-marked (only fresh provisions are)', async () => {
    // The fake has no meta-DB, so init() never provisions — `main` stays unmarked,
    // exactly mirroring "respect a human who never marked / unmarked the root".
    const { projects } = (await app.inject({ method: 'GET', url: '/api/s/main/projects' })).json()
    expect((projects as unknown[]).length).toBe(0)
  })
})
