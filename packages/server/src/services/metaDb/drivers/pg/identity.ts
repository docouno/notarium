import type { PoolClient } from 'pg'
import {
  appendLegacyNameAlias,
  canonicalLegacyNameAliases,
  CAUSAL_BARRIER_KIND,
  type CausalBarrierKey,
  type IdentityClaimOutcome,
  type IdentityFileClaim,
  type IdentityFileSettlement,
  type IdentityPersistence,
  type IdentityRecord,
  unionLegacyNameAliases,
} from '@notarium/core'

import { lockCausalBarriers } from './causalBarriers'
import type { PgDriverCtx } from './context'
import { rekeyReferences } from './identityRefs'
import { IDENTITY_COLUMNS, type IdentityRow, lockIdentityRows, readIdentityRows } from './lockOrder'
import { rekeyAndQuarantineRevisions } from './revisionQuarantine'

const recordOfRow = (r: IdentityRow): IdentityRecord => ({
  id: r.id,
  legacyNameAliases: canonicalLegacyNameAliases(parseJson(r.legacy_name_aliases)),
  filePath: r.file_path,
  space: r.space,
  createdAt: r.created_at,
  materialized: r.materialized,
  deletedAt: r.deleted_at,
  addressRevision: Number(r.address_revision),
})

const parseJson = (raw: string | null): unknown => {
  try {
    return raw == null ? [] : JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** Upsert one row WITHOUT ever changing its space — the SQLite twin's guard,
 *  and the reason a sibling space can no longer take over an existing id (#327). */
const UPSERT_SQL = `INSERT INTO note_identity
       (id, file_path, space, created_at, materialized, deleted_at, legacy_name_aliases)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       address_revision = note_identity.address_revision + CASE
         WHEN note_identity.file_path IS DISTINCT FROM EXCLUDED.file_path
           OR note_identity.deleted_at IS DISTINCT FROM EXCLUDED.deleted_at
         THEN 1 ELSE 0 END,
       file_path = EXCLUDED.file_path,
       created_at = EXCLUDED.created_at,
       materialized = EXCLUDED.materialized,
       deleted_at = EXCLUDED.deleted_at,
       settlement_successor_id = CASE
         WHEN EXCLUDED.deleted_at IS NULL THEN NULL
         ELSE note_identity.settlement_successor_id
       END
     WHERE note_identity.space = EXCLUDED.space`

/** Whether the row actually landed. `FOR UPDATE` locks rows that EXIST; a row
 *  inserted by another space between the lock and this upsert makes the guard fire
 *  and the statement affect nothing. Reporting `claimed` for it would put an id this
 *  space does not own into the registry's maps and skip the remint. */
const upsert = async (client: PoolClient, record: IdentityRecord): Promise<boolean> => {
  const res = await client.query(UPSERT_SQL, [
    record.id,
    record.filePath,
    record.space,
    record.createdAt,
    record.materialized,
    record.deletedAt,
    JSON.stringify(canonicalLegacyNameAliases(record.legacyNameAliases)),
  ])

  return (res.rowCount ?? 0) > 0
}

/** The guard fired: this transaction's premise about who owns the id no longer
 *  holds, so it rolls back instead of reporting a claim it did not get. */
const ownershipLost = (reason: string): Error =>
  Object.assign(new Error(reason), { name: 'IdentityOwnershipLostError' })

/** Discover the complete lineage before the single L1 lock entry. Every edge is
 * revalidated under that lock; this pass only widens the set deterministically. */
const probeSettlementLineage = async (client: PoolClient, id: string): Promise<string[]> => {
  const ids: string[] = []
  const seen = new Set<string>()
  let currentId: string | null = id

  while (currentId) {
    if (seen.has(currentId)) {
      break
    }
    seen.add(currentId)
    ids.push(currentId)
    const [row] = await readIdentityRows(client, [currentId])

    currentId = row?.settlement_successor_id ?? null
  }

  return ids
}

/** The same write where a fired guard is not an outcome but a broken premise.
 *  A settlement decides AFTER locking the ids it will touch, so a sibling space
 *  owning one of them by the time we write means the decision rests on state that
 *  no longer holds. Roll back rather than report a settlement this space did not get.
 *
 *  What clears it is NOT the next read — that one re-runs the same settlement and
 *  rolls back identically. The claimant's row is still dirty, so the write-behind's
 *  next batch is what learns the id is foreign and re-mints the claimant onto a free
 *  one; the read that follows then settles against a premise that holds. */
const upsertOwned = async (client: PoolClient, record: IdentityRecord): Promise<void> => {
  if (!(await upsert(client, record))) {
    throw ownershipLost(`note identity ${record.id} is owned by another space`)
  }
}

const mergeAliases = async (
  client: PoolClient,
  id: string,
  incoming: readonly string[],
): Promise<readonly string[]> => {
  const [row] = await readIdentityRows(client, [id])
  const aliases = unionLegacyNameAliases(
    canonicalLegacyNameAliases(parseJson(row?.legacy_name_aliases ?? null)),
    incoming,
  )
  await client.query('UPDATE note_identity SET legacy_name_aliases = $2 WHERE id = $1', [
    id,
    JSON.stringify(aliases),
  ])
  return aliases
}

export const createIdentityFacet = (ctx: PgDriverCtx): IdentityPersistence => ({
  init: () => ctx.ensureInit(),
  loadAll: async (space: string) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      `SELECT ${IDENTITY_COLUMNS} FROM note_identity WHERE space = $1`,
      [space],
    )
    return (res.rows as IdentityRow[]).map(recordOfRow)
  },
  findById: async (id: string) => {
    await ctx.ensureInit()
    const [row] = await readIdentityRows(ctx.required, [id])

    return row ? recordOfRow(row) : null
  },
  claimMany: async (records: readonly IdentityRecord[]) => {
    if (!records.length) {
      return []
    }
    await ctx.ensureInit()
    const client = await ctx.required.connect()
    const outcomes: IdentityClaimOutcome[] = []

    try {
      await client.query('BEGIN')
      // Lock the ids this batch touches in one deterministic pass, so two spaces
      // flushing overlapping batches order rather than deadlock.
      const { rows: locked } = await lockIdentityRows(
        client,
        records.map((r) => r.id),
      )
      await lockCausalBarriers(
        client,
        records.flatMap((record) => [
          {
            kind: CAUSAL_BARRIER_KIND.spaceLifecycle,
            space: record.space,
            key: record.space,
          },
          { kind: CAUSAL_BARRIER_KIND.address, space: record.space, key: record.id },
          { kind: CAUSAL_BARRIER_KIND.address, space: record.space, key: record.filePath },
        ]),
        (kind) => (kind === CAUSAL_BARRIER_KIND.spaceLifecycle ? 'shared' : 'exclusive'),
      )
      const byId = new Map(locked.map((row) => [row.id, row]))
      const outcomeById = new Map<string, IdentityClaimOutcome>()
      // BY ID, not in arrival order: the rows a batch CREATES are new keys, and two
      // batches inserting the same pair of absent ids in opposite orders deadlock on
      // the unique index — the one order the lock above cannot give them, because a
      // key with no row cannot be locked. See `lockOrder`.
      // The SAME order the lock set uses (`[...ids].sort()`, UTF-16 code units) —
      // `localeCompare` would answer a different one for the same pair, and the two
      // orders have to agree or the sorted creation is sorted by nothing.
      const ordered = [...records].sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      )

      for (const r of ordered) {
        const existing = byId.get(r.id)

        if (existing && existing.space !== r.space) {
          outcomeById.set(r.id, { id: r.id, status: 'foreign-owner', owner: recordOfRow(existing) })
          continue
        }
        if (await upsert(client, r)) {
          const legacyNameAliases = await mergeAliases(client, r.id, r.legacyNameAliases)
          outcomeById.set(r.id, { id: r.id, status: 'claimed', legacyNameAliases })
          continue
        }
        const [owner] = await readIdentityRows(client, [r.id])

        if (!owner) {
          // Refused by the guard, yet no row to point at: the id is neither ours
          // nor anyone's. Reporting `claimed` here is precisely the silence this
          // guard exists to break — the batch stays dirty and is retried.
          throw ownershipLost(`note identity ${r.id} was refused by a vanished owner`)
        }
        outcomeById.set(r.id, { id: r.id, status: 'foreign-owner', owner: recordOfRow(owner) })
      }
      await client.query('COMMIT')
      // Back in the caller's order: the write-behind pairs outcomes with what it sent.
      // One write-behind flush — the dirty ids the drain lane snapshotted for this batch.
      // eslint-disable-next-line no-restricted-syntax
      outcomes.push(...records.map((r) => outcomeById.get(r.id) as IdentityClaimOutcome))
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    return outcomes
  },
  mergeLegacyNameAlias: async ({ id, space, alias }) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      const probedIds = await probeSettlementLineage(client, id)
      const { lock, rows } = await lockIdentityRows(client, probedIds)
      const row = rows.find(({ id: candidate }) => candidate === id)

      if (!row || row.space !== space) {
        await client.query('COMMIT')
        return { status: 'not-owned' } as const
      }
      const seen = new Set<string>()
      let target = row

      for (;;) {
        if (seen.has(target.id)) {
          throw new Error(`identity settlement successor cycle for ${id}`)
        }
        seen.add(target.id)
        const successorId = target.settlement_successor_id

        if (!successorId) {
          break
        }
        if (!target.deleted_at) {
          throw new Error(`live identity ${target.id} has a settlement successor`)
        }
        if (!lock.declared.includes(successorId)) {
          throw ownershipLost(`identity settlement lineage changed while merging ${id}`)
        }
        const successor = rows.find(({ id: candidate }) => candidate === successorId)

        if (!successor || successor.space !== space) {
          throw new Error(`identity settlement successor disappeared for ${target.id}`)
        }
        target = successor
      }
      const barriers: CausalBarrierKey[] = [
        { kind: CAUSAL_BARRIER_KIND.spaceLifecycle, space, key: space },
        ...[...seen].map((lineageId): CausalBarrierKey => ({
          kind: CAUSAL_BARRIER_KIND.address,
          space,
          key: lineageId,
        })),
      ]

      await lockCausalBarriers(client, barriers, (kind) =>
        kind === CAUSAL_BARRIER_KIND.spaceLifecycle ? 'shared' : 'exclusive',
      )
      const legacyNameAliases = appendLegacyNameAlias(
        canonicalLegacyNameAliases(parseJson(target.legacy_name_aliases)),
        alias,
      )
      await client.query('UPDATE note_identity SET legacy_name_aliases = $2 WHERE id = $1', [
        target.id,
        JSON.stringify(legacyNameAliases),
      ])
      await client.query('COMMIT')
      return { status: 'merged', id: target.id, legacyNameAliases } as const
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  },
  settleFileClaim: async ({ space, filePath, current, observedId, at }: IdentityFileClaim) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      // Deterministic global lock order over the identity rows this settlement
      // may touch, in ONE entry; the aggregate's reference/revision locks come after
      // them. Every write below stays inside this set.
      const { rows: held } = await lockIdentityRows(client, [current.id, observedId])
      await lockCausalBarriers(
        client,
        [
          {
            kind: CAUSAL_BARRIER_KIND.spaceLifecycle,
            space,
            key: space,
          },
          { kind: CAUSAL_BARRIER_KIND.address, space, key: current.id },
          { kind: CAUSAL_BARRIER_KIND.address, space, key: observedId },
          { kind: CAUSAL_BARRIER_KIND.address, space, key: current.filePath },
          { kind: CAUSAL_BARRIER_KIND.address, space, key: filePath },
        ],
        (kind) => (kind === CAUSAL_BARRIER_KIND.spaceLifecycle ? 'shared' : 'exclusive'),
      )
      const present = new Set(held.map((row) => row.id))

      // A lock cannot hold a key that has no row, so the two rows this settlement can
      // CREATE are created in sorted order instead — otherwise two settlements
      // creating the same pair from opposite sides deadlock on the unique index.
      // Only the claimant's own row can need hoisting, and only when it sorts first:
      // the branch that revives it (a foreign owner) and the one that retires it both
      // land on the same final state, and a refusal leaves a tombstone the next
      // write-behind flush makes live again.
      const currentHoisted =
        current.id !== observedId && !present.has(current.id) && current.id < observedId

      if (currentHoisted) {
        await client.query(
          `INSERT INTO note_identity
             (id, file_path, space, created_at, materialized, deleted_at, legacy_name_aliases)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (id) DO NOTHING`,
          [
            current.id,
            current.filePath,
            space,
            current.createdAt ?? at,
            current.materialized,
            at,
            JSON.stringify(canonicalLegacyNameAliases(current.legacyNameAliases)),
          ],
        )
      }
      const heldOwner = held.find((row) => row.id === observedId)
      const currentRetiredBeforeClaim =
        current.id !== observedId && !heldOwner && present.has(current.id)

      if (currentRetiredBeforeClaim) {
        // An absent observed id has to be claimed by INSERT, but its intended
        // address is still occupied by the claimant. Make the address cut before
        // that arbitration point; rollback restores it if another space wins the
        // id, while the foreign-owner branch below revives it on a committed loss.
        await upsertOwned(client, { ...current, space, deletedAt: at })
        await mergeAliases(client, current.id, current.legacyNameAliases)
      }
      // First committed claim wins an ABSENT id: the insert itself is the
      // arbitration point, and the loser blocks on the re-read below until the
      // winner commits, then sees the durable owner.
      const inserted = heldOwner
        ? undefined
        : await client.query(
            `INSERT INTO note_identity
               (id, file_path, space, created_at, materialized, deleted_at, legacy_name_aliases)
               VALUES ($1, $2, $3, $4, TRUE, NULL, $5)
               ON CONFLICT (id) DO NOTHING
             RETURNING ${IDENTITY_COLUMNS}`,
            [observedId, filePath, space, current.createdAt ?? at, '[]'],
          )
      // Existing rows were held at entry. For an absent id the INSERT is its
      // arbitration lock; a losing insert waits for the winner, then this read sees
      // the durable owner and guarded writes below refuse any stale premise.
      const ownerRow =
        heldOwner ??
        (inserted?.rows[0] as IdentityRow | undefined) ??
        (await readIdentityRows(client, [observedId]))[0]
      const settlement = await (async (): Promise<IdentityFileSettlement> => {
        if (ownerRow && ownerRow.space !== space) {
          const heldCurrent = held.find((row) => row.id === current.id)
          const record: IdentityRecord = {
            ...current,
            legacyNameAliases: unionLegacyNameAliases(
              heldCurrent
                ? canonicalLegacyNameAliases(parseJson(heldCurrent.legacy_name_aliases))
                : [],
              current.legacyNameAliases,
            ),
            space,
            filePath,
            deletedAt: null,
          }

          await upsertOwned(client, record)
          record.legacyNameAliases = await mergeAliases(client, record.id, record.legacyNameAliases)
          await rekeyReferences(client, { space, fromId: observedId, toId: record.id })
          await rekeyAndQuarantineRevisions(client, {
            space,
            fromId: observedId,
            toId: record.id,
          })
          return { status: 'foreign-owner', owner: recordOfRow(ownerRow), record }
        }
        // A user-copied file: this space's live note already holds the id at
        // another path while the claimant is a DIFFERENT identity. Owner,
        // claimant and every reference stay put. The claimant's own id arriving
        // at a new path is the opposite case — a genuine move — and falls
        // through to the accept below.
        if (
          current.id !== observedId &&
          ownerRow &&
          !ownerRow.deleted_at &&
          ownerRow.file_path !== filePath
        ) {
          return {
            status: 'duplicate-path-owner',
            owner: recordOfRow(ownerRow),
            record: {
              ...current,
              legacyNameAliases: canonicalLegacyNameAliases(current.legacyNameAliases),
            },
          }
        }
        const record: IdentityRecord = {
          id: observedId,
          legacyNameAliases: unionLegacyNameAliases(
            ownerRow ? canonicalLegacyNameAliases(parseJson(ownerRow.legacy_name_aliases)) : [],
            held.find((row) => row.id === current.id)
              ? canonicalLegacyNameAliases(
                  parseJson(held.find((row) => row.id === current.id)!.legacy_name_aliases),
                )
              : [],
            current.legacyNameAliases,
          ),
          filePath,
          space,
          createdAt: ownerRow?.created_at ?? current.createdAt ?? at,
          materialized: true,
          deletedAt: null,
        }

        if (current.id !== observedId && present.has(current.id) && !currentRetiredBeforeClaim) {
          // `idx_note_identity_live_space_path` makes the address cut explicit:
          // retire the held claimant before reviving the observed id at its path.
          // Both writes remain in this transaction, so readers see only either
          // complete side of the swap.
          await upsertOwned(client, { ...current, space, deletedAt: at })
          await mergeAliases(client, current.id, current.legacyNameAliases)
        }
        await upsertOwned(client, record)
        record.legacyNameAliases = await mergeAliases(client, record.id, record.legacyNameAliases)
        if (current.id === observedId) {
          return { status: 'accepted', record }
        }
        if (!present.has(current.id) && !currentHoisted) {
          await upsertOwned(client, { ...current, space, deletedAt: at })
          await mergeAliases(client, current.id, current.legacyNameAliases)
        }
        await client.query('UPDATE note_identity SET settlement_successor_id = $2 WHERE id = $1', [
          current.id,
          record.id,
        ])
        await rekeyReferences(client, { space, fromId: current.id, toId: record.id })
        await rekeyAndQuarantineRevisions(client, { space, fromId: current.id, toId: record.id })

        return { status: 'accepted', record, retiredId: current.id }
      })()

      await client.query('COMMIT')
      return settlement
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  },
  close: () => ctx.close(),
})
