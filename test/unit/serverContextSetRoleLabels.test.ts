import type { FastifyInstance } from 'fastify'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { encodeAbilityLocator } from '@notarium/core'
import { createServer } from '../../packages/server/src/apps/server/server'

let root: string
let app: FastifyInstance | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nt-ctx-labels-'))
})

afterEach(async () => {
  await app?.close()
  app = undefined
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('context sets — how a role attachment is named back to the reader', () => {
  it('names each placement by where it actually lives', async () => {
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
      // The first space is the caller's personal one when the host has no accounts.
      spaces: [space('mine'), space('shared')],
      metaDbUrl: `sqlite:${join(root, 'meta.db')}`,
      authMode: 'none',
      engineDataDir: join(root, 'engine'),
      jobsDataDir: join(root, 'jobs'),
      importStagingDir: join(root, 'jobs', 'imports'),
      pollIntervalMs: 10,
    })
    await app.ready()

    const created = await app.inject({
      method: 'POST',
      url: '/api/s/shared/projects',
      payload: { folderPath: 'launch', create: true },
    })

    expect([200, 201]).toContain(created.statusCode)

    const role = async (payload: Record<string, unknown>) => {
      const response = await app!.inject({
        method: 'POST',
        url: '/api/me/agent-roles/custom',
        payload: {
          description: 'Review the release.',
          instructions: '# Review\n\nReview carefully.',
          ...payload,
        },
      })

      expect(response.statusCode).toBe(201)
      return encodeURIComponent(
        encodeAbilityLocator((response.json() as { locator: never }).locator),
      )
    }

    const personal = await role({ name: 'mine-review', scope: 'personal' })
    const shared = await role({ name: 'shared-review', scope: 'space', space: 'shared' })
    const inProject = await role({
      name: 'project-review',
      scope: 'project',
      project: 'shared/launch',
    })

    const set = await app.inject({
      method: 'POST',
      url: '/api/s/shared/context-sets',
      payload: { name: 'Release' },
    })

    expect([200, 201]).toContain(set.statusCode)
    const setId = (set.json() as { set: { id: string } }).set.id

    for (const locator of [shared, inProject]) {
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: `/api/me/agent-roles/${locator}/context-sets/${setId}`,
          })
        ).statusCode,
      ).toBe(200)
    }
    // A personal role cannot hold a shared set, so it gets its own personal one —
    // the third placement still has to name itself correctly.
    const personalSet = await app.inject({
      method: 'POST',
      url: '/api/s/mine/context-sets',
      payload: { name: 'Mine' },
    })

    expect([200, 201]).toContain(personalSet.statusCode)
    const personalSetId = (personalSet.json() as { set: { id: string } }).set.id

    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/me/agent-roles/${personal}/context-sets/${personalSetId}`,
        })
      ).statusCode,
    ).toBe(200)

    const sets = (
      (await app.inject({ method: 'GET', url: '/api/context-sets' })).json() as {
        sets: Array<{ name: string; attachments: Array<{ kind: string; label: string }> }>
      }
    ).sets

    // Personal · a Space by its slug · a project by space/slug — three placements,
    // three names, and none of them the raw package id a failed resolve falls back to.
    expect(
      sets
        .flatMap(({ attachments }) => attachments)
        .filter(({ kind }) => kind === 'role')
        .map(({ label }) => label)
        .sort(),
    ).toEqual([
      'Role · mine-review · Personal',
      'Role · project-review · shared/launch',
      'Role · shared-review · shared',
    ])
  })
})
