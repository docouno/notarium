import { retrievalOfRow, type RetrievalRow } from '../../rows'
import type {
  RetrievalAggregates,
  RetrievalHistoryQuery,
  RetrievalLogInput,
  RetrievalLogPersistence,
  RetrievalQueryStat,
} from '../../types'
import type { SqliteDriverCtx } from './context'

export const createRetrievalLogFacet = (ctx: SqliteDriverCtx): RetrievalLogPersistence => ({
  append: async (input: RetrievalLogInput) => {
    await ctx.ensureInit()
    const res = ctx.required
      .prepare(
        `INSERT INTO agent_retrievals
             (owner, principal, agent, session_id, session_name, session_attach, tool, query, project, class_filter, result_count, top_score, hits, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.owner,
        input.principal,
        input.agent,
        input.sessionId,
        input.sessionName,
        input.sessionAttach,
        input.tool,
        input.query,
        input.project,
        input.classFilter,
        input.resultCount,
        input.topScore,
        JSON.stringify(input.hits),
        input.createdAt,
      )
    return { ...input, hits: [...input.hits], id: String(res.lastInsertRowid) }
  },
  history: async (q: RetrievalHistoryQuery) => {
    await ctx.ensureInit()
    const filters: string[] = ['owner = ?']
    const params: Array<string | number> = [q.owner]

    if (q.tool) {
      filters.push('tool = ?')
      params.push(q.tool)
    }
    if (q.missesOnly) {
      filters.push('result_count = 0')
    }
    const countWhere = filters.join(' AND ')
    const countParams = [...params]

    if (q.before) {
      filters.push('(created_at < ? OR (created_at = ? AND id < ?))')
      params.push(q.before.at, q.before.at, Number(q.before.id))
    }
    const rowWhere = filters.join(' AND ')
    const rows = ctx.required
      .prepare(
        `SELECT id, owner, principal, agent, session_id, session_name, session_attach, tool, query, project, class_filter, result_count, top_score, hits, created_at
           FROM agent_retrievals WHERE ${rowWhere}
           ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, q.limit + 1, q.offset) as RetrievalRow[]
    const total = Number(
      (
        ctx.required
          .prepare(`SELECT COUNT(*) AS n FROM agent_retrievals WHERE ${countWhere}`)
          .get(...countParams) as {
          n: number | bigint
        }
      ).n,
    )
    return {
      items: rows.slice(0, q.limit).map(retrievalOfRow),
      total,
      hasMore: rows.length > q.limit,
    }
  },
  aggregates: async (owner: string, opts?: { limit?: number }) => {
    await ctx.ensureInit()
    const db = ctx.required
    const limit = opts?.limit ?? 8
    // A "query" is a search/recall call; get_note is a follow-through, not a query.
    const scope = "owner = ? AND tool IN ('search', 'recall')"
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN result_count = 0 THEN 1 ELSE 0 END) AS misses
           FROM agent_retrievals WHERE ${scope}`,
      )
      .get(owner) as { total: number | bigint; misses: number | bigint | null }
    const grouped = (order: string, having: string) =>
      db
        .prepare(
          `SELECT query, tool, COUNT(*) AS count,
                    SUM(CASE WHEN result_count = 0 THEN 1 ELSE 0 END) AS misses,
                    MAX(created_at) AS last_at
             FROM agent_retrievals WHERE ${scope}
             GROUP BY query, tool ${having}
             ORDER BY ${order} LIMIT ?`,
        )
        .all(owner, limit) as Array<{
        query: string
        tool: string
        count: number | bigint
        misses: number | bigint | null
        last_at: string
      }>
    const stat = (r: {
      query: string
      tool: string
      count: number | bigint
      misses: number | bigint | null
      last_at: string
    }): RetrievalQueryStat => ({
      query: r.query,
      tool: r.tool as RetrievalQueryStat['tool'],
      count: Number(r.count),
      misses: Number(r.misses ?? 0),
      lastAt: r.last_at,
    })
    const top = grouped('count DESC, last_at DESC', '').map(stat)
    const misses = grouped('misses DESC, last_at DESC', 'HAVING misses > 0').map(stat)
    return {
      totalQueries: Number(totals.total),
      missCount: Number(totals.misses ?? 0),
      top,
      misses,
    } satisfies RetrievalAggregates
  },
})
