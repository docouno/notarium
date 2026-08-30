import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createLocalFsFiles } from '../../libs/files'
import { createNodeSqliteDriver, type SqlDriver, type SqlValue } from '../../libs/sql'
import { createNotariumStore } from './createNotariumStore'
import { NotariumStore } from './notariumStore'
import { engineMountOf } from './types'

const roots: string[] = []

const root = async (): Promise<string> => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'notarium-wikilink-cache-'))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('NotariumStore exact-generation wikilink cache', () => {
  it('reads/parses a persisted cold corpus once, then derives warm graphs metadata-only', async () => {
    const dir = await root()
    const indexDb = join(dir, 'index.db')
    await fs.writeFile(join(dir, 'target.md'), '# Target\n\nBody')
    await fs.writeFile(join(dir, 'source.md'), '# Source\n\nSee [[Target]]')
    const first = createNotariumStore({ notesDir: dir, indexDb, integritySweepBatchSize: 0 })

    await first.list()
    await first.stop()

    const warm = createNotariumStore({ notesDir: dir, indexDb, integritySweepBatchSize: 0 })

    try {
      await warm.list()
      expect(warm.wikilinkParseCacheStats()).toMatchObject({
        entries: 0,
        bodyReads: 0,
        parserCalls: 0,
      })
      const graph = await warm.graph()
      expect(graph.links).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'source.md', target: 'target.md' }),
        ]),
      )
      const coldStats = warm.wikilinkParseCacheStats()
      expect(coldStats).toMatchObject({ entries: 2, bodyReads: 2, parserCalls: 2 })

      await warm.graphHealth()
      expect(warm.wikilinkParseCacheStats()).toMatchObject({
        entries: 2,
        bodyReads: coldStats.bodyReads,
        parserCalls: coldStats.parserCalls,
        fallbacks: 0,
      })
    } finally {
      await warm.stop()
    }
  })

  it('write-through updates one changed source and immediate delete eviction needs no derivation', async () => {
    const dir = await root()
    const store = createNotariumStore({ notesDir: dir, integritySweepBatchSize: 0 })

    try {
      await store.write({ title: 'Alpha', content: 'A' })
      const source = await store.write({ title: 'Source', content: '[[Alpha]]' })
      await store.graph()
      const before = store.wikilinkParseCacheStats()
      const current = await store.read(source.filePath!)

      await store.write({
        originalId: source.filePath,
        title: 'Source',
        content: '[[Missing]]',
        versionToken: current.versionToken,
      })
      const afterWrite = store.wikilinkParseCacheStats()
      expect(afterWrite.parserCalls - before.parserCalls).toBe(1)
      expect(afterWrite.bodyReads).toBe(before.bodyReads)
      expect((await store.graph()).links).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: source.filePath, target: 'ghost:missing' }),
        ]),
      )
      expect(store.wikilinkParseCacheStats().parserCalls).toBe(afterWrite.parserCalls)

      await store.remove(source.filePath!)
      expect(store.wikilinkParseCacheStats().entries).toBe(1)
    } finally {
      await store.stop()
    }
  })

  it('carries warm labels across a field-only source change without reparsing the body', async () => {
    const dir = await root()
    const store = createNotariumStore({ notesDir: dir, integritySweepBatchSize: 0 })

    try {
      await store.write({ title: 'Target', content: 'body' })
      const source = await store.write({ title: 'Source', content: 'See [[Target]]' })
      await store.graph()
      const before = store.wikilinkParseCacheStats()
      const current = await store.read(source.filePath!)

      await store.write({
        originalId: source.filePath,
        title: 'Source',
        content: current.content,
        versionToken: current.versionToken,
        fields: { status: 'done' },
      })

      expect(store.wikilinkParseCacheStats()).toMatchObject({
        parserCalls: before.parserCalls,
        bodyReads: before.bodyReads,
      })
      expect((await store.graph()).links).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: source.filePath, target: 'target.md' }),
        ]),
      )
      expect(store.wikilinkParseCacheStats().parserCalls).toBe(before.parserCalls)
    } finally {
      await store.stop()
    }
  })

  it('keeps a durable write successful when cache-only fingerprint verification fails', async () => {
    const dir = await root()
    const base = createNodeSqliteDriver(':memory:')
    let failVerification = false
    let failures = 0
    const sql: SqlDriver = {
      ...base,
      get: async <T = Record<string, SqlValue>>(
        statement: string,
        params?: SqlValue[],
      ): Promise<T | undefined> => {
        if (
          failVerification &&
          statement.includes('SELECT source_hash FROM file_fingerprints WHERE')
        ) {
          failures++
          throw new Error('injected cache-only fingerprint verification failure')
        }

        return base.get<T>(statement, params)
      },
    }
    const store = new NotariumStore({
      mounts: [engineMountOf({ class: 'user-doc', prefix: '' }, createLocalFsFiles(dir))],
      sql,
      integritySweepBatchSize: 0,
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      await store.list()
      failVerification = true
      const written = await store.write({ title: 'Source', content: '[[Target]]' })

      failVerification = false
      expect(failures).toBe(1)
      expect(await store.read(written.filePath!)).toMatchObject({
        title: 'Source',
        content: '[[Target]]',
      })
      expect(store.wikilinkParseCacheStats().entries).toBe(0)
      await expect(store.graph()).resolves.toEqual(
        expect.objectContaining({
          links: expect.arrayContaining([
            expect.objectContaining({ source: written.filePath, target: 'ghost:target' }),
          ]),
        }),
      )
      expect(error).toHaveBeenCalledWith(
        '[notarium] wikilink cache publication skipped:',
        expect.any(Error),
      )
    } finally {
      failVerification = false
      error.mockRestore()
      await store.stop()
    }
  })

  it('does not republish write-through labels after a concurrent delete', async () => {
    const dir = await root()
    const base = createNodeSqliteDriver(':memory:')
    let delayVerification = false
    let announceVerification!: () => void
    let releaseVerification!: () => void
    const verificationStarted = new Promise<void>((resolve) => {
      announceVerification = resolve
    })
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve
    })
    const sql: SqlDriver = {
      ...base,
      get: async <T = Record<string, SqlValue>>(
        statement: string,
        params?: SqlValue[],
      ): Promise<T | undefined> => {
        if (
          delayVerification &&
          statement.includes('SELECT source_hash FROM file_fingerprints WHERE')
        ) {
          delayVerification = false
          const captured = await base.get<T>(statement, params)
          announceVerification()
          await verificationGate
          return captured
        }

        return base.get<T>(statement, params)
      },
    }
    const store = new NotariumStore({
      mounts: [engineMountOf({ class: 'user-doc', prefix: '' }, createLocalFsFiles(dir))],
      sql,
      integritySweepBatchSize: 0,
    })

    try {
      await store.list()
      const source = await store.write({ title: 'Source', content: '[[Before]]' })
      const current = await store.read(source.filePath!)

      delayVerification = true
      const delayedWrite = store.write({
        originalId: source.filePath,
        title: 'Source',
        content: '[[After]]',
        versionToken: current.versionToken,
      })

      await verificationStarted
      await store.remove(source.filePath!)
      expect(store.wikilinkParseCacheStats().entries).toBe(0)

      releaseVerification()
      await delayedWrite
      expect(store.wikilinkParseCacheStats()).toMatchObject({ entries: 0, inFlight: 0 })
      expect(await fs.readdir(dir)).toEqual([])
    } finally {
      releaseVerification()
      await store.stop()
    }
  })

  it('keys labels by raw source fingerprint, not equal vector chunk hashes', async () => {
    const dir = await root()
    await fs.writeFile(join(dir, 'target.md'), '# Target\n\ntarget')
    await fs.writeFile(join(dir, 'prose.md'), '# Same\n\n[[Target]]')
    await fs.writeFile(join(dir, 'code.md'), '# Same\n\n    [[Target]]')
    const sql = createNodeSqliteDriver(':memory:')
    const store = new NotariumStore({
      mounts: [engineMountOf({ class: 'user-doc', prefix: '' }, createLocalFsFiles(dir))],
      sql,
      integritySweepBatchSize: 0,
    })

    try {
      await store.list()
      const hashes = await sql.all<{ path: string; content_hash: string }>(
        `SELECT path, content_hash FROM notes WHERE path IN ('prose.md', 'code.md') ORDER BY path`,
      )
      expect(hashes[0].content_hash).toBe(hashes[1].content_hash)

      const graph = await store.graph()
      expect(graph.links.some(({ source }) => source === 'prose.md')).toBe(true)
      expect(graph.links.some(({ source }) => source === 'code.md')).toBe(false)
    } finally {
      await store.stop()
    }
  })

  it('cache-off returns reference parity and never settles entries', async () => {
    const dir = await root()
    const indexDb = join(dir, 'index.db')
    await fs.writeFile(join(dir, 'target.md'), '# Target\n\nBody')
    await fs.writeFile(join(dir, 'source.md'), '# Source\n\n[[Target]] and [[Missing]]')
    const cached = createNotariumStore({ notesDir: dir, indexDb, integritySweepBatchSize: 0 })
    const expected = await cached.graph()
    await cached.stop()

    const reference = createNotariumStore({
      notesDir: dir,
      indexDb,
      wikilinkParseCache: false,
      integritySweepBatchSize: 0,
    })

    try {
      expect(await reference.graph()).toEqual(expected)
      const once = reference.wikilinkParseCacheStats()
      expect(once).toMatchObject({ enabled: false, entries: 0, fallbacks: 1 })
      await reference.graph()
      expect(reference.wikilinkParseCacheStats()).toMatchObject({
        entries: 0,
        bodyReads: once.bodyReads * 2,
        parserCalls: once.parserCalls * 2,
        fallbacks: 2,
      })
    } finally {
      await reference.stop()
    }
  })

  it('retries the whole metadata cut when a body generation changes during an async fill', async () => {
    const dir = await root()
    const indexDb = join(dir, 'index.db')
    await fs.writeFile(join(dir, 'source.md'), '# Source\n\n[[Target A]]')
    await fs.writeFile(join(dir, 'target-a.md'), '# Target A\n\nA')
    await fs.writeFile(join(dir, 'target-b.md'), '# Target B\n\nB')
    const seed = createNotariumStore({ notesDir: dir, indexDb, integritySweepBatchSize: 0 })
    await seed.list()
    await seed.stop()

    const base = createNodeSqliteDriver(indexDb)
    let announceBodyLoad!: () => void
    let releaseBodyLoad!: () => void
    const bodyLoadStarted = new Promise<void>((resolve) => {
      announceBodyLoad = resolve
    })
    const bodyLoadGate = new Promise<void>((resolve) => {
      releaseBodyLoad = resolve
    })
    let delayed = false
    const sql: SqlDriver = {
      ...base,
      get: async <T = Record<string, SqlValue>>(
        statement: string,
        params?: SqlValue[],
      ): Promise<T | undefined> => {
        if (
          !delayed &&
          statement.includes('file_fingerprints.source_hash AS source_hash, notes.body')
        ) {
          delayed = true
          announceBodyLoad()
          await bodyLoadGate
        }

        return base.get<T>(statement, params)
      },
    }
    const store = new NotariumStore({
      mounts: [engineMountOf({ class: 'user-doc', prefix: '' }, createLocalFsFiles(dir))],
      sql,
      integritySweepBatchSize: 0,
    })

    try {
      await store.list()
      const current = await store.read('source.md')
      const graph = store.graph()
      await bodyLoadStarted
      await store.write({
        originalId: 'source.md',
        title: 'Source',
        content: '[[Target B]] now',
        versionToken: current.versionToken,
      })
      releaseBodyLoad()

      const result = await graph
      expect(result.links).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'source.md', target: 'target-b.md' }),
        ]),
      )
      expect(
        result.links.some(
          ({ source, target }) => source === 'source.md' && target === 'target-a.md',
        ),
      ).toBe(false)
      expect(store.wikilinkParseCacheStats()).toMatchObject({ retries: 1, fallbacks: 0 })
    } finally {
      releaseBodyLoad()
      await store.stop()
    }
  })

  it('single-flights cold labels across fresh health and adjacency derivations', async () => {
    const dir = await root()
    const indexDb = join(dir, 'index.db')
    await fs.writeFile(join(dir, 'source.md'), '# Source\n\n[[Target]]')
    await fs.writeFile(join(dir, 'target.md'), '# Target\n\nBody')
    const seed = createNotariumStore({ notesDir: dir, indexDb, integritySweepBatchSize: 0 })
    await seed.list()
    await seed.stop()
    const store = createNotariumStore({ notesDir: dir, indexDb, integritySweepBatchSize: 0 })

    try {
      await store.list()
      const rebuild = Reflect.get(store, 'rebuildGraphAdjacency') as () => Promise<void>

      await Promise.all([store.graphHealth(), rebuild.call(store)])
      expect(store.wikilinkParseCacheStats()).toMatchObject({
        entries: 2,
        loads: 2,
        joins: 2,
        bodyReads: 2,
        parserCalls: 2,
        inFlight: 0,
      })
    } finally {
      await store.stop()
    }
  })

  it('observes only published adjacency generations and exact edge state', async () => {
    const dir = await root()
    const observations: Array<{
      generation: number
      totalNodes: number
      directedEdges: number
      hasEdge: boolean
    }> = []
    const store = createNotariumStore({
      notesDir: dir,
      integritySweepBatchSize: 0,
      onGraphAdjacencyBuilt: (observation) => {
        observations.push({
          generation: observation.generation,
          totalNodes: observation.totalNodes,
          directedEdges: observation.directedEdges,
          hasEdge: observation.hasEdge('source.md', 'target.md'),
        })
      },
    })

    try {
      await store.write({ title: 'Target', content: 'Body' })
      const source = await store.write({ title: 'Source', content: 'No links yet' })
      const rebuild = Reflect.get(store, 'rebuildGraphAdjacency') as () => Promise<void>

      await rebuild.call(store)
      expect(observations).toEqual([
        { generation: 1, totalNodes: 2, directedEdges: 0, hasEdge: false },
      ])

      const current = await store.read(source.filePath!)
      await store.write({
        originalId: source.filePath,
        title: 'Source',
        content: 'Now linked to [[Target]]',
        versionToken: current.versionToken,
      })
      await rebuild.call(store)

      expect(observations.at(-1)).toEqual({
        generation: 2,
        totalNodes: 2,
        directedEdges: 2,
        hasEdge: true,
      })
    } finally {
      await store.stop()
    }
  })

  it('bounds settled memory through create/delete churn and subtree eviction without a graph read', async () => {
    const dir = await root()
    const store = createNotariumStore({ notesDir: dir, integritySweepBatchSize: 0 })

    try {
      for (let index = 0; index < 8; index++) {
        const written = await store.write({
          title: `Transient ${index}`,
          content: '[[Shared Target]]',
        })
        expect(store.wikilinkParseCacheStats().entries).toBe(1)
        await store.remove(written.filePath!)
        expect(store.wikilinkParseCacheStats().entries).toBe(0)
      }

      for (let index = 0; index < 4; index++) {
        await store.write({
          title: `Batch ${index}`,
          directory: 'batch',
          content: `[[Target ${index}]]`,
        })
      }
      const atN = store.wikilinkParseCacheStats()
      expect(atN).toMatchObject({ entries: 4, labelOccurrences: 4 })
      for (let index = 4; index < 8; index++) {
        await store.write({
          title: `Batch ${index}`,
          directory: 'batch',
          content: `[[Target ${index}]]`,
        })
      }
      const at2N = store.wikilinkParseCacheStats()
      expect(at2N.entries).toBe(atN.entries * 2)
      expect(at2N.labelOccurrences).toBe(atN.labelOccurrences * 2)
      expect(at2N.labelCodeUnits).toBeGreaterThan(atN.labelCodeUnits)

      await store.removeDir('batch')
      expect(store.wikilinkParseCacheStats()).toMatchObject({ entries: 0, inFlight: 0 })
    } finally {
      await store.stop()
    }
  })
})
