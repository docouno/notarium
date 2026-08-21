// What a host that cannot publish a package directory tells the outside world.
// One deployment fact, three surfaces: the library listing offers no
// target, the Add answers a stable 503 instead of a stack trace, and neither
// leaves durable state behind — no minted personal space, no library root.
//
// The runtime primitive is mocked at its ONE composition seam. Faking it deeper
// would exercise a shape production never builds; faking it shallower would let
// the test pass on a host that simply has the primitive.

import type { FastifyInstance } from 'fastify'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { encodeAbilityLocator } from '@notarium/core'
import type * as engineModule from '@notarium/engine'

const provider = vi.hoisted(() => ({ available: true }))

vi.mock('@notarium/engine', async () => {
  const actual = await vi.importActual<typeof engineModule>('@notarium/engine')

  return {
    ...actual,
    renameNoReplaceIfAvailable: () =>
      provider.available ? actual.renameNoReplaceIfAvailable() : undefined,
  }
})

const { createServer } = await import('../../packages/server/src/apps/server/server')

let root: string
let app: FastifyInstance | undefined

const boot = async (withSharedSpace = false): Promise<FastifyInstance> => {
  const notesDir = join(root, 'notes')

  app = await createServer({
    spaces: [
      { slug: 'main', engine: 'notarium', notesDir },
      ...(withSharedSpace
        ? [
            {
              slug: 'shared',
              engine: 'notarium' as const,
              notesDir: join(root, 'shared-notes'),
            },
          ]
        : []),
    ],
    metaDbUrl: `sqlite:${join(root, 'meta.db')}`,
    authMode: 'none',
    engineDataDir: join(root, 'engine'),
    jobsDataDir: join(root, 'jobs'),
    importStagingDir: join(root, 'jobs', 'imports'),
    spacesRoot: join(root, 'spaces'),
    pollIntervalMs: 10,
    replayKeyring: { path: join(root, 'replay-keys'), topology: 'canonical-local' },
  })
  await app.ready()
  return app
}

/** Everything the host has minted so far. A Personal Add mints a space on its way
 *  in, so this is what "refused before it touched anything" is measured against. */
const spacesOnDisk = async (): Promise<string[]> => readdir(join(root, 'spaces')).catch(() => [])

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nt-install-availability-'))
  provider.available = true
})

afterEach(async () => {
  await app?.close()
  app = undefined
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('role install availability — a host that cannot publish a package', () => {
  it('offers no target in the role library and none in the skill library', async () => {
    provider.available = false
    const server = await boot()

    const roles = await server.inject({ method: 'GET', url: '/api/me/agent-roles' })
    const skills = await server.inject({ method: 'GET', url: '/api/me/agent-skills' })

    expect(roles.statusCode, roles.body).toBe(200)
    expect(roles.json().installAvailability).toEqual({ personal: false, projects: {} })
    expect(skills.json().installAvailability).toEqual({ personal: false, spaces: {} })
    // Reading the catalog is not publishing it: discovery keeps working, which is
    // the whole reason availability is a listing field and not a 500.
    expect(roles.json().items.length).toBeGreaterThan(0)
    // And the question cost nothing: no space was minted to answer it.
    await expect(spacesOnDisk()).resolves.toEqual([])
  })

  it('answers a stable 503 to a direct Add, before minting a personal space', async () => {
    provider.available = false
    const server = await boot()

    const added = await server.inject({
      method: 'POST',
      url: '/api/me/agent-roles',
      payload: { name: 'grooming', scope: 'personal' },
    })

    expect(added.statusCode, added.body).toBe(503)
    expect(added.json().reason).toBe('role_install_unavailable')
    // The refusal is the whole outcome. A personal space minted on the way in
    // would be the only trace of an Add that never happened.
    await expect(spacesOnDisk()).resolves.toEqual([])
  })

  it('refuses a custom skill the same way, from the same one fact', async () => {
    provider.available = false
    const server = await boot()

    const created = await server.inject({
      method: 'POST',
      url: '/api/me/agent-skills',
      payload: {
        name: 'custom-proof',
        description: 'A custom procedure.',
        instructions: '# Custom proof\n\nFollow the procedure.',
        scope: 'personal',
      },
    })

    expect(created.statusCode, created.body).toBe(503)
    expect(created.json().reason).toBe('role_install_unavailable')
    await expect(spacesOnDisk()).resolves.toEqual([])
  })

  it('keeps stable role, skill, custom, and version conflicts at 409 after capability loss', async () => {
    let server = await boot(true)
    const catalogRole = { name: 'grooming', scope: 'personal' }
    const customRole = {
      name: 'custom-role',
      description: 'A custom role.',
      instructions: '# Custom role\n\nFollow the role.',
      scope: 'personal',
    }
    const customSkill = {
      name: 'custom-skill',
      description: 'A custom skill.',
      instructions: '# Custom skill\n\nFollow the skill.',
      scope: 'personal',
    }
    const versionedRole = {
      name: 'versioned-role',
      description: 'A role with a project version.',
      instructions: '# Versioned role\n\nFollow the version.',
      scope: 'space',
      space: 'shared',
    }

    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/api/me/agent-roles',
          payload: catalogRole,
        })
      ).statusCode,
    ).toBe(201)
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/api/me/agent-roles/custom',
          payload: customRole,
        })
      ).statusCode,
    ).toBe(201)
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/api/me/agent-skills',
          payload: customSkill,
        })
      ).statusCode,
    ).toBe(201)

    const project = await server.inject({
      method: 'POST',
      url: '/api/s/shared/projects',
      payload: { folderPath: 'version-target', create: true },
    })
    expect(project.statusCode, project.body).toBe(201)
    const base = await server.inject({
      method: 'POST',
      url: '/api/me/agent-roles/custom',
      payload: versionedRole,
    })
    expect(base.statusCode, base.body).toBe(201)
    const versionUrl = `/api/me/agent-abilities/${encodeAbilityLocator(base.json().locator)}/versions`
    const versionPayload = { projectId: project.json().id }

    expect(
      (await server.inject({ method: 'POST', url: versionUrl, payload: versionPayload }))
        .statusCode,
    ).toBe(201)

    await app!.close()
    app = undefined
    provider.available = false
    server = await boot(true)

    const conflicts = [
      await server.inject({
        method: 'POST',
        url: '/api/me/agent-roles',
        payload: catalogRole,
      }),
      await server.inject({
        method: 'POST',
        url: '/api/me/agent-skills/catalog',
        payload: { name: 'grooming-evidence', scope: 'personal' },
      }),
      await server.inject({
        method: 'POST',
        url: '/api/me/agent-roles/custom',
        payload: customRole,
      }),
      await server.inject({
        method: 'POST',
        url: '/api/me/agent-skills',
        payload: customSkill,
      }),
      await server.inject({
        method: 'POST',
        url: '/api/me/agent-roles/custom',
        payload: versionedRole,
      }),
      await server.inject({ method: 'POST', url: versionUrl, payload: versionPayload }),
    ]

    expect(conflicts.map((response) => response.statusCode)).toEqual([409, 409, 409, 409, 409, 409])
    expect(conflicts.map((response) => response.json().reason)).toEqual([
      'role_exists',
      'skill_exists',
      'role_exists',
      'skill_exists',
      'role_exists',
      'role_exists',
    ])
  })

  it('offers Personal and installs it where the runtime does carry the primitive', async () => {
    const server = await boot()

    const roles = await server.inject({ method: 'GET', url: '/api/me/agent-roles' })

    // The positive half, ungated on purpose: without it, a build that stopped
    // advertising the target on EVERY host would still pass the three above.
    expect(roles.json().installAvailability).toMatchObject({ personal: true })

    const added = await server.inject({
      method: 'POST',
      url: '/api/me/agent-roles',
      payload: { name: 'grooming', scope: 'personal' },
    })

    expect([201, 503]).toContain(added.statusCode)
    if (added.statusCode === 503) {
      // A machine whose filesystem or kernel refuses the syscall the composition
      // found. Still the typed answer, never a 500.
      expect(added.json().reason).toBe('role_install_unavailable')
    }
  })
})
