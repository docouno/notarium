// One executable contract for the GLOBAL id arbiter (#327). Two spaces reach the
// same table through INDEPENDENT sessions, exactly as two live stores do in a
// host: whoever commits first owns the id, and nothing a loser does — a retry, a
// write-behind batch, a second boot — can move that ownership. Before this, both
// SQL drivers upserted `space`/`file_path` on conflict, so a copied note changed
// owners with the poll order.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { IdentityPersistence, IdentityRecord, RevisionInput } from '@notarium/core'

import type { MetaDb } from '../../packages/server/src/services/metaDb/types'

export type IdentityPersistenceContractFactory = () => Promise<{
  /** Two meta-DB handles on ONE store, each with its own session/connection. */
  alpha: MetaDb
  beta: MetaDb
  /** Write a payload the port itself cannot produce — the hand-edited/older-schema
   *  shape a re-key must refuse rather than normalise. */
  corruptContextSetItems: (setId: string, raw: string) => Promise<void>
  teardown?: () => Promise<void>
}>

const AT = '2026-06-12T10:00:00.000Z'

const record = (over: Partial<IdentityRecord> & Pick<IdentityRecord, 'id'>): IdentityRecord => ({
  filePath: 'a.md',
  space: 'alpha',
  createdAt: null,
  materialized: false,
  deletedAt: null,
  ...over,
})

export const describeIdentityPersistenceContract = (
  name: string,
  factory: IdentityPersistenceContractFactory,
): void => {
  describe(`IdentityPersistence arbitration contract — ${name}`, { timeout: 15_000 }, () => {
    let alphaDb: MetaDb
    let betaDb: MetaDb
    let alpha: IdentityPersistence
    let beta: IdentityPersistence
    let corruptContextSetItems: (setId: string, raw: string) => Promise<void>
    let teardown: (() => Promise<void>) | undefined

    beforeEach(async () => {
      ;({ alpha: alphaDb, beta: betaDb, corruptContextSetItems, teardown } = await factory())
      alpha = alphaDb.identity
      beta = betaDb.identity
      await alpha.init()
      await beta.init()
    })

    afterEach(async () => {
      await teardown?.()
    })

    it('gives an absent id to the first committed claim and refuses every later space', async () => {
      const first = await alpha.settleFileClaim({
        space: 'alpha',
        filePath: 'shared.md',
        current: record({ id: 'alpha-auto-01' }),
        observedId: 'X',
        at: AT,
      })
      expect(first).toMatchObject({
        status: 'accepted',
        retiredId: 'alpha-auto-01',
        record: { id: 'X', space: 'alpha', filePath: 'shared.md', materialized: true },
      })

      const second = await beta.settleFileClaim({
        space: 'beta',
        filePath: 'copy.md',
        current: record({ id: 'beta-auto-01', space: 'beta', filePath: 'copy.md' }),
        observedId: 'X',
        at: AT,
      })
      expect(second).toMatchObject({
        status: 'foreign-owner',
        owner: { id: 'X', space: 'alpha', filePath: 'shared.md' },
        record: { id: 'beta-auto-01', space: 'beta', filePath: 'copy.md' },
      })
      // The loser's own identity is durable, so its convergence can never
      // publish a note the registry cannot resolve.
      expect(await beta.findById!('beta-auto-01')).toMatchObject({
        space: 'beta',
        filePath: 'copy.md',
        deletedAt: null,
      })
      expect(await alpha.findById!('X')).toMatchObject({ space: 'alpha', filePath: 'shared.md' })
    })

    // The header's promise, actually raced: both spaces reach for an ABSENT id at
    // once. Every other case here awaits one call before making the next, which two
    // independent sessions never do and which cannot tell a transaction apart from
    // a plain statement.
    //
    // The falsifying power is Postgres-only, and by construction: `node:sqlite` is
    // synchronous, so the only suspension point in that driver's settlement is
    // `ensureInit` BEFORE `BEGIN` — a `Promise.all` cannot interleave two of them,
    // and removing `BEGIN IMMEDIATE` leaves this green. On Postgres, where the two
    // sessions really are concurrent, dropping the locking pass breaks it. Running
    // it on SQLite too is still worth it: it pins the same three-outcome algebra on
    // both drivers, which is what stops the twin from drifting.
    it('settles a genuine race for an absent id: one owner, the loser told who won', async () => {
      const [first, second] = await Promise.all([
        alpha.settleFileClaim({
          space: 'alpha',
          filePath: 'shared.md',
          current: record({ id: 'alpha-auto-01' }),
          observedId: 'X',
          at: AT,
        }),
        beta.settleFileClaim({
          space: 'beta',
          filePath: 'copy.md',
          current: record({ id: 'beta-auto-01', space: 'beta', filePath: 'copy.md' }),
          observedId: 'X',
          at: AT,
        }),
      ])
      const outcomes = [first.status, second.status].sort()

      expect(outcomes).toEqual(['accepted', 'foreign-owner'])

      const durable = await alpha.findById!('X')
      const loser = first.status === 'foreign-owner' ? first : second

      expect(loser).toMatchObject({ status: 'foreign-owner' })
      // The loser was handed the COMMITTED owner, not its own stale reading of it.
      expect((loser as { owner: IdentityRecord }).owner).toMatchObject({
        id: 'X',
        space: durable!.space,
        filePath: durable!.filePath,
      })
      // …and both keep their own live identity, so neither publishes a note the
      // registry cannot resolve.
      expect(await alpha.findById!('alpha-auto-01')).toBeTruthy()
      expect(await beta.findById!('beta-auto-01')).toBeTruthy()
    })

    it('is idempotent on replay: the owner re-settling its own claim keeps everything', async () => {
      await alpha.settleFileClaim({
        space: 'alpha',
        filePath: 'shared.md',
        current: record({ id: 'alpha-auto-01' }),
        observedId: 'X',
        at: AT,
      })
      const replay = await alpha.settleFileClaim({
        space: 'alpha',
        filePath: 'shared.md',
        current: record({ id: 'X', filePath: 'shared.md', materialized: true }),
        observedId: 'X',
        at: '2026-06-12T11:00:00.000Z',
      })

      expect(replay).toMatchObject({ status: 'accepted', record: { id: 'X' } })
      expect(replay).not.toHaveProperty('retiredId')
      expect(await beta.findById!('X')).toMatchObject({ space: 'alpha', filePath: 'shared.md' })
    })

    it('leaves a TOMBSTONED owner’s space owning the id — a foreign claim never resurrects it', async () => {
      await alpha.claimMany([
        record({ id: 'X', filePath: 'gone.md', materialized: true, deletedAt: AT }),
      ])
      const settled = await beta.settleFileClaim({
        space: 'beta',
        filePath: 'copy.md',
        current: record({ id: 'beta-auto-01', space: 'beta', filePath: 'copy.md' }),
        observedId: 'X',
        at: AT,
      })

      expect(settled).toMatchObject({ status: 'foreign-owner', owner: { space: 'alpha' } })
      expect(await beta.findById!('X')).toMatchObject({
        space: 'alpha',
        filePath: 'gone.md',
        deletedAt: AT,
      })
    })

    it('lets the OWNING space resurrect its own tombstone at a new path (the external move)', async () => {
      await alpha.claimMany([
        record({ id: 'X', filePath: 'old.md', materialized: true, deletedAt: AT }),
      ])
      const settled = await alpha.settleFileClaim({
        space: 'alpha',
        filePath: 'new.md',
        current: record({ id: 'alpha-auto-02', filePath: 'new.md' }),
        observedId: 'X',
        at: AT,
      })

      expect(settled).toMatchObject({
        status: 'accepted',
        record: { id: 'X', filePath: 'new.md', deletedAt: null },
        retiredId: 'alpha-auto-02',
      })
    })

    it('retires a claimant whose own row was never persisted, whichever way the pair sorts', async () => {
      // Both rows this settlement can create are absent, and the pair is deliberately
      // ordered `current < observed` — the case the Postgres driver has to create in
      // SORTED order, because a lock cannot hold a key that has no row and two
      // settlements building the same pair from opposite sides would deadlock on the
      // unique index (#327). Behaviour is what this pins, and it is identical in both
      // dialects: the superseded identity becomes durable AS A TOMBSTONE, so a later
      // reference write can still canonicalize off it.
      const settled = await alpha.settleFileClaim({
        space: 'alpha',
        filePath: 'sorted-first.md',
        current: record({ id: 'aa-claimant-01', filePath: 'sorted-first.md' }),
        observedId: 'zz-observed-01',
        at: AT,
      })

      expect(settled).toMatchObject({
        status: 'accepted',
        record: { id: 'zz-observed-01', filePath: 'sorted-first.md', deletedAt: null },
        retiredId: 'aa-claimant-01',
      })
      expect(await alpha.findById!('aa-claimant-01')).toMatchObject({
        space: 'alpha',
        deletedAt: AT,
      })
      // And the mirror pair, where the natural write order is already sorted.
      const mirrored = await alpha.settleFileClaim({
        space: 'alpha',
        filePath: 'sorted-last.md',
        current: record({ id: 'zz-claimant-02', filePath: 'sorted-last.md' }),
        observedId: 'aa-observed-02',
        at: AT,
      })

      expect(mirrored).toMatchObject({ status: 'accepted', retiredId: 'zz-claimant-02' })
      expect(await alpha.findById!('zz-claimant-02')).toMatchObject({ deletedAt: AT })
    })

    it('refuses a copy inside ONE space without moving the id or the copy (duplicate-path-owner)', async () => {
      await alpha.settleFileClaim({
        space: 'alpha',
        filePath: 'original.md',
        current: record({ id: 'alpha-auto-01', filePath: 'original.md' }),
        observedId: 'X',
        at: AT,
      })
      const settled = await alpha.settleFileClaim({
        space: 'alpha',
        filePath: 'copy.md',
        current: record({ id: 'alpha-auto-02', filePath: 'copy.md' }),
        observedId: 'X',
        at: AT,
      })

      expect(settled).toMatchObject({
        status: 'duplicate-path-owner',
        owner: { id: 'X', filePath: 'original.md' },
        record: { id: 'alpha-auto-02', filePath: 'copy.md' },
      })
      expect(await alpha.findById!('X')).toMatchObject({ filePath: 'original.md' })
      // The copy's own row is NOT written by a refusal — nothing moved at all.
      expect(await alpha.findById!('alpha-auto-02')).toBeNull()
    })

    it('accepts a genuine same-space move: no second live path competes for the id', async () => {
      await alpha.settleFileClaim({
        space: 'alpha',
        filePath: 'original.md',
        current: record({ id: 'alpha-auto-01', filePath: 'original.md' }),
        observedId: 'X',
        at: AT,
      })
      const settled = await alpha.settleFileClaim({
        space: 'alpha',
        filePath: 'moved.md',
        current: record({ id: 'X', filePath: 'moved.md', materialized: true }),
        observedId: 'X',
        at: AT,
      })

      expect(settled).toMatchObject({ status: 'accepted', record: { filePath: 'moved.md' } })
      expect(await alpha.findById!('X')).toMatchObject({ space: 'alpha', filePath: 'moved.md' })
    })

    it('claimMany refuses a foreign id instead of taking it over, and reports the owner', async () => {
      await alpha.claimMany([record({ id: 'X', filePath: 'owned.md', materialized: true })])
      const outcomes = await beta.claimMany([
        record({ id: 'X', space: 'beta', filePath: 'stolen.md' }),
        record({ id: 'beta-own-01', space: 'beta', filePath: 'own.md' }),
      ])

      expect(outcomes).toEqual([
        { id: 'X', status: 'foreign-owner', owner: expect.objectContaining({ space: 'alpha' }) },
        { id: 'beta-own-01', status: 'claimed' },
      ])
      expect(await beta.findById!('X')).toMatchObject({ space: 'alpha', filePath: 'owned.md' })
      expect(await beta.loadAll('beta')).toEqual([
        expect.objectContaining({ id: 'beta-own-01', filePath: 'own.md' }),
      ])
    })

    it('carries the claimant’s OWN references onto its id, and leaves the owner’s alone', async () => {
      const seed = async (db: MetaDb, space: string, noteId: string): Promise<void> => {
        await db.favorites.add({
          owner: `user:${space}`,
          space,
          kind: 'note',
          entityId: noteId,
          createdAt: '2026-06-01T00:00:00.000Z',
          rank: null,
        })
        await db.contextSets.createSet({
          id: `set-${space}`,
          homeSpace: space,
          name: 'Bundle',
          items: [
            { space: 'other', noteId: 'keep-me-01' },
            { space, noteId },
          ],
          createdAt: '2026-06-01T00:00:00.000Z',
        })
        await db.scopePins.addPin({
          targetKind: 'personal',
          targetId: `scope-${space}`,
          targetSpace: space,
          noteSpace: space,
          noteId,
          createdAt: '2026-06-01T00:00:00.000Z',
        })
        await db.contextOrder.setOrder('personal', `scope-${space}`, space, [
          { entryKind: 'set', entryRef: `set-${space}` },
          { entryKind: 'pin', entryRef: noteId },
        ])
      }

      // Seeded BEFORE the id has an owner — the legacy shape this repair exists
      // for: both spaces already reference X because the old upsert let them.
      await seed(alphaDb, 'alpha', 'X')
      await seed(betaDb, 'beta', 'X')
      await alpha.claimMany([record({ id: 'X', filePath: 'owned.md', materialized: true })])
      const settled = await beta.settleFileClaim({
        space: 'beta',
        filePath: 'copy.md',
        current: record({ id: 'beta-auto-01', space: 'beta', filePath: 'copy.md' }),
        observedId: 'X',
        at: AT,
      })

      expect(settled.status).toBe('foreign-owner')
      // Beta's references now point at Beta's own note…
      expect(await betaDb.favorites.ids('user:beta', 'beta', 'note')).toEqual(['beta-auto-01'])
      expect((await betaDb.contextSets.getSet('set-beta'))!.items).toEqual([
        { space: 'other', noteId: 'keep-me-01' },
        { space: 'beta', noteId: 'beta-auto-01' },
      ])
      expect(await betaDb.scopePins.pinsForTarget('personal', 'scope-beta')).toEqual([
        expect.objectContaining({ noteSpace: 'beta', noteId: 'beta-auto-01' }),
      ])
      expect(await betaDb.contextOrder.orderForTarget('personal', 'scope-beta')).toEqual([
        expect.objectContaining({ entryKind: 'set', entryRef: 'set-beta', rank: 0 }),
        expect.objectContaining({ entryKind: 'pin', entryRef: 'beta-auto-01', rank: 1 }),
      ])
      // …and the OWNER's identical references are untouched: the id still means
      // the canonical owner everywhere outside the claimant's own space.
      expect(await alphaDb.favorites.ids('user:alpha', 'alpha', 'note')).toEqual(['X'])
      expect((await alphaDb.contextSets.getSet('set-alpha'))!.items).toEqual([
        { space: 'other', noteId: 'keep-me-01' },
        { space: 'alpha', noteId: 'X' },
      ])
      expect(await alphaDb.scopePins.pinsForTarget('personal', 'scope-alpha')).toEqual([
        expect.objectContaining({ noteSpace: 'alpha', noteId: 'X' }),
      ])
    })

    // POSITION, not age. Favourites list `rank IS NULL, rank ASC, created_at DESC`,
    // so a merge that kept the older row would push the survivor DOWN the list. Both
    // cases below carry a third, untouched favourite so the position is observable at
    // all — asserting only the survivor's createdAt cannot see a demotion (#327).
    it('merges an unranked re-keyed favourite onto the surviving VISIBLE position', async () => {
      const add = (entityId: string, createdAt: string, rank: number | null = null) =>
        betaDb.favorites.add({
          owner: 'user:beta',
          space: 'beta',
          kind: 'note',
          entityId,
          createdAt,
          rank,
        })

      await add('X', '2026-06-01T00:00:00.000Z')
      await add('beta-auto-01', '2026-05-01T00:00:00.000Z')
      await add('beta-other', '2026-04-01T00:00:00.000Z')

      expect((await betaDb.favorites.list('user:beta', 'beta')).map((f) => f.entityId)).toEqual([
        'X',
        'beta-auto-01',
        'beta-other',
      ])

      await alpha.claimMany([record({ id: 'X', filePath: 'owned.md', materialized: true })])
      await beta.settleFileClaim({
        space: 'beta',
        filePath: 'copy.md',
        current: record({ id: 'beta-auto-01', space: 'beta', filePath: 'copy.md' }),
        observedId: 'X',
        at: AT,
      })

      const merged = await betaDb.favorites.list('user:beta', 'beta')

      // X held the first slot; the surviving row keeps it and `beta-other` does not move.
      expect(merged.map((f) => f.entityId)).toEqual(['beta-auto-01', 'beta-other'])
      expect(merged[0]).toEqual(
        expect.objectContaining({ createdAt: '2026-06-01T00:00:00.000Z', rank: null }),
      )
    })

    it('keeps a RANKED favourite at its rank when a re-key merges an unranked twin onto it', async () => {
      const add = (entityId: string, createdAt: string, rank: number | null) =>
        betaDb.favorites.add({
          owner: 'user:beta',
          space: 'beta',
          kind: 'note',
          entityId,
          createdAt,
          rank,
        })

      // The ranked survivor is the NEWER row, so an age-based merge would prefer the
      // unranked one and hand the survivor its (absent) rank.
      await add('beta-auto-01', '2026-06-01T00:00:00.000Z', 0)
      await add('beta-other', '2026-04-01T00:00:00.000Z', 3)
      await add('X', '2026-05-01T00:00:00.000Z', null)

      await alpha.claimMany([record({ id: 'X', filePath: 'owned.md', materialized: true })])
      await beta.settleFileClaim({
        space: 'beta',
        filePath: 'copy.md',
        current: record({ id: 'beta-auto-01', space: 'beta', filePath: 'copy.md' }),
        observedId: 'X',
        at: AT,
      })

      const merged = await betaDb.favorites.list('user:beta', 'beta')

      // The dragged favourite stays first. Merging on age would have handed the
      // survivor the unranked row's slot, dropping it below `beta-other`.
      expect(merged.map((f) => f.entityId)).toEqual(['beta-auto-01', 'beta-other'])
      expect(merged[0]).toEqual(expect.objectContaining({ rank: 0 }))
    })

    it('rolls the whole settlement back rather than normalise a malformed reference payload', async () => {
      await alpha.claimMany([record({ id: 'X', filePath: 'owned.md', materialized: true })])
      await betaDb.contextSets.createSet({
        id: 'set-broken',
        homeSpace: 'beta',
        name: 'Broken',
        items: [{ space: 'beta', noteId: 'X' }],
        createdAt: '2026-06-01T00:00:00.000Z',
      })
      await corruptContextSetItems('set-broken', '{"not":"an array with X"}')

      await expect(
        beta.settleFileClaim({
          space: 'beta',
          filePath: 'copy.md',
          current: record({ id: 'beta-auto-01', space: 'beta', filePath: 'copy.md' }),
          observedId: 'X',
          at: AT,
        }),
      ).rejects.toThrow(/malformed/)
      // Nothing half-applied: the claimant's identity row was never written.
      expect(await beta.findById!('beta-auto-01')).toBeNull()
      expect(await beta.findById!('X')).toMatchObject({ space: 'alpha' })
    })

    it('refuses a reference writer that raced a settlement, and canonicalizes a retired id', async () => {
      await alpha.claimMany([record({ id: 'X', filePath: 'owned.md', materialized: true })])

      // A route's pre-resolve is an auth check, not a consistency proof: this
      // writer believes X is Beta's, and the registry says otherwise.
      await expect(
        betaDb.favorites.add({
          owner: 'user:beta',
          space: 'beta',
          kind: 'note',
          entityId: 'X',
          createdAt: AT,
          rank: null,
        }),
      ).rejects.toThrow(/changed identity/)

      // A retired id whose path has exactly one live owner canonicalizes onto it
      // instead of persisting a membership nobody can resolve.
      await alpha.settleFileClaim({
        space: 'alpha',
        filePath: 'owned.md',
        current: record({ id: 'X', filePath: 'owned.md', materialized: true }),
        observedId: 'Y',
        at: AT,
      })
      await alphaDb.favorites.add({
        owner: 'user:alpha',
        space: 'alpha',
        kind: 'note',
        entityId: 'X',
        createdAt: AT,
        rank: null,
      })
      expect(await alphaDb.favorites.ids('user:alpha', 'alpha', 'note')).toEqual(['Y'])
    })

    it('refuses a stale reorder whose membership a settlement carried onto a new id', async () => {
      // The other half of the same judgement. `accepted` re-keys the pin onto the
      // id that won and tombstones the old one, leaving a live note at that path —
      // and an order entry still naming the old id is a client ranking a list it
      // read before the move. Ranking it anyway silently drops the pin.
      await alpha.claimMany([record({ id: 'X', filePath: 'owned.md', materialized: true })])
      await alphaDb.scopePins.addPin({
        targetKind: 'project',
        targetId: 'scope-1',
        targetSpace: 'alpha',
        noteSpace: 'alpha',
        noteId: 'X',
        createdAt: AT,
      })
      await alpha.settleFileClaim({
        space: 'alpha',
        filePath: 'owned.md',
        current: record({ id: 'X', filePath: 'owned.md', materialized: true }),
        observedId: 'Y',
        at: AT,
      })

      // The membership followed the id; the client's entry did not.
      expect(
        (await alphaDb.scopePins.pinsForTarget('project', 'scope-1')).map((p) => p.noteId),
      ).toEqual(['Y'])
      await expect(
        alphaDb.contextOrder.setOrder('project', 'scope-1', 'alpha', [
          { entryKind: 'pin', entryRef: 'X' },
        ]),
      ).rejects.toThrow(/changed identity/)
    })

    it('still reorders a scope whose pin points at a DELETED note', async () => {
      // A tombstone with nothing standing at its path is an ordinary deleted note,
      // not a settlement's re-key. Reading it as one made every reorder of the
      // scope a `reference_identity_conflict` — and that conflict tells the caller
      // to retry something that can never succeed, because the note does not come
      // back to its path on its own and nothing prunes the pin.
      await alpha.claimMany([record({ id: 'pinned', filePath: 'pinned.md', materialized: true })])
      await alphaDb.scopePins.addPin({
        targetKind: 'project',
        targetId: 'scope-1',
        targetSpace: 'alpha',
        noteSpace: 'alpha',
        noteId: 'pinned',
        createdAt: AT,
      })
      await alphaDb.contextOrder.setOrder('project', 'scope-1', 'alpha', [
        { entryKind: 'pin', entryRef: 'pinned' },
      ])

      // The note is deleted through us: the row is tombstoned, the pin is not
      // pruned, and no successor takes the path.
      await alpha.claimMany([
        record({
          id: 'pinned',
          filePath: 'pinned.md',
          materialized: true,
          deletedAt: AT,
        }),
      ])

      await expect(
        alphaDb.contextOrder.setOrder('project', 'scope-1', 'alpha', [
          { entryKind: 'pin', entryRef: 'pinned' },
        ]),
      ).resolves.toBeUndefined()
      expect(
        (await alphaDb.contextOrder.orderForTarget('project', 'scope-1')).map((e) => e.entryRef),
      ).toEqual(['pinned'])

      // The same entry with its membership gone is stale, not a conflict either.
      await alphaDb.scopePins.removePin('project', 'scope-1', 'pinned')
      await expect(
        alphaDb.contextOrder.setOrder('project', 'scope-1', 'alpha', [
          { entryKind: 'pin', entryRef: 'pinned' },
        ]),
      ).resolves.toBeUndefined()
    })

    const at = (minute: number): string => `2026-06-12T10:0${minute}:00.000Z`
    const revision = (over: Partial<RevisionInput>): RevisionInput => ({
      noteId: 'X',
      space: 'alpha',
      baseRevisionId: null,
      theirRevisionId: null,
      sourceRevisionId: null,
      kind: 'write',
      entryRole: 'origin',
      principal: 'user:someone',
      // Written through an agent session, because the session audit reads the
      // SAME rows through `agent_owner` — with no attribution these rows would
      // be invisible to it and its half of the gap contract untestable.
      agent: {
        owner: 'someone',
        agent: 'claude',
        session: { id: 'sess-1', name: 'Morning', attach: 'declared' },
      },
      contentHash: null,
      title: 'Shared',
      class: 'user-doc',
      slug: null,
      tags: [],
      createdAt: at(0),
      charsAdded: null,
      charsRemoved: null,
      ...over,
    })

    /** The exact alternating history a take-over produced — Alpha wrote X, Beta then
     *  owned X and chained onto Alpha's row, then Alpha owned it again — settled into a
     *  real quarantine.
     *
     *  Sanitizing the row mapper is not the contract; the QUERIES are. Each test below
     *  reads a different predicate over this one fixture — visibility, classification,
     *  counting, the high-water cursor — and each could read a raw column and still look
     *  right in review. They are separate tests so a first failure cannot hide the rest.
     *  canon: docs/note-history.md#model */
    const seedCrossSpaceGap = async ({ betaTombstone = false } = {}) => {
      const alphaClean = await alphaDb.revisions.append(revision({ createdAt: at(0) }), null)
      const betaCrossed = await betaDb.revisions.append(
        revision({ space: 'beta', baseRevisionId: alphaClean.id, createdAt: at(1) }),
        null,
      )
      const alphaLate = await alphaDb.revisions.append(
        revision({ baseRevisionId: betaCrossed.id, createdAt: at(2) }),
        null,
      )
      // Beta deleting its copy BEFORE the settlement is what makes the note's newest
      // row both a tombstone and a gap — the state the trash and the delta high-water
      // mark can only be told apart on.
      const betaTombstoned = betaTombstone
        ? await betaDb.revisions.append(
            revision({
              space: 'beta',
              kind: 'delete',
              baseRevisionId: betaCrossed.id,
              createdAt: at(3),
            }),
            null,
          )
        : null

      await alpha.claimMany([record({ id: 'X', filePath: 'owned.md', materialized: true })])
      await beta.settleFileClaim({
        space: 'beta',
        filePath: 'copy.md',
        current: record({ id: 'beta-auto-01', space: 'beta', filePath: 'copy.md' }),
        observedId: 'X',
        at: AT,
      })

      return { alphaClean, betaCrossed, alphaLate, betaTombstoned }
    }

    it('quarantines the contaminated chain in EVERY space and keeps the clean prefix trusted', async () => {
      const { alphaClean, betaCrossed, alphaLate } = await seedCrossSpaceGap()

      // Beta's own row followed its id AND became a gap: it was chained onto
      // another space's state, so nothing about it can be attributed.
      const betaHistory = await betaDb.revisions.listByNote('beta', 'beta-auto-01', {
        offset: 0,
        limit: 10,
      })

      expect(betaHistory.items).toEqual([
        expect.objectContaining({
          id: betaCrossed.id,
          noteId: 'beta-auto-01',
          unavailableReason: 'identity-conflict',
          principal: null,
          contentHash: null,
          class: null,
          baseRevisionId: null,
          tags: [],
        }),
      ])

      const alphaHistory = await alphaDb.revisions.listByNote('alpha', 'X', {
        offset: 0,
        limit: 10,
      })
      const byId = new Map(alphaHistory.items.map((item) => [item.id, item]))

      // The clean prefix is untouched and is still the operational latest…
      expect(byId.get(alphaClean.id)).toMatchObject({
        principal: 'user:someone',
        title: 'Shared',
      })
      expect(byId.get(alphaClean.id)).not.toHaveProperty('unavailableReason')
      // …while the row DOWNSTREAM of the contamination is a gap, in the owner's
      // own space, and was NOT re-keyed — its id still means what it always did.
      expect(byId.get(alphaLate.id)).toMatchObject({
        noteId: 'X',
        unavailableReason: 'identity-conflict',
      })
      expect(await alphaDb.revisions.latestFor('alpha', 'X')).toMatchObject({ id: alphaClean.id })
      // A gap is history all the same: the write path must not invent a baseline over it.
      expect(await betaDb.revisions.hasAnyFor('beta', 'beta-auto-01')).toBe(true)
      expect(await betaDb.revisions.latestFor('beta', 'beta-auto-01')).toBeNull()
    })

    it('carries the gap through the delta, collapse, total and high-water mark', async () => {
      const { betaTombstoned } = await seedCrossSpaceGap({ betaTombstone: true })
      // The gap travels like any other entry, the class filter does not consult the
      // raw class it is withholding, and the per-note collapse keeps the newest row —
      // which here is itself a gap.
      const delta = await betaDb.revisions.listBySpaceSince('beta', null, 10, ['user-doc'])

      expect(delta.items).toEqual([
        expect.objectContaining({
          id: betaTombstoned?.id,
          unavailableReason: 'identity-conflict',
        }),
      ])
      expect(delta.total).toBe(1)
      // The high-water mark is taken over the whole post-filter set INCLUDING gaps, or
      // an acknowledge would step over one and never replay it. It cannot be put OFF the
      // page to prove that: the window is id-DESC, so the maximum is always its first
      // item — what is falsifiable, and what this pins, is that a gap can BE the maximum.
      expect(delta.maxRevId).toBe(betaTombstoned?.id)
    })

    it('gives the gap its own Activity bucket and lets no author scope claim it', async () => {
      const { betaCrossed } = await seedCrossSpaceGap()
      // Its own bucket, never guessed into created/edited/deleted, and the
      // synthetic-baseline suppression cannot reach it (it has no readable parent).
      const days = await betaDb.revisions.activityByDay('beta', {
        from: at(0),
        to: at(9),
        tzOffsetMinutes: 0,
        excludeClasses: [],
      })

      expect(days.find((d) => d.unavailable > 0)).toMatchObject({
        unavailable: 1,
        created: 0,
        edited: 0,
        deleted: 0,
      })
      // Class exclusion outside the delta too: the gap's RAW class is `user-doc`, and
      // the surface that filters on it must read the effective one — null — instead.
      const events = await betaDb.revisions.activityEvents('beta', {
        from: at(0),
        to: at(9),
        excludeClasses: ['user-doc'],
        offset: 0,
        limit: 10,
      })

      expect(events.items.map((e) => e.id)).toContain(betaCrossed.id)
      expect(events.items.find((e) => e.id === betaCrossed.id)).toMatchObject({
        unavailableReason: 'identity-conflict',
        principal: null,
      })
      expect(
        (
          await betaDb.revisions.activityByNote('beta', {
            from: at(0),
            to: at(9),
            excludeClasses: [],
          })
        ).find((n) => n.noteId === 'beta-auto-01'),
      ).toMatchObject({ count: 1 })

      // A gap belongs to nobody: an author scope cannot claim it by reading the
      // principal the gap withholds.
      const mine = await betaDb.revisions.activityByDay('beta', {
        from: at(0),
        to: at(9),
        tzOffsetMinutes: 0,
        excludeClasses: [],
        author: { exact: ['user:someone'], prefixes: [] },
      })

      expect(mine.reduce((sum, d) => sum + d.unavailable, 0)).toBe(0)
    })

    it('shapes the gap in the session audit without shifting the session count', async () => {
      const { alphaClean, betaCrossed } = await seedCrossSpaceGap()
      // The session audit is the one surface that reaches these rows by AGENT
      // rather than by space, and it shapes them itself instead of going through
      // the revision mapper — so it needs its own proof that a gap stays a gap.
      const audit = await betaDb.sessionAudit.events({
        owner: 'someone',
        sessionId: 'sess-1',
        type: 'write',
        limit: 10,
      })
      const audited = audit.items.map((e) => (e.type === 'write' ? e : null)).filter((e) => e)

      // The write still happened in this session: it is not dropped, and the
      // count that the session page shows does not shift.
      expect(audit.total).toBe(3)
      expect(audited.find((e) => e?.id === betaCrossed.id)).toMatchObject({
        unavailableReason: 'identity-conflict',
        title: 'Unavailable revision',
        principal: null,
        agent: null,
        class: null,
        noteId: 'beta-auto-01',
        revisionKind: 'write',
      })
      // …while a trusted write in the same session is untouched.
      expect(audited.find((e) => e?.id === alphaClean.id)).toMatchObject({
        title: 'Shared',
        principal: 'user:someone',
        agent: 'claude',
        class: 'user-doc',
      })
    })

    it('never derives operational state from a gap, and purges it with the note', async () => {
      // With the delete quarantined too, the note's newest row IS a tombstone: only the
      // integrity filter keeps it out of the trash, and a trash row would carry a title
      // and a restore source read straight out of another space's bytes.
      await seedCrossSpaceGap({ betaTombstone: true })
      // No alias, no timestamp, no tombstone.
      expect((await betaDb.revisions.historicalNames('beta')).has('beta-auto-01')).toBe(false)
      expect((await betaDb.revisions.latestTimestamps('beta')).has('beta-auto-01')).toBe(false)
      expect(
        (await betaDb.revisions.listTrashed('beta', { offset: 0, limit: 10 })).items.map(
          (t) => t.noteId,
        ),
      ).not.toContain('beta-auto-01')
      expect(await betaDb.revisions.listTrashed('beta', { offset: 0, limit: 10 })).toMatchObject({
        total: 0,
        restorableTotal: 0,
      })

      // And a purge takes the gap with it — both integrity states, in this space.
      await betaDb.revisions.purgeNotes('beta', ['beta-auto-01'])
      expect(await betaDb.revisions.hasAnyFor('beta', 'beta-auto-01')).toBe(false)
      expect(
        await alphaDb.revisions.listByNote('alpha', 'X', { offset: 0, limit: 10 }),
      ).toMatchObject({ total: 2 })
    })

    it('keeps the first edit after a repair in Activity, gap-only past and all', async () => {
      await seedCrossSpaceGap()
      // The repair leaves the note with a past nobody can read, so the very next
      // external edit finds no trusted parent to chain to — exactly the shape the
      // Activity surfaces used to READ as a synthetic baseline and suppress. It is
      // not one, and now nothing has to guess: the writer asked `hasAnyFor` (trusted
      // AND quarantined), found a past, and stamped `change` (#327).
      const afterRepair = await betaDb.revisions.append(
        revision({
          space: 'beta',
          noteId: 'beta-auto-01',
          kind: 'external',
          entryRole: 'change',
          baseRevisionId: null,
          createdAt: at(4),
        }),
        null,
      )
      const events = await betaDb.revisions.activityEvents('beta', {
        from: at(0),
        to: at(9),
        excludeClasses: [],
        offset: 0,
        limit: 10,
      })

      expect(events.items.map((e) => e.id)).toContain(afterRepair.id)
      expect(
        (
          await betaDb.revisions.activityByNote('beta', {
            from: at(0),
            to: at(9),
            excludeClasses: [],
          })
        ).find((n) => n.noteId === 'beta-auto-01'),
      ).toMatchObject({ count: 2, lastAt: at(4) })

      // …while the genuine first sighting of a note with NO past stays suppressed —
      // the same two rows, told apart by what the writer knew rather than by a shape
      // they share.
      await betaDb.revisions.append(
        revision({
          space: 'beta',
          noteId: 'beta-fresh',
          kind: 'external',
          entryRole: 'baseline',
          baseRevisionId: null,
          createdAt: at(5),
        }),
        null,
      )
      expect(
        (
          await betaDb.revisions.activityByNote('beta', {
            from: at(0),
            to: at(9),
            excludeClasses: [],
          })
        ).find((n) => n.noteId === 'beta-fresh'),
      ).toBeUndefined()
    })

    it('leaves ONE origin behind when a re-key merges two chains into one note', async () => {
      // The legacy population this task exists for: beta journaled under the foreign
      // id AND under its own, so the re-key lands two chains on one note — each with
      // its own first row. A note is born once, so the later origin has to become a
      // change; measured before the rule existed, the dashboard reported `created: 2`
      // for that single note, and the predicate it replaced (`base_rev IS NULL`) had
      // exactly the same effect (#327).
      // X belongs to ALPHA — that is what makes beta's settlement a foreign-owner
      // one, and a foreign-owner settlement is what re-keys beta's legacy chain.
      await alpha.claimMany([record({ id: 'X', filePath: 'owned.md', materialized: true })])
      await beta.claimMany([record({ id: 'beta-own-01', space: 'beta', filePath: 'merged.md' })])
      await betaDb.revisions.append(
        revision({ noteId: 'beta-own-01', space: 'beta', entryRole: 'origin', createdAt: at(1) }),
        null,
      )
      await betaDb.revisions.append(
        revision({ noteId: 'X', space: 'beta', entryRole: 'origin', createdAt: at(2) }),
        null,
      )
      await beta.settleFileClaim({
        space: 'beta',
        filePath: 'merged.md',
        current: record({ id: 'beta-own-01', space: 'beta', filePath: 'merged.md' }),
        observedId: 'X',
        at: AT,
      })
      const merged = await betaDb.revisions.listByNote('beta', 'beta-own-01', {
        offset: 0,
        limit: 10,
      })

      expect(merged.items.filter((row) => row.entryRole === 'origin')).toHaveLength(1)
      // The EARLIEST one keeps it — the note's real first state, not whichever chain
      // arrived last.
      expect(merged.items.at(-1)).toMatchObject({ entryRole: 'origin' })
      const days = await betaDb.revisions.activityByDay('beta', {
        from: at(0),
        to: at(9),
        tzOffsetMinutes: 0,
        excludeClasses: [],
      })

      expect(days.reduce((sum, day) => sum + day.created, 0)).toBe(1)
    })

    it('keeps each space’s registry load free of the other’s rows', async () => {
      await alpha.claimMany([record({ id: 'alpha-1', filePath: 'same.md' })])
      await beta.claimMany([record({ id: 'beta-1', space: 'beta', filePath: 'same.md' })])

      expect((await alpha.loadAll('alpha')).map((r) => r.id)).toEqual(['alpha-1'])
      expect((await beta.loadAll('beta')).map((r) => r.id)).toEqual(['beta-1'])
    })
  })
}
