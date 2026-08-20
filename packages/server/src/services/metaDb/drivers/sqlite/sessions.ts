import { parseAbilityLocator, serializeAbilityLocator } from '@notarium/core'
import type {
  AgentSessionNamedStart,
  AgentSessionRecord,
  AgentSessionsPersistence,
} from '../../types'
import type { SqliteDriverCtx } from './context'

type AgentSessionRow = {
  id: string
  owner: string
  name: string
  named: number
  parent_id: string | null
  created_at: string
  last_seen_at: string
  calls: number
  role: string | null
  role_locator: string | null
  role_context_project_id: string | null
}

const roleLocatorOf = (value: string | null): AgentSessionRecord['roleLocator'] => {
  const locator = value ? parseAbilityLocator(value) : null
  // A bound role is a role of either shippable source. Narrowing to `owned` here is
  // what would leave a System activation unable to survive its own resume.
  return locator?.kind === 'role' && locator.source !== 'catalog' ? locator : null
}

const sessionOf = (row: AgentSessionRow): AgentSessionRecord => ({
  id: row.id,
  owner: row.owner,
  name: row.name,
  named: row.named === 1,
  parentId: row.parent_id,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  calls: row.calls,
  role: row.role,
  roleLocator: roleLocatorOf(row.role_locator),
  roleContextProjectId: row.role_context_project_id,
})

const COLUMNS =
  'id, owner, name, named, parent_id, created_at, last_seen_at, calls, role, role_locator, role_context_project_id'

const insertSession = (ctx: SqliteDriverCtx, session: AgentSessionRecord): AgentSessionRecord => {
  const row = ctx.required
    .prepare(
      `INSERT INTO agent_sessions
         (id, owner, name, named, parent_id, created_at, last_seen_at, calls, role, role_locator, role_context_project_id)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE ? IS NULL
           OR EXISTS (
             SELECT 1 FROM agent_sessions
              WHERE id = ? AND owner = ?
           )
      RETURNING ${COLUMNS}`,
    )
    .get(
      session.id,
      session.owner,
      session.name,
      session.named ? 1 : 0,
      session.parentId,
      session.createdAt,
      session.lastSeenAt,
      session.calls,
      session.role,
      session.roleLocator ? serializeAbilityLocator(session.roleLocator) : null,
      session.roleContextProjectId,
      session.parentId,
      session.parentId,
      session.owner,
    ) as AgentSessionRow | undefined

  if (!row) {
    throw new Error(`no same-owner parent agent session: ${session.parentId}`)
  }

  return sessionOf(row)
}

export const createSessionsFacet = (ctx: SqliteDriverCtx): AgentSessionsPersistence => ({
  insert: async (session) => {
    await ctx.ensureInit()
    insertSession(ctx, session)
  },
  touch: async (owner, id, lastSeenAt, retainedSince) => {
    await ctx.ensureInit()
    const row = ctx.required
      .prepare(
        `UPDATE agent_sessions
            SET last_seen_at = MAX(last_seen_at, ?), calls = calls + 1
          WHERE owner = ? AND id = ? AND last_seen_at >= ?
        RETURNING ${COLUMNS}`,
      )
      .get(lastSeenAt, owner, id, retainedSince) as AgentSessionRow | undefined
    return row ? sessionOf(row) : null
  },
  inferActiveAndTouch: async (owner, activeSince, lastSeenAt) => {
    await ctx.ensureInit()
    const row = ctx.required
      .prepare(
        `UPDATE agent_sessions
            SET last_seen_at = MAX(last_seen_at, ?), calls = calls + 1
          WHERE owner = ?
            AND id = (
              SELECT CASE WHEN COUNT(*) = 1 THEN MIN(id) END
                FROM agent_sessions
               WHERE owner = ? AND last_seen_at >= ?
            )
        RETURNING ${COLUMNS}`,
      )
      .get(lastSeenAt, owner, owner, activeSince) as AgentSessionRow | undefined
    return row ? sessionOf(row) : null
  },
  startNamed: async (candidate, activeSince, retainedSince, limit) => {
    await ctx.ensureInit()
    ctx.required.exec('BEGIN IMMEDIATE')

    try {
      const rows = ctx.required
        .prepare(
          `SELECT ${COLUMNS} FROM agent_sessions
            WHERE owner = ? AND name = ? AND last_seen_at >= ?
            ORDER BY last_seen_at DESC, id DESC LIMIT ?`,
        )
        .all(candidate.owner, candidate.name, retainedSince, limit + 1) as AgentSessionRow[]
      let result: AgentSessionNamedStart

      if (rows.length > 1) {
        result = {
          kind: 'ambiguous',
          matches: rows.slice(0, limit).map(sessionOf),
        }
      } else {
        const match = rows[0]

        if (!match) {
          result = { kind: 'new', record: insertSession(ctx, candidate) }
        } else if (match.last_seen_at >= activeSince) {
          result = {
            kind: 'forked',
            record: insertSession(ctx, {
              ...candidate,
              parentId: match.id,
              role: match.role,
              roleLocator: roleLocatorOf(match.role_locator),
              roleContextProjectId: match.role_context_project_id,
            }),
          }
        } else {
          const row = ctx.required
            .prepare(
              `UPDATE agent_sessions
                  SET last_seen_at = MAX(last_seen_at, ?), calls = calls + 1
                WHERE owner = ? AND id = ? AND last_seen_at >= ?
              RETURNING ${COLUMNS}`,
            )
            .get(candidate.lastSeenAt, candidate.owner, match.id, retainedSince) as AgentSessionRow
          result = { kind: 'resumed', record: sessionOf(row) }
        }
      }

      ctx.required.exec('COMMIT')
      return result
    } catch (error) {
      if (ctx.required.isTransaction) {
        ctx.required.exec('ROLLBACK')
      }
      throw error
    }
  },
  listRecent: async (owner, since, limit) => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare(
        `SELECT ${COLUMNS} FROM agent_sessions
          WHERE owner = ? AND last_seen_at >= ?
          ORDER BY last_seen_at DESC, id DESC LIMIT ?`,
      )
      .all(owner, since, limit) as AgentSessionRow[]
    return rows.map(sessionOf)
  },
  setRole: async (owner, id, role) => {
    await ctx.ensureInit()
    ctx.required.exec('BEGIN IMMEDIATE')
    try {
      const before = ctx.required
        .prepare(`SELECT ${COLUMNS} FROM agent_sessions WHERE owner = ? AND id = ?`)
        .get(owner, id) as AgentSessionRow | undefined

      if (!before) {
        ctx.required.exec('COMMIT')
        return null
      }
      const changed =
        before.role !== role.name ||
        before.role_locator !== serializeAbilityLocator(role.locator) ||
        before.role_context_project_id !== role.contextProjectId
      const row = changed
        ? (ctx.required
            .prepare(
              `UPDATE agent_sessions
                  SET role = ?, role_locator = ?, role_context_project_id = ?
                WHERE owner = ? AND id = ? RETURNING ${COLUMNS}`,
            )
            .get(
              role.name,
              serializeAbilityLocator(role.locator),
              role.contextProjectId,
              owner,
              id,
            ) as AgentSessionRow)
        : before
      ctx.required.exec('COMMIT')
      return { record: sessionOf(row), changed }
    } catch (error) {
      if (ctx.required.isTransaction) {
        ctx.required.exec('ROLLBACK')
      }
      throw error
    }
  },
  prune: async (before) => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare('DELETE FROM agent_sessions WHERE last_seen_at < ? RETURNING owner')
      .all(before) as Array<{ owner: string }>
    return [...new Set(rows.map(({ owner }) => owner))].sort()
  },
})
