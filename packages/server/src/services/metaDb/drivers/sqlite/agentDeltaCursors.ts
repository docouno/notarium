import type { AgentDeltaCursorScope, AgentDeltaCursorsPersistence } from '../../types'
import type { SqliteDriverCtx } from './context'

type CursorRow = { last_rev: string | null }

const advanceOwner = (
  ctx: SqliteDriverCtx,
  owner: string,
  project: string,
  lastRev: string,
  updatedAt: string,
): void => {
  ctx.required
    .prepare(
      `INSERT INTO mcp_delta_owner_cursors (owner, project, last_rev, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(owner, project) DO UPDATE
         SET last_rev = excluded.last_rev, updated_at = excluded.updated_at
       WHERE CAST(mcp_delta_owner_cursors.last_rev AS INTEGER) < CAST(excluded.last_rev AS INTEGER)`,
    )
    .run(owner, project, lastRev, updatedAt)
}

const advanceSession = (
  ctx: SqliteDriverCtx,
  sessionId: string,
  project: string,
  lastRev: string,
  updatedAt: string,
): void => {
  ctx.required
    .prepare(
      `INSERT INTO mcp_delta_session_cursors (session_id, project, last_rev, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id, project) DO UPDATE
         SET last_rev = excluded.last_rev, updated_at = excluded.updated_at
       WHERE mcp_delta_session_cursors.last_rev IS NULL
          OR CAST(mcp_delta_session_cursors.last_rev AS INTEGER) < CAST(excluded.last_rev AS INTEGER)`,
    )
    .run(sessionId, project, lastRev, updatedAt)
}

export const createAgentDeltaCursorsFacet = (
  ctx: SqliteDriverCtx,
): AgentDeltaCursorsPersistence => ({
  getOrInit: async (scope, project, initializedAt) => {
    await ctx.ensureInit()

    if (!scope.session) {
      const row = ctx.required
        .prepare('SELECT last_rev FROM mcp_delta_owner_cursors WHERE owner = ? AND project = ?')
        .get(scope.owner, project) as CursorRow | undefined
      return row?.last_rev ?? null
    }

    const { id, parentId } = scope.session
    // A NULL last_rev is a real frozen cursor: this episode first touched the
    // project before the owner had any fallback. The no-op conflict update makes
    // concurrent first touches return the already-materialised value.
    const row = ctx.required
      .prepare(
        `INSERT INTO mcp_delta_session_cursors (session_id, project, last_rev, updated_at)
         VALUES (
           ?,
           ?,
           CASE
             WHEN ? IS NOT NULL AND EXISTS (
               SELECT 1 FROM mcp_delta_session_cursors
                WHERE session_id = ? AND project = ?
             ) THEN (
               SELECT last_rev FROM mcp_delta_session_cursors
                WHERE session_id = ? AND project = ?
             )
             ELSE (
               SELECT last_rev FROM mcp_delta_owner_cursors
                WHERE owner = ? AND project = ?
             )
           END,
           ?
         )
         ON CONFLICT(session_id, project) DO UPDATE
           SET updated_at = mcp_delta_session_cursors.updated_at
         RETURNING last_rev`,
      )
      .get(
        id,
        project,
        parentId,
        parentId,
        project,
        parentId,
        project,
        scope.owner,
        project,
        initializedAt,
      ) as CursorRow
    return row.last_rev
  },

  advance: async (scope: AgentDeltaCursorScope, project, lastRev, updatedAt) => {
    await ctx.ensureInit()

    if (!scope.session) {
      advanceOwner(ctx, scope.owner, project, lastRev, updatedAt)
      return
    }

    ctx.required.exec('BEGIN IMMEDIATE')
    try {
      advanceOwner(ctx, scope.owner, project, lastRev, updatedAt)
      advanceSession(ctx, scope.session.id, project, lastRev, updatedAt)
      ctx.required.exec('COMMIT')
    } catch (error) {
      if (ctx.required.isTransaction) {
        ctx.required.exec('ROLLBACK')
      }
      throw error
    }
  },
})
