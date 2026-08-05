// In-memory GatewayStatePersistence for the e2e fake (#21 stage 9): a plain Map
// behind the same write-retry dedup interface the SQLite/PG facets implement.

import type { DedupResult, GatewayStatePersistence } from '@notarium/server'

type DedupRow = { result: DedupResult; createdAt: string }

export class InMemoryGatewayState implements GatewayStatePersistence {
  private dedup = new Map<string, DedupRow>() // `${scope}\0${key}` → row

  clear(): void {
    this.dedup.clear()
  }

  async dedupGet(scope: string, key: string, sinceIso: string): Promise<DedupResult | null> {
    const row = this.dedup.get(`${scope}\0${key}`)

    if (!row || !(row.createdAt > sinceIso)) {
      return null
    }

    return { ...row.result }
  }
  async dedupPut(
    scope: string,
    key: string,
    result: DedupResult,
    createdAt: string,
  ): Promise<void> {
    this.dedup.set(`${scope}\0${key}`, { result: { ...result }, createdAt })
  }
  async dedupPrune(beforeIso: string): Promise<void> {
    for (const [k, row] of this.dedup) {
      if (row.createdAt < beforeIso) {
        this.dedup.delete(k)
      }
    }
  }
}
