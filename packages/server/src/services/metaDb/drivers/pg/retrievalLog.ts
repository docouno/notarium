import { retrievalOfRow, type RetrievalRow } from '../../rows'
import type {
  RetrievalAggregates,
  RetrievalHistoryQuery,
  RetrievalLogInput,
  RetrievalLogPersistence,
  RetrievalQueryStat,
} from '../../types'
import type { PgDriverCtx } from './context'

export const createRetrievalLogFacet = (ctx: PgDriverCtx): RetrievalLogPersistence => ({
  append: async (input: RetrievalLogInput) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      `INSERT INTO agent_retrievals
           (owner, principal, agent, tool, query, project, class_filter, result_count, top_score, hits, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
      [
        input.owner,
        input.principal,
        input.agent,
        input.tool,
        input.query,
        input.project,
        input.classFilter,
        input.resultCount,
        input.topScore,
        JSON.stringify(input.hits),
        input.createdAt,
      ],
    )
    return { ...input, hits: [...input.hits], id: String(res.rows[0].id) }
  },
  history: async (q: RetrievalHistoryQuery) => {
    await ctx.ensureInit()
    const filters: string[] = ['owner = $1']
    const params: Array<string | number> = [q.owner]

    if (q.tool) {
      params.push(q.tool)
      filters.push(`tool = $${params.length}`)
    }
    if (q.missesOnly) {
      filters.push('result_count = 0')
    }
    const countWhere = filters.join(' AND ')
    const countParams = [...params]

    if (q.before) {
      params.push(q.before.at)
      const at1 = `$${params.length}`
      params.push(q.before.at)
      const at2 = `$${params.length}`
      params.push(q.before.id)
      const id = `$${params.length}::bigint`
      filters.push(`(created_at < ${at1} OR (created_at = ${at2} AND id < ${id}))`)
    }
    const rowWhere = filters.join(' AND ')
    const [rows, count] = await Promise.all([
      ctx.required.query(
        `SELECT id, owner, principal, agent, tool, query, project, class_filter, result_count, top_score, hits, created_at
           FROM agent_retrievals WHERE ${rowWhere}
           ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, q.limit + 1, q.offset],
      ),
      ctx.required.query(
        `SELECT COUNT(*) AS n FROM agent_retrievals WHERE ${countWhere}`,
        countParams,
      ),
    ])
    return {
      items: (rows.rows as RetrievalRow[]).slice(0, q.limit).map(retrievalOfRow),
      total: Number(count.rows[0].n),
      hasMore: rows.rows.length > q.limit,
    }
  },
  aggregates: async (owner: string, opts?: { limit?: number }) => {
    await ctx.ensureInit()
    const limit = opts?.limit ?? 8
    // A "query" is a search/recall call; get_note is a follow-through, not a query.
    const scope = "owner = $1 AND tool IN ('search', 'recall')"
    const totalsRes = await ctx.required.query(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN result_count = 0 THEN 1 ELSE 0 END) AS misses
         FROM agent_retrievals WHERE ${scope}`,
      [owner],
    )

    const grouped = async (order: string, having: string) => {
      const res = await ctx.required.query(
        `SELECT query, tool, COUNT(*) AS count,
                  SUM(CASE WHEN result_count = 0 THEN 1 ELSE 0 END) AS misses,
                  MAX(created_at) AS last_at
           FROM agent_retrievals WHERE ${scope}
           GROUP BY query, tool ${having}
           ORDER BY ${order} LIMIT $2`,
        [owner, limit],
      )
      return (
        res.rows as Array<{
          query: string
          tool: string
          count: string | number
          misses: string | number | null
          last_at: string
        }>
      ).map((r): RetrievalQueryStat => ({
        query: r.query,
        tool: r.tool as RetrievalQueryStat['tool'],
        count: Number(r.count),
        misses: Number(r.misses ?? 0),
        lastAt: r.last_at,
      }))
    }
    const [top, misses] = await Promise.all([
      grouped('count DESC, last_at DESC', ''),
      grouped(
        'misses DESC, last_at DESC',
        'HAVING SUM(CASE WHEN result_count = 0 THEN 1 ELSE 0 END) > 0',
      ),
    ])
    const totals = totalsRes.rows[0] as { total: string | number; misses: string | number | null }
    return {
      totalQueries: Number(totals.total),
      missCount: Number(totals.misses ?? 0),
      top,
      misses,
    } satisfies RetrievalAggregates
  },
})
