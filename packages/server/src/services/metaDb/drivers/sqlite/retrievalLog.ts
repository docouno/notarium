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
             (owner, principal, agent, session_id, session_name, session_attach, agent_call_id, tool, query, project, class_filter, result_count, top_score, hits, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE ? IS NULL OR NOT EXISTS (
              SELECT 1 FROM agent_session_cleanup_markers marker
               WHERE marker.owner = ? AND marker.session_id = ?
            )`,
      )
      .run(
        input.owner,
        input.principal,
        input.agent,
        input.sessionId,
        input.sessionName,
        input.sessionAttach,
        input.agentCallId ?? null,
        input.tool,
        input.query,
        input.project,
        input.classFilter,
        input.resultCount,
        input.topScore,
        JSON.stringify(input.hits),
        input.createdAt,
        input.sessionId,
        input.owner,
        input.sessionId,
      )

    if (res.changes === 0) {
      return null
    }

    return {
      ...input,
      agentCallId: input.agentCallId ?? null,
      hits: [...input.hits],
      id: String(res.lastInsertRowid),
    }
  },
  history: async (q: RetrievalHistoryQuery) => {
    await ctx.ensureInit()
    const filters: string[] = [
      'owner = ?',
      `NOT EXISTS (
        SELECT 1 FROM agent_session_cleanup_markers marker
         WHERE marker.owner = agent_retrievals.owner
           AND marker.session_id = agent_retrievals.session_id
           AND (marker.reason = 'human-delete' OR agent_retrievals.agent_call_id IS NOT NULL)
      )`,
    ]
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
        `SELECT id, owner, principal, agent, session_id, session_name, session_attach, agent_call_id, tool, query, project, class_filter, result_count, top_score, hits, created_at
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
    db.exec('BEGIN')

    try {
      const hasMarkers = Boolean(
        db
          .prepare('SELECT 1 FROM agent_session_cleanup_markers WHERE owner = ? LIMIT 1')
          .get(owner),
      )
      const visibility = hasMarkers
        ? `AND NOT EXISTS (
             SELECT 1 FROM agent_session_cleanup_markers marker
              WHERE marker.owner = agent_retrievals.owner
                AND marker.session_id = agent_retrievals.session_id
                AND (marker.reason = 'human-delete' OR agent_retrievals.agent_call_id IS NOT NULL)
           )`
        : ''
      // A "query" is a search/recall call; get_note is a follow-through, not a query.
      const scope = `owner = ? AND tool IN ('search', 'recall') ${visibility}`
      const totals = db
        .prepare(
          `SELECT COUNT(*) AS total, SUM(CASE WHEN result_count = 0 THEN 1 ELSE 0 END) AS misses
             FROM agent_retrievals WHERE ${scope}`,
        )
        .get(owner) as { total: number | bigint; misses: number | bigint | null }
      const grouped = db
        .prepare(
          `WITH grouped AS MATERIALIZED (
             SELECT query, tool, COUNT(*) AS count,
                    SUM(CASE WHEN result_count = 0 THEN 1 ELSE 0 END) AS misses,
                    MAX(created_at) AS last_at
               FROM agent_retrievals WHERE ${scope}
              GROUP BY query, tool
           )
           SELECT 'top' AS bucket, query, tool, count, misses, last_at FROM (
             SELECT * FROM grouped ORDER BY count DESC, last_at DESC LIMIT ?
           )
           UNION ALL
           SELECT 'miss' AS bucket, query, tool, count, misses, last_at FROM (
             SELECT * FROM grouped WHERE misses > 0
              ORDER BY misses DESC, last_at DESC LIMIT ?
           )`,
        )
        .all(owner, limit, limit) as Array<{
        bucket: 'top' | 'miss'
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
      const top = grouped.filter((row) => row.bucket === 'top').map(stat)
      const misses = grouped.filter((row) => row.bucket === 'miss').map(stat)
      const result = {
        totalQueries: Number(totals.total),
        missCount: Number(totals.misses ?? 0),
        top,
        misses,
      } satisfies RetrievalAggregates
      db.exec('COMMIT')
      return result
    } catch (error) {
      if (db.isTransaction) {
        db.exec('ROLLBACK')
      }
      throw error
    }
  },
})
