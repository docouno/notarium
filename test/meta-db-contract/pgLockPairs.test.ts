/**
 * Deadlock probes: every pair of the seven transactions that span more than one tier,
 * released from a queue at the same instant.
 *
 * WHAT THIS IS NOT. These pairs do not prove the lock order — the mechanism does that
 * (`lockOrder.ts` states it, `pgLockOrder.test.ts` observes it). A probe answers about
 * the FIXTURE it was given: the `settlement × purgeSpace` pair stayed green for the
 * whole life of IMPL-86, and the same defect measured 5/5 or 0/5 deadlocks depending
 * on one row's `home_space`, while IMPL-88 measured 10/10 or 0/10 depending on the
 * collation of two ids. They are here as a regression net over incidents that really
 * happened, and they are read as nothing more.
 *
 * The interleaving is forced rather than hoped for: a blocker holds the one identity
 * row all seven enter the hierarchy through, both sides queue behind it, and the
 * commit releases them together — the state a real deadlock needs.
 *
 * WHY `test:pg` RUNS WITHOUT FILE PARALLELISM. The harness isolates each test in its
 * own SCHEMA, but a PostgreSQL advisory lock is keyed on the DATABASE: the wide-scan
 * mutex and the revision stripes are the same key in every schema. This file holds
 * them 29 times over, which starved the waiter-based tests in `postgres.test.ts`
 * (5 s deadlines) into intermittent timeouts once it started running beside them.
 * Serial files cost ~35 s and make the gate deterministic. The underlying property —
 * two deployments sharing one database in separate schemas serialize their whole
 * revision tier against each other — predates this file and is a tail, not a
 * test-harness concern.
 */
import pg from 'pg'
import { expect } from 'vitest'

import type { IdentityRecord } from '@notarium/core'

import type { MetaDb } from '../../packages/server/src/services/metaDb/types'
import { createPostgresTestSchema, describePostgres } from './postgresHarness'

const AT = '2026-08-11T10:00:00.000Z'
const SPACE = 'alpha'
const NOTE = 'note-a'
const PROJECT = 'project-alpha'
const DEADLOCK = '40P01'

type Probe = { id: string; run: (db: MetaDb) => Promise<unknown> }

/** The seven transactions that touch more than one tier — the only ones a lock order
 *  can be wrong about. Each is aimed at the SAME note, so both sides of a pair
 *  actually contend. */
const PROBES: readonly Probe[] = [
  {
    id: 'favorites.add',
    run: (db) =>
      db.favorites.add({
        owner: 'user:al',
        space: SPACE,
        kind: 'note',
        entityId: NOTE,
        createdAt: AT,
        rank: null,
      }),
  },
  {
    id: 'favorites.removeByEntity',
    run: (db) => db.favorites.removeByEntity('user:al', SPACE, NOTE),
  },
  {
    id: 'contextSets.addItem',
    run: (db) => db.contextSets.addItem('set-1', { space: SPACE, noteId: NOTE }),
  },
  {
    id: 'scopePins.addPin',
    run: (db) =>
      db.scopePins.addPin({
        targetKind: 'project',
        targetId: PROJECT,
        targetSpace: SPACE,
        noteSpace: SPACE,
        noteId: NOTE,
        createdAt: AT,
      }),
  },
  {
    id: 'contextOrder.setOrder',
    run: (db) =>
      db.contextOrder.setOrder('project', PROJECT, SPACE, [
        { entryKind: 'pin', entryRef: NOTE },
        { entryKind: 'set', entryRef: 'set-1' },
      ]),
  },
  {
    id: 'identity.settleFileClaim',
    run: (db) =>
      db.identity.settleFileClaim({
        space: SPACE,
        filePath: `${NOTE}.md`,
        current: {
          id: NOTE,
          filePath: `${NOTE}.md`,
          space: SPACE,
          createdAt: AT,
          materialized: true,
          deletedAt: null,
        },
        observedId: 'note-observed',
        at: AT,
      }),
  },
  { id: 'pgMetaDb.purgeSpace', run: (db) => db.purgeSpace(SPACE) },
]

const identity = (id: string): IdentityRecord => ({
  id,
  filePath: `${id}.md`,
  space: SPACE,
  createdAt: AT,
  materialized: true,
  deletedAt: null,
})

const seed = async (db: MetaDb): Promise<void> => {
  await db.spaces.upsert({
    id: SPACE,
    slug: SPACE,
    notesDir: '/alpha',
    displayName: 'Alpha',
    aliases: [],
    createdAt: AT,
    archivedAt: null,
    archivedBy: null,
  })
  await db.projects.upsert({
    id: PROJECT,
    space: SPACE,
    path: '',
    slug: 'alpha-project',
    aliases: [],
    pathAliases: [],
    displayName: 'Alpha project',
    status: 'active',
    lastSeen: AT,
    createdAt: AT,
  })
  await db.identity.claimMany([identity(NOTE), identity('note-observed-neighbour')])
  await db.contextSets.createSet({
    id: 'set-1',
    homeSpace: SPACE,
    name: 'Set',
    items: [{ space: SPACE, noteId: NOTE }],
    createdAt: AT,
  })
  await db.favorites.add({
    owner: 'user:al',
    space: SPACE,
    kind: 'note',
    entityId: NOTE,
    createdAt: AT,
    rank: null,
  })
  await db.scopePins.addPin({
    targetKind: 'project',
    targetId: PROJECT,
    targetSpace: SPACE,
    noteSpace: SPACE,
    noteId: NOTE,
    createdAt: AT,
  })
  await db.contextOrder.setOrder('project', PROJECT, SPACE, [
    { entryKind: 'pin', entryRef: NOTE },
    { entryKind: 'set', entryRef: 'set-1' },
  ])
  await db.revisions.append(
    {
      noteId: NOTE,
      space: SPACE,
      baseRevisionId: null,
      theirRevisionId: null,
      sourceRevisionId: null,
      kind: 'write',
      entryRole: 'origin',
      principal: 'ui',
      contentHash: 'hash-a',
      title: NOTE,
      class: 'user-doc',
      slug: null,
      tags: [],
      createdAt: AT,
      charsAdded: 1,
      charsRemoved: 0,
    },
    'body',
  )
}

/** Each probe here creates a schema, seeds it, and lets two transactions contend
 *  across a container boundary, so the vitest default (5 s) is not a budget this file
 *  can be polled against. Stated once, and PROBE_WAIT_MS is derived from it. */
const SUITE_TIMEOUT_MS = 15_000

/** How long a probe waits for its two sides to actually queue — deliberately a
 *  FRACTION of the suite budget. Exhausting it is not a failure, and a budget EQUAL
 *  to the test timeout could never say so: the test died of the timeout first, with
 *  no diagnosis, which is the opposite of what the comment below promises. */
const PROBE_WAIT_MS = SUITE_TIMEOUT_MS / 3

const PROBE_SUITE = { timeout: SUITE_TIMEOUT_MS }

const waitForWaiters = async (admin: pg.Pool, schema: string, expected: number): Promise<void> => {
  const deadline = Date.now() + PROBE_WAIT_MS

  while (Date.now() < deadline) {
    const result = await admin.query(
      `SELECT COUNT(*) AS n FROM pg_stat_activity
        WHERE application_name = $1 AND wait_event_type = 'Lock'`,
      [schema],
    )

    if (Number(result.rows[0].n) >= expected) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  // Not a failure: a probe whose two sides never queue is a weaker probe, not a
  // broken one, and saying so beats hanging the suite.
}

const deadlockOf = (error: unknown): string | null => {
  const code = (error as { code?: unknown } | null)?.code

  return code === DEADLOCK ? DEADLOCK : null
}

const pairs = PROBES.flatMap((left, index) => PROBES.slice(index).map((right) => [left, right]))

/** The pair above that is NOT a fixture question — the cycle fix 8 removed, reproduced
 *  on purpose. Two conditions make it, and both are why the existing same-space probe
 *  never saw it: the purge is of a DIFFERENT space (so tier 1 does not serialize the
 *  two at all), and a legacy set in that space carries the claimant's id (so the
 *  settlement's unfiltered LIKE prefilter locks a row the purge will delete).
 *
 *  With the tier-2 deletes below the wide-scan mutex, the purge holds the mutex and
 *  waits for that row while the settlement holds the row and waits for the mutex. */
const BETA = 'beta'

describePostgres('Postgres deadlock probes', PROBE_SUITE, () => {
  for (const [left, right] of pairs) {
    it(`${left.id} × ${right.id} settle without a deadlock`, async () => {
      const testSchema = await createPostgresTestSchema('lock_pairs')
      const db = testSchema.db
      const blocker = new pg.Pool({ connectionString: testSchema.scopedUrl })

      try {
        await seed(db)
        const held = await blocker.connect()

        await held.query('BEGIN')
        // The one row all seven enter the hierarchy through.
        await held.query('SELECT id FROM note_identity WHERE id = $1 FOR UPDATE', [NOTE])

        const outcomes = [left.run(db), right.run(db)].map((promise) =>
          promise.then(
            () => null,
            (error: unknown) => error,
          ),
        )

        await waitForWaiters(testSchema.admin, testSchema.schema, 2)
        await held.query('COMMIT')
        held.release()

        const errors = await Promise.all(outcomes)
        // A race may legitimately end in a conflict or a lost premise; a DEADLOCK is
        // the only outcome the order exists to prevent.
        expect(errors.map(deadlockOf).filter(Boolean)).toEqual([])
      } finally {
        await blocker.end().catch(() => {})
        await testSchema.teardown()
      }
    })
  }

  it('settles a claim in one space against a purge of another holding the same set row', async () => {
    const testSchema = await createPostgresTestSchema('lock_pairs_cross')
    const db = testSchema.db
    const blocker = new pg.Pool({ connectionString: testSchema.scopedUrl })

    try {
      await seed(db)
      await db.spaces.upsert({
        id: BETA,
        slug: BETA,
        notesDir: '/beta',
        displayName: 'Beta',
        aliases: [],
        createdAt: AT,
        archivedAt: null,
        archivedBy: null,
      })
      // The legacy collision this whole task is about: the same note id, in both
      // spaces, referenced by a set that lives in the space being purged.
      await db.identity.claimMany([{ ...identity(NOTE), id: 'beta-note', space: BETA }])
      await db.contextSets.createSet({
        id: 'beta-set',
        homeSpace: BETA,
        name: 'Beta set',
        items: [{ space: BETA, noteId: NOTE }],
        createdAt: AT,
      })
      await db.favorites.add({
        owner: 'user:al',
        space: BETA,
        kind: 'note',
        entityId: 'beta-note',
        createdAt: AT,
        rank: null,
      })
      const held = await blocker.connect()

      await held.query('BEGIN')
      await held.query('SELECT id FROM context_sets WHERE id = $1 FOR UPDATE', ['beta-set'])

      const settling = db.identity
        .settleFileClaim({
          space: SPACE,
          filePath: `${NOTE}.md`,
          current: identity(NOTE),
          observedId: 'note-observed',
          at: AT,
        })
        .then(
          () => null,
          (error: unknown) => error,
        )
      const purging = db.purgeSpace(BETA).then(
        () => null,
        (error: unknown) => error,
      )

      await waitForWaiters(testSchema.admin, testSchema.schema, 2)
      await held.query('COMMIT')
      held.release()

      expect([await settling, await purging].map(deadlockOf).filter(Boolean)).toEqual([])
    } finally {
      await blocker.end().catch(() => {})
      await testSchema.teardown()
    }
  })
})

/**
 * The import reservation pairs (#302). They are NOT in `PROBES` above because they
 * enter the hierarchy somewhere else entirely: L0j outranks identity, and none of
 * them touches `note_identity` — the one row that file forces its contention through.
 * So they get their own gate, one per pair, and the same reading applies: incident
 * pins over a fixture, not a proof of the order.
 */
const IMPORT_AT = '2026-08-11T10:00:00.000Z'

describePostgres('Postgres deadlock probes — import reservations', PROBE_SUITE, () => {
  /** Two jobs, both running under a known lease — the premise every path needs. */
  const runningImports = async (db: MetaDb, ids: readonly string[]): Promise<void> => {
    for (const id of ids) {
      await db.jobs.enqueue({
        id,
        space: SPACE,
        kind: 'import',
        principal: 'user:al',
        createdAt: IMPORT_AT,
      })

      expect((await db.jobs.claimNext(`lease-${id}`, ['import'], IMPORT_AT))?.id).toBe(id)
    }
  }

  const claim = (entryKey: string, destinationPath: string) => ({
    entryKey,
    destinationPath,
    targetId: `target-${entryKey}`,
    expectedId: null,
    ownership: 'fresh-owned' as const,
  })

  it('reserve × reserve claiming the same destinations in opposite order', async () => {
    const testSchema = await createPostgresTestSchema('lock_pairs_reserve')
    const db = testSchema.db
    const blocker = new pg.Pool({ connectionString: testSchema.scopedUrl })

    try {
      await runningImports(db, ['job-1', 'job-2'])
      const held = await blocker.connect()

      // A claim on the FIRST contested path, taken and then rolled back. The unique
      // index is what both sides queue on, so this holds them at the same key until
      // it lets go — the state a crossing pair needs, and the only way to get it
      // when neither side can be paused from outside.
      await held.query('BEGIN')
      await held.query(
        `INSERT INTO import_reservations (id, space, job_id, upload_ref, fence, status, created_at, updated_at)
         VALUES ('blocker-res', $1, 'blocker-job', 'blocker-upload', 'blocker-fence', 'active', $2, $2)`,
        [SPACE, IMPORT_AT],
      )
      await held.query(
        `INSERT INTO import_reservation_paths
           (reservation_id, entry_key, space, destination_path, target_id, expected_id, ownership)
         VALUES ('blocker-res', 'blocked', $1, 'imported/a.md', 'target-blocked', NULL, 'fresh-owned')`,
        [SPACE],
      )

      // The SAME two destinations, declared in opposite order. Insertion sorts by
      // destination path, so both sides take them in one agreed order; without that,
      // each holds the key the other is waiting for.
      //
      // And the two sides map their members onto those destinations DIFFERENTLY,
      // which is what makes this a probe of the sort KEY and not merely of the sort:
      // `entry_key` is the archive member's name, `destination_path` the slug of the
      // note's TITLE, so job-1's `vault/apple.md` is titled "Zebra" while job-2's is
      // titled "Apple". Sorting on `entry_key` orders these two batches oppositely —
      // and with both fixtures keyed alike (`vault/a.md` → `imported/a.md`) that
      // mis-sort was invisible here AND in the lock-order gate.
      const outcomes = [
        db.importReservations.reserve({
          space: SPACE,
          jobId: 'job-1',
          workerLease: 'lease-job-1',
          uploadRef: 'upload-1',
          entries: [
            claim('vault/zebra.md', 'imported/a.md'),
            claim('vault/apple.md', 'imported/b.md'),
          ],
          now: IMPORT_AT,
        }),
        db.importReservations.reserve({
          space: SPACE,
          jobId: 'job-2',
          workerLease: 'lease-job-2',
          uploadRef: 'upload-2',
          entries: [
            claim('vault/zebra.md', 'imported/b.md'),
            claim('vault/apple.md', 'imported/a.md'),
          ],
          now: IMPORT_AT,
        }),
      ].map((promise) =>
        promise.then(
          (outcome) => outcome,
          (error: unknown) => error,
        ),
      )

      await waitForWaiters(testSchema.admin, testSchema.schema, 2)
      await held.query('ROLLBACK')
      held.release()

      const settled = await Promise.all(outcomes)

      expect(settled.map(deadlockOf).filter(Boolean)).toEqual([])
      // Exactly one of them owns the destinations; the other is REFUSED, which is
      // the answer the unique index exists to give — not an error.
      expect(settled.filter((outcome) => (outcome as { ok?: boolean }).ok === true)).toHaveLength(1)
      expect(settled.filter((outcome) => (outcome as { ok?: boolean }).ok === false)).toMatchObject(
        [{ reason: 'path_conflict' }],
      )
    } finally {
      await blocker.end().catch(() => {})
      await testSchema.teardown()
    }
  })

  /** Both remaining pairs have the same shape: a fenced write holds the job's fence
   *  across its physical write, and an invalidation of the SAME job arrives inside
   *  that window. The advisory is what makes them contend at all, so no external
   *  blocker is needed — the write itself is the gate. */
  const againstAnEnteredWrite = async (
    prefix: string,
    rival: (db: MetaDb) => Promise<unknown>,
    after: (db: MetaDb) => Promise<void>,
  ): Promise<void> => {
    const testSchema = await createPostgresTestSchema(prefix)
    const db = testSchema.db

    let releaseWrite = (): void => {}

    try {
      await runningImports(db, ['job-1'])
      const taken = await db.importReservations.reserve({
        space: SPACE,
        jobId: 'job-1',
        workerLease: 'lease-job-1',
        uploadRef: 'upload-1',
        entries: [claim('a', 'imported/a.md'), claim('b', 'imported/b.md')],
        now: IMPORT_AT,
      })

      expect(taken.ok).toBe(true)
      if (!taken.ok) {
        return
      }
      const entered = new Promise<void>((resolve) => {
        const inFlight = new Promise<void>((release) => {
          releaseWrite = release
        })

        void db.importReservations
          .withFencedWrite(
            {
              reservationId: taken.reservation.id,
              fence: taken.reservation.fence,
              jobId: 'job-1',
              workerLease: 'lease-job-1',
              space: SPACE,
              destinationPath: 'imported/a.md',
            },
            async () => {
              resolve()
              await inFlight
            },
          )
          .catch(() => undefined)
      })

      await entered
      const rivalOutcome = rival(db).then(
        () => null,
        (error: unknown) => error,
      )

      await waitForWaiters(testSchema.admin, testSchema.schema, 1)
      releaseWrite()

      expect(deadlockOf(await rivalOutcome)).toBeNull()
      await after(db)
    } finally {
      releaseWrite()
      await testSchema.teardown()
    }
  }

  it('fenced write × adopt of the same job', async () =>
    await againstAnEnteredWrite(
      'lock_pairs_adopt',
      (db) =>
        db.importReservations.adopt({
          space: SPACE,
          jobId: 'job-1',
          workerLease: 'lease-job-1',
          uploadRef: 'upload-1',
          now: IMPORT_AT,
        }),
      async (db) => {
        // The takeover happened, and it re-fenced: the write that was in flight
        // waited for nothing it then invalidated.
        expect((await db.importReservations.forJob('job-1'))?.entries).toHaveLength(2)
      },
    ))

  it('fenced write × closeForJob of the same job', async () =>
    await againstAnEnteredWrite(
      'lock_pairs_close',
      (db) => db.importReservations.closeForJob({ jobId: 'job-1', now: IMPORT_AT }),
      async (db) => {
        expect(await db.importReservations.forJob('job-1')).toBeNull()
      },
    ))
})
