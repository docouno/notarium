import type { FastifyInstance } from 'fastify'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { encodeAbilityLocator } from '@notarium/core'
import { createServer } from '../../packages/server/src/apps/server/server'

/**
 * Both halves of one rule, on one route, against one durable failure each.
 *
 * A purged target is NOT THERE, and the ability routes answer 404 for it. Anything
 * else is OUR failure and must stay loud — a 500 the operator can see in the log and
 * the client can retry. The halves are worth stating together because they are told
 * apart by a single predicate: widened, it turns every internal failure into "your
 * ability vanished"; narrowed, it turns a lost race into a server crash.
 *
 * The `/enabled` route is the one used here on purpose. Two independent facets produce
 * the purge code — `abilityAvailability` (reach) and `abilityPreferences` (the
 * owner's Enable/Disable) — and this route is the only one that reaches the second.
 */
let root: string
let metaDbPath: string
let app: FastifyInstance | undefined

// Two spaces, because a host with one would make it the caller's personal one — and a
// Space-scoped locator into a personal library is not an address at all.
const spaceConfig = (slug: string) => {
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
      { class: 'skill' as const, dir: join(root, `${slug}-skills`), prefix: '.notarium/skills' },
    ],
  }
}

const boot = async (): Promise<FastifyInstance> => {
  metaDbPath = join(root, 'meta.db')
  app = await createServer({
    spaces: [spaceConfig('mine'), spaceConfig('shared')],
    metaDbUrl: `sqlite:${metaDbPath}`,
    authMode: 'none',
    engineDataDir: join(root, 'engine'),
    jobsDataDir: join(root, 'jobs'),
    importStagingDir: join(root, 'jobs', 'imports'),
    pollIntervalMs: 10,
  })
  await app.ready()
  return app
}

const onMetaDb = (statement: string): void => {
  const db = new DatabaseSync(metaDbPath)

  try {
    db.exec(statement)
  } finally {
    db.close()
  }
}

/** A Space role plus the URL that toggles the owner's preference for it. */
const enabledUrlOfNewRole = async (host: FastifyInstance, name: string): Promise<string> => {
  const created = await host.inject({
    method: 'POST',
    url: '/api/me/agent-roles/custom',
    payload: {
      scope: 'space',
      space: 'shared',
      name,
      description: 'Review the release.',
      instructions: `# ${name}\n\nReview carefully.`,
    },
  })

  expect(created.statusCode).toBe(201)
  const { locator } = created.json() as { locator: Parameters<typeof encodeAbilityLocator>[0] }

  return `/api/me/agent-abilities/${encodeURIComponent(encodeAbilityLocator(locator))}/enabled`
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nt-ability-honesty-'))
})

afterEach(async () => {
  await app?.close()
  app = undefined
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('ability writes — a target that is gone versus a host that is broken', () => {
  it('answers not found when the preference target was purged out from under it', async () => {
    const host = await boot()
    const url = await enabledUrlOfNewRole(host, 'review')

    // The control: while the home Space is alive this exact request lands.
    expect(
      (await host.inject({ method: 'PUT', url, payload: { enabled: false } })).statusCode,
    ).toBe(200)

    // The preference row is keyed by the Space and the registry note it belongs to,
    // and the Space can go while a request is in flight. `abilityPreferences` refuses
    // that write with the same machine-readable code the reach facet uses — a 500 here
    // would tell the client the server broke and leave the ability looking editable.
    onMetaDb("DELETE FROM spaces WHERE slug = 'shared'")

    const purged = await host.inject({ method: 'PUT', url, payload: { enabled: true } })

    expect(purged.statusCode).toBe(404)
    expect(purged.json()).toEqual({ error: 'not found' })
  })

  it('stays loud when the durable write fails for any other reason', async () => {
    const host = await boot()
    const url = await enabledUrlOfNewRole(host, 'review')

    expect(
      (await host.inject({ method: 'PUT', url, payload: { enabled: false } })).statusCode,
    ).toBe(200)

    // The Space is untouched: the target IS there, and the ability is exactly as
    // reachable as it was a moment ago. Only the durable write is broken. Reporting
    // that as 404 would tell the author their role vanished, hand the client a
    // permanent answer to a transient failure, and leave no trace of the real fault.
    onMetaDb('DROP TABLE ability_preferences')

    const broken = await host.inject({ method: 'PUT', url, payload: { enabled: true } })

    expect(broken.statusCode).toBe(500)
  })
})
