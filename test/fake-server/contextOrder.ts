import type {
  ContextOrderEntryKind,
  ContextOrderPersistence,
  ContextOrderRecord,
  ContextSetTargetKind,
} from '@notarium/server'

/** In-memory twin of the context-order facet (#210) for the fake server — mirrors the
 *  sqlite/pg drivers: a rank overlay keyed by (scope, entryKind, entryRef); a reorder
 *  REPLACES the scope's whole order with dense ranks (0-based). */
export class InMemoryContextOrder implements ContextOrderPersistence {
  private rows: ContextOrderRecord[] = []

  clear(): void {
    this.rows = []
  }

  async orderForTarget(
    targetKind: ContextSetTargetKind,
    targetId: string,
  ): Promise<ContextOrderRecord[]> {
    return this.rows
      .filter((r) => r.targetKind === targetKind && r.targetId === targetId)
      .sort((a, b) => a.rank - b.rank)
      .map((r) => ({ ...r }))
  }

  async setOrder(
    targetKind: ContextSetTargetKind,
    targetId: string,
    targetSpace: string,
    entries: ReadonlyArray<{ entryKind: ContextOrderEntryKind; entryRef: string }>,
  ): Promise<void> {
    this.rows = this.rows.filter((r) => !(r.targetKind === targetKind && r.targetId === targetId))
    // Dedup by (entryKind, entryRef) — the real drivers share that PK, so a duplicate would be
    // a 500 there; drop it here too for parity.
    const seen = new Set<string>()
    let rank = 0

    for (const e of entries) {
      const key = `${e.entryKind}:${e.entryRef}`

      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      this.rows.push({
        targetKind,
        targetId,
        targetSpace,
        entryKind: e.entryKind,
        entryRef: e.entryRef,
        rank: rank++,
      })
    }
  }
}
