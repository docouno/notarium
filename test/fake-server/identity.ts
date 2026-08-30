// In-memory IdentityPersistence twin. It implements the SAME global arbitration
// the SQLite and PostgreSQL drivers do (#327) — a test double that merely stored
// rows would let a claim through that a real driver refuses, and every identity
// test above it would then be proving the wrong model.
//
// ARBITRATION is all it implements. The side effects a real settlement performs in
// the same transaction — re-keying this space's references, quarantining the chains
// the collision contaminated, demoting the second `origin` a merge produces — need a
// journal and facet tables this double does not have. So the fake stand shows the
// SETTLED world, never the repair; anything asserting the repair belongs in the
// meta-DB contract, against a real driver. canon: docs/seeds.md

import type {
  IdentityClaimOutcome,
  IdentityFileClaim,
  IdentityFileSettlement,
  IdentityPersistence,
  IdentityRecord,
} from '@notarium/core'
import {
  appendLegacyNameAlias,
  canonicalLegacyNameAliases,
  unionLegacyNameAliases,
} from '@notarium/core'

const copyRecord = (record: IdentityRecord): IdentityRecord => ({
  ...record,
  legacyNameAliases: canonicalLegacyNameAliases(record.legacyNameAliases),
})

const projectedRecord = (
  record: IdentityRecord,
  successors: ReadonlyMap<string, string>,
): IdentityRecord => {
  const projected = copyRecord(record)
  const successorId = successors.get(record.id)

  delete projected.settlementSuccessorId
  return successorId ? { ...projected, settlementSuccessorId: successorId } : projected
}

export class InMemoryIdentity implements IdentityPersistence {
  /** The global table, keyed by id across every space. */
  readonly rows = new Map<string, IdentityRecord>()
  /** Exact lineage produced only by an accepted settlement. Ordinary delete/path reuse is not
   * ancestry, and resurrection clears an older outgoing edge. */
  readonly settlementSuccessors = new Map<string, string>()
  /** Every record handed to claimMany, in call order — the write-behind assertions. */
  readonly claimed: IdentityRecord[] = []
  /** Spaces loadAll was asked for, in call order. */
  readonly loadedFor: string[] = []

  constructor(seed: readonly IdentityRecord[] = []) {
    for (const rec of seed) {
      const stored = copyRecord(rec)

      delete stored.settlementSuccessorId
      this.rows.set(rec.id, stored)
      if (rec.settlementSuccessorId) {
        this.settlementSuccessors.set(rec.id, rec.settlementSuccessorId)
      }
    }
  }

  async init(): Promise<void> {}

  async loadAll(space: string): Promise<IdentityRecord[]> {
    this.loadedFor.push(space)
    return [...this.rows.values()]
      .filter((r) => r.space === space)
      .map((record) => projectedRecord(record, this.settlementSuccessors))
  }

  async findById(id: string): Promise<IdentityRecord | null> {
    const row = this.rows.get(id)
    return row ? projectedRecord(row, this.settlementSuccessors) : null
  }

  async findByIds(ids: readonly string[]): Promise<IdentityRecord[]> {
    return [...new Set(ids)].flatMap((id) => {
      const row = this.rows.get(id)

      return row ? [projectedRecord(row, this.settlementSuccessors)] : []
    })
  }

  async claimMany(records: readonly IdentityRecord[]): Promise<IdentityClaimOutcome[]> {
    const outcomes: IdentityClaimOutcome[] = []

    for (const rec of records) {
      const existing = this.rows.get(rec.id)

      this.claimed.push(copyRecord(rec))
      if (existing && existing.space !== rec.space) {
        outcomes.push({ id: rec.id, status: 'foreign-owner', owner: copyRecord(existing) })
        continue
      }
      const legacyNameAliases = unionLegacyNameAliases(
        existing?.legacyNameAliases ?? [],
        rec.legacyNameAliases,
      )
      this.rows.set(rec.id, copyRecord({ ...rec, legacyNameAliases }))
      if (!rec.deletedAt) {
        this.settlementSuccessors.delete(rec.id)
      }
      outcomes.push({ id: rec.id, status: 'claimed', legacyNameAliases: [...legacyNameAliases] })
    }

    return outcomes
  }

  async mergeLegacyNameAlias({ id, space, alias }: { id: string; space: string; alias: string }) {
    const first = this.rows.get(id)

    if (!first || first.space !== space) {
      return { status: 'not-owned' } as const
    }
    const seen = new Set<string>()
    let target = first

    for (;;) {
      if (seen.has(target.id)) {
        throw new Error(`identity settlement successor cycle for ${id}`)
      }
      seen.add(target.id)
      const successorId = this.settlementSuccessors.get(target.id)

      if (!successorId) {
        break
      }
      const successor = this.rows.get(successorId)

      if (!successor || successor.space !== space) {
        throw new Error(`identity settlement successor disappeared for ${target.id}`)
      }
      target = successor
    }

    target.legacyNameAliases = appendLegacyNameAlias(target.legacyNameAliases, alias)
    return {
      status: 'merged',
      id: target.id,
      legacyNameAliases: [...target.legacyNameAliases],
    } as const
  }

  async settleFileClaim({
    space,
    filePath,
    current,
    observedId,
    at,
  }: IdentityFileClaim): Promise<IdentityFileSettlement> {
    const owner = this.rows.get(observedId)

    if (owner && owner.space !== space) {
      const durableCurrent = this.rows.get(current.id)
      const record: IdentityRecord = copyRecord({
        ...current,
        legacyNameAliases: unionLegacyNameAliases(
          durableCurrent?.legacyNameAliases ?? [],
          current.legacyNameAliases,
        ),
        space,
        filePath,
        deletedAt: null,
      })

      this.rows.set(record.id, copyRecord(record))
      this.settlementSuccessors.delete(record.id)
      return { status: 'foreign-owner', owner: copyRecord(owner), record: copyRecord(record) }
    }
    if (current.id !== observedId && owner && !owner.deletedAt && owner.filePath !== filePath) {
      return {
        status: 'duplicate-path-owner',
        owner: copyRecord(owner),
        record: copyRecord(current),
      }
    }
    const durableCurrent = this.rows.get(current.id)
    const record: IdentityRecord = {
      id: observedId,
      legacyNameAliases: unionLegacyNameAliases(
        owner?.legacyNameAliases ?? [],
        durableCurrent?.legacyNameAliases ?? [],
        current.legacyNameAliases,
      ),
      filePath,
      space,
      createdAt: owner?.createdAt ?? current.createdAt ?? at,
      materialized: true,
      deletedAt: null,
    }

    this.settlementSuccessors.delete(record.id)
    this.rows.set(record.id, copyRecord(record))
    if (current.id === observedId) {
      return { status: 'accepted', record }
    }
    this.rows.set(
      current.id,
      copyRecord({
        ...current,
        legacyNameAliases: unionLegacyNameAliases(
          durableCurrent?.legacyNameAliases ?? [],
          current.legacyNameAliases,
        ),
        space,
        deletedAt: at,
      }),
    )
    this.settlementSuccessors.set(current.id, record.id)

    return { status: 'accepted', record: copyRecord(record), retiredId: current.id }
  }

  async close(): Promise<void> {}
}
