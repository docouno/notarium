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

export class InMemoryIdentity implements IdentityPersistence {
  /** The global table, keyed by id across every space. */
  readonly rows = new Map<string, IdentityRecord>()
  /** Every record handed to claimMany, in call order — the write-behind assertions. */
  readonly claimed: IdentityRecord[] = []
  /** Spaces loadAll was asked for, in call order. */
  readonly loadedFor: string[] = []

  constructor(seed: readonly IdentityRecord[] = []) {
    for (const rec of seed) {
      this.rows.set(rec.id, { ...rec })
    }
  }

  async init(): Promise<void> {}

  async loadAll(space: string): Promise<IdentityRecord[]> {
    this.loadedFor.push(space)
    return [...this.rows.values()].filter((r) => r.space === space).map((r) => ({ ...r }))
  }

  async findById(id: string): Promise<IdentityRecord | null> {
    const row = this.rows.get(id)
    return row ? { ...row } : null
  }

  async claimMany(records: readonly IdentityRecord[]): Promise<IdentityClaimOutcome[]> {
    const outcomes: IdentityClaimOutcome[] = []

    for (const rec of records) {
      const existing = this.rows.get(rec.id)

      this.claimed.push({ ...rec })
      if (existing && existing.space !== rec.space) {
        outcomes.push({ id: rec.id, status: 'foreign-owner', owner: { ...existing } })
        continue
      }
      this.rows.set(rec.id, { ...rec })
      outcomes.push({ id: rec.id, status: 'claimed' })
    }

    return outcomes
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
      const record: IdentityRecord = { ...current, space, filePath, deletedAt: null }

      this.rows.set(record.id, { ...record })
      return { status: 'foreign-owner', owner: { ...owner }, record }
    }
    if (current.id !== observedId && owner && !owner.deletedAt && owner.filePath !== filePath) {
      return { status: 'duplicate-path-owner', owner: { ...owner }, record: { ...current } }
    }
    const record: IdentityRecord = {
      id: observedId,
      filePath,
      space,
      createdAt: owner?.createdAt ?? current.createdAt ?? at,
      materialized: true,
      deletedAt: null,
    }

    this.rows.set(record.id, { ...record })
    if (current.id === observedId) {
      return { status: 'accepted', record }
    }
    this.rows.set(current.id, { ...current, space, deletedAt: at })

    return { status: 'accepted', record, retiredId: current.id }
  }

  async close(): Promise<void> {}
}
