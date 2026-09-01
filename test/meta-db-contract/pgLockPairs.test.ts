/**
 * Deadlock probes: every pair of the transactions that span more than one tier,
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
 * The interleaving is forced rather than hoped for: a blocker holds what the ladder is
 * entered through — the identity row, the project row, the wide-scan mutex and the
 * Space stripe — both sides queue behind it, and the commit releases them together, which is
 * the state a real deadlock needs. One member still enters through none of them — a
 * placement move comes in by WRITING the tier-2 pointer rows — so its eleven pairs
 * still spend the wait budget and are still read as the weaker probes the note below
 * describes.
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

import { type IdentityRecord, serializeAbilityLocator } from '@notarium/core'

import { abilityPackageOfLocator } from '../../packages/server/src/services/metaDb/abilityAddress'
import {
  ABILITY_TARGET_PURGED,
  type MetaDb,
  PROVIDER_PERSISTENCE_ERROR,
} from '../../packages/server/src/services/metaDb/types'
import { providerDisclosureOf } from '../../packages/server/src/services/providerRegistry'
import { createPostgresTestSchema, describePostgres } from './postgresHarness'

const AT = '2026-08-11T10:00:00.000Z'
const SPACE = 'alpha'
const NOTE = 'note-a'
const PROJECT = 'project-alpha'
const PACKAGE = 'AbCdefGhij_1'
const PROVIDER_KEY = { keyId: 'ck_111111111111111111111111', generation: 1 }
const NEXT_PROVIDER_KEY = { keyId: 'ck_222222222222222222222222', generation: 2 }
const DEADLOCK = '40P01'

/** The 32-bit hash every advisory key in `lockOrder` is built with, spelled here
 *  because a probe that held some other number would wait on nothing and pass. If the
 *  producer's ever stops being this, the probe stops seeing two waiters and says so. */
const hash32 = (value: string): number => {
  let hash = 0

  for (const character of value) {
    hash = (Math.imul(31, hash) + character.charCodeAt(0)) | 0
  }

  return hash
}

/** The per-scope advisory key: same hash, same input (`kind:id`). */
const scopeLockKey = (targetKind: string, targetId: string): number =>
  hash32(`${targetKind}:${targetId}`)

type Probe = { id: string; run: (db: MetaDb) => Promise<unknown> }

/** The transactions that touch more than one tier — the only ones a lock order can be
 *  wrong about. Each is aimed at the SAME note, project and Space, so both sides of a
 *  pair actually contend.
 *
 *  Tier 4 put four more in this set, and none of them was here: the ability policy
 *  (which reads `folders` at L4f before writing the ability tables at L4a), the owner
 *  override (L3s/L3n, then L4p), the placement move (tier 2, then L4p) and the exact
 *  note purge (tier 3, then L4a/L4p). `lockOrder` states in prose that tier 4 comes
 *  last precisely BECAUSE a purge and an availability write meet there in opposite
 *  directions — and that meeting had no probe at all. */
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
    id: 'contextSets.addItems',
    run: (db) =>
      db.contextSets.addItems('set-1', [
        { space: SPACE, noteId: NOTE },
        { space: SPACE, noteId: 'note-b' },
      ]),
  },
  {
    id: 'contextSets.removeItem',
    run: (db) => db.contextSets.removeItem('set-1', { space: SPACE, noteId: NOTE }),
  },
  {
    id: 'contextSets.reorderItems',
    run: (db) =>
      db.contextSets.reorderItems('set-1', [
        { space: SPACE, noteId: 'note-b' },
        { space: SPACE, noteId: NOTE },
      ]),
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
          legacyNameAliases: [],
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
  {
    // A non-empty selection on purpose: an empty one never reads the project rows, so
    // it never enters L4f — the very level this pair is about.
    id: 'abilityAvailability.set',
    run: (db) =>
      db.abilityAvailability.set(
        SPACE,
        PACKAGE,
        { mode: 'selected-projects', projectIds: [PROJECT] },
        NOTE,
      ),
  },
  {
    id: 'abilityPreferences.setEnabled',
    run: (db) =>
      db.abilityPreferences.setEnabled(
        'user:al',
        {
          locator: {
            source: 'owned',
            kind: 'role',
            packageId: PACKAGE,
            location: { scope: 'space', spaceId: SPACE },
          },
          registryNoteId: NOTE,
        },
        false,
        AT,
      ),
  },
  {
    id: 'abilityPlacement.moveOwnedRolePlacement',
    run: (db) =>
      db.abilityPlacement.moveOwnedRolePlacement({
        fromTargetId: `project:${PROJECT}:${PACKAGE}`,
        toTargetId: `space:${SPACE}:${PACKAGE}`,
        fromLocator: `owned:role:project:${SPACE}:${PROJECT}:${PACKAGE}`,
        toLocator: `owned:role:space:${SPACE}:${PACKAGE}`,
        registryNoteId: NOTE,
        manifestNoteId: NOTE,
        trail: 'record',
      }),
  },
  {
    // The current provider-space writer: target-space fence (L3s), resource (L5r),
    // then attachment (L5a). Vertical 14 adds retargeting to the same pair matrix.
    id: 'providerAttachments.offerProviderAttachment',
    run: (db) =>
      db.offerProviderAttachment(
        {
          id: 'provider-attachment-probe',
          resourceId: 'provider-resource-probe',
          targetKind: 'space',
          targetId: SPACE,
          targetSpace: SPACE,
          state: 'pending',
          resourceEpoch: null,
          credentialEpoch: null,
          disclosure: null,
          createdAt: AT,
          expiresAt: '2026-08-25T00:00:00.000Z',
        },
        providerDisclosureOf,
      ),
  },
  {
    id: 'providerAttachments.acceptProviderAttachment',
    run: (db) =>
      db.acceptProviderAttachment(
        {
          id: 'provider-attachment-probe',
          expectedResourceEpoch: 0,
          expectedCredentialEpoch: 0,
          acceptedAt: AT,
          manager: 'al',
        },
        providerDisclosureOf,
      ),
  },
  {
    id: 'providerAttachments.detachProviderAttachment',
    run: (db) => db.detachProviderAttachment({ id: 'provider-attachment-probe', manager: 'al' }),
  },
  {
    id: 'pgMetaDb.retargetProviderCredential',
    run: (db) =>
      db.retargetProviderCredential({
        owner: 'al',
        credentialId: 'provider-credential-probe',
        expectedCredentialRuntimeEpoch: 0,
        origin: 'https://provider-next.example',
        resources: [
          {
            id: 'provider-resource-probe',
            expectedRuntimeEpoch: 0,
            baseUrl: 'https://provider-next.example/v1',
            detachCredential: false,
          },
        ],
      }),
  },
  {
    id: 'pgMetaDb.removeMemberAndProviderAttachments',
    run: (db) => db.removeMemberAndProviderAttachments(SPACE, 'al'),
  },
  { id: 'revisions.purgeNotes', run: (db) => db.revisions.purgeNotes(SPACE, [NOTE]) },
  { id: 'pgMetaDb.purgeSpace', run: (db) => db.purgeSpace(SPACE) },
]

const identity = (id: string): IdentityRecord => ({
  id,
  legacyNameAliases: [],
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
  await db.auth.createUser({
    username: 'al',
    displayName: 'Al',
    passwordHash: null,
    admin: false,
    disabledAt: null,
    createdAt: AT,
    personalSpace: null,
  })
  await db.auth.upsertMember(SPACE, 'al', 'owner', AT)
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
  await db.secretKeyring.replaceNonRetiredWith({
    ...PROVIDER_KEY,
    canary: `v1.${PROVIDER_KEY.keyId}.YWJj`,
    state: 'active',
    createdAt: AT,
    retiredAt: null,
  })
  await db.credentials.create(
    {
      id: 'provider-credential-probe',
      owner: 'al',
      name: 'Provider credential',
      kind: 'bearer',
      secret: `v1.${PROVIDER_KEY.keyId}.YWJj`,
      origin: 'https://provider.example',
      injection: { header: '', prefix: 'Bearer ' },
      disabledAt: null,
      rpm: null,
      tpm: null,
      consentEpoch: 0,
      runtimeEpoch: 0,
    },
    PROVIDER_KEY,
  )
  await db.providerResources.create(
    {
      id: 'provider-resource-probe',
      owner: 'al',
      name: 'Provider resource',
      wire: 'openai-compatible',
      baseUrl: 'https://provider.example/v1',
      headers: {},
      allowPrivateNetwork: false,
      models: [],
      defaultModel: null,
      credentialId: 'provider-credential-probe',
      consentEpoch: 0,
      runtimeEpoch: 0,
      disabledAt: null,
      lastCheck: {},
      firstByteTimeoutMs: 30_000,
      callTimeoutMs: 300_000,
    },
    null,
  )
  await db.offerProviderAttachment(
    {
      id: 'provider-attachment-probe',
      resourceId: 'provider-resource-probe',
      targetKind: 'space',
      targetId: SPACE,
      targetSpace: SPACE,
      state: 'pending',
      resourceEpoch: null,
      credentialEpoch: null,
      disclosure: null,
      createdAt: AT,
      expiresAt: '2026-08-25T00:00:00.000Z',
    },
    providerDisclosureOf,
  )
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

/** The same wait, but the QUEUEING is the claim rather than the setup. Used by the one
 *  probe below whose whole subject is "do these two contend at all": there, an expired
 *  budget is not a weaker probe, it is the defect. */
const requireWaiters = async (admin: pg.Pool, schema: string, expected: number): Promise<void> => {
  await waitForWaiters(admin, schema, expected)
  const result = await admin.query(
    `SELECT COUNT(*) AS n FROM pg_stat_activity
      WHERE application_name = $1 AND wait_event_type = 'Lock'`,
    [schema],
  )

  expect(
    Number(result.rows[0].n),
    `${expected} sides had to queue on the same key and did not`,
  ).toBeGreaterThanOrEqual(expected)
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
        // Every ENTRY POINT of the ladder, not just identity's. A probe that queues
        // behind none of these does not interleave at all — it runs its two sides one
        // after the other, exhausts the wait budget and proves nothing: which is what
        // `abilityAvailability.set × pgMetaDb.purgeSpace`, the pair tier 4 was ordered
        // FOR, did on the day it was added. The project row is tier 4's door, the
        // wide-scan mutex is the purges' and the Space stripe is the override's.
        await held.query('SELECT id FROM note_identity WHERE id = $1 FOR UPDATE', [NOTE])
        await held.query('SELECT id FROM folders WHERE id = $1 FOR UPDATE', [PROJECT])
        await held.query(`SELECT pg_advisory_xact_lock(hashtext('notarium:revision:wide'), 0)`)
        await held.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
          'notarium:revision:space',
          SPACE,
        ])

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

  it('orders generation GC ahead of whole-Space projection cleanup', async () => {
    const testSchema = await createPostgresTestSchema('lock_pairs_activity_gc')
    const db = testSchema.db
    const blocker = new pg.Pool({ connectionString: testSchema.scopedUrl })

    try {
      await seed(db)
      await blocker.query(
        `INSERT INTO activity_note_actor_states (
           space, generation, source_ordinal, revision_id, note_id,
           actor_kind, actor_key, class_key, event_count,
           chars_added_sum, chars_added_known, chars_removed_sum, chars_removed_known
         )
         SELECT space, 99, source_ordinal, revision_id, note_id,
                actor_kind, actor_key, class_key, event_count,
                chars_added_sum, chars_added_known, chars_removed_sum, chars_removed_known
           FROM activity_note_actor_states WHERE space = $1 AND generation = 1`,
        [SPACE],
      )
      await blocker.query(
        `INSERT INTO activity_note_actor_heads (
           space, generation, note_id, actor_kind, actor_key, class_key,
           source_ordinal, revision_id
         )
         SELECT space, 99, note_id, actor_kind, actor_key, class_key,
                source_ordinal, revision_id
           FROM activity_note_actor_heads WHERE space = $1 AND generation = 1`,
        [SPACE],
      )
      await blocker.query(
        `INSERT INTO activity_projection_gc (space, generation, phase, updated_at)
         VALUES ($1, 99, 'states', $2)`,
        [SPACE, AT],
      )
      const held = await blocker.connect()

      await held.query('BEGIN')
      await held.query(
        'SELECT generation FROM activity_projection_gc WHERE space = $1 FOR UPDATE',
        [SPACE],
      )
      const gc = db.revisions.maintainActivityProjectionGc(SPACE).then(
        () => null,
        (error: unknown) => error,
      )

      await requireWaiters(testSchema.admin, testSchema.schema, 1)
      const purge = db.purgeSpace(SPACE).then(
        () => null,
        (error: unknown) => error,
      )

      await requireWaiters(testSchema.admin, testSchema.schema, 2)
      await held.query('COMMIT')
      held.release()

      expect((await Promise.all([gc, purge])).map(deadlockOf).filter(Boolean)).toEqual([])
    } finally {
      await blocker.end().catch(() => {})
      await testSchema.teardown()
    }
  })

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

  /** `abilityAvailability.set × pgMetaDb.purgeSpace` — the pair tier 4 was ordered FOR
   *  — released so that the inversion is REACHED rather than hoped for.
   *
   *  In the generic probe above, both sides queue behind one blocker and are freed by
   *  one COMMIT, so the winner is decided by round-trip count: `set` is one statement
   *  away from its `INSERT` while the purge is a dozen away from the space row. It
   *  takes the space row first, every time, and the pair stays green over a live
   *  cycle. So this one holds the two sides apart instead: the purge goes first and
   *  is stopped on a row it deletes AFTER the space row and BEFORE `folders`, which
   *  is exactly the window the writer has to arrive in.
   *
   *  What the writer then does decides the outcome. Reaching `folders` (L4f) first and
   *  the space row second — which a FOREIGN KEY to `spaces` does, silently, from the
   *  `INSERT` — is the inverted pair, and Postgres answers `40P01`: a 500 for a `PUT
   *  …/availability` that raced a purge of its own Space. Taking the Space FIRST, as
   *  the lifecycle fence now does, makes the writer wait for the purge to finish and
   *  then refuse in the shape a route can read. */
  it('refuses an availability write against a purge holding the space, without a deadlock', async () => {
    const testSchema = await createPostgresTestSchema('lock_pairs_space')
    const db = testSchema.db
    const gate = new pg.Pool({ connectionString: testSchema.scopedUrl })

    try {
      await seed(db)
      const held = await gate.connect()

      await held.query('BEGIN')
      await held.query('SELECT note_id FROM note_revisions WHERE space = $1 FOR UPDATE', [SPACE])

      const purging = db.purgeSpace(SPACE).then(
        () => null,
        (error: unknown) => error,
      )

      // The purge is now parked BELOW the space row and ABOVE `folders`.
      await waitForWaiters(testSchema.admin, testSchema.schema, 1)

      const setting = db.abilityAvailability
        .set(SPACE, PACKAGE, { mode: 'selected-projects', projectIds: [PROJECT] }, NOTE)
        .then(
          () => null,
          (error: unknown) => error,
        )

      // …and the writer is parked wherever its own order puts it.
      await waitForWaiters(testSchema.admin, testSchema.schema, 2)
      await held.query('COMMIT')
      held.release()

      const write = await setting
      const purge = await purging

      expect([write, purge].map(deadlockOf).filter(Boolean)).toEqual([])
      expect(purge).toBeNull()
      // Not merely "no deadlock": the loser of this race owes the route an answer it
      // can turn into a 404, and a raw driver code is indistinguishable from a bug.
      expect(write === null || (write as { code?: unknown }).code === ABILITY_TARGET_PURGED).toBe(
        true,
      )
    } finally {
      await gate.end().catch(() => {})
      await testSchema.teardown()
    }
  })

  /** `abilityPreferences.setEnabled × abilityPlacement.moveOwnedRolePlacement` — the
   *  one pair in this schema that addresses the same rows while sharing no ROW.
   *
   *  A disable writes `(owner, locator)`, which need not exist yet; a promotion
   *  rewrites the `locator` COLUMN for every owner at once and can name no prefix of
   *  that primary key. Under READ COMMITTED the move's range `UPDATE` neither sees nor
   *  locks a row inserted after its snapshot, so before L4p had an entry the two took
   *  nothing in common: the disable committed onto the locator the package had just
   *  left, and `isEnabled` — which reads an absent row as "enabled" — answered that a
   *  role its owner had switched off was back on.
   *
   *  So this probe is not the generic "released from one queue" shape, and its claim is
   *  not "no deadlock". It holds the L4p key itself and requires BOTH sides to QUEUE on
   *  it: without `lockAbilityPreferencePackages` neither one does, the wait budget
   *  expires, and `requireWaiters` says so.
   *
   *  The state assertions after the release are the second half, and they are read off
   *  the TABLE rather than through `isEnabled`: serializing decides which side goes
   *  first and nothing more, and the order where the move goes first used to leave the
   *  disable on the locator the package had left — which the reading side now resolves
   *  through the trail, so the harm would be invisible to the very method that used to
   *  report it. Both owners' rows have to be AT the destination, whichever side won. */
  it('serializes an owner disable against the placement move that rewrites its locator', async () => {
    const testSchema = await createPostgresTestSchema('lock_pairs_preferences')
    const db = testSchema.db
    const gate = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const atProject = {
      source: 'owned',
      kind: 'role',
      packageId: PACKAGE,
      location: { scope: 'project', spaceId: SPACE, projectId: PROJECT },
    } as const
    const atSpace = {
      source: 'owned',
      kind: 'role',
      packageId: PACKAGE,
      location: { scope: 'space', spaceId: SPACE },
    } as const
    // Serialized, not hand-spelled: the row this move has to carry is keyed by whatever
    // `setEnabled` wrote, and the advisory key held below has to be the same string.
    const fromLocator = serializeAbilityLocator(atProject)
    const toLocator = serializeAbilityLocator(atSpace)

    let release = async (): Promise<void> => {}

    try {
      await seed(db)
      // A SECOND owner, disabled at the source before either side starts. Its row is
      // what the move carries, so the final state can tell a rewrite that happened
      // from one that never reached the table.
      await db.abilityPreferences.setEnabled(
        'user:bo',
        { locator: atProject, registryNoteId: NOTE },
        false,
        AT,
      )
      const held = await gate.connect()

      // Released exactly once, and from a handle the `finally` can reach: the wait
      // below is an ASSERTION, and an assertion that throws while this client is out
      // of the pool leaves `gate.end()` waiting for it forever — the suite then dies
      // of its own timeout with no diagnosis at all, which is the one outcome a probe
      // about waiting must never produce.
      release = async () => {
        release = async () => {}
        await held.query('COMMIT').catch(() => {})
        held.release()
      }
      await held.query('BEGIN')
      // The L4p key, spelled the way `lockAbilityPreferencePackages` spells it: the
      // PACKAGE, which both addresses of this move name and which a `setEnabled` at
      // either of them names too.
      await held.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        'notarium:ability-preferences',
        abilityPackageOfLocator(fromLocator),
      ])

      const disabling = db.abilityPreferences
        .setEnabled('user:al', { locator: atProject, registryNoteId: NOTE }, false, AT)
        .then(
          () => null,
          (error: unknown) => error,
        )
      const moving = db.abilityPlacement
        .moveOwnedRolePlacement({
          fromTargetId: `project:${PROJECT}:${PACKAGE}`,
          toTargetId: `space:${SPACE}:${PACKAGE}`,
          fromLocator,
          toLocator,
          registryNoteId: NOTE,
          manifestNoteId: NOTE,
          trail: 'record',
        })
        .then(
          () => null,
          (error: unknown) => error,
        )

      await requireWaiters(testSchema.admin, testSchema.schema, 2)
      await release()

      expect([await disabling, await moving].map(deadlockOf).filter(Boolean)).toEqual([])
      // Read as rows: every override of this package sits at the address the package
      // now has. A row left at `fromLocator` is the harm — a bit written where nothing
      // reads it — and it is the outcome BOTH orders used to be allowed to produce.
      const stored = await testSchema.admin.query(
        `SELECT owner, locator FROM ${testSchema.schema}.ability_preferences ORDER BY owner`,
      )

      expect(stored.rows).toEqual([
        { owner: 'user:al', locator: toLocator },
        { owner: 'user:bo', locator: toLocator },
      ])
      // …and the same fact as a caller sees it, at either spelling of the address.
      expect([
        await db.abilityPreferences.isEnabled('user:al', atSpace),
        await db.abilityPreferences.isEnabled('user:al', atProject),
      ]).toEqual([false, false])
    } finally {
      await release()
      await gate.end().catch(() => {})
      await testSchema.teardown()
    }
  })

  /** `scopePins.addPin × abilityPlacement.moveOwnedRolePlacement` — the same shape one
   *  tier up, and the one this pair spent a round without: a pin INSERT is keyed by
   *  `(target_kind, target_id, note_id)` and the move re-addresses every pin of a
   *  target by range, so under READ COMMITTED the INSERT is invisible to it. The pin
   *  landed on the target the role had just left, and nothing but the opposite move
   *  ever reads that target again — the note the user pinned is simply gone from the
   *  role's context.
   *
   *  Same two halves as the probe above: both sides must QUEUE on the L2d key, and the
   *  pin must exist at the address the role actually has. The matrix pair of the same
   *  two transactions asks only "no deadlock", which stayed green throughout. */
  it('serializes a pin against the placement move that re-addresses the target', async () => {
    const testSchema = await createPostgresTestSchema('lock_pairs_pins')
    const db = testSchema.db
    const gate = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const fromTargetId = `project:${PROJECT}:${PACKAGE}`
    const toTargetId = `space:${SPACE}:${PACKAGE}`

    let release = async (): Promise<void> => {}

    try {
      await seed(db)
      const held = await gate.connect()

      release = async () => {
        release = async () => {}
        await held.query('COMMIT').catch(() => {})
        held.release()
      }
      await held.query('BEGIN')
      // The L2d key, spelled the way `lockScopePinTargets` spells it: the namespace of
      // the pin advisory and the 32-bit hash of `kind:id`, sorted by the helper, so the
      // source target is the one the move takes first.
      await held.query('SELECT pg_advisory_xact_lock($1, $2)', [
        0x7363_5069,
        scopeLockKey('role', fromTargetId),
      ])

      const pinning = db.scopePins
        .addPin({
          targetKind: 'role',
          targetId: fromTargetId,
          targetSpace: SPACE,
          noteSpace: SPACE,
          noteId: NOTE,
          createdAt: AT,
        })
        .then(
          () => null,
          (error: unknown) => error,
        )
      const moving = db.abilityPlacement
        .moveOwnedRolePlacement({
          fromTargetId,
          toTargetId,
          fromLocator: serializeAbilityLocator({
            source: 'owned',
            kind: 'role',
            packageId: PACKAGE,
            location: { scope: 'project', spaceId: SPACE, projectId: PROJECT },
          }),
          toLocator: serializeAbilityLocator({
            source: 'owned',
            kind: 'role',
            packageId: PACKAGE,
            location: { scope: 'space', spaceId: SPACE },
          }),
          registryNoteId: NOTE,
          manifestNoteId: NOTE,
          trail: 'record',
        })
        .then(
          () => null,
          (error: unknown) => error,
        )

      await requireWaiters(testSchema.admin, testSchema.schema, 2)
      await release()

      expect([await pinning, await moving].map(deadlockOf).filter(Boolean)).toEqual([])
      // Whichever side won: the pin is at the target the role now has. Landing at the
      // source is the harm — an orphan no reader of this role will ever see again.
      expect(
        (await db.scopePins.pinsForTarget('role', toTargetId)).map((pin) => pin.noteId),
      ).toEqual([NOTE])
      expect(await db.scopePins.pinsForTarget('role', fromTargetId)).toEqual([])
    } finally {
      await release()
      await gate.end().catch(() => {})
      await testSchema.teardown()
    }
  })

  it('serializes two re-claims of one logical job call so only one may send', async () => {
    const testSchema = await createPostgresTestSchema('lock_pairs_call_log')
    const db = testSchema.db
    const gate = new pg.Pool({ connectionString: testSchema.scopedUrl })
    const job = { jobId: 'job-1', jobCallKey: 'embed-batch-0' }
    const intent = (id: string) =>
      db.providerCallLog
        .intent({
          id,
          owner: 'al',
          principal: 'user:al',
          agent: null,
          resourceId: 'resource-a',
          credentialId: null,
          host: 'provider.example',
          spaces: [],
          job,
          createdAt: AT,
        })
        .then(
          (result) => result,
          (error: unknown) => error,
        )

    let release = async (): Promise<void> => {}

    try {
      const held = await gate.connect()

      release = async () => {
        release = async () => {}
        await held.query('COMMIT').catch(() => {})
        held.release()
      }
      await held.query('BEGIN')
      await held.query('SELECT pg_advisory_xact_lock($1, $2)', [
        // The producer's namespace and key, spelled out: a probe holding some other
        // number would wait on nothing and pass while the fence was missing.
        0x7063_614c,
        hash32(`${job.jobId}\u0000${job.jobCallKey}`),
      ])

      const first = intent('call-1')
      const second = intent('call-2')

      await requireWaiters(testSchema.admin, testSchema.schema, 2)
      await release()

      // Both re-claims read "no attempt yet" if nothing serializes them, and both
      // send. Here one records and the other is refused BY the first — the second
      // never becomes an upstream request, and it is not a unique violation either.
      const outcomes = [await first, await second] as Array<{ status?: string }>
      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['blocked', 'recorded'])
      expect(await db.providerCallLog.listForOwner('al')).toHaveLength(1)
      expect(await db.providerCallLog.latestForJobCall(job.jobId, job.jobCallKey)).toMatchObject({
        attemptNo: 1,
      })
    } finally {
      await release()
      await gate.end().catch(() => {})
      await testSchema.teardown()
    }
  })

  it('serializes the final zero-reference retirement against a stale ciphertext writer', async () => {
    const testSchema = await createPostgresTestSchema('lock_pairs_key_retire')
    const db = testSchema.db
    const gate = new pg.Pool({ connectionString: testSchema.scopedUrl })

    let release = async (): Promise<void> => {}

    try {
      await db.secretKeyring.replaceNonRetiredWith({
        ...PROVIDER_KEY,
        canary: `v1.${PROVIDER_KEY.keyId}.YWJj`,
        state: 'active',
        createdAt: AT,
        retiredAt: null,
      })
      await db.secretKeyring.admitReadable({
        ...NEXT_PROVIDER_KEY,
        canary: `v1.${NEXT_PROVIDER_KEY.keyId}.YWJj`,
        state: 'readable',
        createdAt: AT,
        retiredAt: null,
      })
      await db.secretKeyring.projectActive(NEXT_PROVIDER_KEY)
      const held = await gate.connect()

      release = async () => {
        release = async () => {}
        await held.query('COMMIT').catch(() => {})
        held.release()
      }
      await held.query('BEGIN')
      await held.query('SELECT pg_advisory_xact_lock($1, $2)', [0x7365_634b, 0])

      const staleWriter = db.credentials
        .create(
          {
            id: 'credential-after-final-scan',
            owner: 'user:al',
            name: 'Stale writer',
            kind: 'bearer',
            secret: `v1.${PROVIDER_KEY.keyId}.YWJj`,
            origin: 'https://provider.example',
            injection: { header: '', prefix: 'Bearer ' },
            disabledAt: null,
            rpm: null,
            tpm: null,
            consentEpoch: 0,
            runtimeEpoch: 0,
          },
          PROVIDER_KEY,
        )
        .then(
          () => null,
          (error: unknown) => error,
        )
      const retiring = db.providerCiphertexts
        .retireKeys({
          active: NEXT_PROVIDER_KEY,
          sourceKeyIds: new Set([PROVIDER_KEY.keyId]),
          retiredAt: AT,
        })
        .then(
          (result) => result,
          (error: unknown) => error,
        )

      await requireWaiters(testSchema.admin, testSchema.schema, 2)
      await release()

      expect(await staleWriter).toMatchObject({
        code: PROVIDER_PERSISTENCE_ERROR.staleCiphertextKey,
      })
      expect(await retiring).toMatchObject({
        status: 'retired',
        retiredKeyIds: [PROVIDER_KEY.keyId],
      })
      expect(await db.credentials.get('credential-after-final-scan')).toBeNull()
      expect(
        (await db.secretKeyring.list()).find((row) => row.keyId === PROVIDER_KEY.keyId)?.retiredAt,
      ).toBe(AT)
    } finally {
      await release()
      await gate.end().catch(() => {})
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
