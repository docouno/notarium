// What the home route tells a client when the move it asked for COMMITTED and only
// the confirmation of it failed.
//
// This is the one outcome on the route that is neither a success nor a refusal, and
// the two things a client cannot lose to it are the KIND of failure and the ADDRESS:
// the package is at its new home, so a caller sent back to the placement it named is
// addressing a home the role no longer has. Untyped, the answer is a bare 500 whose
// body is a sentence — indistinguishable from the server having broken, and carrying
// no address at all.
//
// The barrier is faked at the ONE composition seam that produces it — the library the
// server builds. Everything else is the real assembly: the real `createServer`, the
// real meta-DB, the real promotion with all three of its durable effects, the real
// route and the real error shaping.

import type { FastifyInstance } from 'fastify'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { encodeAbilityLocator } from '@notarium/core'
import type * as rolesModule from '../../packages/server/src/services/roles'

/** Which placement's projection barrier refuses to answer. `null` is the honest
 *  host, and it is asserted first: without it, a route that answered this way to
 *  every promotion would look exactly as correct as one that answered it here. */
const barrier = vi.hoisted(() => ({ unanswerableAt: null as 'space' | null }))

vi.mock('../../packages/server/src/services/roles', async (importOriginal) => {
  const actual = await importOriginal<typeof rolesModule>()

  return {
    ...actual,
    createFsRoleLibrary: (
      options: Parameters<typeof rolesModule.createFsRoleLibrary>[0],
    ): ReturnType<typeof rolesModule.createFsRoleLibrary> => {
      const composition = actual.createFsRoleLibrary(options)

      return {
        ...composition,
        library: {
          ...composition.library,
          awaitReadableNoteIds: async (location, directoryNames) => {
            if (barrier.unanswerableAt === location.scope) {
              throw new Error('the projection barrier timed out')
            }

            return composition.library.awaitReadableNoteIds(location, directoryNames)
          },
        },
      }
    },
  }
})

const { createServer } = await import('../../packages/server/src/apps/server/server')

let root: string
let app: FastifyInstance | undefined
let errorLog: ReturnType<typeof vi.spyOn> | undefined

const spaceConfig = (slug: string) => {
  const notesDir = join(root, slug)

  return {
    slug,
    engine: 'notarium' as const,
    notesDir,
    mounts: [
      { class: 'user-doc' as const, dir: notesDir, prefix: '' },
      { class: 'skill' as const, dir: join(root, `${slug}-skills`), prefix: '.notarium/skills' },
    ],
  }
}

const boot = async (): Promise<FastifyInstance> => {
  app = await createServer({
    spaces: [spaceConfig('mine'), spaceConfig('shared')],
    metaDbUrl: `sqlite:${join(root, 'meta.db')}`,
    authMode: 'none',
    engineDataDir: join(root, 'engine'),
    jobsDataDir: join(root, 'jobs'),
    importStagingDir: join(root, 'jobs', 'imports'),
    pollIntervalMs: 10,
  })
  await app.ready()
  return app
}

/** A role that lives in a project of a shared Space — the only shape that has a
 *  Space home to be promoted TO. */
const projectRoleOf = async (
  host: FastifyInstance,
  name: string,
): Promise<
  Extract<Parameters<typeof encodeAbilityLocator>[0], { source: 'owned'; kind: 'role' }>
> => {
  const project = await host.inject({
    method: 'POST',
    url: '/api/s/shared/projects',
    payload: { folderPath: 'alpha', create: true },
  })

  expect(project.statusCode, project.body).toBe(201)
  const created = await host.inject({
    method: 'POST',
    url: '/api/me/agent-roles/custom',
    payload: {
      scope: 'project',
      project: 'shared/alpha',
      name,
      description: 'Review the release.',
      instructions: `# ${name}\n\nReview carefully.`,
    },
  })

  expect(created.statusCode, created.body).toBe(201)

  return created.json().locator as Extract<
    Parameters<typeof encodeAbilityLocator>[0],
    { source: 'owned'; kind: 'role' }
  >
}

const promote = async (
  host: FastifyInstance,
  locator: Parameters<typeof encodeAbilityLocator>[0],
) =>
  host.inject({
    method: 'PUT',
    url: `/api/me/agent-abilities/${encodeURIComponent(encodeAbilityLocator(locator))}/home`,
    payload: { scope: 'space' },
  })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nt-home-unconfirmed-'))
  barrier.unanswerableAt = null
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  errorLog?.mockRestore()
  errorLog = undefined
  await app?.close()
  app = undefined
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('a promotion the host could not confirm', () => {
  it('answers the ordinary success while the barrier answers', async () => {
    const host = await boot()
    const locator = await projectRoleOf(host, 'review')
    const promoted = await promote(host, locator)

    expect(promoted.statusCode, promoted.body).toBe(200)
    expect(promoted.json()).toMatchObject({ locator: { location: { scope: 'space' } } })
    // The honest host says nothing about the ROUTE. Asserted so the log check below
    // proves the barrier's failure, and not that this route logs on every promotion.
    // Scoped to the `[api]` prefix: boot's own `[spaces]` provisioning noise shares
    // this channel and says nothing about whether the promotion was confirmed.
    expect(JSON.stringify(errorLog?.mock.calls)).not.toContain('[api]')
  })

  it('keeps the failure typed and the new home addressable when it does not', async () => {
    const host = await boot()
    const locator = await projectRoleOf(host, 'review')

    barrier.unanswerableAt = 'space'

    const promoted = await promote(host, locator)
    const body = promoted.json() as { error: string; reason?: string; locator?: unknown }

    // The status is the 5xx it always was — this deployment could not do the whole of
    // what it was asked — but NOT 503 `role_install_unavailable`: that reason states
    // the operation was REFUSED, and this one committed. A caller who retried on it
    // would race the very package this call published, which is the outcome the Add
    // path already refuses to name after its own commit.
    expect(promoted.statusCode).toBe(500)
    expect(body.reason).toBe('role_placement_unconfirmed')
    // The address the answer carries is the one the package IS at, in the same shape
    // the successful answer carries it — the placement the caller named has been left.
    expect(body.locator).toEqual({
      source: 'owned',
      kind: 'role',
      packageId: locator.packageId,
      location: { scope: 'space', spaceId: locator.location.spaceId },
    })
    expect(body.error).toContain('review')
    // The wire carries what the caller can act on; WHY the barrier did not answer is
    // only ever in the cause, and the cause is only ever in the operator log. This
    // answer is returned rather than thrown, so the app-level handler never sees it
    // and the route has to say it itself — without this, the one diagnostic for a
    // half-landed promotion is nowhere at all.
    expect(body.error).not.toContain('the projection barrier timed out')
    expect(JSON.stringify(errorLog?.mock.calls)).toContain('the projection barrier timed out')
    // Nothing is rolled back for a barrier that ran after the commit, so the placement
    // the caller named is not a home this role has any more — and asking again at that
    // address is not a second promotion.
    barrier.unanswerableAt = null

    const again = await promote(host, locator)

    expect(again.statusCode).not.toBe(200)
  })
})
