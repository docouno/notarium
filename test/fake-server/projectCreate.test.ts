// Create-an-empty-project guard (#13 C): POST /api/s/<slug>/projects with the
// `create` flag mints a FRESH folder through the space store before publishing
// its marker, so the route gained a three-state guard:
//   create=true  → the folder must NOT exist yet (409 if it does)
//   create absent → the folder MUST already exist (400 if not) — mark-as-project
// The base conformance fake runs WITHOUT a markerStore (the guard is skipped), so
// this guard is exercised here against a minimal in-memory MarkerStore — the only
// production-only piece (the registry row is the shared boundary, #18). Without
// this, the whole `create` branch is dead in the test suite.

import type { FastifyInstance } from 'fastify'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { CachedStore } from '@notarium/core'
import type { MarkerStore } from '@notarium/server'

import { createApp, type Fixture } from './app.js'

const fixture = (): Fixture => ({
  now: '2026-06-14T12:00:00.000Z',
  spaces: [
    {
      slug: 'team',
      displayName: 'Team',
      notes: [
        {
          id: 'docs-child',
          title: 'Docs child',
          class: 'user-doc',
          filePath: 'docs/child.md',
          content: 'child',
        },
        {
          id: 'race-overview',
          title: 'Race overview',
          class: 'user-doc',
          filePath: 'race/index.md',
          content: 'race overview',
        },
        {
          id: 'between-child',
          title: 'Between child',
          class: 'user-doc',
          filePath: 'between/child.md',
          content: 'child',
        },
        {
          id: 'snapshot-child',
          title: 'Snapshot child',
          class: 'user-doc',
          filePath: 'snapshot/child.md',
          content: 'child',
        },
        {
          id: 'wobble-child',
          title: 'Wobble child',
          class: 'user-doc',
          filePath: 'wobble/child.md',
          content: 'child',
        },
        {
          id: 'failure-overview',
          title: 'Failure overview',
          class: 'user-doc',
          filePath: 'failure/index.md',
          content: 'failure overview',
        },
      ],
    },
  ],
  auth: {
    users: [{ username: 'alice', password: 'alice-password-1' }],
    members: [{ space: 'team', username: 'alice', role: 'owner' }],
  },
})

let teamStore: CachedStore

/** Minimal in-memory MarkerStore over the same logical directory channel as
 *  `teamStore`. A marker write requires the folder to exist and never creates it.
 *  Keyed by the SPACE ID the server addresses it with (#100 phase 4 / #127 — the
 *  fake mints id ≠ slug), so a pre-existing folder is seeded via `seedFolder` AFTER the
 *  app resolved that opaque id, not by the human slug. */
type SeedableMarkerStore = MarkerStore & {
  seedFolder(space: string, path: string): void
  /** Flip the capability the way a host without the anchor already answers it —
   *  mid-test, so a case can prove the refusal is the CAPABILITY talking and not
   *  a project that was never there. */
  setAvailable(value: boolean): void
}
const inMemoryMarkerStore = (): SeedableMarkerStore => {
  const key = (s: string, p: string) => `${s}\0${p}`
  const exists = new Set<string>()
  const markers = new Map<string, string>()
  let available = true
  return {
    available: () => available,
    setAvailable: (value) => {
      available = value
    },
    folderExists: async (space, path) =>
      path === '' || exists.has(key(space, path)) || markers.has(key(space, path)),
    write: async (space, path, raw) => {
      const storeHasFolder = path === '' || (await teamStore.listDirs()).includes(path)

      if (!exists.has(key(space, path)) && !storeHasFolder) {
        throw Object.assign(new Error('marker parent is missing'), { code: 'ENOENT' })
      }
      markers.set(key(space, path), raw)
      exists.add(key(space, path))
    },
    read: async (space, path) => markers.get(key(space, path)) ?? null,
    remove: async (space, path) => {
      markers.delete(key(space, path))
    },
    scan: async () => ({ hits: [], complete: true }),
    seedFolder: (space, path) => {
      exists.add(key(space, path)) // pre-existing folder, keyed by the space's id
    },
  }
}

let app: FastifyInstance
let markerStore: SeedableMarkerStore
let teamId: string
let port: number

const listen = async (instance: FastifyInstance): Promise<number> => {
  await instance.listen({ port: 0, host: '127.0.0.1' })
  return (instance.server.address() as AddressInfo).port
}

const loginCookie = async (): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { identifier: 'alice', password: 'alice-password-1' },
  })
  return res.headers['set-cookie'] as string
}

const patFor = async (cookie: string): Promise<string> => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/me/tokens',
    headers: { cookie },
    payload: { name: 'lifecycle', scope: 'write' },
  })
  expect(created.statusCode).toBe(201)
  return created.json().token as string
}

const startSession = async (bearer: string, project: string) => {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'start_session', arguments: { project } },
    }),
  })
  return ((await res.json()) as { result?: { structuredContent?: Record<string, unknown> } }).result
    ?.structuredContent
}

const callTool = async (bearer: string, name: string, args: Record<string, unknown>) => {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  return (await res.json()) as {
    result?: { isError?: boolean; content?: { type: string; text?: string }[] }
  }
}

const mark = (cookie: string, body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/s/team/projects', headers: { cookie }, payload: body })

beforeEach(async () => {
  markerStore = inMemoryMarkerStore()
  app = await createApp(fixture(), {
    markerStore,
    configureWorld: (world) => {
      if (world.slug === 'team') {
        teamStore = world.store
      }
    },
  })
  port = await listen(app)
  // 'docs' already exists on disk; the store keys by the space's opaque id (#127),
  // minted inside createApp — resolve it off /api/spaces, then seed (alice owns team).
  const cookie = await loginCookie()
  const spaces = (
    await app.inject({ method: 'GET', url: '/api/spaces', headers: { cookie } })
  ).json().spaces as Array<{ id: string; slug: string }>
  teamId = spaces.find((s) => s.slug === 'team')!.id
  for (const folder of ['docs', 'race', 'between', 'snapshot', 'failure', 'wobble']) {
    markerStore.seedFolder(teamId, folder)
  }
})

afterEach(async () => {
  await app.close()
})

describe('POST /projects create guard (#13 C)', () => {
  it('create=true on a FRESH path mints the folder through the store before its marker', async () => {
    const cookie = await loginCookie()
    const res = await mark(cookie, { folderPath: 'roadmap', displayName: 'Roadmap', create: true })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ handle: 'team/roadmap', path: 'roadmap', status: 'active' })
    expect(await teamStore.listDirs()).toContain('roadmap')
    expect(await markerStore.folderExists(teamId, 'roadmap')).toBe(true)
  })

  it('create=true on an EXISTING folder is a 409 conflict (never clobbers/aliases it)', async () => {
    const cookie = await loginCookie()
    const res = await mark(cookie, { folderPath: 'docs', displayName: 'Docs', create: true })
    expect(res.statusCode).toBe(409)
  })

  it('mark (create absent) on a NON-EXISTENT folder is a 400 (mark addresses an existing folder)', async () => {
    const cookie = await loginCookie()
    const res = await mark(cookie, { folderPath: 'ghost' })
    expect(res.statusCode).toBe(400)
  })

  it('mark (create absent) on an EXISTING folder succeeds (201) — the original mark-as-project path', async () => {
    const cookie = await loginCookie()
    const res = await mark(cookie, { folderPath: 'docs', displayName: 'Docs' })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ handle: 'team/docs', path: 'docs' })
  })

  it('a just-created project re-creates as a 409 (the store-owned folder now exists)', async () => {
    const cookie = await loginCookie()
    expect((await mark(cookie, { folderPath: 'plans', create: true })).statusCode).toBe(201)
    expect((await mark(cookie, { folderPath: 'plans', create: true })).statusCode).toBe(409)
  })

  it('create rejects non-portable paths, while an existing legacy folder remains markable', async () => {
    const cookie = await loginCookie()

    for (const folderPath of ['CON', 'NUL', 'foo:bar']) {
      expect((await mark(cookie, { folderPath, create: true })).statusCode).toBe(400)
    }

    markerStore.seedFolder(teamId, 'foo:bar')
    const legacy = await mark(cookie, { folderPath: 'foo:bar', displayName: 'Legacy' })
    expect(legacy.statusCode).toBe(201)
    expect(legacy.json()).toMatchObject({ handle: 'team/legacy', path: 'foo:bar' })
  })
})

describe('project overview auto-pin lifecycle (#311)', () => {
  const createPage = (cookie: string, folderPath: string, tags?: string[] | string) =>
    app.inject({
      method: 'POST',
      url: '/api/s/team/folders/page',
      headers: { cookie },
      payload: { folderPath, content: `# ${folderPath}\n\nOverview.`, tags },
    })

  const readNote = (cookie: string, id: string) =>
    app.inject({ method: 'GET', url: `/api/note?id=${id}`, headers: { cookie } })

  it('pins the first authored page of an active project in the create revision', async () => {
    const cookie = await loginCookie()
    const bearer = await patFor(cookie)
    const project = await mark(cookie, {
      folderPath: 'roadmap',
      displayName: 'Roadmap',
      create: true,
    })
    const page = await createPage(cookie, 'roadmap', ['guide', 'always-load', 'always-load'])
    expect(page.statusCode).toBe(201)
    const pageNoteId = page.json().pageNoteId as string
    const note = await readNote(cookie, pageNoteId)
    expect(note.json().frontmatter.tags).toEqual(['guide', 'always-load'])

    const context = await app.inject({
      method: 'GET',
      url: `/api/s/team/projects/${project.json().id}/agent-context`,
      headers: { cookie },
    })
    expect(context.statusCode).toBe(200)
    expect(context.json().pins).toEqual([
      expect.objectContaining({ noteId: pageNoteId, folderPage: true }),
    ])
    const session = await startSession(bearer, 'team/roadmap')
    expect(
      (session?.project as { alwaysLoad: Array<{ noteId: string }> }).alwaysLoad.map(
        (item) => item.noteId,
      ),
    ).toContain(pageNoteId)
  })

  it('pins an existing page only on a real project transition and respects manual opt-out', async () => {
    const cookie = await loginCookie()
    const page = await createPage(cookie, 'docs', 'guide')
    expect(page.statusCode).toBe(201)
    const pageNoteId = page.json().pageNoteId as string
    const firstMark = await mark(cookie, { folderPath: 'docs', displayName: 'Docs' })
    expect(firstMark.statusCode).toBe(201)
    expect((await readNote(cookie, pageNoteId)).json().frontmatter.tags).toEqual([
      'guide',
      'always-load',
    ])

    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/note/pin',
          headers: { cookie },
          payload: { id: pageNoteId, pinned: false },
        })
      ).statusCode,
    ).toBe(200)
    const unpinned = await readNote(cookie, pageNoteId)
    const edited = await app.inject({
      method: 'POST',
      url: '/api/note',
      headers: { cookie },
      payload: {
        originalId: pageNoteId,
        versionToken: unpinned.json().versionToken,
        directory: 'docs',
        content: '# Docs updated\n\nStill opted out.',
      },
    })
    expect(edited.statusCode).toBe(200)
    expect((await readNote(cookie, pageNoteId)).json().frontmatter.tags).toEqual(['guide'])
    expect((await mark(cookie, { folderPath: 'docs', displayName: 'Docs' })).statusCode).toBe(201)
    expect((await readNote(cookie, pageNoteId)).json().frontmatter.tags).toEqual(['guide'])

    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/s/team/projects/${firstMark.json().id}`,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(200)
    expect((await mark(cookie, { folderPath: 'docs', displayName: 'Docs' })).statusCode).toBe(201)
    expect((await readNote(cookie, pageNoteId)).json().frontmatter.tags).toEqual([
      'guide',
      'always-load',
    ])
  })

  it('does not materialise an overview when a project is created without one', async () => {
    const cookie = await loginCookie()
    expect((await mark(cookie, { folderPath: 'empty', create: true })).statusCode).toBe(201)
    const notes = await app.inject({
      method: 'GET',
      url: '/api/s/team/notes?folder=empty&depth=subtree',
      headers: { cookie },
    })
    expect(notes.statusCode).toBe(200)
    expect(notes.json().notes).toEqual([])
  })

  it('keeps a manual unpin after a mark whose conditional auto-pin was registered first', async () => {
    const cookie = await loginCookie()
    const entered = (() => {
      let resolve!: () => void
      const promise = new Promise<void>((done) => {
        resolve = done
      })
      return { promise, resolve }
    })()
    const release = (() => {
      let resolve!: () => void
      const promise = new Promise<void>((done) => {
        resolve = done
      })
      return { promise, resolve }
    })()
    const writeMarker = markerStore.write.bind(markerStore)
    let held = true

    markerStore.write = async (space, path, raw) => {
      if (held && path === 'race') {
        held = false
        entered.resolve()
        await release.promise
      }

      return writeMarker(space, path, raw)
    }

    const marking = mark(cookie, { folderPath: 'race', displayName: 'Race' })
    await entered.promise
    const unpinning = app.inject({
      method: 'PUT',
      url: '/api/note/pin',
      headers: { cookie },
      payload: { id: 'race-overview', pinned: false },
    })
    release.resolve()
    expect((await marking).statusCode).toBe(201)
    expect((await unpinning).statusCode).toBe(200)
    expect((await readNote(cookie, 'race-overview')).json().frontmatter.tags ?? []).not.toContain(
      'always-load',
    )
  })

  it('lets a folder delete finish after an in-flight mark without leaving a registry ghost', async () => {
    const cookie = await loginCookie()
    let openMarkerWritten!: () => void
    const markerWritten = new Promise<void>((resolve) => {
      openMarkerWritten = resolve
    })
    let openMarkRelease!: () => void
    const markRelease = new Promise<void>((resolve) => {
      openMarkRelease = resolve
    })
    const writeMarker = markerStore.write.bind(markerStore)
    let held = true

    markerStore.write = async (space, path, raw) => {
      await writeMarker(space, path, raw)
      if (held && path === 'race') {
        held = false
        openMarkerWritten()
        await markRelease
      }
    }

    let openDeleteEntered!: () => void
    const deleteEntered = new Promise<void>((resolve) => {
      openDeleteEntered = resolve
    })
    const removeDir = teamStore.removeDir!.bind(teamStore)

    teamStore.removeDir = async (path, opts) => {
      const result = removeDir(path, opts)
      openDeleteEntered()
      return result
    }

    const marking = mark(cookie, { folderPath: 'race', displayName: 'Race' })
    await markerWritten
    const deleting = app.inject({
      method: 'DELETE',
      url: '/api/s/team/folders?path=race',
      headers: { cookie },
    })
    await deleteEntered
    // Give an unfenced delete every ready turn it needs to expose the old ordering:
    // marker removed + empty registry snapshot, then mark publishes its row late.
    await new Promise<void>((resolve) => setImmediate(resolve))
    openMarkRelease()

    const [marked, deleted] = await Promise.all([marking, deleting])
    expect(marked.statusCode).toBe(201)
    expect(deleted.statusCode).toBe(200)
    const projects = await app.inject({
      method: 'GET',
      url: '/api/s/team/projects',
      headers: { cookie },
    })
    expect(projects.statusCode).toBe(200)
    expect(projects.json().projects).toEqual([])
    expect((await teamStore.listDirs()).filter((path) => path === 'race')).toEqual([])
  })

  it('reconciles page-create × mark when the project appears after the pre-write snapshot', async () => {
    const cookie = await loginCookie()
    let openEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      openEntered = resolve
    })
    let openRelease!: () => void
    const release = new Promise<void>((resolve) => {
      openRelease = resolve
    })
    const write = teamStore.write.bind(teamStore)
    let held = true

    teamStore.write = async (input, opts) => {
      if (held && input.fileName === 'index' && !input.originalId) {
        held = false
        openEntered()
        await release
      }

      return write(input, opts)
    }

    const page = createPage(cookie, 'between')
    await entered
    expect((await mark(cookie, { folderPath: 'between', displayName: 'Between' })).statusCode).toBe(
      201,
    )
    openRelease()
    const created = await page
    expect(created.statusCode).toBe(201)
    expect((await readNote(cookie, created.json().pageNoteId)).json().frontmatter.tags).toContain(
      'always-load',
    )
  })

  it('uses the active pre-write snapshot for page-create × unmark', async () => {
    const cookie = await loginCookie()
    const project = await mark(cookie, { folderPath: 'snapshot', displayName: 'Snapshot' })
    expect(project.statusCode).toBe(201)
    let openEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      openEntered = resolve
    })
    let openRelease!: () => void
    const release = new Promise<void>((resolve) => {
      openRelease = resolve
    })
    const write = teamStore.write.bind(teamStore)
    let held = true

    teamStore.write = async (input, opts) => {
      if (held && input.fileName === 'index' && !input.originalId) {
        held = false
        openEntered()
        await release
      }

      return write(input, opts)
    }

    const page = createPage(cookie, 'snapshot')
    await entered
    const unmark = await app.inject({
      method: 'DELETE',
      url: `/api/s/team/projects/${project.json().id}`,
      headers: { cookie },
    })
    expect(unmark.statusCode).toBe(200)
    openRelease()
    const created = await page
    expect(created.statusCode).toBe(201)
    expect((await readNote(cookie, created.json().pageNoteId)).json().frontmatter.tags).toContain(
      'always-load',
    )
  })

  it('marks the space root even after a page has identified it', async () => {
    const cookie = await loginCookie()
    // Writing a page at the root mints a plain folder-identity there, exactly as it does
    // for any other folder.
    const page = await app.inject({
      method: 'POST',
      url: '/api/s/team/folders/page',
      headers: { cookie },
      payload: { folderPath: '', content: '# Team\n\nThe root cover.' },
    })
    expect(page.statusCode).toBe(201)

    // Marking that root then has to ADOPT that row, like every other path. Skipping the
    // adoption because `''` is falsy made the mark collide on UNIQUE(space, path) and
    // answer with a raw constraint error, and keep answering it: the boot scan that
    // prunes a folder row whose marker vanished needs a marker store, which the host
    // hitting this branch does not have. The toggle in Workspace settings is the human's
    // only way in.
    const rootFolderId = page.json().folderId as string
    expect(rootFolderId).toBeTruthy()

    const marked = await mark(cookie, { folderPath: '', displayName: 'Team Root' })
    expect(marked.statusCode).toBe(201)
    // What THIS stand proves is the marker-backed path end to end: a root that a page
    // identified is marked, and the mark reuses that id rather than minting a second.
    // It does not prove the adoption RULE — a marker store is present here, so the id
    // arrives from the marker before the registry row is ever consulted. The rule, and
    // the raw UNIQUE 500 that skipping it caused on a registry-only host, are pinned by
    // `markFolderAsProject … SPACE ROOT` in test/unit/projects.test.ts.
    expect(marked.json()).toMatchObject({ id: rootFolderId, path: '', status: 'active' })
  })

  it('mints the identity of a folder that a page MOVE brings into existence', async () => {
    const cookie = await loginCookie()
    const bearer = await patFor(cookie)
    const page = await createPage(cookie, 'docs')
    expect(page.statusCode).toBe(201)
    const pageNoteId = page.json().pageNoteId as string

    // The destination does not exist yet — move_note creates it. A marker is metadata
    // ABOUT an existing folder and never provisions one, which this stand's marker store
    // models by refusing a folder it has never seen. So the id can only be minted from
    // the move's `finalize`: mint it before the move and the marker write fails, the
    // best-effort catch swallows it, and the folder silently gets no identity at all.
    const moved = await callTool(bearer, 'move_note', {
      ref: pageNoteId,
      toFolder: 'archive/2026',
    })
    expect(moved.result?.isError ?? false).toBe(false)

    const tree = await app.inject({
      method: 'GET',
      url: '/api/s/team/tree',
      headers: { cookie },
    })
    expect(tree.statusCode).toBe(200)
    const landed = (tree.json().folders as Array<{ path: string; id?: string }>).find(
      (f) => f.path === 'archive/2026',
    )
    expect(landed?.id).toBeTruthy()
  })

  it('keeps a successful page create successful when its post-primary auto-pin fails', async () => {
    const cookie = await loginCookie()
    let openEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      openEntered = resolve
    })
    let openRelease!: () => void
    const release = new Promise<void>((resolve) => {
      openRelease = resolve
    })
    const write = teamStore.write.bind(teamStore)
    const mutateTags = teamStore.mutateTags.bind(teamStore)
    let held = true

    teamStore.write = async (input, opts) => {
      if (held && input.fileName === 'index' && !input.originalId) {
        held = false
        openEntered()
        await release
      }

      return write(input, opts)
    }

    // The project appears AFTER the pre-write snapshot, so the pin is the post-primary
    // reconciliation — the one branch where a page create touches mutateTags at all.
    // The injection is armed only once the mark itself is done, so what fails is
    // unambiguously the page's own reconciliation.
    const page = createPage(cookie, 'wobble')
    await entered
    const marked = await mark(cookie, { folderPath: 'wobble', displayName: 'Wobble' })

    teamStore.mutateTags = async () => {
      throw new Error('injected auto-pin failure')
    }
    openRelease()
    const created = await page

    // The page is the PRIMARY mutation: a failed metadata step is logged, never rolled
    // back onto a page that already exists on disk.
    expect(marked.statusCode).toBe(201)
    expect(created.statusCode).toBe(201)
    teamStore.mutateTags = mutateTags
    expect(
      (await readNote(cookie, created.json().pageNoteId)).json().frontmatter.tags ?? [],
    ).not.toContain('always-load')
  })

  it('keeps a successful mark successful when the post-primary auto-pin fails', async () => {
    const cookie = await loginCookie()
    const mutateTags = teamStore.mutateTags.bind(teamStore)

    teamStore.mutateTags = async (input) => {
      if (input.id === 'failure-overview') {
        throw new Error('injected auto-pin failure')
      }

      return mutateTags(input)
    }

    const marked = await mark(cookie, { folderPath: 'failure', displayName: 'Failure' })
    expect(marked.statusCode).toBe(201)
    expect(marked.json()).toMatchObject({ path: 'failure', status: 'active' })
    expect(
      (await readNote(cookie, 'failure-overview')).json().frontmatter.tags ?? [],
    ).not.toContain('always-load')
  })

  it('handles an early reservation read failure while the primary mark is in flight', async () => {
    const cookie = await loginCookie()
    let openReadAttempted!: () => void
    const readAttempted = new Promise<void>((resolve) => {
      openReadAttempted = resolve
    })
    const read = teamStore.read.bind(teamStore)

    teamStore.read = async (id, opts) => {
      if (id === 'failure-overview') {
        openReadAttempted()
        throw new Error('injected reservation read failure')
      }

      return read(id, opts)
    }
    const writeMarker = markerStore.write.bind(markerStore)

    markerStore.write = async (space, path, raw) => {
      if (path === 'failure') {
        await readAttempted
        await new Promise<void>((resolve) => setImmediate(resolve))
      }

      return writeMarker(space, path, raw)
    }
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)

    process.on('unhandledRejection', onUnhandled)
    try {
      const marked = await mark(cookie, { folderPath: 'failure', displayName: 'Failure' })
      expect(marked.statusCode).toBe(201)
      expect(marked.json()).toMatchObject({ path: 'failure', status: 'active' })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

// The marker capability is a runtime fact now, not just a configured path, so the
// branch these gates guard went from "no local notes dir" to "any host without the
// /proc/self/fd anchor". Both routes must refuse BEFORE they mutate anything.
describe('marker capability absent (P5 honest degradation)', () => {
  it('refuses to mark or to create a project, minting neither folder nor marker', async () => {
    const cookie = await loginCookie()

    markerStore.setAvailable(false)
    for (const body of [
      { folderPath: 'docs', displayName: 'Docs' },
      { folderPath: 'roadmap', displayName: 'Roadmap', create: true },
    ]) {
      expect((await mark(cookie, body)).statusCode).toBe(404)
    }
    // A refusal further in would already have minted the folder: `create` goes
    // through the space store before the marker is ever published.
    expect(await teamStore.listDirs()).not.toContain('roadmap')
    await expect(markerStore.read(teamId, 'docs')).resolves.toBeNull()
  })

  it('refuses to rename a project that demonstrably exists', async () => {
    const cookie = await loginCookie()
    const created = await mark(cookie, { folderPath: 'docs', displayName: 'Docs' })

    expect(created.statusCode).toBe(201)
    const id = created.json().id as string
    const before = await markerStore.read(teamId, 'docs')

    // 404 because the capability went away, not because the project did — the
    // same request renames it while the anchor is there.
    markerStore.setAvailable(false)
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/s/team/projects/${id}`,
      headers: { cookie },
      payload: { slug: 'renamed' },
    })

    expect(res.statusCode).toBe(404)
    await expect(markerStore.read(teamId, 'docs')).resolves.toBe(before)
  })

  it('refuses the same rename over MCP, and as a missing project rather than a 500', async () => {
    const cookie = await loginCookie()
    const created = await mark(cookie, { folderPath: 'docs', displayName: 'Docs' })

    expect(created.statusCode).toBe(201)
    const handle = created.json().handle as string
    const bearer = await patFor(cookie)
    const before = await markerStore.read(teamId, 'docs')

    markerStore.setAvailable(false)
    const res = await callTool(bearer, 'rename_project', { project: handle, slug: 'renamed-proj' })

    // `isError` alone cannot carry this: the gateway sets it for an honest
    // ToolFailure and for any unexpected throw alike. The MESSAGE is the whole
    // claim — the tool answers anti-enumeration, not `internal error` from
    // halfway through the marker write.
    expect(res.result?.isError).toBe(true)
    expect(res.result?.content?.[0]?.text).toMatch(/no such project/)
    await expect(markerStore.read(teamId, 'docs')).resolves.toBe(before)
  })
})
