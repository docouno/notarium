import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sha256Hex } from '@notarium/core'

import type { FileStat, FileStore } from '../../libs/files'
import { createLocalFsFiles } from '../../libs/files'
import { createNodeSqliteDriver, type SqlDriver } from '../../libs/sql'
import { createNotariumStore } from './createNotariumStore'
import { NotariumStore } from './notariumStore'
import { INDEX_MIGRATIONS, INDEX_VERSION_KEY, META_INTEGRITY_SWEEP_CURSOR } from './schema'

const roots: string[] = []
const fixedTime = new Date('2026-07-23T12:00:00.000Z')
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const mkroot = async (prefix = 'notarium-external-edit-'): Promise<string> => {
  const root = await fs.mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

const writePreservingMtime = async (root: string, path: string, raw: string): Promise<void> => {
  await fs.writeFile(join(root, path), raw)
  await fs.utimes(join(root, path), fixedTime, fixedTime)
}

/** A storage adapter whose cheap token deliberately under-reports changes. It
 *  models a remote/list API that preserves mtime+size and emits no usable etag;
 *  only watcher path forcing or the source-integrity sweep can discover edits. */
const staticTokenFiles = (
  root: string,
): {
  files: FileStore
  signal(path: string | null): void
  setUnreadable(path: string, unreadable: boolean): void
  readCount(path: string): number
} => {
  const base = createLocalFsFiles(root)
  let listener: ((path: string | null) => void) | null = null
  const unreadable = new Set<string>()
  const reads = new Map<string, number>()
  const hideChange = (stat: FileStat): FileStat => ({ ...stat, changeToken: 'fixed' })
  const files: FileStore = {
    ...base,
    scan: async () => (await base.scan()).map(hideChange),
    stat: async (path) => {
      const stat = await base.stat(path)
      return stat ? hideChange(stat) : null
    },
    read: (path) => {
      reads.set(path, (reads.get(path) ?? 0) + 1)
      return unreadable.has(path) ? Promise.resolve(null) : base.read(path)
    },
    watch: (onChange) => {
      listener = onChange
      return () => {
        listener = null
      }
    },
  }

  return {
    files,
    signal: (path) => listener?.(path),
    setUnreadable: (path, value) => {
      if (value) {
        unreadable.add(path)
      } else {
        unreadable.delete(path)
      }
    },
    readCount: (path) => reads.get(path) ?? 0,
  }
}

const userMount = (files: FileStore) => [{ class: 'user-doc' as const, prefix: '', files }]

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('NotariumStore external edit convergence', () => {
  it('uses the LocalFS change token to catch a same-size, same-mtime edit on the next poll', async () => {
    const root = await mkroot()
    await writePreservingMtime(root, 'a.md', '# Target A\n\nA')
    await writePreservingMtime(root, 'b.md', '# Target B\n\nB')
    await writePreservingMtime(root, 'probe.md', '# AAAA\n\ntermold [[Target A]]')
    const store = createNotariumStore({
      notesDir: root,
      integritySweepBatchSize: 0,
    })

    try {
      const seed = await store.changes(null)
      // Cross a coarse ctime tick before the rewrite: this test isolates the
      // LocalFS token fast path with the integrity sweep deliberately disabled.
      await sleep(20)
      await writePreservingMtime(root, 'probe.md', '# BBBB\n\ntermnew [[Target B]]')
      const delta = await store.changes(seed.cursor)

      expect(delta.upserts.map((item) => item.meta.filePath)).toContain('probe.md')
      expect((await store.list()).find((note) => note.filePath === 'probe.md')?.title).toBe('BBBB')
      expect(await store.search('termold', { pageSize: 10 })).toHaveLength(0)
      expect(await store.search('termnew', { pageSize: 10 })).toHaveLength(1)
      expect(
        (await store.graph()).links.some(
          (link) => link.source === 'probe.md' && link.target === 'b.md',
        ),
      ).toBe(true)
      expect(
        (await store.graph()).links.some(
          (link) => link.source === 'probe.md' && link.target === 'a.md',
        ),
      ).toBe(false)
    } finally {
      await store.stop()
    }
  })

  it('force-reads an exact watcher path even when every stat prefilter lies', async () => {
    const root = await mkroot()
    await writePreservingMtime(root, 'probe.md', '# Probe\n\nAAAA')
    const adapter = staticTokenFiles(root)
    const store = new NotariumStore({
      mounts: userMount(adapter.files),
      sql: createNodeSqliteDriver(':memory:'),
      integritySweepBatchSize: 0,
    })

    try {
      let signals = 0
      const unwatch = store.watch(() => {
        signals++
      })
      const seed = await store.changes(null)
      await writePreservingMtime(root, 'probe.md', '# Probe\n\nBBBB')

      const stale = await store.changes(seed.cursor)
      expect(stale.upserts).toEqual([])
      expect(await store.search('BBBB', { pageSize: 10 })).toHaveLength(0)

      adapter.signal('probe.md')
      expect(signals).toBe(1)
      const healed = await store.changes(stale.cursor)
      expect(healed.upserts).toHaveLength(1)
      expect(healed.upserts[0].content).toBe('BBBB')
      expect(await store.search('BBBB', { pageSize: 10 })).toHaveLength(1)
      unwatch?.()
    } finally {
      await store.stop()
    }
  })

  it('treats a pathless watcher event as a wake-up and heals through the bounded sweep', async () => {
    const root = await mkroot()
    await writePreservingMtime(root, 'probe.md', '# Probe\n\nAAAA')
    const adapter = staticTokenFiles(root)
    const store = new NotariumStore({
      mounts: userMount(adapter.files),
      sql: createNodeSqliteDriver(':memory:'),
      integritySweepBatchSize: 1,
    })

    try {
      let signals = 0
      const unwatch = store.watch(() => {
        signals++
      })
      const seed = await store.changes(null)
      await writePreservingMtime(root, 'probe.md', '# Probe\n\nBBBB')
      adapter.signal(null)

      expect(signals).toBe(1)
      const healed = await store.changes(seed.cursor)
      expect(healed.upserts.map((item) => item.meta.filePath)).toEqual(['probe.md'])
      expect(await store.search('BBBB', { pageSize: 10 })).toHaveLength(1)
      unwatch?.()
    } finally {
      await store.stop()
    }
  })

  it('bounds a missed-event frontmatter edit via the rotating sweep without quiet seq churn', async () => {
    const root = await mkroot()
    const before = ['---', 'tags: [AAAA]', '---', '# Probe', '', 'body'].join('\n')
    const after = ['---', 'tags: [BBBB]', '---', '# Probe', '', 'body'].join('\n')
    await writePreservingMtime(root, 'a.md', '# A\n\nA')
    await writePreservingMtime(root, 'b.md', '# B\n\nB')
    await writePreservingMtime(root, 'probe.md', before)
    const adapter = staticTokenFiles(root)
    const store = new NotariumStore({
      mounts: userMount(adapter.files),
      sql: createNodeSqliteDriver(':memory:'),
      integritySweepBatchSize: 1,
    })

    try {
      const seed = await store.changes(null)
      const quiet = await store.changes(seed.cursor)
      expect(quiet.upserts).toEqual([])
      expect(quiet.cursor).toBe(seed.cursor)

      await writePreservingMtime(root, 'probe.md', after)
      let cursor = quiet.cursor
      let healed = false

      for (let poll = 0; poll < 3; poll++) {
        const delta = await store.changes(cursor)
        cursor = delta.cursor
        if (delta.upserts.some((item) => item.meta.filePath === 'probe.md')) {
          healed = true
          break
        }
      }

      expect(healed).toBe(true)
      expect((await store.list()).find((note) => note.filePath === 'probe.md')?.tags).toEqual([
        'BBBB',
      ])
      expect(await store.search('AAAA', { pageSize: 10 })).toHaveLength(0)
      expect(await store.search('BBBB', { pageSize: 10 })).toHaveLength(1)
    } finally {
      await store.stop()
    }
  })

  it('persists the rotating cursor so a restart continues with the next path', async () => {
    const root = await mkroot()
    const dbRoot = await mkroot('notarium-external-edit-db-')
    const indexDb = join(dbRoot, 'index.db')

    for (const path of ['a.md', 'b.md', 'c.md']) {
      await writePreservingMtime(root, path, `# ${path}\n\nbody`)
    }
    const adapter = staticTokenFiles(root)
    let store = new NotariumStore({
      mounts: userMount(adapter.files),
      sql: createNodeSqliteDriver(indexDb),
      integritySweepBatchSize: 1,
    })
    await store.changes(null)
    await store.stop()

    let db = createNodeSqliteDriver(indexDb)
    expect(
      (
        await db.get<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [
          META_INTEGRITY_SWEEP_CURSOR,
        ])
      )?.value,
    ).toBe('a.md')
    await db.close()

    store = new NotariumStore({
      mounts: userMount(adapter.files),
      sql: createNodeSqliteDriver(indexDb),
      integritySweepBatchSize: 1,
    })
    await store.list()
    await store.stop()

    db = createNodeSqliteDriver(indexDb)
    expect(
      (
        await db.get<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [
          META_INTEGRITY_SWEEP_CURSOR,
        ])
      )?.value,
    ).toBe('b.md')
    await db.close()
  })

  it('does not let an unreadable sweep path starve later files', async () => {
    const root = await mkroot()

    for (const path of ['a.md', 'b.md', 'c.md']) {
      await writePreservingMtime(root, path, `# ${path}\n\nAAAA`)
    }
    const adapter = staticTokenFiles(root)
    const sql = createNodeSqliteDriver(':memory:')
    const store = new NotariumStore({
      mounts: userMount(adapter.files),
      sql,
      integritySweepBatchSize: 1,
    })

    try {
      const seed = await store.changes(null) // boot verifies a.md
      adapter.setUnreadable('b.md', true)
      await writePreservingMtime(root, 'c.md', '# c.md\n\nBBBB')

      const blockedAttempt = await store.changes(seed.cursor)
      expect(blockedAttempt.upserts).toEqual([])
      expect(
        (
          await sql.get<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [
            META_INTEGRITY_SWEEP_CURSOR,
          ])
        )?.value,
      ).toBe('b.md')

      const healedLater = await store.changes(blockedAttempt.cursor)
      expect(healedLater.upserts.map((item) => item.meta.filePath)).toEqual(['c.md'])
      expect(await store.search('BBBB', { pageSize: 10 })).toHaveLength(1)
    } finally {
      await store.stop()
    }
  })

  it('bounds failed exact watcher paths to one immediate attempt', async () => {
    const root = await mkroot()

    for (const path of ['a.md', 'b.md', 'c.md']) {
      await writePreservingMtime(root, path, `# ${path}\n\nbody`)
    }
    const adapter = staticTokenFiles(root)
    const store = new NotariumStore({
      mounts: userMount(adapter.files),
      sql: createNodeSqliteDriver(':memory:'),
      integritySweepBatchSize: 1,
    })

    try {
      const unwatch = store.watch(() => {})
      const seed = await store.changes(null) // cursor = a.md

      for (const path of ['a.md', 'b.md', 'c.md']) {
        adapter.setUnreadable(path, true)
        adapter.signal(path)
      }
      const beforeForced = ['a.md', 'b.md', 'c.md'].reduce(
        (sum, path) => sum + adapter.readCount(path),
        0,
      )
      const forcedAttempt = await store.changes(seed.cursor)
      const afterForced = ['a.md', 'b.md', 'c.md'].reduce(
        (sum, path) => sum + adapter.readCount(path),
        0,
      )
      expect(afterForced - beforeForced).toBe(3)

      await store.changes(forcedAttempt.cursor)
      const afterFallback = ['a.md', 'b.md', 'c.md'].reduce(
        (sum, path) => sum + adapter.readCount(path),
        0,
      )
      expect(afterFallback - afterForced).toBe(1)
      unwatch?.()
    } finally {
      await store.stop()
    }
  })

  it('binds a fingerprint to the exact notes seq under interleaved upserts', async () => {
    const root = await mkroot()
    const oldRaw = '# Oldd\n\nAAAA'
    const newRaw = '# Neww\n\nBBBB'
    await writePreservingMtime(root, 'a.md', oldRaw)
    const adapter = staticTokenFiles(root)
    const sql = createNodeSqliteDriver(':memory:')
    const store = new NotariumStore({
      mounts: userMount(adapter.files),
      sql,
      integritySweepBatchSize: 1,
    })
    await store.list()
    await writePreservingMtime(root, 'a.md', newRaw)
    const baseStat = await adapter.files.stat('a.md')

    if (!baseStat) {
      throw new Error('missing test stat')
    }
    type ReviewStore = {
      seq: number
      upsertRow(path: string, cls: 'user-doc', stat: FileStat, raw: string): Promise<void>
      recordFingerprint(
        rowid: number,
        seq: number,
        hash: string,
        token: string | undefined,
      ): Promise<{ changes: number }>
    }
    const reviewStore = store as unknown as ReviewStore
    const originalRecord = reviewStore.recordFingerprint.bind(store)
    let announceNew!: () => void
    let releaseNew!: () => void
    const newReachedFingerprint = new Promise<void>((resolve) => {
      announceNew = resolve
    })
    const holdNewFingerprint = new Promise<void>((resolve) => {
      releaseNew = resolve
    })

    reviewStore.recordFingerprint = async (rowid, seq, hash, token) => {
      if (token === 'new') {
        announceNew()
        await holdNewFingerprint
      }

      return originalRecord(rowid, seq, hash, token)
    }

    try {
      const newer = reviewStore.upsertRow(
        'a.md',
        'user-doc',
        { ...baseStat, changeToken: 'new' },
        newRaw,
      )
      await newReachedFingerprint
      await reviewStore.upsertRow('a.md', 'user-doc', { ...baseStat, changeToken: 'old' }, oldRaw)
      releaseNew()
      await newer

      const raced = await sql.get<{
        title: string
        seq: number
        note_seq: number
        change_token: string
      }>(
        `SELECT notes.title, notes.seq, file_fingerprints.note_seq,
                file_fingerprints.change_token
         FROM notes JOIN file_fingerprints ON file_fingerprints.note_rowid = notes.rowid
         WHERE notes.path = 'a.md'`,
      )
      expect(raced).toMatchObject({
        title: 'Oldd',
        change_token: 'old',
      })
      expect(raced?.note_seq).toBe(raced?.seq)

      // Model the crash residue the version binding is designed to reject:
      // fingerprint bytes from NEW alongside the OLD materialization, but tagged
      // with the earlier writer's seq. It must behave as no fingerprint at all.
      await sql.run(
        `UPDATE file_fingerprints
         SET source_hash = ?, change_token = 'new', note_seq = ?
         WHERE note_rowid = (SELECT rowid FROM notes WHERE path = 'a.md')`,
        [await sha256Hex(newRaw), (raced?.seq ?? 1) - 1],
      )
      const healed = await store.changes(String(reviewStore.seq))
      expect(healed.upserts.map((item) => item.meta.filePath)).toEqual(['a.md'])
      expect((await store.list()).find((note) => note.filePath === 'a.md')?.title).toBe('Neww')
    } finally {
      reviewStore.recordFingerprint = originalRecord
      releaseNew()
      await store.stop()
    }
  })

  it('serializes seq publication for a genuinely async SQL driver', async () => {
    const root = await mkroot()
    await writePreservingMtime(root, 'a.md', '# Base\n\nbody')
    const adapter = staticTokenFiles(root)
    const baseSql = createNodeSqliteDriver(':memory:')
    let delayFirst = false
    let announceFirstRun!: () => void
    let releaseFirstRun!: () => void
    let secondRunStarted = false
    const firstRunStarted = new Promise<void>((resolve) => {
      announceFirstRun = resolve
    })
    const holdFirstRun = new Promise<void>((resolve) => {
      releaseFirstRun = resolve
    })
    const sql: SqlDriver = {
      ...baseSql,
      run: async (statement, params) => {
        if (delayFirst && statement.includes('UPDATE notes SET title')) {
          if (params?.[0] === 'First') {
            announceFirstRun()
            await holdFirstRun
          } else if (params?.[0] === 'Second') {
            secondRunStarted = true
          }
        }

        return baseSql.run(statement, params)
      },
    }
    const store = new NotariumStore({
      mounts: userMount(adapter.files),
      sql,
      integritySweepBatchSize: 0,
    })
    await store.list()
    const stat = await adapter.files.stat('a.md')

    if (!stat) {
      throw new Error('missing test stat')
    }
    type AsyncReviewStore = {
      seq: number
      embedContentHash(title: string, body: string): Promise<string>
      upsertRow(
        path: string,
        cls: 'user-doc',
        stat: FileStat,
        raw: string,
        sourceHash?: string,
      ): Promise<void>
    }
    const reviewStore = store as unknown as AsyncReviewStore
    const originalContentHash = reviewStore.embedContentHash.bind(store)
    let announceSecondHash!: () => void
    const secondHashReady = new Promise<void>((resolve) => {
      announceSecondHash = resolve
    })

    reviewStore.embedContentHash = async (title, body) => {
      const hash = await originalContentHash(title, body)

      if (title === 'Second') {
        announceSecondHash()
      }

      return hash
    }

    try {
      delayFirst = true
      const first = reviewStore.upsertRow(
        'a.md',
        'user-doc',
        { ...stat, changeToken: 'first' },
        '# First\n\nAAAA',
        'source-first',
      )
      await firstRunStarted
      const second = reviewStore.upsertRow(
        'a.md',
        'user-doc',
        { ...stat, changeToken: 'second' },
        '# Second\n\nBBBB',
        'source-second',
      )
      await secondHashReady
      await new Promise((resolve) => setImmediate(resolve))

      expect(secondRunStarted).toBe(false)
      releaseFirstRun()
      await Promise.all([first, second])

      const row = await baseSql.get<{ title: string; seq: number }>(
        `SELECT title, seq FROM notes WHERE path = 'a.md'`,
      )
      expect(row).toEqual({ title: 'Second', seq: reviewStore.seq })
    } finally {
      reviewStore.embedContentHash = originalContentHash
      releaseFirstRun()
      await store.stop()
    }
  })

  it('keeps the delta cursor behind a pending async publication', async () => {
    const root = await mkroot()
    await writePreservingMtime(root, 'a.md', '# Base\n\nbody')
    const adapter = staticTokenFiles(root)
    const baseSql = createNodeSqliteDriver(':memory:')
    let delayUpdate = false
    let announceUpdate!: () => void
    let releaseUpdate!: () => void
    const updateStarted = new Promise<void>((resolve) => {
      announceUpdate = resolve
    })
    const holdUpdate = new Promise<void>((resolve) => {
      releaseUpdate = resolve
    })
    const sql: SqlDriver = {
      ...baseSql,
      run: async (statement, params) => {
        if (
          delayUpdate &&
          statement.includes('UPDATE notes SET title') &&
          params?.[0] === 'Published'
        ) {
          announceUpdate()
          await holdUpdate
        }

        return baseSql.run(statement, params)
      },
    }
    const store = new NotariumStore({
      mounts: userMount(adapter.files),
      sql,
      integritySweepBatchSize: 0,
    })

    type CursorReviewStore = {
      seq: number
      rescan(): Promise<void>
      upsertRow(
        path: string,
        cls: 'user-doc',
        stat: FileStat,
        raw: string,
        sourceHash?: string,
      ): Promise<void>
    }
    const reviewStore = store as unknown as CursorReviewStore
    const originalRescan = reviewStore.rescan.bind(store)

    try {
      const seed = await store.changes(null)
      const stat = await adapter.files.stat('a.md')

      if (!stat) {
        throw new Error('missing test stat')
      }
      // Keep the race test on the publication boundary itself. A real LocalFS
      // rescan has unrelated I/O yield points and could still be running when
      // the assertion fires, making a gate-less implementation pass by timing.
      reviewStore.rescan = () => Promise.resolve()
      delayUpdate = true
      const writer = reviewStore.upsertRow(
        'a.md',
        'user-doc',
        stat,
        '# Published\n\nAAAA',
        'source-published',
      )
      await updateStarted
      let deltaSettled = false
      const pendingDelta = store.changes(seed.cursor).then((delta) => {
        deltaSettled = true
        return delta
      })
      await new Promise((resolve) => setImmediate(resolve))

      expect(deltaSettled).toBe(false)
      expect(reviewStore.seq).toBe(Number(seed.cursor))
      releaseUpdate()
      const [, delta] = await Promise.all([writer, pendingDelta])
      expect(delta.cursor).toBe(String(reviewStore.seq))
      expect(delta.upserts.map((item) => item.meta.filePath)).toEqual(['a.md'])
      expect(delta.upserts[0].content).toBe('AAAA')

      const quiet = await store.changes(delta.cursor)
      expect(quiet.cursor).toBe(delta.cursor)
      expect(quiet.upserts).toEqual([])
    } finally {
      reviewStore.rescan = originalRescan
      releaseUpdate()
      await store.stop()
    }
  })

  it('rejects a non-finite, fractional, or negative sweep batch size', async () => {
    const root = await mkroot()

    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1]) {
      const sql = createNodeSqliteDriver(':memory:')

      try {
        expect(
          () =>
            new NotariumStore({
              mounts: userMount(createLocalFsFiles(root)),
              sql,
              integritySweepBatchSize: value,
            }),
        ).toThrow('integritySweepBatchSize must be a non-negative integer')
      } finally {
        await sql.close()
      }
    }
  })

  it('lazily adopts fingerprints after the additive migration without a false delta', async () => {
    const root = await mkroot()
    const dbRoot = await mkroot('notarium-external-edit-migration-')
    const indexDb = join(dbRoot, 'index.db')
    await writePreservingMtime(root, 'probe.md', '# Probe\n\nbody')
    const adapter = staticTokenFiles(root)
    let store = new NotariumStore({
      mounts: userMount(adapter.files),
      sql: createNodeSqliteDriver(indexDb),
      integritySweepBatchSize: 0,
      migrations: [INDEX_MIGRATIONS[0]],
    })
    const seed = await store.changes(null)
    await store.stop()

    store = new NotariumStore({
      mounts: userMount(adapter.files),
      sql: createNodeSqliteDriver(indexDb),
      integritySweepBatchSize: 1,
    })
    const afterMigration = await store.changes(seed.cursor)
    expect(afterMigration.cursor).toBe(seed.cursor)
    expect(afterMigration.upserts).toEqual([])
    await store.stop()

    const db = createNodeSqliteDriver(indexDb)
    expect(
      (await db.get<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [INDEX_VERSION_KEY]))
        ?.value,
    ).toBe(String(INDEX_MIGRATIONS.length))
    expect(
      (await db.get<{ count: number }>(`SELECT count(*) AS count FROM file_fingerprints`))?.count,
    ).toBe(1)
    await db.close()
  })
})
