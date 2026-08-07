// Runtime space creation on the notarium engine (#69), end to end through the
// real production assembly (createServer, not the e2e fake). Pinned here:
//   - `spacesRoot` set ⇒ /api/config advertises spaceCreate; POST /api/spaces
//     mints `<spacesRoot>/<slug>` and the new space is immediately served;
//   - a created space SURVIVES A RESTART even though it is never in
//     SPACES_CONFIG — it lives in the meta-DB registry and configFor rebuilds
//     its notesDir from the convention (without this it would vanish, files
//     intact but unserved);
//   - a freshly created note resolves by id in the very next request (the
//     write-behind identity flush is forced on create, #21/#69 B).
// AUTH_MODE=none keeps the harness to one principal that sees everything.

import type { FastifyInstance } from 'fastify'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { noteFileBase } from '@notarium/core'

import { createServer } from '../../packages/server/src/apps/server/server'
import { serializeMarker } from '../../packages/server/src/services/projects'

let root: string
const apps: FastifyInstance[] = []

const boot = async (configuredSpaces: string[]): Promise<FastifyInstance> => {
  for (const slug of configuredSpaces) {
    await mkdir(join(root, slug), { recursive: true })
  }
  const app = await createServer({
    spaces: configuredSpaces.map((slug) => ({
      slug,
      engine: 'notarium' as const,
      notesDir: join(root, slug),
    })),
    metaDbUrl: `sqlite:${join(root, 'meta.db')}`,
    authMode: 'none',
    engineDataDir: join(root, 'engine'),
    jobsDataDir: join(root, 'jobs'),
    importStagingDir: join(root, 'jobs', 'imports'),
    spacesRoot: root,
    pollIntervalMs: 0,
  })
  await app.ready()
  apps.push(app)
  return app
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nt-spacecreate-'))
})
afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close()
  }
  // Retry the teardown: under heavy parallel load the sqlite index DBs may still
  // be checkpointing their WAL as rm walks the tree (ENOTEMPTY) — close awaits
  // the flushes, but the OS-level file unlink can lag a beat behind.
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('createServer — runtime space creation (#69)', () => {
  it('advertises the capability, mints a served space, and survives a restart', async () => {
    const app = await boot(['main'])

    const config = (await app.inject({ method: 'GET', url: '/api/config' })).json()
    expect(config.capabilities.spaceCreate).toBe(true)

    // Mint a space that is NOT in SPACES_CONFIG.
    const created = await app.inject({
      method: 'POST',
      url: '/api/spaces',
      payload: { slug: 'work', displayName: 'Work' },
    })
    expect(created.statusCode).toBe(201)

    // It is listed and its notes mount exists on disk.
    const listed = (await app.inject({ method: 'GET', url: '/api/spaces' })).json()
    expect(listed.spaces.map((s: { slug: string }) => s.slug)).toContain('work')
    expect((await stat(join(root, 'work'))).isDirectory()).toBe(true)

    // The space is live: create a note in it, then read it back by id in the
    // next request (the create→read race the flush-on-create fix closes).
    const note = await app.inject({
      method: 'POST',
      url: '/api/s/work/notes',
      payload: { title: 'First In Work' },
    })
    expect(note.statusCode).toBe(200)
    const id = note.json().id as string
    const byId = await app.inject({ method: 'GET', url: `/api/note?id=${id}` })
    expect(byId.statusCode).toBe(200)
    expect(byId.json().space).toBe('work')

    // Restart with ONLY the configured space — the created one must be
    // recovered from the meta-DB registry, not lost.
    await apps.splice(apps.indexOf(app), 1)[0].close()
    const restarted = await boot(['main'])
    const afterRestart = (await restarted.inject({ method: 'GET', url: '/api/spaces' })).json()
    expect(afterRestart.spaces.map((s: { slug: string }) => s.slug)).toContain('work')
    // And it still serves the note created before the restart.
    const stillThere = await restarted.inject({ method: 'GET', url: `/api/note?id=${id}` })
    expect(stillThere.statusCode).toBe(200)
    expect(stillThere.json().title).toBe('First In Work')
  })

  it('derives the handle from the NAME — any language, soft-suffix, id fallback (#123)', async () => {
    const app = await boot(['main'])
    const create = (displayName: string) =>
      app.inject({ method: 'POST', url: '/api/spaces', payload: { displayName } })

    // A plain name → slugified handle (no client-side slug needed anymore).
    expect((await create('Public Space')).json().slug).toBe('public-space')
    // Cyrillic → transliterated, not collapsed to empty.
    expect((await create('Моё Пространство')).json().slug).toBe('moio-prostranstvo')
    // Accented Latin → clean ASCII (NFKD).
    expect((await create('Łódź')).json().slug).toBe('lodz')

    // A name with no romanisable characters (CJK) still creates — an id-shaped,
    // addressable, traversal-safe handle — and keeps the name as the label.
    const cjk = await create('你好世界')
    expect(cjk.statusCode).toBe(201)
    expect(cjk.json().slug).toMatch(/^[a-z0-9_-]+$/)
    expect(cjk.json().slug).not.toBe('')
    expect(cjk.json().displayName).toBe('你好世界')
    // …and it is immediately served at its derived handle.
    const cjkNotes = await app.inject({ method: 'GET', url: `/api/s/${cjk.json().slug}/notes` })
    expect(cjkNotes.statusCode).toBe(200)

    // Same name twice → distinct handles via soft suffix (a derived handle is a
    // convenience, never a 409 — that rule is reserved for an explicit rename).
    expect((await create('Team')).json().slug).toBe('team')
    expect((await create('Team')).json().slug).toBe('team-2')
    expect((await create('Team')).json().slug).toBe('team-3')

    // Nothing to derive a handle from → a name is required (400, never a junk space).
    expect((await create('')).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/spaces', payload: {} })).statusCode).toBe(
      400,
    )
  })

  it('rejects non-durable runtime display names before minting a space', async () => {
    const app = await boot(['main'])
    const loneSurrogate = String.fromCharCode(0xd800)

    for (const displayName of ['bad\nname', `bad${loneSurrogate}`, 'x'.repeat(201)]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/spaces',
        payload: { displayName },
      })

      expect(response.statusCode).toBe(400)
    }

    const listed = (await app.inject({ method: 'GET', url: '/api/spaces' })).json()
    expect(listed.spaces.map((space: { slug: string }) => space.slug)).toEqual(['main'])
  })

  it('stores a Windows-device handle under a portable physical directory and recovers it', async () => {
    const app = await boot(['main'])
    const created = await app.inject({
      method: 'POST',
      url: '/api/spaces',
      payload: { displayName: 'CON' },
    })

    expect(created.statusCode).toBe(201)
    expect(created.json().slug).toBe('con')
    const physicalName = noteFileBase('con')
    expect(physicalName).toMatch(/^~con-[a-f0-9]{24}$/)
    expect((await stat(join(root, physicalName))).isDirectory()).toBe(true)
    await expect(stat(join(root, 'con'))).rejects.toMatchObject({ code: 'ENOENT' })

    await apps.splice(apps.indexOf(app), 1)[0].close()
    const restarted = await boot(['main'])
    const afterRestart = (await restarted.inject({ method: 'GET', url: '/api/spaces' })).json()
    expect(afterRestart.spaces).toContainEqual(expect.objectContaining({ slug: 'con' }))
    expect((await restarted.inject({ method: 'GET', url: '/api/s/con/notes' })).statusCode).toBe(
      200,
    )
  })

  it('rejects non-durable configured display names at the direct createServer boundary', async () => {
    const loneSurrogate = String.fromCharCode(0xd800)

    for (const displayName of ['bad\nname', `bad${loneSurrogate}`, 'x'.repeat(201)]) {
      await expect(
        createServer({
          spaces: [{ slug: 'main', displayName, engine: 'notarium', notesDir: join(root, 'main') }],
          authMode: 'none',
          engineDataDir: join(root, 'engine'),
          jobsDataDir: join(root, 'jobs'),
          importStagingDir: join(root, 'jobs', 'imports'),
          pollIntervalMs: 0,
        }),
      ).rejects.toThrow(/bad displayName for configured space "main"/)
    }
  })

  it('adopts a re-cloned space folder by its marker id, bounding a hostile displayName (#126)', async () => {
    // Pre-plant two RUNTIME space folders under spacesRoot (a re-clone into this
    // empty meta-DB), carrying root `space` facets — exactly what discoverDiskSpaces
    // adopts at boot. 'recloned' has a hand-planted oversized + control-char
    // displayName (bypasses the wire's max(200)); 'reclone2' has a whitespace-only
    // one (must fall back to the slug).
    const hostile = 'x'.repeat(250) + '\u0000\u0007ctrl'
    await mkdir(join(root, 'recloned'), { recursive: true })
    await writeFile(
      join(root, 'recloned', '.notariummeta'),
      serializeMarker({
        id: 'rootProjAA01',
        slug: 'recloned',
        displayName: hostile,
        space: { id: 'reclonedSpc1', slug: 'recloned' },
      }),
      'utf8',
    )
    await mkdir(join(root, 'reclone2'), { recursive: true })
    await writeFile(
      join(root, 'reclone2', '.notariummeta'),
      serializeMarker({
        id: 'rootProjAA02',
        slug: 'reclone2',
        displayName: '   ',
        space: { id: 'reclonedSpc2', slug: 'reclone2' },
      }),
      'utf8',
    )

    const app = await boot(['main'])
    const listed = (await app.inject({ method: 'GET', url: '/api/spaces' })).json()
    const recloned = listed.spaces.find((s: { slug: string }) => s.slug === 'recloned')
    const reclone2 = listed.spaces.find((s: { slug: string }) => s.slug === 'reclone2')

    // Adopted under the MARKER id (cross-host continuity), not a fresh local one.
    expect(recloned?.id).toBe('reclonedSpc1')
    expect(reclone2?.id).toBe('reclonedSpc2')
    // The hostile displayName is clamped to ≤200 and stripped of control chars.
    expect(recloned.displayName.length).toBeLessThanOrEqual(200)
    // eslint-disable-next-line no-control-regex
    expect(recloned.displayName).not.toMatch(/[\u0000-\u001f\u007f]/)
    // A blank displayName falls back to the slug.
    expect(reclone2.displayName).toBe('reclone2')
    // It is live: served under its adopted handle.
    expect((await app.inject({ method: 'GET', url: '/api/s/recloned/notes' })).statusCode).toBe(200)
  })

  it('without spacesRoot the capability is honestly false and POST /api/spaces 404s', async () => {
    await mkdir(join(root, 'main'), { recursive: true })
    const app = await createServer({
      spaces: [{ slug: 'main', engine: 'notarium', notesDir: join(root, 'main') }],
      metaDbUrl: `sqlite:${join(root, 'meta.db')}`,
      authMode: 'none',
      engineDataDir: join(root, 'engine'),
      jobsDataDir: join(root, 'jobs'),
      importStagingDir: join(root, 'jobs', 'imports'),
      pollIntervalMs: 0,
      // no spacesRoot
    })
    await app.ready()
    apps.push(app)

    const config = (await app.inject({ method: 'GET', url: '/api/config' })).json()
    expect(config.capabilities.spaceCreate).toBe(false)
    const created = await app.inject({
      method: 'POST',
      url: '/api/spaces',
      payload: { slug: 'work', displayName: 'Work' },
    })
    expect(created.statusCode).toBe(404)
  })
})
