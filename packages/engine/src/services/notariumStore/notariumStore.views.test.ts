import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { sha256Hex } from '@notarium/core'

import { createLocalFsFiles, type FileStat } from '../../libs/files'
import { createNodeSqliteDriver, type SqlDriver } from '../../libs/sql'
import { NotariumStore } from './notariumStore'
import { engineMountOf } from './types'

const carrier = (rank: string, prose = 'Visible sprint prose.') =>
  [
    prose,
    '',
    '```nota',
    'version: 1',
    'source:',
    '  kind: notes',
    '  secretConfigToken: hidden-from-search',
    'views:',
    '  - name: Board',
    '    type: board',
    '    options:',
    '      groupBy: note.status',
    '      order:',
    '        kind: manual',
    '        ranks: |-',
    `          ["task-1","${rank}"]`,
    '```',
  ].join('\n')

const racedCarrier = (rank: string, prose: string, tags?: string): string =>
  [
    '---',
    'view: board',
    ...(tags ? [`tags: [${tags}]`] : []),
    '---',
    '# Race',
    '',
    carrier(rank, prose),
  ].join('\n')

describe('NotariumStore view projections', () => {
  let root: string | undefined

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true })
      root = undefined
    }
  })

  it('keeps raw carrier bytes while indexing only semantic prose and a dedicated marker', async () => {
    root = mkdtempSync(join(tmpdir(), 'notarium-views-'))
    const raw = [
      '---',
      'title: Sprint',
      'view: board',
      '---',
      '',
      '# Sprint',
      '',
      carrier('a0V'),
    ].join('\n')

    writeFileSync(join(root, 'sprint.md'), raw)
    const sql = createNodeSqliteDriver(':memory:')
    const store = new NotariumStore({
      mounts: [engineMountOf({ class: 'user-doc', prefix: '' }, createLocalFsFiles(root))],
      sql,
      integritySweepBatchSize: 0,
    })

    const [meta] = await store.list()

    expect(meta.viewType).toBe('board')
    expect(meta.fields?.keys).not.toHaveProperty('view')
    expect((await store.read('sprint.md')).content).toContain('secretConfigToken')
    expect((await store.search('Visible sprint')).map((hit) => hit.filePath)).toEqual(['sprint.md'])
    expect(await store.search('hidden-from-search')).toEqual([])
    expect((await store.preview('sprint.md')).snippet).toBe('Visible sprint prose.')

    const row = await sql.get<{
      body: string
      semantic_body: string
      view_type: string
      content_hash: string
      rowid: number
    }>(
      `SELECT rowid, body, semantic_body, view_type, content_hash
         FROM notes WHERE path = 'sprint.md'`,
    )

    expect(row?.body).toContain('hidden-from-search')
    expect(row?.semantic_body).toContain('Visible sprint prose.')
    expect(row?.semantic_body).not.toContain('hidden-from-search')
    expect(row?.view_type).toBe('board')
    const vectorReview = store as unknown as {
      vecReady: boolean
      enqueueEmbed(rowid: bigint): void
    }
    const originalVecReady = vectorReview.vecReady
    const originalEnqueueEmbed = vectorReview.enqueueEmbed.bind(store)
    const vectorInvalidations: bigint[] = []

    vectorReview.vecReady = true
    vectorReview.enqueueEmbed = (rowid) => vectorInvalidations.push(rowid)
    const changesBefore = await sql.get<{ total: number }>('SELECT total_changes() AS total')

    await store.write({
      title: 'Sprint',
      originalId: 'sprint.md',
      content: carrier('a1V'),
      viewType: 'board',
    })
    const changesAfter = await sql.get<{ total: number }>('SELECT total_changes() AS total')
    const changed = await sql.get<{
      body: string
      semantic_body: string
      content_hash: string
      rowid: number
    }>(
      `SELECT rowid, body, semantic_body, content_hash
         FROM notes WHERE path = 'sprint.md'`,
    )

    expect(changed?.body).toContain('a1V')
    expect(changed?.semantic_body).toBe(row?.semantic_body)
    expect(changed?.content_hash).toBe(row?.content_hash)
    expect(changed?.rowid).toBe(row?.rowid)
    // The raw carrier and fingerprint move. FTS does not delete/reinsert an
    // identical title/semantic body/tags row merely because ranks changed.
    expect(changesAfter!.total - changesBefore!.total).toBe(2)
    expect(vectorInvalidations).toEqual([])
    vectorReview.vecReady = originalVecReady
    vectorReview.enqueueEmbed = originalEnqueueEmbed
    await store.stop()
  })

  it('lets the latest overlapping raw generation restore FTS inputs read before publication', async () => {
    root = mkdtempSync(join(tmpdir(), 'notarium-views-race-'))
    const baseSql = createNodeSqliteDriver(':memory:')
    let gateUpdates = false
    let earlierUpdateStarted!: () => void
    let latestUpdateStarted!: () => void
    let releaseEarlier!: () => void
    let releaseLatest!: () => void
    const earlierUpdateStartedPromise = new Promise<void>((resolve) => {
      earlierUpdateStarted = resolve
    })
    const latestUpdateStartedPromise = new Promise<void>((resolve) => {
      latestUpdateStarted = resolve
    })
    const releaseEarlierPromise = new Promise<void>((resolve) => {
      releaseEarlier = resolve
    })
    const releaseLatestPromise = new Promise<void>((resolve) => {
      releaseLatest = resolve
    })
    const sql: SqlDriver = {
      ...baseSql,
      run: async (statement, params = []) => {
        if (gateUpdates && statement.includes('UPDATE notes SET title')) {
          const strings = params.filter((value): value is string => typeof value === 'string')

          if (strings.some((value) => value.includes('Bravo prose.'))) {
            earlierUpdateStarted()
            await releaseEarlierPromise
          } else if (strings.some((value) => value.includes('Alpha prose.'))) {
            latestUpdateStarted()
            await releaseLatestPromise
          }
        }

        return baseSql.run(statement, params)
      },
    }
    const store = new NotariumStore({
      mounts: [engineMountOf({ class: 'user-doc', prefix: '' }, createLocalFsFiles(root))],
      sql,
      integritySweepBatchSize: 0,
    })
    const upsert = (
      store as unknown as {
        upsertRow(
          fullPath: string,
          cls: 'user-doc',
          stat: FileStat,
          raw: string,
          knownSourceHash: string,
        ): Promise<void>
      }
    ).upsertRow.bind(store)
    const publish = async (raw: string, sourceHash: string, mtimeMs: number): Promise<void> =>
      upsert(
        'race.md',
        'user-doc',
        {
          path: 'race.md',
          mtimeMs,
          size: Buffer.byteLength(raw),
          birthtimeMs: mtimeMs,
          changeToken: `generation-${mtimeMs}`,
        },
        raw,
        sourceHash,
      )
    const initial = racedCarrier('a0', 'Alpha prose.')
    const earlier = racedCarrier('a1', 'Bravo prose.', 'blue')
    const latest = racedCarrier('a2', 'Alpha prose.')
    const [initialHash, earlierHash, latestHash] = await Promise.all(
      [initial, earlier, latest].map(sha256Hex),
    )

    await store.list()
    await publish(initial, initialHash, 1)
    const initialProjection = await sql.get<{ content_hash: string; rowid: number }>(
      `SELECT content_hash, rowid FROM notes WHERE path = 'race.md'`,
    )
    const vectorReview = store as unknown as {
      vecReady: boolean
      enqueueEmbed(rowid: bigint): void
      publishWithSeq<T>(publish: (seq: number) => Promise<T>): Promise<T>
    }
    const originalVecReady = vectorReview.vecReady
    const originalEnqueueEmbed = vectorReview.enqueueEmbed.bind(store)
    const vectorInvalidations: bigint[] = []

    vectorReview.vecReady = true
    vectorReview.enqueueEmbed = (rowid) => vectorInvalidations.push(rowid)
    gateUpdates = true
    const earlierWrite = publish(earlier, earlierHash, 2)

    await earlierUpdateStartedPromise
    let latestQueued!: () => void
    const latestQueuedPromise = new Promise<void>((resolve) => {
      latestQueued = resolve
    })
    const originalPublishWithSeq = vectorReview.publishWithSeq.bind(store)

    vectorReview.publishWithSeq = <T>(publication: (seq: number) => Promise<T>): Promise<T> => {
      const pending = originalPublishWithSeq(publication)

      latestQueued()
      return pending
    }
    const latestWrite = publish(latest, latestHash, 3)
    await latestQueuedPromise
    vectorReview.publishWithSeq = originalPublishWithSeq
    releaseEarlier()
    await Promise.all([earlierWrite, latestUpdateStartedPromise])
    const earlierProjection = await sql.get<{ content_hash: string; semantic_body: string }>(
      `SELECT content_hash, semantic_body FROM notes WHERE path = 'race.md'`,
    )
    releaseLatest()
    await latestWrite

    const row = await sql.get<{
      body: string
      tags: string
      semantic_body: string
      content_hash: string
      seq: number
    }>(`SELECT body, tags, semantic_body, content_hash, seq FROM notes WHERE path = 'race.md'`)
    const fingerprint = await sql.get<{ source_hash: string; note_seq: number }>(
      `SELECT source_hash, note_seq FROM file_fingerprints WHERE note_rowid =
         (SELECT rowid FROM notes WHERE path = 'race.md')`,
    )
    const staleFts = await sql.all<{ path: string }>(
      `SELECT notes.path FROM notes_fts JOIN notes ON notes.rowid = notes_fts.rowid
       WHERE notes_fts MATCH 'Bravo'`,
    )
    const currentFts = await sql.all<{ path: string }>(
      `SELECT notes.path FROM notes_fts JOIN notes ON notes.rowid = notes_fts.rowid
       WHERE notes_fts MATCH 'Alpha'`,
    )

    expect(row?.body).toContain('a2')
    expect(row?.body).toContain('Alpha prose.')
    expect(row?.body).not.toContain('Bravo prose.')
    expect(row?.tags).toBe('[]')
    expect(earlierProjection?.semantic_body).toContain('Bravo prose.')
    expect(earlierProjection?.content_hash).not.toBe(initialProjection?.content_hash)
    expect(row?.semantic_body).toContain('Alpha prose.')
    expect(row?.semantic_body).not.toContain('Bravo prose.')
    expect(row?.content_hash).toBe(initialProjection?.content_hash)
    expect(fingerprint).toEqual({ source_hash: latestHash, note_seq: row?.seq })
    expect(staleFts).toEqual([])
    expect(currentFts).toEqual([{ path: 'race.md' }])
    expect(vectorInvalidations).toEqual([
      BigInt(initialProjection!.rowid),
      BigInt(initialProjection!.rowid),
    ])
    vectorReview.vecReady = originalVecReady
    vectorReview.enqueueEmbed = originalEnqueueEmbed
    await store.stop()
  })
})
