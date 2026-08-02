// In-memory GatewayStatePersistence for the e2e fake (#21 stage 9): plain Maps
// behind the same interface the SQLite/PG facets implement, so the production
// MCP gateway (start_session bookmarks + write-retry dedup) runs UNCHANGED over
// a world the harness can reset instantly — the executable-spec posture of #18.

import type { DedupResult, GatewayStatePersistence } from '@notarium/server'

type DedupRow = { result: DedupResult; createdAt: string }

export class InMemoryGatewayState implements GatewayStatePersistence {
  private bookmarks = new Map<string, string>() // `${principalId}\0${space}` → lastRev
  private dedup = new Map<string, DedupRow>() // `${scope}\0${key}` → row

  clear(): void {
    this.bookmarks.clear()
    this.dedup.clear()
  }

  async bookmarkGet(principalId: string, space: string): Promise<string | null> {
    return this.bookmarks.get(`${principalId}\0${space}`) ?? null
  }
  // The driver signature is (principalId, space, lastRev, updatedAt); the twin
  // omits updatedAt (TS contravariance keeps it interface-compatible). Nothing
  // reads the timestamp back — bookmarkGet returns only the cursor — so storing it
  // would be dead state; the twin models exactly the observable behavior.
  async bookmarkSet(principalId: string, space: string, lastRev: string): Promise<void> {
    const key = `${principalId}\0${space}`
    const current = this.bookmarks.get(key)

    if (current == null || BigInt(lastRev) > BigInt(current)) {
      this.bookmarks.set(key, lastRev)
    }
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
