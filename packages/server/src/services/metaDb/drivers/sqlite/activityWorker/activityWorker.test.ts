import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'

import type { RevisionInput } from '@notarium/core'

import { SqliteMetaDb } from '../../../sqliteMetaDb'
import { createSqliteActivityWorker } from './activityWorker'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()))
})

const revision = (index: number): RevisionInput => ({
  noteId: `note-${index}`,
  space: 'space-a',
  baseRevisionId: null,
  theirRevisionId: null,
  sourceRevisionId: null,
  kind: 'external',
  entryRole: 'origin',
  principal: 'user:alice',
  contentHash: null,
  title: `Note ${index}`,
  class: 'user-doc',
  slug: null,
  tags: [],
  createdAt: new Date(Date.UTC(2026, 7, 30, 0, 0, index)).toISOString(),
  charsAdded: null,
  charsRemoved: null,
})

it('preserves Activity errors and closes its dedicated connection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'notarium-activity-worker-'))
  const path = join(directory, 'meta.sqlite')
  const db = new SqliteMetaDb(path)
  await db.revisions.init()
  const worker = createSqliteActivityWorker(path)
  cleanups.push(async () => {
    await worker.close()
    await db.close()
    rmSync(directory, { recursive: true, force: true })
  })

  await expect(worker.activityGroupsByNote('space-a', {})).rejects.toMatchObject({
    reason: 'activity_projection_rebuilding',
    isUnavailable: true,
  })
  await expect(db.revisions.prepareActivityProjection('space-a')).resolves.toEqual({
    state: 'ready',
    lease: { through: null, activeGeneration: '1', sourceGeneration: '1' },
  })
  await expect(worker.activityGroupsByNote('space-a', {})).resolves.toEqual({
    items: [],
    through: null,
    activityLease: { through: null, activeGeneration: '1', sourceGeneration: '1' },
  })

  await worker.close()
  await expect(worker.activityGroupsByNote('space-a', {})).rejects.toThrow(
    'SQLite Activity worker is closed',
  )
})

it('resumes a durable rebuild cursor after replacing the worker and main connection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'notarium-activity-worker-resume-'))
  const path = join(directory, 'meta.sqlite')
  let db = new SqliteMetaDb(path)
  cleanups.push(async () => {
    await db.close()
    rmSync(directory, { recursive: true, force: true })
  })

  for (let index = 0; index < 25; index++) {
    await db.revisions.append(revision(index), null)
  }
  const invalidator = new DatabaseSync(path)

  try {
    invalidator
      .prepare("UPDATE note_revisions SET integrity = 'quarantined' WHERE note_id = 'note-0'")
      .run()
  } finally {
    invalidator.close()
  }
  await expect(db.revisions.prepareActivityProjection('space-a')).resolves.toEqual({
    state: 'rebuilding',
  })
  await expect(db.revisions.maintainActivityProjection('space-a')).resolves.toMatchObject({
    state: 'rebuilding',
    processed: 10,
  })
  await db.close()

  db = new SqliteMetaDb(path)
  await expect(db.revisions.prepareActivityProjection('space-a')).resolves.toEqual({
    state: 'rebuilding',
  })
  for (;;) {
    const step = await db.revisions.maintainActivityProjection('space-a')

    if (step.state === 'ready') {
      break
    }
  }
  const groups = await db.revisions.activityGroupsByNote('space-a', {})

  expect(groups.items).toHaveLength(25)
  expect(groups.items.find(({ noteId }) => noteId === 'note-0')?.lastEvent).toMatchObject({
    unavailableReason: 'identity-conflict',
  })
})

it('turns foreground SQLite writer contention into a retryable empty GC turn', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'notarium-activity-worker-busy-'))
  const path = join(directory, 'meta.sqlite')
  const db = new SqliteMetaDb(path)
  cleanups.push(async () => {
    await db.close()
    rmSync(directory, { recursive: true, force: true })
  })

  await db.revisions.prepareActivityProjection('space-a')
  // Spawn and warm the worker before the competing writer owns the database.
  await expect(db.revisions.maintainActivityProjectionGc('space-a')).resolves.toEqual({
    deleted: 0,
    pending: false,
  })
  const writer = new DatabaseSync(path)

  try {
    writer
      .prepare(
        `INSERT INTO activity_projection_gc (space, generation, phase, updated_at)
         VALUES ('space-a', 99, 'states', CURRENT_TIMESTAMP)`,
      )
      .run()
    writer.exec('BEGIN IMMEDIATE')
    await expect(db.revisions.maintainActivityProjectionGc('space-a')).resolves.toEqual({
      deleted: 0,
      pending: true,
    })
    writer.exec('ROLLBACK')
  } finally {
    if (writer.isTransaction) {
      writer.exec('ROLLBACK')
    }
    writer.close()
  }
  await expect(db.revisions.maintainActivityProjectionGc('space-a')).resolves.toEqual({
    deleted: 0,
    pending: false,
  })
})
