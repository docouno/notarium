import type pg from 'pg'

import type {
  AgentSessionNamedStart,
  AgentSessionRecord,
  AgentSessionsPersistence,
} from '../../types'
import type { PgDriverCtx } from './context'

type AgentSessionRow = {
  id: string
  owner: string
  name: string
  named: boolean
  parent_id: string | null
  created_at: string
  last_seen_at: string
  calls: number | string
}

const sessionOf = (row: AgentSessionRow): AgentSessionRecord => ({
  id: row.id,
  owner: row.owner,
  name: row.name,
  named: row.named,
  parentId: row.parent_id,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  calls: Number(row.calls),
})

const COLUMNS = 'id, owner, name, named, parent_id, created_at, last_seen_at, calls'

type Queryable = Pick<pg.Pool, 'query'>

const insertSession = async (
  db: Queryable,
  session: AgentSessionRecord,
): Promise<AgentSessionRecord> => {
  const result = await db.query(
    `INSERT INTO agent_sessions
       (id, owner, name, named, parent_id, created_at, last_seen_at, calls)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8
      WHERE $5::text IS NULL
         OR EXISTS (
           SELECT 1 FROM agent_sessions
            WHERE id = $5 AND owner = $2
         )
    RETURNING ${COLUMNS}`,
    [
      session.id,
      session.owner,
      session.name,
      session.named,
      session.parentId,
      session.createdAt,
      session.lastSeenAt,
      session.calls,
    ],
  )
  const row = result.rows[0] as AgentSessionRow | undefined

  if (!row) {
    throw new Error(`no same-owner parent agent session: ${session.parentId}`)
  }

  return sessionOf(row)
}

export const createSessionsFacet = (ctx: PgDriverCtx): AgentSessionsPersistence => ({
  insert: async (session) => {
    await ctx.ensureInit()
    await insertSession(ctx.required, session)
  },
  touch: async (owner, id, lastSeenAt, retainedSince) => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      `UPDATE agent_sessions
          SET last_seen_at = GREATEST(last_seen_at, $1), calls = calls + 1
        WHERE owner = $2 AND id = $3 AND last_seen_at >= $4
      RETURNING ${COLUMNS}`,
      [lastSeenAt, owner, id, retainedSince],
    )
    const row = result.rows[0] as AgentSessionRow | undefined
    return row ? sessionOf(row) : null
  },
  inferActiveAndTouch: async (owner, activeSince, lastSeenAt) => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      `WITH candidate AS (
         SELECT MIN(id) AS id
           FROM agent_sessions
          WHERE owner = $1 AND last_seen_at >= $2
         HAVING COUNT(*) = 1
       )
       UPDATE agent_sessions AS session
          SET last_seen_at = GREATEST(session.last_seen_at, $3), calls = session.calls + 1
         FROM candidate
        WHERE session.owner = $1 AND session.id = candidate.id
      RETURNING session.${COLUMNS.replaceAll(', ', ', session.')}`,
      [owner, activeSince, lastSeenAt],
    )
    const row = result.rows[0] as AgentSessionRow | undefined
    return row ? sessionOf(row) : null
  },
  startNamed: async (candidate, activeSince, retainedSince, limit) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        `agent-session:${candidate.owner}`,
        candidate.name,
      ])
      const matches = await client.query(
        `SELECT ${COLUMNS} FROM agent_sessions
          WHERE owner = $1 AND name = $2 AND last_seen_at >= $3
          ORDER BY last_seen_at DESC, id DESC LIMIT $4`,
        [candidate.owner, candidate.name, retainedSince, limit + 1],
      )
      const rows = matches.rows as AgentSessionRow[]
      let result: AgentSessionNamedStart

      if (rows.length > 1) {
        result = {
          kind: 'ambiguous',
          matches: rows.slice(0, limit).map(sessionOf),
        }
      } else {
        const match = rows[0]

        if (!match) {
          result = { kind: 'new', record: await insertSession(client, candidate) }
        } else if (match.last_seen_at >= activeSince) {
          result = {
            kind: 'forked',
            record: await insertSession(client, { ...candidate, parentId: match.id }),
          }
        } else {
          const updated = await client.query(
            `UPDATE agent_sessions
                SET last_seen_at = GREATEST(last_seen_at, $1), calls = calls + 1
              WHERE owner = $2 AND id = $3 AND last_seen_at >= $4
            RETURNING ${COLUMNS}`,
            [candidate.lastSeenAt, candidate.owner, match.id, retainedSince],
          )
          result = {
            kind: 'resumed',
            record: sessionOf(updated.rows[0] as AgentSessionRow),
          }
        }
      }

      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
  listRecent: async (owner, since, limit) => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      `SELECT ${COLUMNS} FROM agent_sessions
        WHERE owner = $1 AND last_seen_at >= $2
        ORDER BY last_seen_at DESC, id DESC LIMIT $3`,
      [owner, since, limit],
    )
    return (result.rows as AgentSessionRow[]).map(sessionOf)
  },
  prune: async (before) => {
    await ctx.ensureInit()
    await ctx.required.query('DELETE FROM agent_sessions WHERE last_seen_at < $1', [before])
  },
})
