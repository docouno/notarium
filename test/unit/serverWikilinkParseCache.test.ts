import type { FastifyInstance } from 'fastify'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { NotariumStore } from '@notarium/engine'

import { createServer } from '../../packages/server/src/apps/server/server'

describe('createServer — wikilink parser rollback composition', () => {
  it('carries false through server → factory → concrete engine', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-wikilink-rollback-'))
    const notesDir = join(root, 'notes')
    let app: FastifyInstance | undefined
    let engine: NotariumStore | undefined
    const adjacency: Array<{ space: string; hasEdge: boolean }> = []

    try {
      await mkdir(notesDir, { recursive: true })
      await writeFile(join(notesDir, 'target.md'), '# Target\n\nBody', 'utf8')
      await writeFile(join(notesDir, 'source.md'), '# Source\n\nNo links yet', 'utf8')
      app = await createServer({
        spaces: [{ slug: 'main', engine: 'notarium', notesDir }],
        metaDbUrl: `sqlite:${join(root, 'meta.db')}`,
        authMode: 'none',
        engineDataDir: join(root, 'engine'),
        jobsDataDir: join(root, 'jobs'),
        importStagingDir: join(root, 'jobs', 'imports'),
        pollIntervalMs: 0,
        wikilinkParseCache: false,
        onEngineCreated: (created) => {
          engine = created
        },
        onGraphAdjacencyBuilt: (space, observation) => {
          adjacency.push({
            space: space.slug,
            hasEdge: observation.hasEdge('source.md', 'target.md'),
          })
        },
      })
      await app.ready()

      const health = await app.inject({ method: 'GET', url: '/api/s/main/graph/health' })
      const rebuild = Reflect.get(engine!, 'rebuildGraphAdjacency') as () => Promise<void>

      await rebuild.call(engine)
      const noteResponse = await app.inject({
        method: 'GET',
        url: `/api/s/main/note?ref=${encodeURIComponent('Source')}`,
      })
      const source = noteResponse.json<{
        id: string
        title: string
        content: string
        versionToken: string
      }>()
      const writeResponse = await app.inject({
        method: 'POST',
        url: '/api/note',
        payload: {
          originalId: source.id,
          versionToken: source.versionToken,
          title: source.title,
          content: `${source.content}\n\n[[Target]]`,
        },
      })

      const stored = await engine!.read('source.md')
      const graph = await engine!.graph()
      await rebuild.call(engine)

      expect(health.statusCode).toBe(200)
      expect(noteResponse.statusCode).toBe(200)
      expect(writeResponse.statusCode).toBe(200)
      expect(stored.content).toContain('[[Target]]')
      expect(graph.links).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'source.md', target: 'target.md' }),
        ]),
      )
      expect(engine).toBeDefined()
      expect(engine!.wikilinkParseCacheStats()).toMatchObject({
        enabled: false,
        entries: 0,
      })
      expect(adjacency).toEqual([
        { space: 'main', hasEdge: false },
        { space: 'main', hasEdge: true },
      ])
    } finally {
      await app?.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
