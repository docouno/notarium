import type {
  RetrievalAggregates,
  RetrievalHistoryQuery,
  RetrievalLogInput,
  RetrievalLogPersistence,
  RetrievalLogRecord,
  RetrievalQueryStat,
} from '@notarium/server'

// In-memory twin of the agent-retrieval audit facet (#243) — the SQL drivers'
// behavioural double for the fake backend / conformance tests. Append-only, ordered
// newest-first by insertion (the drivers' `ORDER BY id DESC`); a miss is a zero-result
// call; aggregates count only search/recall (get_note is a follow-through). Kept in
// lockstep with sqliteMetaDb/pgMetaDb's `retrievalLog`.
export class InMemoryRetrievalLog implements RetrievalLogPersistence {
  private rows: RetrievalLogRecord[] = []
  private seq = 0

  clear(): void {
    this.rows = []
    this.seq = 0
  }

  async append(input: RetrievalLogInput): Promise<RetrievalLogRecord> {
    const row: RetrievalLogRecord = { ...input, hits: [...input.hits], id: String(++this.seq) }
    this.rows.push(row)
    return { ...row, hits: [...row.hits] }
  }

  async history(
    q: RetrievalHistoryQuery,
  ): Promise<{ items: RetrievalLogRecord[]; total: number; hasMore: boolean }> {
    const baseMatched = this.rows.filter(
      (r) =>
        r.owner === q.owner &&
        (q.tool ? r.tool === q.tool : true) &&
        (q.missesOnly ? r.resultCount === 0 : true),
    )
    const matched = baseMatched.filter((r) =>
      q.before
        ? r.createdAt < q.before.at ||
          (r.createdAt === q.before.at && Number(r.id) < Number(q.before.id))
        : true,
    )
    // Newest-first by created_at, then insertion (id) as the tiebreaker — mirrors the
    // drivers' `ORDER BY created_at DESC, id DESC`. NB backdated seed rows are appended out
    // of chronological order, so created_at (not insertion) is the real timeline.
    const withSeq = matched.map((r) => ({ r, id: Number(r.id) }))
    withSeq.sort((a, b) => b.r.createdAt.localeCompare(a.r.createdAt) || b.id - a.id)
    const ordered = withSeq.map((x) => x.r)
    const page = ordered.slice(q.offset, q.offset + q.limit + 1)
    const items = page.slice(0, q.limit).map((r) => ({ ...r, hits: [...r.hits] }))
    return { items, total: baseMatched.length, hasMore: page.length > q.limit }
  }

  async aggregates(owner: string, opts?: { limit?: number }): Promise<RetrievalAggregates> {
    const limit = opts?.limit ?? 8
    // A "query" is a search/recall call; get_note is a follow-through, not a query.
    const queries = this.rows.filter(
      (r) => r.owner === owner && (r.tool === 'search' || r.tool === 'recall'),
    )
    const byKey = new Map<string, RetrievalQueryStat>()

    for (const r of queries) {
      const key = `${r.tool}\0${r.query}`
      const stat = byKey.get(key) ?? {
        query: r.query,
        tool: r.tool,
        count: 0,
        misses: 0,
        lastAt: r.createdAt,
      }
      stat.count += 1
      if (r.resultCount === 0) {
        stat.misses += 1
      }
      if (r.createdAt > stat.lastAt) {
        stat.lastAt = r.createdAt
      }
      byKey.set(key, stat)
    }
    const all = [...byKey.values()]
    const top = [...all]
      .sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt))
      .slice(0, limit)
      .map((s) => ({ ...s }))
    const misses = all
      .filter((s) => s.misses > 0)
      .sort((a, b) => b.misses - a.misses || b.lastAt.localeCompare(a.lastAt))
      .slice(0, limit)
      .map((s) => ({ ...s }))
    return {
      totalQueries: queries.length,
      missCount: queries.filter((r) => r.resultCount === 0).length,
      top,
      misses,
    }
  }
}
