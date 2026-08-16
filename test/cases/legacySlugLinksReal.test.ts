import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import { CachedStore } from '@notarium/core'
import { createNotariumStore } from '@notarium/engine'
import { createMetaDb, dataPathsFromEnv } from '@notarium/server'

const execute = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('legacy-slug-links real seed projection', () => {
  it('replays stable identities, unique legacy edges and ambiguous ghosts through production stores', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'notarium-real-legacy-seed-'))
    roots.push(dataDir)
    const cwd = process.cwd()

    await execute(join(cwd, 'node_modules', '.bin', 'tsx'), ['scripts/seed.ts'], {
      cwd,
      env: {
        ...process.env,
        CASE: 'legacy-slug-links',
        DATA_DIR: dataDir,
        NOW: '2026-08-14T12:00:00.000Z',
        SCALE: '1',
        SEED: 'legacy-real-proof',
      },
      timeout: 90_000,
    })

    const paths = dataPathsFromEnv({ ...process.env, DATA_DIR: dataDir })
    const metaDb = createMetaDb(paths.metaDbUrl)
    const space = (await metaDb.spaces.list()).find(({ slug }) => slug === 'main')

    if (!space) {
      await metaDb.close()
      throw new Error('real seed did not create main space')
    }
    const notesDir = join(paths.defaultSpacesRoot, space.notesDir)
    const inner = createNotariumStore({
      notesDir,
      indexDb: join(paths.engineDataDir, `${space.notesDir}.db`),
    })
    const store = new CachedStore({
      inner,
      identityPersistence: metaDb.identity,
      revisionPersistence: metaDb.revisions,
      space: space.id,
      pollIntervalMs: 0,
      readBody: async (filePath) => {
        try {
          return await readFile(join(notesDir, filePath), 'utf8')
        } catch {
          return null
        }
      },
    })

    try {
      await store.start()
      const notes = await store.list()
      const unique = notes.find(({ title }) => title === 'Қазақстан жоспары')
      const source = notes.find(({ title }) => title === 'Legacy link source')
      const collisions = notes.filter(({ title }) => title === 'AҚB' || title === 'AҒB')

      expect(unique).toMatchObject({
        filePath: 'current/қazaқstan-zhospary.md',
        legacyNameAliases: ['aza-stan-zhospary'],
      })
      expect(unique?.id).toBeDefined()
      expect(source?.id).toBeDefined()
      expect(collisions).toHaveLength(2)
      expect(collisions.map(({ legacyNameAliases }) => legacyNameAliases)).toEqual([
        ['a-b'],
        ['a-b'],
      ])
      await expect(store.resolveWikilink('aza-stan-zhospary')).resolves.toMatchObject({
        id: unique?.id,
      })
      await expect(store.resolveWikilink('a-b')).rejects.toMatchObject({ isNotFound: true })

      const graph = await store.graph()

      expect(graph.links).toContainEqual(
        expect.objectContaining({ source: source?.id, target: unique?.id }),
      )
      expect(
        graph.links.some(
          ({ source: sourceId, target }) =>
            sourceId === source?.id && collisions.some(({ id }) => id === target),
        ),
      ).toBe(false)
      expect(graph.nodes).toContainEqual(expect.objectContaining({ ghost: true, target: 'a-b' }))
    } finally {
      store.stop()
      await store.settle()
      await metaDb.close()
    }
  }, 120_000)
})
