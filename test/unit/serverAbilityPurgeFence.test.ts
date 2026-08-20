import type { FastifyInstance } from 'fastify'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { encodeAbilityLocator } from '@notarium/core'
import { createServer } from '../../packages/server/src/apps/server/server'

let root: string
let app: FastifyInstance | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nt-ability-fence-'))
})

afterEach(async () => {
  await app?.close()
  app = undefined
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('ability routes — a durable target purged out from under the write', () => {
  it('answers not found instead of an internal failure', async () => {
    const metaDbPath = join(root, 'meta.db')

    // Two spaces, because a host with one would make it the caller's personal one —
    // and a Space-scoped locator into a personal library is not an address at all.
    const space = (slug: string) => {
      const notesDir = join(root, slug)

      return {
        slug,
        engine: 'notarium' as const,
        notesDir,
        mounts: [
          { class: 'user-doc' as const, dir: notesDir, prefix: '' },
          {
            class: 'agent-memory' as const,
            dir: join(notesDir, '.notarium/memory'),
            prefix: '.notarium/memory',
          },
          {
            class: 'profile' as const,
            dir: join(notesDir, '.notarium/profile'),
            prefix: '.notarium/profile',
          },
          {
            class: 'skill' as const,
            dir: join(root, `${slug}-skills`),
            prefix: '.notarium/skills',
          },
        ],
      }
    }

    app = await createServer({
      spaces: [space('mine'), space('shared')],
      metaDbUrl: `sqlite:${metaDbPath}`,
      authMode: 'none',
      engineDataDir: join(root, 'engine'),
      jobsDataDir: join(root, 'jobs'),
      importStagingDir: join(root, 'jobs', 'imports'),
      pollIntervalMs: 10,
    })
    await app.ready()

    const created = await app.inject({
      method: 'POST',
      url: '/api/me/agent-roles/custom',
      payload: {
        scope: 'space',
        space: 'shared',
        name: 'review',
        description: 'Review the release.',
        instructions: '# Review\n\nReview carefully.',
      },
    })

    expect(created.statusCode).toBe(201)
    const { locator } = created.json() as { locator: Parameters<typeof encodeAbilityLocator>[0] }
    const url = `/api/me/agent-abilities/${encodeURIComponent(
      encodeAbilityLocator(locator),
    )}/availability`

    expect(
      (await app.inject({ method: 'PUT', url, payload: { mode: 'all-projects' } })).statusCode,
    ).toBe(200)

    // The reach row is FOREIGN KEY'd to its home space, and the space can go while a
    // request is in flight. The facets refuse that write with one machine-readable
    // code precisely so the answer is "this ability is not there" — a 500 would tell
    // the client the server broke and leave the ability looking editable.
    const db = new DatabaseSync(metaDbPath)

    try {
      db.prepare('DELETE FROM spaces WHERE slug = ?').run('shared')
    } finally {
      db.close()
    }

    expect(
      (await app.inject({ method: 'PUT', url, payload: { mode: 'all-projects' } })).statusCode,
    ).toBe(404)
  })

  it('answers every ability write the same way when the ability is not there', async () => {
    const metaDbPath = join(root, 'meta.db')

    const space = (slug: string) => {
      const notesDir = join(root, slug)

      return {
        slug,
        engine: 'notarium' as const,
        notesDir,
        mounts: [
          { class: 'user-doc' as const, dir: notesDir, prefix: '' },
          {
            class: 'agent-memory' as const,
            dir: join(notesDir, '.notarium/memory'),
            prefix: '.notarium/memory',
          },
          {
            class: 'profile' as const,
            dir: join(notesDir, '.notarium/profile'),
            prefix: '.notarium/profile',
          },
          {
            class: 'skill' as const,
            dir: join(root, `${slug}-skills`),
            prefix: '.notarium/skills',
          },
        ],
      }
    }

    app = await createServer({
      spaces: [space('mine'), space('shared')],
      metaDbUrl: `sqlite:${metaDbPath}`,
      authMode: 'none',
      engineDataDir: join(root, 'engine'),
      jobsDataDir: join(root, 'jobs'),
      importStagingDir: join(root, 'jobs', 'imports'),
      pollIntervalMs: 10,
    })
    await app.ready()

    const project = await app.inject({
      method: 'POST',
      url: '/api/s/shared/projects',
      payload: { folderPath: 'launch', create: true },
    })

    expect([200, 201]).toContain(project.statusCode)

    const created = await app.inject({
      method: 'POST',
      url: '/api/me/agent-roles/custom',
      payload: {
        scope: 'space',
        space: 'shared',
        name: 'review',
        description: 'Review the release.',
        instructions: '# Review\n\nReview carefully.',
      },
    })

    expect(created.statusCode).toBe(201)
    const { locator } = created.json() as {
      locator: Parameters<typeof encodeAbilityLocator>[0] & { packageId: string }
    }
    // A package id that addresses nothing, at a placement the caller genuinely holds.
    const absent = encodeURIComponent(
      encodeAbilityLocator({ ...locator, packageId: 'AbsentAbCdEf' }),
    )
    const projectId = (project.json() as { id: string }).id

    // Every write path answers ONE way. `/versions` used to be the odd one out and
    // returned 500 with an internal message, because the not-found answer was wired
    // per route instead of being a property of the refusal itself.
    for (const [method, url, payload] of [
      ['PUT', `/api/me/agent-abilities/${absent}/enabled`, { enabled: false }],
      ['PUT', `/api/me/agent-abilities/${absent}/availability`, { mode: 'all-projects' }],
      ['POST', `/api/me/agent-abilities/${absent}/versions`, { projectId }],
    ] as const) {
      const response = await app.inject({ method, url, payload })

      expect([method, response.statusCode]).toEqual([method, 404])
      expect(response.json()).toEqual({ error: 'not found' })
    }
  })

  it('describes a published skill the same way through both doors', async () => {
    const metaDbPath = join(root, 'meta.db')

    const space = (slug: string) => {
      const notesDir = join(root, slug)

      return {
        slug,
        engine: 'notarium' as const,
        notesDir,
        mounts: [
          { class: 'user-doc' as const, dir: notesDir, prefix: '' },
          {
            class: 'agent-memory' as const,
            dir: join(notesDir, '.notarium/memory'),
            prefix: '.notarium/memory',
          },
          {
            class: 'profile' as const,
            dir: join(notesDir, '.notarium/profile'),
            prefix: '.notarium/profile',
          },
          {
            class: 'skill' as const,
            dir: join(root, `${slug}-skills`),
            prefix: '.notarium/skills',
          },
        ],
      }
    }

    app = await createServer({
      spaces: [space('mine'), space('shared')],
      metaDbUrl: `sqlite:${metaDbPath}`,
      authMode: 'none',
      engineDataDir: join(root, 'engine'),
      jobsDataDir: join(root, 'jobs'),
      importStagingDir: join(root, 'jobs', 'imports'),
      pollIntervalMs: 10,
    })
    await app.ready()

    expect(
      [200, 201].includes(
        (
          await app.inject({
            method: 'POST',
            url: '/api/s/shared/projects',
            payload: { folderPath: 'launch', create: true },
          })
        ).statusCode,
      ),
    ).toBe(true)

    // The SAME reach, stated with a repeat, through the two doors that publish a
    // Space skill. Two hand-written response builders had already stopped agreeing
    // about it: one collapsed the repeat and the other echoed it back.
    const availability = {
      mode: 'selected-projects',
      projects: ['shared/launch', 'shared/launch'],
    }
    const created = await app.inject({
      method: 'POST',
      url: '/api/me/agent-skills',
      payload: {
        scope: 'space',
        space: 'shared',
        availability,
        name: 'evidence',
        description: 'Evidence for the release.',
        instructions: '# Evidence\n\nGather evidence.',
      },
    })

    expect(created.statusCode).toBe(201)

    const added = await app.inject({
      method: 'POST',
      url: '/api/me/agent-skills/catalog',
      payload: { scope: 'space', space: 'shared', name: 'grooming-evidence', availability },
    })

    expect(added.statusCode).toBe(201)
    expect((created.json() as { skill: { availability: unknown } }).skill.availability).toEqual(
      (added.json() as { skill: { availability: unknown } }).skill.availability,
    )
    expect((created.json() as { skill: { availability: unknown } }).skill.availability).toEqual({
      mode: 'selected-projects',
      projects: ['shared/launch'],
    })
  })
})
