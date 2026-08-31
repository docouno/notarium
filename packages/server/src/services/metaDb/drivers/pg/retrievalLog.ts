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
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      if (input.sessionId) {
        // eslint-disable-next-line no-restricted-syntax -- shared session diagnostics guard, outside the note hierarchy
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
          `agent-session-diagnostics:${input.owner}`,
          input.sessionId,
        ])
      }
      const res = await client.query(
        `INSERT INTO agent_retrievals
           (owner, principal, agent, session_id, session_name, session_attach, agent_call_id, tool, query, project, class_filter, result_count, top_score, hits, created_at)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
          WHERE $4::text IS NULL OR NOT EXISTS (
            SELECT 1 FROM agent_session_cleanup_markers marker
             WHERE marker.owner = $1 AND marker.session_id = $4
          )
         RETURNING id`,
        [
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
        ],
      )
      await client.query('COMMIT')
      if (!res.rows[0]) {
        return null
      }

      return {
        ...input,
        agentCallId: input.agentCallId ?? null,
        hits: [...input.hits],
        id: String(res.rows[0].id),
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
  history: async (q: RetrievalHistoryQuery) => {
    await ctx.ensureInit()
    const filters: string[] = [
      'owner = $1',
      `NOT EXISTS (
        SELECT 1 FROM agent_session_cleanup_markers marker
         WHERE marker.owner = agent_retrievals.owner
           AND marker.session_id = agent_retrievals.session_id
           AND (marker.reason = 'human-delete' OR agent_retrievals.agent_call_id IS NOT NULL)
      )`,
    ]
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
        `SELECT id, owner, principal, agent, session_id, session_name, session_attach, agent_call_id, tool, query, project, class_filter, result_count, top_score, hits, created_at
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
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const marker = await client.query(
        'SELECT 1 FROM agent_session_cleanup_markers WHERE owner = $1 LIMIT 1',
        [owner],
      )
      const visibility =
        marker.rowCount === 0
          ? ''
          : `AND NOT EXISTS (
               SELECT 1 FROM agent_session_cleanup_markers marker
                WHERE marker.owner = agent_retrievals.owner
                  AND marker.session_id = agent_retrievals.session_id
                  AND (marker.reason = 'human-delete' OR agent_retrievals.agent_call_id IS NOT NULL)
             )`
      // A "query" is a search/recall call; get_note is a follow-through, not a query.
      const scope = `owner = $1 AND tool IN ('search', 'recall') ${visibility}`
      const totalsRes = await client.query(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN result_count = 0 THEN 1 ELSE 0 END) AS misses
           FROM agent_retrievals WHERE ${scope}`,
        [owner],
      )
      const groupedRes = await client.query(
        `WITH grouped AS MATERIALIZED (
           SELECT query, tool, COUNT(*) AS count,
                    SUM(CASE WHEN result_count = 0 THEN 1 ELSE 0 END) AS misses,
                    MAX(created_at) AS last_at
             FROM agent_retrievals WHERE ${scope}
            GROUP BY query, tool
         )
         (SELECT 'top' AS bucket, query, tool, count, misses, last_at
            FROM grouped ORDER BY count DESC, last_at DESC LIMIT $2)
         UNION ALL
         (SELECT 'miss' AS bucket, query, tool, count, misses, last_at
            FROM grouped WHERE misses > 0 ORDER BY misses DESC, last_at DESC LIMIT $2)`,
        [owner, limit],
      )
      const grouped = (
        groupedRes.rows as Array<{
          bucket: 'top' | 'miss'
          query: string
          tool: string
          count: string | number
          misses: string | number | null
          last_at: string
        }>
      ).map((r) => ({
        bucket: r.bucket,
        stat: {
          query: r.query,
          tool: r.tool as RetrievalQueryStat['tool'],
          count: Number(r.count),
          misses: Number(r.misses ?? 0),
          lastAt: r.last_at,
        } satisfies RetrievalQueryStat,
      }))
      const top = grouped.filter((row) => row.bucket === 'top').map((row) => row.stat)
      const misses = grouped.filter((row) => row.bucket === 'miss').map((row) => row.stat)
      const totals = totalsRes.rows[0] as {
        total: string | number
        misses: string | number | null
      }
      const result = {
        totalQueries: Number(totals.total),
        missCount: Number(totals.misses ?? 0),
        top,
        misses,
      } satisfies RetrievalAggregates
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
})
