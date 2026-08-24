import pg from 'pg'
import { expect, it } from 'vitest'

import type { RevisionInput } from '@notarium/core'

import {
  lockRevisionKeys,
  REVISION_LOCK_STRIPE_MASK,
} from '../../packages/server/src/services/metaDb/drivers/pg/revisionLocks'
import { PgMetaDb } from '../../packages/server/src/services/metaDb/pgMetaDb'
import { describeAbilityAvailabilityContract } from './abilityAvailabilityContract'
import { describeAbilityCreateContract } from './abilityCreateContract'
import { describeAbilityPlacementContract } from './abilityPlacementContract'
import { describeAbilityPreferencesContract } from './abilityPreferencesContract'
import { describeAgentDeltaCursorsContract } from './agentDeltaCursorsContract'
import { describeAgentSessionsContract } from './agentSessionsContract'
import { describeCausalMetadataContract } from './causalMetadataContract'
import { describeFavoritesContract } from './favoritesContract'
import { describeGatewayStateContract } from './gatewayStateContract'
import { describeIdentityPersistenceContract } from './identityPersistenceContract'
import { describeImportReservationsContract } from './importReservationsContract'
import { describeJobsContract } from './jobsContract'
import { describeLegacyNameAliasesContract } from './legacyNameAliasesContract'
import { createPostgresTestSchema, describePostgres } from './postgresHarness'
import { describeRevisionPersistenceContract } from './revisionPersistenceContract'
import { describeSessionAuditContract } from './sessionAuditContract'
import { describeSpaceLifecycleWriterContract } from './spaceLifecycleWriterContract'

/** Every test here creates a schema, migrates it and lets two transactions contend
 *  across a container boundary, so the vitest default (5 s) is not a budget this
 *  file can be polled against. Stated once, and the probe budget below is derived
 *  from it — the same shape `pgLockPairs.test.ts` uses, and for the same reason. */
const SUITE_TIMEOUT_MS = 15_000

/** How long one probe waits for the state it is about to assert on. Deliberately a
 *  FRACTION of the suite budget: equal to it, the test would die of the timeout
 *  before its own "timed out waiting for N waiters" could ever be read — which is
 *  what a 5 s wait under a 5 s test timeout did on a loaded host. */
const PROBE_WAIT_MS = SUITE_TIMEOUT_MS / 3

const SUITE = { timeout: SUITE_TIMEOUT_MS }

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
  const deadline = Date.now() + PROBE_WAIT_MS

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
  expected = 1,
): Promise<void> => {
  const deadline = Date.now() + PROBE_WAIT_MS

  while (Date.now() < deadline) {
    const result = await testSchema.admin.query(
      `SELECT COUNT(*) AS n
         FROM pg_stat_activity
        WHERE application_name = $1
          AND wait_event_type = 'Lock'
          AND wait_event <> 'advisory'`,
      [testSchema.schema],
    )

    if (Number(result.rows[0].n) >= expected) {
      return
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
  throw new Error(`timed out waiting for ${expected} non-advisory lock waiter(s)`)
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
  entryRole: 'origin',
  principal: 'ui',
  contentHash: `${noteId}-hash`,
  stateFormat: null,
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

describePostgres('live Postgres driver', SUITE, () => {
  describeAbilityPreferencesContract('Postgres', async () => {
    const testSchema = await createPostgresTestSchema('ability_preferences')
    return { db: testSchema.db, teardown: testSchema.teardown }
  })

  describeAbilityAvailabilityContract('Postgres', async () => {
    const testSchema = await createPostgresTestSchema('ability_availability')
    return { db: testSchema.db, teardown: testSchema.teardown }
  })

  describeAbilityCreateContract('Postgres', async () => {
    const testSchema = await createPostgresTestSchema('ability_create')
    return { db: testSchema.db, teardown: testSchema.teardown }
  })

  describeAbilityPlacementContract('Postgres', async () => {
    const testSchema = await createPostgresTestSchema('ability_placement')
    return { db: testSchema.db, teardown: testSchema.teardown }
  })

  describeImportReservationsContract('Postgres', async () => {
    const testSchema = await createPostgresTestSchema('import_reservations')

    return {
      reservations: testSchema.db.importReservations,
      jobs: testSchema.db.jobs,
      purgeSpace: (space) => testSchema.db.purgeSpace(space),
      teardown: () => testSchema.teardown(),
    }
  })

  describeJobsContract('Postgres', async () => {
    const testSchema = await createPostgresTestSchema('jobs_contract')

    return { jobs: testSchema.db.jobs, teardown: () => testSchema.teardown() }
  })

  describeSpaceLifecycleWriterContract('Postgres', async () => {
    const testSchema = await createPostgresTestSchema('space_lifecycle_writers')
    return { db: testSchema.db, teardown: () => testSchema.teardown() }
  })

  it('round-trips a role target through all three reusable context facets', async () => {
    const testSchema = await createPostgresTestSchema('role_context_facets')
    const target = 'project:project%3Aone:research'

    try {
      await testSchema.db.contextSets.createSet({
        id: 'role-set',
        homeSpace: 'space-home',
        name: 'Role set',
        items: [{ space: 'space-note', noteId: 'set-note' }],
        createdAt: '2026-08-07T00:00:00Z',
      })
      await testSchema.db.contextSets.attach({
        setId: 'role-set',
        targetKind: 'role',
        targetId: target,
        targetSpace: 'space-project',
        createdAt: '2026-08-07T00:00:00Z',
      })
      await testSchema.db.scopePins.addPin({
        targetKind: 'role',
        targetId: target,
        targetSpace: 'space-project',
        noteSpace: 'space-note',
        noteId: 'role-pin',
        createdAt: '2026-08-07T00:00:00Z',
      })
      await testSchema.db.contextOrder.setOrder('role', target, 'space-project', [
        { entryKind: 'set', entryRef: 'role-set' },
        { entryKind: 'pin', entryRef: 'role-pin' },
      ])

      expect(
        (await testSchema.db.contextSets.setsForTarget('role', target)).map((set) => set.id),
      ).toEqual(['role-set'])
      expect(
        (await testSchema.db.scopePins.pinsForTarget('role', target)).map((pin) => pin.noteId),
      ).toEqual(['role-pin'])
      expect(
        (await testSchema.db.contextOrder.orderForTarget('role', target)).map((entry) => [
          entry.entryKind,
          entry.entryRef,
          entry.rank,
        ]),
      ).toEqual([
        ['set', 'role-set', 0],
        ['pin', 'role-pin', 1],
      ])
    } finally {
      await testSchema.teardown()
    }
  })

  describeGatewayStateContract('Postgres', async () => {
    const testSchema = await createPostgresTestSchema('gateway_contract')
    return { persistence: testSchema.db.gateway, teardown: testSchema.teardown }
  })

  describeAgentDeltaCursorsContract('Postgres', async () => {
    const testSchema = await createPostgresTestSchema('agent_delta_cursors_contract')
    return {
      persistence: testSchema.db.agentDeltaCursors,
      sessions: testSchema.db.sessions,
      projects: testSchema.db.projects,
      folders: testSchema.db.folders,
      teardown: testSchema.teardown,
    }
  })

  describeAgentSessionsContract('Postgres', async () => {
    const testSchema = await createPostgresTestSchema('agent_sessions_contract')
    return { persistence: testSchema.db.sessions, teardown: testSchema.teardown }
  })

  describeFavoritesContract('Postgres', async () => {
    const testSchema = await createPostgresTestSchema('favorites_contract')
    return { persistence: testSchema.db.favorites, teardown: testSchema.teardown }
  })

  it('unfavorites through the id the client still holds after a settlement', async () => {
    // Twin of the SQLite case in test/unit/metaDb.test.ts: the route resolves the note
    // before it calls, and a settlement can commit in between, taking the favourite
    // onto the successor id. Removing only the named id leaves the row on screen after
    // an unfavorite that answered ok.
    const testSchema = await createPostgresTestSchema('favorites_settlement')
    const record = {
      id: 'old-id',
      legacyNameAliases: [],
      filePath: 'a.md',
      space: 'team',
      createdAt: null,
      materialized: true,
      deletedAt: null,
    }

    try {
      await testSchema.db.identity.claimMany([record])
      await testSchema.db.favorites.add({
        owner: 'user:al',
        space: 'team',
        kind: 'note',
        entityId: 'old-id',
        createdAt: '2026-06-23T10:00:00.000Z',
        rank: null,
      })
      await testSchema.db.identity.settleFileClaim({
        space: 'team',
        filePath: 'a.md',
        current: record,
        observedId: 'new-id',
        at: '2026-06-23T11:00:00.000Z',
      })

      expect(await testSchema.db.favorites.ids('user:al', 'team', 'note')).toEqual(['new-id'])

      await testSchema.db.favorites.removeByEntity('user:al', 'team', 'old-id')

      expect(await testSchema.db.favorites.list('user:al', 'team')).toEqual([])
    } finally {
      await testSchema.teardown()
    }
  })

  describeRevisionPersistenceContract('Postgres', async () => {
    const testSchema = await createPostgresTestSchema('revision_contract')
    return {
      persistence: testSchema.db.revisions,
      // Written the way the identity aggregate's settlement transaction leaves it —
      // the revision port has no way to decide a quarantine.
      quarantine: async (revisionIds) => {
        await testSchema.admin.query(
          `UPDATE "${testSchema.schema.replaceAll('"', '""')}".note_revisions
              SET integrity = 'quarantined'
            WHERE id = ANY($1::bigint[])`,
          [revisionIds],
        )
      },
      teardown: testSchema.teardown,
    }
  })

  // Two pools onto ONE schema: the arbitration contract is about independent
  // sessions racing for an id, so a single connection would prove nothing.
  describeIdentityPersistenceContract('Postgres', async () => {
    const testSchema = await createPostgresTestSchema('identity_contract')
    const peer = new PgMetaDb(testSchema.scopedUrl)

    return {
      alpha: testSchema.db,
      beta: peer,
      // The port cannot produce a payload it refuses to read back; write it the
      // way a hand edit or an older schema would have.
      corruptContextSetItems: async (setId, raw) => {
        await testSchema.admin.query(
          `UPDATE "${testSchema.schema.replaceAll('"', '""')}".context_sets SET items = $1 WHERE id = $2`,
          [raw, setId],
        )
      },
      teardown: async () => {
        await peer.close()
        await testSchema.teardown()
      },
    }
  })

  describeLegacyNameAliasesContract('Postgres', async () => {
    const testSchema = await createPostgresTestSchema('legacy_alias_contract')
    const peer = new PgMetaDb(testSchema.scopedUrl)

    return {
      alpha: testSchema.db.identity,
      beta: peer.identity,
      corruptAliases: async (id, raw) => {
        await testSchema.admin.query(
          `UPDATE "${testSchema.schema.replaceAll('"', '""')}".note_identity
              SET legacy_name_aliases = $1 WHERE id = $2`,
          [raw, id],
        )
      },
      teardown: async () => {
        await peer.close()
        await testSchema.teardown()
      },
    }
  })

  describeCausalMetadataContract('Postgres', async () => {
    const testSchema = await createPostgresTestSchema('causal_metadata_contract')
    return {
      operations: testSchema.db.restoreOperations,
      lifecycle: testSchema.db.spaceLifecycle,
      outbox: testSchema.db.causalOutbox,
      installation: testSchema.db.installationGeneration,
      ownerProofs: testSchema.db.ownerProofs,
      revisions: testSchema.db.revisions,
      terminal: testSchema.db.restoreTerminal,
      setAddress: async (noteId, space, addressRevision, legacyNameAliases = []) => {
        await testSchema.db.identity.claimMany([
          {
            id: noteId,
            legacyNameAliases,
            filePath: `address-${addressRevision}.md`,
            space,
            createdAt: null,
            materialized: true,
            deletedAt: null,
          },
        ])
      },
      getAddress: (noteId) => testSchema.db.identity.findById!(noteId),
      prepareTerminalResurrection: async (noteId, space, filePath, at) => {
        const current = await testSchema.db.identity.findById!(noteId)

        if (!current) {
          throw new Error(`missing identity ${noteId}`)
        }
        await testSchema.db.identity.settleFileClaim({
          space,
          filePath,
          current,
          observedId: 'terminal-successor',
          at,
        })
        const retired = await testSchema.db.identity.findById!(noteId)

        if (!retired) {
          throw new Error(`missing retired identity ${noteId}`)
        }

        return retired
      },
      mergeLegacyNameAlias: (noteId, space, alias) =>
        testSchema.db.identity.mergeLegacyNameAlias({ id: noteId, space, alias }),
      teardown: testSchema.teardown,
    }
  })

  describeSessionAuditContract('Postgres', async () => {
    const testSchema = await createPostgresTestSchema('session_audit_contract')
    return {
      audit: testSchema.db.sessionAudit,
      retrievals: testSchema.db.retrievalLog,
      revisions: testSchema.db.revisions,
      sessions: testSchema.db.sessions,
      teardown: testSchema.teardown,
    }
  })

  // Both lock-order races the #327 review found, forced deterministically rather than
  // hoped for. A settlement enters at tier 1 (identity) and reaches tier 2 (the scope
  // advisory) and tier 3 (revision stripes) later; the two peers below used to enter
  // at tier 2 and tier 3 and reach for identity afterwards, which is a cycle. Parking
  // the settlement on a favourites row holds it between the tiers so the interleaving
  // is not left to chance. canon: drivers/pg/lockOrder
  const seedForSettlement = async (
    testSchema: Awaited<ReturnType<typeof createPostgresTestSchema>>,
  ): Promise<void> => {
    await testSchema.db.identity.claimMany([
      {
        id: 'X',
        legacyNameAliases: [],
        filePath: 'owned.md',
        space: 'alpha',
        createdAt: null,
        materialized: true,
        deletedAt: null,
      },
      // The claimant's own durable row: without it there is no tuple for a peer to
      // block on, and the race the test means to force never forms.
      {
        id: 'beta-auto-01',
        legacyNameAliases: [],
        filePath: 'copy.md',
        space: 'beta',
        createdAt: null,
        materialized: false,
        deletedAt: null,
      },
    ])
    // A claimant favourite gives the settlement a tier-2 row to park on.
    await testSchema.db.favorites.add({
      owner: 'user:beta',
      space: 'beta',
      kind: 'note',
      entityId: 'beta-auto-01',
      createdAt: '2026-06-12T10:00:00.000Z',
      rank: null,
    })
  }

  const settleForeignClaim = (
    testSchema: Awaited<ReturnType<typeof createPostgresTestSchema>>,
  ): Promise<unknown> =>
    testSchema.db.identity.settleFileClaim({
      space: 'beta',
      filePath: 'copy.md',
      current: {
        id: 'beta-auto-01',
        legacyNameAliases: [],
        filePath: 'copy.md',
        space: 'beta',
        createdAt: null,
        materialized: false,
        deletedAt: null,
      },
      observedId: 'X',
      at: '2026-06-12T10:00:00.000Z',
    })

  it('orders a scope reorder behind a settlement holding the same identity', async () => {
    const testSchema = await createPostgresTestSchema('identity_reorder_order')
    const blockerPool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const blocker = await blockerPool.connect()
    let settleTask: Promise<unknown> | undefined
    let reorderTask: Promise<unknown> | undefined

    try {
      // Pinned under the OBSERVED id BEFORE the owner claims it — the legacy shape a
      // collision leaves behind, and the reference a foreign-owner settlement migrates
      // (and therefore the scope whose advisory lock it reaches for). Pinning after the
      // claim is impossible by design: `addPin` refuses a foreign id.
      await testSchema.db.scopePins.addPin({
        targetKind: 'project',
        targetId: 'scope-1',
        targetSpace: 'beta',
        noteSpace: 'beta',
        noteId: 'X',
        createdAt: '2026-06-12T10:00:00.000Z',
      })
      await seedForSettlement(testSchema)

      // Park the settlement AFTER its identity rows, before it reaches the scope.
      await blocker.query('BEGIN')
      await blocker.query(
        `SELECT owner FROM favorites WHERE owner = $1 AND space = $2 AND kind = 'note' AND entity_id = $3 FOR UPDATE`,
        ['user:beta', 'beta', 'beta-auto-01'],
      )

      settleTask = settleForeignClaim(testSchema)
      await waitForTupleLockWaiter(testSchema)

      reorderTask = testSchema.db.contextOrder.setOrder('project', 'scope-1', 'beta', [
        { entryKind: 'pin', entryRef: 'beta-auto-01' },
      ])
      await waitForTupleLockWaiter(testSchema, 2)
      await blocker.query('COMMIT')

      // Neither may be chosen as a deadlock victim: the reorder waits at tier 1 for
      // the settlement it can never be ahead of.
      await withTimeout(Promise.all([settleTask, reorderTask]), PROBE_WAIT_MS)
      expect(await testSchema.db.identity.findById!('X')).toMatchObject({ space: 'alpha' })
      expect(
        (await testSchema.db.contextOrder.orderForTarget('project', 'scope-1')).map(
          (entry) => entry.entryRef,
        ),
      ).toEqual(['beta-auto-01'])
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      await Promise.allSettled([settleTask, reorderTask].filter((task) => task != null))
      blocker.release()
      await blockerPool.end()
      await testSchema.teardown()
    }
  })

  it('orders a whole-space purge behind a settlement holding the same identity', async () => {
    const testSchema = await createPostgresTestSchema('identity_purge_order')
    const blockerPool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const blocker = await blockerPool.connect()
    let settleTask: Promise<unknown> | undefined
    let purgeTask: Promise<void> | undefined

    try {
      await seedForSettlement(testSchema)
      await testSchema.db.spaces.upsert({
        id: 'beta',
        slug: 'beta',
        notesDir: 'beta',
        displayName: 'Beta',
        aliases: [],
        createdAt: '2026-06-12T10:00:00.000Z',
        archivedAt: null,
        archivedBy: null,
      })
      // A journal for the claimant id, so the settlement actually reaches the
      // revision tier the purge also wants.
      await testSchema.db.revisions.append(
        {
          noteId: 'X',
          space: 'beta',
          baseRevisionId: null,
          theirRevisionId: null,
          sourceRevisionId: null,
          kind: 'write',
          entryRole: 'origin',
          principal: 'user:beta',
          contentHash: null,
          title: 'Copy',
          class: 'user-doc',
          slug: null,
          tags: [],
          createdAt: '2026-06-12T10:00:00.000Z',
          charsAdded: null,
          charsRemoved: null,
        } satisfies RevisionInput,
        null,
      )

      await blocker.query('BEGIN')
      await blocker.query(
        `SELECT owner FROM favorites WHERE owner = $1 AND space = $2 AND kind = 'note' AND entity_id = $3 FOR UPDATE`,
        ['user:beta', 'beta', 'beta-auto-01'],
      )

      settleTask = settleForeignClaim(testSchema)
      await waitForTupleLockWaiter(testSchema)

      purgeTask = testSchema.db.purgeSpace('beta')
      await waitForTupleLockWaiter(testSchema, 2)
      await blocker.query('COMMIT')

      await withTimeout(Promise.all([settleTask, purgeTask]), PROBE_WAIT_MS)
      expect(await testSchema.db.identity.findById!('X')).toMatchObject({ space: 'alpha' })
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      await Promise.allSettled([settleTask, purgeTask].filter((task) => task != null))
      blocker.release()
      await blockerPool.end()
      await testSchema.teardown()
    }
  })

  it('enters the revision tier through the wide-scan mutex when its keys are unknown', async () => {
    const testSchema = await createPostgresTestSchema('identity_wide_scan_order')
    const blockerPool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const blocker = await blockerPool.connect()
    let settleTask: Promise<unknown> | undefined
    let settled = false

    try {
      await seedForSettlement(testSchema)
      // A journal for the claimant, so the settlement really walks a contamination
      // closure — the one tier-3 key set that is discovered instead of being known.
      await testSchema.db.revisions.append(
        {
          noteId: 'beta-auto-01',
          space: 'beta',
          baseRevisionId: null,
          theirRevisionId: null,
          sourceRevisionId: null,
          kind: 'write',
          entryRole: 'origin',
          principal: 'user:beta',
          contentHash: null,
          title: 'Copy',
          class: 'user-doc',
          slug: null,
          tags: [],
          createdAt: '2026-06-12T10:00:00.000Z',
          charsAdded: null,
          charsRemoved: null,
        } satisfies RevisionInput,
        null,
      )

      // Another wide scan already in flight. Sorting within a tier is what keeps it
      // deadlock-free, and a closure that grows as it is walked cannot sort its keys
      // up front — so the settlement has to wait its turn here rather than start
      // taking note stripes in an order only this run knows.
      await blocker.query('BEGIN')
      await blocker.query(`SELECT pg_advisory_xact_lock(hashtext('notarium:revision:wide'), 0)`)

      settleTask = settleForeignClaim(testSchema).then((result) => {
        settled = true
        return result
      })
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(settled).toBe(false)

      await blocker.query('COMMIT')
      await withTimeout(settleTask, PROBE_WAIT_MS)
      expect(settled).toBe(true)
      expect(await testSchema.db.identity.findById!('X')).toMatchObject({ space: 'alpha' })
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      await Promise.allSettled([settleTask].filter((task) => task != null))
      blocker.release()
      await blockerPool.end()
      await testSchema.teardown()
    }
  })

  it('rejects a cursor insert queued behind project deletion', async () => {
    const testSchema = await createPostgresTestSchema('agent_cursor_project_race')
    const blockerPool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const blocker = await blockerPool.connect()
    let deleteTask: Promise<void> | undefined
    let advanceTask: Promise<void> | undefined

    try {
      await testSchema.db.projects.upsert({
        id: 'project-race',
        space: 'space-a',
        path: 'race',
        slug: 'race',
        aliases: [],
        pathAliases: [],
        displayName: 'Race',
        status: 'active',
        lastSeen: '2026-08-04T10:00:00Z',
        createdAt: '2026-08-04T10:00:00Z',
      })
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM folders WHERE id = $1 FOR UPDATE', ['project-race'])

      deleteTask = testSchema.db.projects.delete('project-race')
      await waitForTupleLockWaiter(testSchema)
      advanceTask = testSchema.db.agentDeltaCursors.advance(
        { owner: 'alice' },
        'project-race',
        '42',
        '2026-08-04T10:01:00Z',
      )
      await blocker.query('COMMIT')

      await deleteTask
      await expect(advanceTask).rejects.toThrow(/foreign key/i)
      expect(
        await testSchema.db.agentDeltaCursors.getOrInit(
          { owner: 'alice' },
          'project-race',
          '2026-08-04T10:02:00Z',
        ),
      ).toBeNull()
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      await Promise.allSettled([deleteTask, advanceTask].filter((task) => task != null))
      blocker.release()
      await blockerPool.end()
      await testSchema.teardown()
    }
  })

  it('rejects a cursor insert queued behind a project-to-folder type flip', async () => {
    const testSchema = await createPostgresTestSchema('agent_cursor_project_retype_race')
    const blockerPool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const blocker = await blockerPool.connect()
    let retypeTask: Promise<void> | undefined
    let advanceTask: Promise<void> | undefined

    try {
      await testSchema.db.projects.upsert({
        id: 'project-retype-race',
        space: 'space-a',
        path: 'race',
        slug: 'race',
        aliases: [],
        pathAliases: [],
        displayName: 'Race',
        status: 'active',
        lastSeen: '2026-08-04T10:00:00Z',
        createdAt: '2026-08-04T10:00:00Z',
      })
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM folders WHERE id = $1 FOR UPDATE', [
        'project-retype-race',
      ])

      retypeTask = testSchema.db.folders.upsert({
        id: 'project-retype-race',
        space: 'space-a',
        path: 'race',
        pathAliases: [],
        lastSeen: '2026-08-04T10:01:00Z',
        createdAt: '2026-08-04T10:00:00Z',
      })
      await waitForTupleLockWaiter(testSchema)
      advanceTask = testSchema.db.agentDeltaCursors.advance(
        { owner: 'alice' },
        'project-retype-race',
        '42',
        '2026-08-04T10:02:00Z',
      )
      await blocker.query('COMMIT')

      await retypeTask
      await expect(advanceTask).rejects.toThrow(/foreign key/i)
      expect(await testSchema.db.projects.getById('project-retype-race')).toBeNull()
      expect(await testSchema.db.folders.getById('project-retype-race')).not.toBeNull()
      expect(
        await testSchema.db.agentDeltaCursors.getOrInit(
          { owner: 'alice' },
          'project-retype-race',
          '2026-08-04T10:03:00Z',
        ),
      ).toBeNull()
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      await Promise.allSettled([retypeTask, advanceTask].filter((task) => task != null))
      blocker.release()
      await blockerPool.end()
      await testSchema.teardown()
    }
  })

  it('orders a session advance before a concurrent project retype without deadlock', async () => {
    const testSchema = await createPostgresTestSchema('agent_cursor_session_retype_order')
    const blockerPool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const blocker = await blockerPool.connect()
    let advanceTask: Promise<void> | undefined
    let retypeTask: Promise<void> | undefined

    try {
      const projectId = 'project-session-retype-order'
      const sessionId = 'ses_aaaaaaaaaaaa'
      await testSchema.db.projects.upsert({
        id: projectId,
        space: 'space-a',
        path: 'session-race',
        slug: 'session-race',
        aliases: [],
        pathAliases: [],
        displayName: 'Session race',
        status: 'active',
        lastSeen: '2026-08-04T10:00:00Z',
        createdAt: '2026-08-04T10:00:00Z',
      })
      await testSchema.db.sessions.insert({
        id: sessionId,
        owner: 'alice',
        name: 'race',
        named: true,
        parentId: null,
        createdAt: '2026-08-04T10:00:00Z',
        lastSeenAt: '2026-08-04T10:00:00Z',
        calls: 1,
        role: null,
        roleLocator: null,
        roleContextProjectId: null,
        projectId: null,
      })
      // The owner row exists while the session row does not: getOrInit can leave
      // exactly this shape when a concurrent retype removes the materialised row
      // before the response acknowledges its revision window.
      await testSchema.db.agentDeltaCursors.advance(
        { owner: 'alice' },
        projectId,
        '10',
        '2026-08-04T10:01:00Z',
      )

      await blocker.query('BEGIN')
      await blocker.query(
        'SELECT owner FROM mcp_delta_owner_cursors WHERE owner = $1 AND project = $2 FOR UPDATE',
        ['alice', projectId],
      )

      advanceTask = testSchema.db.agentDeltaCursors.advance(
        { owner: 'alice', session: { id: sessionId, parentId: null } },
        projectId,
        '42',
        '2026-08-04T10:02:00Z',
      )
      await waitForTupleLockWaiter(testSchema)

      retypeTask = testSchema.db.folders.upsert({
        id: projectId,
        space: 'space-a',
        path: 'session-race',
        pathAliases: [],
        lastSeen: '2026-08-04T10:03:00Z',
        createdAt: '2026-08-04T10:00:00Z',
      })
      await waitForTupleLockWaiter(testSchema, 2)
      await blocker.query('COMMIT')

      await withTimeout(Promise.all([advanceTask, retypeTask]), PROBE_WAIT_MS)
      expect(await testSchema.db.projects.getById(projectId)).toBeNull()
      expect(await testSchema.db.folders.getById(projectId)).not.toBeNull()
      expect(
        await testSchema.db.agentDeltaCursors.getOrInit(
          { owner: 'alice' },
          projectId,
          '2026-08-04T10:04:00Z',
        ),
      ).toBeNull()
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      await Promise.allSettled([advanceTask, retypeTask].filter((task) => task != null))
      blocker.release()
      await blockerPool.end()
      await testSchema.teardown()
    }
  })

  it('orders a space purge before a concurrent session advance without deadlock', async () => {
    const testSchema = await createPostgresTestSchema('agent_cursor_session_purge_order')
    const blockerPool = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const blocker = await blockerPool.connect()
    let purgeTask: Promise<void> | undefined
    let advanceTask: Promise<void> | undefined
    const spaceId = 'space-session-purge-order'
    const projectId = 'project-session-purge-order'
    const sessionId = 'ses_aaaaaaaaaaaa'

    try {
      await testSchema.db.spaces.upsert({
        id: spaceId,
        slug: 'session-purge',
        displayName: 'Session purge',
        notesDir: 'session-purge',
        aliases: [],
        createdAt: '2026-08-04T10:00:00Z',
        archivedAt: null,
        archivedBy: null,
      })
      await testSchema.db.projects.upsert({
        id: projectId,
        space: spaceId,
        path: '',
        slug: 'session-purge',
        aliases: [],
        pathAliases: [],
        displayName: 'Session purge',
        status: 'active',
        lastSeen: '2026-08-04T10:00:00Z',
        createdAt: '2026-08-04T10:00:00Z',
      })
      await testSchema.db.sessions.insert({
        id: sessionId,
        owner: 'alice',
        name: 'purge race',
        named: true,
        parentId: null,
        createdAt: '2026-08-04T10:00:00Z',
        lastSeenAt: '2026-08-04T10:00:00Z',
        calls: 1,
        role: null,
        roleLocator: null,
        roleContextProjectId: null,
        projectId: null,
      })
      const scope = { owner: 'alice', session: { id: sessionId, parentId: null } }
      await testSchema.db.agentDeltaCursors.advance(scope, projectId, '10', '2026-08-04T10:01:00Z')
      await testSchema.db.spaces.upsert({
        id: spaceId,
        slug: 'session-purge',
        displayName: 'Session purge',
        notesDir: 'session-purge',
        aliases: [],
        createdAt: '2026-08-04T10:00:00Z',
        archivedAt: '2026-08-04T11:00:00Z',
        archivedBy: 'user:admin',
      })
      await testSchema.db.spaceLifecycle.transition({
        space: spaceId,
        expectedPhases: ['active'],
        phase: 'archived',
        changedAt: '2026-08-04T11:00:00Z',
        changedBy: 'user:admin',
      })

      await blocker.query('BEGIN')
      await blocker.query(
        `SELECT session_id FROM mcp_delta_session_cursors
          WHERE session_id = $1 AND project = $2 FOR UPDATE`,
        [sessionId, projectId],
      )

      purgeTask = testSchema.db.purgeSpace(spaceId)
      await waitForTupleLockWaiter(testSchema)
      advanceTask = testSchema.db.agentDeltaCursors.advance(
        scope,
        projectId,
        '42',
        '2026-08-04T10:02:00Z',
      )
      await waitForTupleLockWaiter(testSchema, 2)
      await blocker.query('COMMIT')

      await withTimeout(purgeTask, PROBE_WAIT_MS)
      await expect(withTimeout(advanceTask, PROBE_WAIT_MS)).rejects.toThrow(/foreign key/i)
      expect(await testSchema.db.projects.getById(projectId)).toBeNull()
      expect(
        await testSchema.db.agentDeltaCursors.getOrInit(
          { owner: 'alice' },
          projectId,
          '2026-08-04T10:03:00Z',
        ),
      ).toBeNull()
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      await Promise.allSettled([purgeTask, advanceTask].filter((task) => task != null))
      blocker.release()
      await blockerPool.end()
      await testSchema.teardown()
    }
  })

  it('purges only legacy bookmark handles that unambiguously belong to the space', async () => {
    const testSchema = await createPostgresTestSchema('legacy_bookmark_purge')
    const inspect = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const victim = 'space-legacy-gone'
    const keep = 'space-legacy-keep'

    try {
      await testSchema.db.spaces.upsert({
        id: victim,
        slug: 'gone',
        displayName: 'Gone',
        notesDir: 'gone',
        aliases: ['retired-gone', 'shared-retired'],
        createdAt: '2026-08-04T10:00:00Z',
        archivedAt: null,
        archivedBy: null,
      })
      await testSchema.db.spaces.upsert({
        id: keep,
        slug: 'keep',
        displayName: 'Keep',
        notesDir: 'keep',
        aliases: ['shared-retired'],
        createdAt: '2026-08-04T10:00:00Z',
        archivedAt: null,
        archivedBy: null,
      })
      for (const [id, space, slug] of [
        ['project-legacy-gone', victim, 'gone'],
        ['project-legacy-keep', keep, 'keep'],
      ]) {
        await testSchema.db.projects.upsert({
          id,
          space,
          path: '',
          slug,
          aliases: [],
          pathAliases: [],
          displayName: slug,
          status: 'active',
          lastSeen: '2026-08-04T10:00:00Z',
          createdAt: '2026-08-04T10:00:00Z',
        })
      }
      const legacyKeys = [
        victim,
        'project-legacy-gone',
        'gone',
        'retired-gone',
        keep,
        'project-legacy-keep',
        'shared-retired',
      ]
      await inspect.query(
        `INSERT INTO mcp_bookmarks (principal_id, space, last_rev, updated_at)
         SELECT 'pat:alice:legacy', legacy_key, '1', '2026-08-04T10:00:00Z'
           FROM unnest($1::text[]) AS legacy_key`,
        [legacyKeys],
      )
      await testSchema.db.spaces.upsert({
        id: victim,
        slug: 'gone',
        displayName: 'Gone',
        notesDir: 'gone',
        aliases: ['retired-gone', 'shared-retired'],
        createdAt: '2026-08-04T10:00:00Z',
        archivedAt: '2026-08-04T11:00:00Z',
        archivedBy: 'user:admin',
      })
      await testSchema.db.spaceLifecycle.transition({
        space: victim,
        expectedPhases: ['active'],
        phase: 'archived',
        changedAt: '2026-08-04T11:00:00Z',
        changedBy: 'user:admin',
      })

      await testSchema.db.purgeSpace(victim)

      const remaining = await inspect.query<{ space: string }>(
        'SELECT space FROM mcp_bookmarks ORDER BY space',
      )
      expect(remaining.rows.map(({ space }) => space)).toEqual(
        [keep, 'project-legacy-keep', 'shared-retired'].sort(),
      )
    } finally {
      await inspect.end()
      await testSchema.teardown()
    }
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
      purgeTask = testSchema.db.revisions.purgeNotes('space-a', ['purged']).finally(() => {
        purgeSettled = true
      })

      await waitForAdvisoryWaiters(testSchema, 2)
      expect(appendSettled).toBe(false)
      expect(purgeSettled).toBe(false)
      await locker.query('COMMIT')
      await Promise.all([appendTask, purgeTask])

      expect(await testSchema.db.revisions.content('shared-race-hash')).toBe('shared')
      expect(await testSchema.db.revisions.latestFor('space-a', 'survivor')).not.toBeNull()
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

      purgeTask = testSchema.db.revisions.purgeNotes('space-a', ['terminal-note-race'])
      await waitForAdvisoryWaiters(testSchema, 1)
      appendTask = testSchema.db.revisions.append(input, 'late body')
      const appendRejection = expect(appendTask).rejects.toThrow(
        /revision target was permanently purged: note/,
      )
      await waitForAdvisoryWaiters(testSchema, 2)

      await locker.query('COMMIT')
      await purgeTask
      await appendRejection
      expect(await testSchema.db.revisions.latestFor('space-a', 'terminal-note-race')).toBeNull()
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
      await withTimeout(Promise.all([legacyTask, modernTask]), PROBE_WAIT_MS)

      expect(await testSchema.db.revisions.latestFor('space-a', 'legacy-new-hash')).not.toBeNull()
      expect(await testSchema.db.revisions.latestFor('space-b', 'modern-new-hash')).not.toBeNull()
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
      expect(await testSchema.db.revisions.latestFor('space-a', input.noteId)).not.toBeNull()
      await locker.query('BEGIN')
      await lockRevisionStripe(locker, 'blob', 'legacy-terminal-race-hash')

      purgeTask = testSchema.db.revisions.purgeNotes('space-a', ['legacy-terminal-race'])
      await waitForAdvisoryWaiters(testSchema, 1)
      legacyTask = rawAppendWithoutApplicationLocks(legacyPool, input, 'late legacy body')
      const legacyRejection = expect(legacyTask).rejects.toThrow(
        /revision target was permanently purged: note/,
      )
      await waitForAdvisoryWaiters(testSchema, 2)

      await locker.query('COMMIT')
      await purgeTask
      await legacyRejection
      expect(await testSchema.db.revisions.latestFor('space-a', 'legacy-terminal-race')).toBeNull()
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
      expect(await testSchema.db.revisions.latestFor('space-b', 'legacy-space-terminal')).toBeNull()
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

      expect(await testSchema.db.revisions.latestFor('space-a', 'blocked-in-space')).toBeNull()
      expect(await testSchema.db.revisions.latestFor('space-a', independentNote)).toBeNull()
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
      expect(await testSchema.db.revisions.latestFor('space-a', 'space-terminal-seed')).toBeNull()
      expect(await testSchema.db.revisions.latestFor('space-a', 'late-in-purged-space')).toBeNull()
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
      expect(await testSchema.db.revisions.latestFor('space-b', 'surviving-space')).not.toBeNull()
      expect(await testSchema.db.revisions.latestFor('space-a', 'purged-space')).toBeNull()
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
      expect(await testSchema.db.revisions.latestFor('space-b', survivorNote)).not.toBeNull()
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
