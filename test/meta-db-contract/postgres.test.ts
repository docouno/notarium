import pg from 'pg'
import { expect, it } from 'vitest'

import type { RevisionInput } from '@notarium/core'

import {
  lockRevisionKeys,
  REVISION_LOCK_STRIPE_MASK,
} from '../../packages/server/src/services/metaDb/drivers/pg/revisionLocks'
import { PgMetaDb } from '../../packages/server/src/services/metaDb/pgMetaDb'
import { describeAgentSessionsContract } from './agentSessionsContract'
import { describeGatewayStateContract } from './gatewayStateContract'
import { createPostgresTestSchema, describePostgres } from './postgresHarness'
import { describeRevisionPersistenceContract } from './revisionPersistenceContract'

const advisoryWaiterCount = async (
  testSchema: Awaited<ReturnType<typeof createPostgresTestSchema>>,
): Promise<number> => {
  const result = await testSchema.admin.query(
    `SELECT COUNT(*) AS n
       FROM pg_stat_activity
      WHERE application_name = $1
        AND wait_event_type = 'Lock'
        AND wait_event = 'advisory'`,
    [testSchema.schema],
  )
  return Number(result.rows[0].n)
}

const waitForAdvisoryWaiters = async (
  testSchema: Awaited<ReturnType<typeof createPostgresTestSchema>>,
  expected: number,
): Promise<void> => {
  const deadline = Date.now() + 5_000

  while (Date.now() < deadline) {
    if ((await advisoryWaiterCount(testSchema)) >= expected) {
      return
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
  throw new Error(
    `timed out waiting for ${expected} advisory-lock sessions; saw ${await advisoryWaiterCount(testSchema)}`,
  )
}

const waitForTupleLockWaiter = async (
  testSchema: Awaited<ReturnType<typeof createPostgresTestSchema>>,
): Promise<void> => {
  const deadline = Date.now() + 5_000

  while (Date.now() < deadline) {
    const result = await testSchema.admin.query(
      `SELECT COUNT(*) AS n
         FROM pg_stat_activity
        WHERE application_name = $1
          AND wait_event_type = 'Lock'
          AND wait_event <> 'advisory'`,
      [testSchema.schema],
    )

    if (Number(result.rows[0].n) >= 1) {
      return
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
  throw new Error('timed out waiting for a legacy/modern CAS tuple-lock waiter')
}

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout>

  try {
    return await Promise.race([
      promise,
      new Promise<never>(
        (_, rejectTimeout) =>
          (timeout = setTimeout(
            () => rejectTimeout(new Error(`operation did not finish within ${timeoutMs} ms`)),
            timeoutMs,
          )),
      ),
    ])
  } finally {
    clearTimeout(timeout!)
  }
}

const lockRevisionStripe = (
  client: pg.PoolClient,
  namespace: 'blob' | 'note',
  key: string,
): Promise<pg.QueryResult> =>
  client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2) & $3::integer)', [
    `notarium:revision:${namespace}`,
    key,
    REVISION_LOCK_STRIPE_MASK,
  ])

const revisionStripe = async (client: pg.PoolClient, key: string): Promise<number> => {
  const result = await client.query('SELECT hashtext($1) & $2::integer AS stripe', [
    key,
    REVISION_LOCK_STRIPE_MASK,
  ])
  return Number(result.rows[0].stripe)
}

const revision = (noteId: string, over: Partial<RevisionInput> = {}): RevisionInput => ({
  noteId,
  space: 'space-a',
  baseRevisionId: null,
  theirRevisionId: null,
  sourceRevisionId: null,
  kind: 'write',
  principal: 'ui',
  contentHash: `${noteId}-hash`,
  title: noteId,
  class: 'user-doc',
  slug: null,
  tags: [],
  createdAt: '2026-06-12T10:00:00.000Z',
  charsAdded: 1,
  charsRemoved: 0,
  ...over,
})

/** A rolling peer without application advisory locks or a fence read. The
 * database trigger must still serialize and reject it. */
const rawAppendWithoutApplicationLocks = async (
  pool: pg.Pool,
  rev: RevisionInput,
  content: string | null,
  afterBlob?: (client: pg.PoolClient) => Promise<void>,
): Promise<void> => {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')
    if (rev.contentHash != null && content != null) {
      await client.query(
        'INSERT INTO revision_blobs (hash, content) VALUES ($1, $2) ON CONFLICT (hash) DO NOTHING',
        [rev.contentHash, content],
      )
      await afterBlob?.(client)
    }
    await client.query(
      `INSERT INTO note_revisions
         (note_id, space, base_rev, their_rev, source_rev, kind, principal, content_hash, title, class, slug, tags, created_at, chars_added, chars_removed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        rev.noteId,
        rev.space,
        rev.baseRevisionId,
        rev.theirRevisionId,
        rev.sourceRevisionId,
        rev.kind,
        rev.principal,
        rev.contentHash,
        rev.title,
        rev.class,
        rev.slug,
        JSON.stringify(rev.tags),
        rev.createdAt,
        rev.charsAdded,
        rev.charsRemoved,
      ],
    )
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

describePostgres('live Postgres driver', () => {
  describeGatewayStateContract('Postgres', async () => {
    const testSchema = await createPostgresTestSchema('gateway_contract')
    return { persistence: testSchema.db.gateway, teardown: testSchema.teardown }
  })

  describeAgentSessionsContract('Postgres', async () => {
    const testSchema = await createPostgresTestSchema('agent_sessions_contract')
    return { persistence: testSchema.db.sessions, teardown: testSchema.teardown }
  })

  describeRevisionPersistenceContract('Postgres', async () => {
    const testSchema = await createPostgresTestSchema('revision_contract')
    return { persistence: testSchema.db.revisions, teardown: testSchema.teardown }
  })

  it('atomically grants only while a stable space id exists and is active', async () => {
    const testSchema = await createPostgresTestSchema('grant_active_space')
    const space = {
      id: 'space-grant-1',
      slug: 'research',
      displayName: 'Research',
      notesDir: 'research',
      aliases: ['library'],
      createdAt: '2026-08-02T12:00:00Z',
      archivedAt: null,
      archivedBy: null,
    }

    try {
      await testSchema.db.spaces.upsert(space)
      await expect(
        testSchema.db.grantMemberToActiveSpace(
          space.id,
          'recovery',
          'reader',
          '2026-08-02T12:01:00Z',
        ),
      ).resolves.toEqual({ status: 'granted', space })
      expect(await testSchema.db.auth.grantsFor('recovery')).toEqual([
        { space: space.id, role: 'reader' },
      ])

      const archived = {
        ...space,
        archivedAt: '2026-08-02T12:02:00Z',
        archivedBy: 'user:admin',
      }
      await testSchema.db.spaces.upsert(archived)
      await expect(
        testSchema.db.grantMemberToActiveSpace(
          space.id,
          'recovery',
          'owner',
          '2026-08-02T12:03:00Z',
        ),
      ).resolves.toEqual({ status: 'archived', space: archived })
      expect(await testSchema.db.auth.grantsFor('recovery')).toEqual([
        { space: space.id, role: 'reader' },
      ])

      await testSchema.db.purgeSpace(space.id)
      await expect(
        testSchema.db.grantMemberToActiveSpace(
          space.id,
          'recovery',
          'owner',
          '2026-08-02T12:04:00Z',
        ),
      ).resolves.toEqual({ status: 'missing' })
      expect(await testSchema.db.auth.grantsFor('recovery')).toEqual([])
    } finally {
      await testSchema.teardown()
    }
  })

  it('does not orphan a late recovery grant when purge already owns the lock queue', async () => {
    const testSchema = await createPostgresTestSchema('grant_purge_race')
    const blockerPool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const blocker = await blockerPool.connect()
    let purgeTask: Promise<void> | undefined
    let grantTask: ReturnType<PgMetaDb['grantMemberToActiveSpace']> | undefined

    try {
      await testSchema.db.spaces.upsert({
        id: 'space-race-1',
        slug: 'research',
        displayName: 'Research',
        notesDir: 'research',
        aliases: [],
        createdAt: '2026-08-02T12:00:00Z',
        archivedAt: null,
        archivedBy: null,
      })
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM spaces WHERE id = $1 FOR UPDATE', ['space-race-1'])

      purgeTask = testSchema.db.purgeSpace('space-race-1')
      await waitForTupleLockWaiter(testSchema)
      grantTask = testSchema.db.grantMemberToActiveSpace(
        'space-race-1',
        'recovery',
        'owner',
        '2026-08-02T12:01:00Z',
      )
      await blocker.query('COMMIT')

      await purgeTask
      await expect(grantTask).resolves.toEqual({ status: 'missing' })
      expect(await testSchema.db.auth.grantsFor('recovery')).toEqual([])
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      blocker.release()
      await Promise.allSettled([purgeTask, grantTask].filter((task) => task != null))
      await blockerPool.end()
      await testSchema.teardown()
    }
  })

  it('keeps BIGSERIAL delta cursors exact above Number.MAX_SAFE_INTEGER', async () => {
    const testSchema = await createPostgresTestSchema('revision_bigserial')

    try {
      await testSchema.db.revisions.init()
      const sequence = `"${testSchema.schema}"."note_revisions_id_seq"`
      await testSchema.admin.query('SELECT setval($1::regclass, $2::bigint, true)', [
        sequence,
        '9007199254740992',
      ])
      const input = revision('big-a', { contentHash: 'big-a-1', title: 'Big A' })
      const acknowledged = await testSchema.db.revisions.append(input, 'one')
      const next = await testSchema.db.revisions.append(
        {
          ...input,
          noteId: 'big-b',
          contentHash: 'big-b-1',
          title: 'Big B',
          createdAt: '2026-06-12T10:01:00.000Z',
        },
        'two',
      )

      expect(acknowledged.id).toBe('9007199254740993')
      expect(next.id).toBe('9007199254740994')
      await expect(
        testSchema.db.revisions.listBySpaceSince('space-a', acknowledged.id, 10),
      ).resolves.toEqual({
        items: [next],
        total: 1,
        maxRevId: next.id,
      })
    } finally {
      await testSchema.teardown()
    }
  })

  it('returns delta items, total, and max cursor from one snapshot during appends', async () => {
    const testSchema = await createPostgresTestSchema('revision_snapshot')
    const writer = new PgMetaDb(testSchema.scopedUrl)

    try {
      await testSchema.db.revisions.append(revision('snapshot-seed'), 'seed')
      await Promise.all([
        (async () => {
          for (let index = 0; index < 40; index++) {
            await writer.revisions.append(
              revision(`snapshot-${index}`, {
                createdAt: `2026-06-12T10:${String(index).padStart(2, '0')}:00.000Z`,
              }),
              `body-${index}`,
            )
          }
        })(),
        (async () => {
          for (let index = 0; index < 80; index++) {
            const delta = await testSchema.db.revisions.listBySpaceSince('space-a', null, 100)
            expect(delta.total).toBe(delta.items.length)
            expect(delta.maxRevId).toBe(delta.items[0]?.id ?? null)
          }
        })(),
      ])
    } finally {
      await writer.close()
      await testSchema.teardown()
    }
  })

  it('bounds batch purge advisory locks with deterministic note/blob stripes', async () => {
    const testSchema = await createPostgresTestSchema('revision_lock_stripes')
    const pool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const client = await pool.connect()

    try {
      await testSchema.db.revisions.init()

      const noteKeys = ['sparse-note-a', 'sparse-note-b', 'sparse-note-c']
      const blobKeys = ['sparse-blob-a', 'sparse-blob-b', 'sparse-blob-c', 'sparse-blob-d']
      await client.query('BEGIN')
      const expected = await client.query(
        `SELECT classid, objid, objsubid
           FROM (
             SELECT
               (hashtext('notarium:revision:note')::bigint & 4294967295)::text AS classid,
               stripe::text AS objid,
               2 AS objsubid
             FROM (
               SELECT DISTINCT (hashtext(value) & $3::integer) AS stripe
                 FROM unnest($1::text[]) AS note(value)
             ) note_stripes
             UNION ALL
             SELECT
               (hashtext('notarium:revision:blob')::bigint & 4294967295)::text AS classid,
               stripe::text AS objid,
               2 AS objsubid
             FROM (
               SELECT DISTINCT (hashtext(value) & $3::integer) AS stripe
                 FROM unnest($2::text[]) AS blob(value)
             ) blob_stripes
           ) expected_locks
          ORDER BY classid, objid, objsubid`,
        [noteKeys, blobKeys, REVISION_LOCK_STRIPE_MASK],
      )
      await lockRevisionKeys(client, 'note', noteKeys)
      await lockRevisionKeys(client, 'blob', blobKeys)
      const locks = await client.query(
        `SELECT classid::text, objid::text, objsubid
           FROM pg_locks
          WHERE pid = pg_backend_pid()
            AND locktype = 'advisory'
            AND granted
          ORDER BY classid::text, objid::text, objsubid`,
      )

      expect(locks.rows).toEqual(expected.rows)
      await client.query('ROLLBACK')

      await client.query('BEGIN')
      await lockRevisionKeys(
        client,
        'note',
        Array.from({ length: 1_000 }, (_, index) => `note-${index}`),
      )
      await lockRevisionKeys(
        client,
        'blob',
        Array.from({ length: 1_000 }, (_, index) => `blob-${index}`),
      )
      const lockCount = await client.query(
        `SELECT COUNT(*) AS n FROM pg_locks
          WHERE pid = pg_backend_pid() AND locktype = 'advisory' AND granted`,
      )

      expect(Number(lockCount.rows[0].n)).toBeLessThanOrEqual(2 * (REVISION_LOCK_STRIPE_MASK + 1))
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
      await pool.end()
      await testSchema.teardown()
    }
  })

  it('serializes append and purge on a shared blob before garbage collection', async () => {
    const testSchema = await createPostgresTestSchema('revision_blob_race')
    const lockerPool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const locker = await lockerPool.connect()
    let appendSettled = false
    let purgeSettled = false
    let appendTask: Promise<unknown> | undefined
    let purgeTask: Promise<unknown> | undefined

    try {
      await testSchema.db.revisions.append(
        revision('purged', { contentHash: 'shared-race-hash' }),
        'shared',
      )
      await locker.query('BEGIN')
      await lockRevisionStripe(locker, 'blob', 'shared-race-hash')

      appendTask = testSchema.db.revisions
        .append(revision('survivor', { contentHash: 'shared-race-hash' }), 'shared')
        .finally(() => {
          appendSettled = true
        })
      purgeTask = testSchema.db.revisions.purgeNotes(['purged']).finally(() => {
        purgeSettled = true
      })

      await waitForAdvisoryWaiters(testSchema, 2)
      expect(appendSettled).toBe(false)
      expect(purgeSettled).toBe(false)
      await locker.query('COMMIT')
      await Promise.all([appendTask, purgeTask])

      expect(await testSchema.db.revisions.content('shared-race-hash')).toBe('shared')
      expect(await testSchema.db.revisions.latestFor('survivor')).not.toBeNull()
    } finally {
      await locker.query('ROLLBACK').catch(() => {})
      await Promise.allSettled([appendTask, purgeTask].filter((task) => task != null))
      locker.release()
      await lockerPool.end()
      await testSchema.teardown()
    }
  })

  it('rejects a late same-note append when note purge wins the lock order', async () => {
    const testSchema = await createPostgresTestSchema('revision_note_terminal')
    const lockerPool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const locker = await lockerPool.connect()
    let appendTask: Promise<unknown> | undefined
    let purgeTask: Promise<unknown> | undefined

    try {
      const input = revision('terminal-note-race', { contentHash: 'terminal-note-race-hash' })
      await testSchema.db.revisions.append(input, 'terminal body')
      await locker.query('BEGIN')
      await lockRevisionStripe(locker, 'blob', 'terminal-note-race-hash')

      purgeTask = testSchema.db.revisions.purgeNotes(['terminal-note-race'])
      await waitForAdvisoryWaiters(testSchema, 1)
      appendTask = testSchema.db.revisions.append(input, 'late body')
      const appendRejection = expect(appendTask).rejects.toThrow(
        /revision target was permanently purged: note/,
      )
      await waitForAdvisoryWaiters(testSchema, 2)

      await locker.query('COMMIT')
      await purgeTask
      await appendRejection
      expect(await testSchema.db.revisions.latestFor('terminal-note-race')).toBeNull()
      expect(await testSchema.db.revisions.content('terminal-note-race-hash')).toBeNull()
    } finally {
      await locker.query('ROLLBACK').catch(() => {})
      await Promise.allSettled([appendTask, purgeTask].filter((task) => task != null))
      locker.release()
      await lockerPool.end()
      await testSchema.teardown()
    }
  })

  it('does not deadlock lock-unaware and current writers sharing one new blob hash', async () => {
    const testSchema = await createPostgresTestSchema('revision_legacy_blob_order')
    const legacyPool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    let legacyTask: Promise<unknown> | undefined
    let modernTask: Promise<unknown> | undefined
    let releaseLegacy: (() => void) | undefined

    try {
      await testSchema.db.revisions.init()
      let markBlobReady!: () => void
      const blobReady = new Promise<void>((resolveReady) => {
        markBlobReady = resolveReady
      })
      const legacyGate = new Promise<void>((resolveGate) => {
        releaseLegacy = resolveGate
      })
      const sharedHash = 'legacy-modern-new-hash'
      legacyTask = rawAppendWithoutApplicationLocks(
        legacyPool,
        revision('legacy-new-hash', { contentHash: sharedHash }),
        'shared new body',
        async () => {
          markBlobReady()
          await legacyGate
        },
      )
      await blobReady

      modernTask = testSchema.db.revisions.append(
        revision('modern-new-hash', { space: 'space-b', contentHash: sharedHash }),
        'shared new body',
      )
      // The modern writer must wait on the uncommitted unique tuple before it
      // owns any advisory lock; otherwise releasing legacy creates a deadlock.
      await waitForTupleLockWaiter(testSchema)
      releaseLegacy?.()
      await withTimeout(Promise.all([legacyTask, modernTask]), 5_000)

      expect(await testSchema.db.revisions.latestFor('legacy-new-hash')).not.toBeNull()
      expect(await testSchema.db.revisions.latestFor('modern-new-hash')).not.toBeNull()
      expect(await testSchema.db.revisions.content(sharedHash)).toBe('shared new body')
    } finally {
      releaseLegacy?.()
      await Promise.allSettled([legacyTask, modernTask].filter((task) => task != null))
      await legacyPool.end()
      await testSchema.teardown()
    }
  })

  it('DB-enforces purge fences for a lock-unaware writer during rolling deploy', async () => {
    const testSchema = await createPostgresTestSchema('revision_legacy_terminal')
    const lockerPool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const legacyPool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const locker = await lockerPool.connect()
    let legacyTask: Promise<unknown> | undefined
    let purgeTask: Promise<unknown> | undefined

    try {
      const input = revision('legacy-terminal-race', {
        contentHash: 'legacy-terminal-race-hash',
      })
      await testSchema.db.revisions.append(input, 'terminal body')
      await expect(
        legacyPool.query('DELETE FROM note_revisions WHERE note_id = $1', [input.noteId]),
      ).rejects.toThrow(/revision purge requires a fenced writer/)
      expect(await testSchema.db.revisions.latestFor(input.noteId)).not.toBeNull()
      await locker.query('BEGIN')
      await lockRevisionStripe(locker, 'blob', 'legacy-terminal-race-hash')

      purgeTask = testSchema.db.revisions.purgeNotes(['legacy-terminal-race'])
      await waitForAdvisoryWaiters(testSchema, 1)
      legacyTask = rawAppendWithoutApplicationLocks(legacyPool, input, 'late legacy body')
      const legacyRejection = expect(legacyTask).rejects.toThrow(
        /revision target was permanently purged: note/,
      )
      await waitForAdvisoryWaiters(testSchema, 2)

      await locker.query('COMMIT')
      await purgeTask
      await legacyRejection
      expect(await testSchema.db.revisions.latestFor('legacy-terminal-race')).toBeNull()
      expect(await testSchema.db.revisions.content('legacy-terminal-race-hash')).toBeNull()

      const spaceInput = revision('legacy-space-terminal', {
        space: 'space-b',
        contentHash: 'legacy-space-terminal-hash',
      })
      await testSchema.db.revisions.append(spaceInput, 'space body')
      await testSchema.db.purgeSpace('space-b')
      await expect(
        rawAppendWithoutApplicationLocks(legacyPool, spaceInput, 'late space body'),
      ).rejects.toThrow(/revision target was permanently purged: space/)
      expect(await testSchema.db.revisions.latestFor('legacy-space-terminal')).toBeNull()
    } finally {
      await locker.query('ROLLBACK').catch(() => {})
      await Promise.allSettled([legacyTask, purgeTask].filter((task) => task != null))
      locker.release()
      await lockerPool.end()
      await legacyPool.end()
      await testSchema.teardown()
    }
  })

  it('keeps same-space appends concurrent while whole-space purge waits exclusively', async () => {
    const testSchema = await createPostgresTestSchema('revision_space_lock')
    const lockerPool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const locker = await lockerPool.connect()
    let blockedAppend: Promise<unknown> | undefined
    let purgeTask: Promise<unknown> | undefined

    try {
      const blockedStripe = await revisionStripe(locker, 'blocked-in-space')
      let independentNote = 'independent-in-space'
      let suffix = 0

      while ((await revisionStripe(locker, independentNote)) === blockedStripe) {
        independentNote = `independent-in-space-${++suffix}`
      }
      await locker.query('BEGIN')
      await lockRevisionStripe(locker, 'note', 'blocked-in-space')
      blockedAppend = testSchema.db.revisions.append(revision('blocked-in-space'), 'blocked body')
      await waitForAdvisoryWaiters(testSchema, 1)

      // The blocked append holds only a shared space lock: an unrelated note in
      // that space must retain full throughput.
      await withTimeout(
        testSchema.db.revisions.append(revision(independentNote), 'independent body'),
        3_000,
      )

      purgeTask = testSchema.db.purgeSpace('space-a')
      // One session waits on the note lock and purge waits on its shared space
      // holder. An exclusive append-space lock would have blocked the write above.
      await waitForAdvisoryWaiters(testSchema, 2)
      await locker.query('COMMIT')
      await Promise.all([blockedAppend, purgeTask])

      expect(await testSchema.db.revisions.latestFor('blocked-in-space')).toBeNull()
      expect(await testSchema.db.revisions.latestFor(independentNote)).toBeNull()
    } finally {
      await locker.query('ROLLBACK').catch(() => {})
      await Promise.allSettled([blockedAppend, purgeTask].filter((task) => task != null))
      locker.release()
      await lockerPool.end()
      await testSchema.teardown()
    }
  })

  it('rejects a late same-space append when whole-space purge wins the lock order', async () => {
    const testSchema = await createPostgresTestSchema('revision_space_terminal')
    const lockerPool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const locker = await lockerPool.connect()
    let appendTask: Promise<unknown> | undefined
    let purgeTask: Promise<unknown> | undefined

    try {
      await testSchema.db.revisions.append(revision('space-terminal-seed'), 'seed')
      await locker.query('BEGIN')
      await lockRevisionStripe(locker, 'note', 'space-terminal-seed')

      purgeTask = testSchema.db.purgeSpace('space-a')
      await waitForAdvisoryWaiters(testSchema, 1)
      appendTask = testSchema.db.revisions.append(revision('late-in-purged-space'), 'late')
      const appendRejection = expect(appendTask).rejects.toThrow(
        /revision target was permanently purged: space/,
      )
      await waitForAdvisoryWaiters(testSchema, 2)

      await locker.query('COMMIT')
      await purgeTask
      await appendRejection
      expect(await testSchema.db.revisions.latestFor('space-terminal-seed')).toBeNull()
      expect(await testSchema.db.revisions.latestFor('late-in-purged-space')).toBeNull()
    } finally {
      await locker.query('ROLLBACK').catch(() => {})
      await Promise.allSettled([appendTask, purgeTask].filter((task) => task != null))
      locker.release()
      await lockerPool.end()
      await testSchema.teardown()
    }
  })

  it('serializes cross-space append and whole-space purge on a shared blob', async () => {
    const testSchema = await createPostgresTestSchema('revision_space_blob_race')
    const lockerPool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const locker = await lockerPool.connect()
    let appendTask: Promise<unknown> | undefined
    let purgeTask: Promise<unknown> | undefined

    try {
      await testSchema.db.revisions.append(
        revision('purged-space', { contentHash: 'shared-space-race-hash' }),
        'shared across spaces',
      )
      await locker.query('BEGIN')
      await lockRevisionStripe(locker, 'blob', 'shared-space-race-hash')

      appendTask = testSchema.db.revisions.append(
        revision('surviving-space', {
          space: 'space-b',
          contentHash: 'shared-space-race-hash',
        }),
        'shared across spaces',
      )
      purgeTask = testSchema.db.purgeSpace('space-a')

      await waitForAdvisoryWaiters(testSchema, 2)
      await locker.query('COMMIT')
      await Promise.all([appendTask, purgeTask])

      expect(await testSchema.db.revisions.content('shared-space-race-hash')).toBe(
        'shared across spaces',
      )
      expect(await testSchema.db.revisions.latestFor('surviving-space')).not.toBeNull()
      expect(await testSchema.db.revisions.latestFor('purged-space')).toBeNull()
    } finally {
      await locker.query('ROLLBACK').catch(() => {})
      await Promise.allSettled([appendTask, purgeTask].filter((task) => task != null))
      locker.release()
      await lockerPool.end()
      await testSchema.teardown()
    }
  })

  it('reasserts CAS bytes when cross-space purge wins before modern append locks', async () => {
    const testSchema = await createPostgresTestSchema('revision_modern_cas_reassert')
    const lockerPool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const locker = await lockerPool.connect()
    let appendTask: Promise<unknown> | undefined

    try {
      const seedNote = 'cas-reassert-seed'
      const sharedHash = 'cas-reassert-shared-hash'
      await testSchema.db.revisions.append(
        revision(seedNote, { contentHash: sharedHash }),
        'reassert body',
      )
      const seedStripe = await revisionStripe(locker, seedNote)
      let survivorNote = 'cas-reassert-survivor'
      let suffix = 0

      while ((await revisionStripe(locker, survivorNote)) === seedStripe) {
        survivorNote = `cas-reassert-survivor-${++suffix}`
      }

      await locker.query('BEGIN')
      await lockRevisionStripe(locker, 'note', survivorNote)
      appendTask = testSchema.db.revisions.append(
        revision(survivorNote, { space: 'space-b', contentHash: sharedHash }),
        'reassert body',
      )
      const appendOutcome = appendTask.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      await waitForAdvisoryWaiters(testSchema, 1)

      await withTimeout(testSchema.db.purgeSpace('space-a'), 3_000)
      expect(await testSchema.db.revisions.content(sharedHash)).toBeNull()
      await locker.query('COMMIT')

      const outcome = await appendOutcome
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) {
        throw outcome.error
      }
      expect(await testSchema.db.revisions.latestFor(survivorNote)).not.toBeNull()
      expect(await testSchema.db.revisions.content(sharedHash)).toBe('reassert body')
    } finally {
      await locker.query('ROLLBACK').catch(() => {})
      await Promise.allSettled([appendTask].filter((task) => task != null))
      locker.release()
      await lockerPool.end()
      await testSchema.teardown()
    }
  })
})
