import type pg from 'pg'

import type { AgentDeltaCursorScope, AgentDeltaCursorsPersistence } from '../../types'
import type { PgDriverCtx } from './context'
import { lockProjectParentRow } from './lockOrder'

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>
type CursorRow = { last_rev: string | null }

const advanceOwner = async (
  db: Queryable,
  owner: string,
  project: string,
  lastRev: string,
  updatedAt: string,
): Promise<void> => {
  await db.query(
    `INSERT INTO mcp_delta_owner_cursors (owner, project, last_rev, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (owner, project) DO UPDATE
       SET last_rev = EXCLUDED.last_rev, updated_at = EXCLUDED.updated_at
     WHERE mcp_delta_owner_cursors.last_rev::BIGINT < EXCLUDED.last_rev::BIGINT`,
    [owner, project, lastRev, updatedAt],
  )
}

const advanceSession = async (
  db: Queryable,
  sessionId: string,
  project: string,
  lastRev: string,
  updatedAt: string,
): Promise<void> => {
  await db.query(
    `INSERT INTO mcp_delta_session_cursors (session_id, project, last_rev, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (session_id, project) DO UPDATE
       SET last_rev = EXCLUDED.last_rev, updated_at = EXCLUDED.updated_at
     WHERE mcp_delta_session_cursors.last_rev IS NULL
        OR mcp_delta_session_cursors.last_rev::BIGINT < EXCLUDED.last_rev::BIGINT`,
    [sessionId, project, lastRev, updatedAt],
  )
}

export const createAgentDeltaCursorsFacet = (ctx: PgDriverCtx): AgentDeltaCursorsPersistence => ({
  getOrInit: async (scope, project, initializedAt) => {
    await ctx.ensureInit()

    if (!scope.session) {
      const result = await ctx.required.query(
        'SELECT last_rev FROM mcp_delta_owner_cursors WHERE owner = $1 AND project = $2',
        [scope.owner, project],
      )
      return (result.rows[0] as CursorRow | undefined)?.last_rev ?? null
    }

    const { id, parentId } = scope.session
    const result = await ctx.required.query(
      `INSERT INTO mcp_delta_session_cursors (session_id, project, last_rev, updated_at)
       VALUES (
         $1,
         $2,
         CASE
           WHEN $3::text IS NOT NULL AND EXISTS (
             SELECT 1 FROM mcp_delta_session_cursors
              WHERE session_id = $3 AND project = $2
           ) THEN (
             SELECT last_rev FROM mcp_delta_session_cursors
              WHERE session_id = $3 AND project = $2
           )
           ELSE (
             SELECT last_rev FROM mcp_delta_owner_cursors
              WHERE owner = $4 AND project = $2
           )
         END,
         $5
       )
       ON CONFLICT (session_id, project) DO UPDATE
         SET updated_at = mcp_delta_session_cursors.updated_at
       RETURNING last_rev`,
      [id, project, parentId, scope.owner, initializedAt],
    )

    return (result.rows[0] as CursorRow).last_rev
  },

  advance: async (scope: AgentDeltaCursorScope, project, lastRev, updatedAt) => {
    await ctx.ensureInit()

    if (!scope.session) {
      await advanceOwner(ctx.required, scope.owner, project, lastRev, updatedAt)
      return
    }

    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      // Keep one parent-first lock order with project deletion/retyping. Without
      // this, updating an existing owner child and then inserting a missing
      // session child can deadlock a retype trigger that already owns the parent
      // row and is waiting to delete that owner child. `folders` is L4f, so the
      // lock is taken through the module that states the order (#327).
      await lockProjectParentRow(client, project)
      await advanceOwner(client, scope.owner, project, lastRev, updatedAt)
      await advanceSession(client, scope.session.id, project, lastRev, updatedAt)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
})
