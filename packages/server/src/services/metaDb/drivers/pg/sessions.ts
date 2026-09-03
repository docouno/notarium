import type pg from 'pg'

import { parseAbilityLocator, serializeAbilityLocator } from '@notarium/core'
import { resolveLiveRoleContextTarget, roleContextTargetOfLocator } from '../../abilityAddress'
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
  role: string | null
  role_locator: string | null
  role_context_project_id: string | null
  project_id: string | null
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
  named: row.named,
  parentId: row.parent_id,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  calls: Number(row.calls),
  role: row.role,
  roleLocator: roleLocatorOf(row.role_locator),
  roleContextProjectId: row.role_context_project_id,
  projectId: row.project_id,
})

const COLUMNS =
  'id, owner, name, named, parent_id, created_at, last_seen_at, calls, role, role_locator, role_context_project_id, project_id'

type Queryable = Pick<pg.Pool, 'query'>

const lockSession = async (client: pg.PoolClient, owner: string, sessionId: string) => {
  // eslint-disable-next-line no-restricted-syntax -- shared session diagnostics guard, outside the note hierarchy
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
    `agent-session-diagnostics:${owner}`,
    sessionId,
  ])
}

const insertSession = async (
  db: Queryable,
  session: AgentSessionRecord,
): Promise<AgentSessionRecord> => {
  const result = await db.query(
    `INSERT INTO agent_sessions
       (id, owner, name, named, parent_id, created_at, last_seen_at, calls, role, role_locator, role_context_project_id, project_id)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
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
      session.role,
      session.roleLocator ? serializeAbilityLocator(session.roleLocator) : null,
      session.roleContextProjectId,
      session.projectId,
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
  getRetained: async (owner, id, retainedSince) => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      `SELECT ${COLUMNS} FROM agent_sessions
        WHERE owner = $1 AND id = $2 AND last_seen_at >= $3
          AND NOT EXISTS (
            SELECT 1 FROM agent_session_cleanup_markers marker
             WHERE marker.owner = agent_sessions.owner AND marker.session_id = agent_sessions.id
          )`,
      [owner, id, retainedSince],
    )
    const row = result.rows[0] as AgentSessionRow | undefined
    return row ? sessionOf(row) : null
  },
  listNamed: async (owner, name, retainedSince, limit) => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      `SELECT ${COLUMNS} FROM agent_sessions
        WHERE owner = $1 AND name = $2 AND last_seen_at >= $3
          AND NOT EXISTS (
            SELECT 1 FROM agent_session_cleanup_markers marker
             WHERE marker.owner = agent_sessions.owner AND marker.session_id = agent_sessions.id
          )
        ORDER BY last_seen_at DESC, id DESC LIMIT $4`,
      [owner, name, retainedSince, limit],
    )
    return (result.rows as AgentSessionRow[]).map(sessionOf)
  },
  touch: async (owner, id, lastSeenAt, retainedSince, projectId) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await lockSession(client, owner, id)
      const result = await client.query(
        `UPDATE agent_sessions
          SET last_seen_at = GREATEST(last_seen_at, $1), calls = calls + 1,
              project_id = CASE WHEN $5::boolean THEN $6 ELSE project_id END
        WHERE owner = $2 AND id = $3 AND last_seen_at >= $4
          AND NOT EXISTS (
            SELECT 1 FROM agent_session_cleanup_markers marker
             WHERE marker.owner = agent_sessions.owner AND marker.session_id = agent_sessions.id
          )
      RETURNING ${COLUMNS}`,
        [lastSeenAt, owner, id, retainedSince, projectId !== undefined, projectId ?? null],
      )
      await client.query('COMMIT')
      const row = result.rows[0] as AgentSessionRow | undefined
      return row ? sessionOf(row) : null
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
  startNamed: async (candidate, activeSince, retainedSince, limit, projectId) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      // Same-owner named starts share one world so resume/fork/ambiguity decisions
      // cannot observe and mutate different snapshots.
      // eslint-disable-next-line no-restricted-syntax -- outside the note-identity hierarchy: one owner's session-start world
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        `agent-session:${candidate.owner}`,
        'start',
      ])
      const matches = await client.query(
        `SELECT ${COLUMNS} FROM agent_sessions
          WHERE owner = $1 AND name = $2 AND last_seen_at >= $3
            AND NOT EXISTS (
              SELECT 1 FROM agent_session_cleanup_markers marker
               WHERE marker.owner = agent_sessions.owner AND marker.session_id = agent_sessions.id
            )
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
        let match: AgentSessionRow | undefined = rows[0]

        if (match) {
          await lockSession(client, candidate.owner, match.id)
          const guarded = await client.query(
            `SELECT ${COLUMNS} FROM agent_sessions
              WHERE owner = $1 AND id = $2
                AND NOT EXISTS (
                  SELECT 1 FROM agent_session_cleanup_markers marker
                   WHERE marker.owner = agent_sessions.owner
                     AND marker.session_id = agent_sessions.id
                )`,
            [candidate.owner, match.id],
          )
          match = guarded.rows[0] as AgentSessionRow | undefined
        }

        if (!match) {
          result = {
            kind: 'new',
            record: await insertSession(client, {
              ...candidate,
              projectId: projectId ?? candidate.projectId,
            }),
          }
        } else if (match.last_seen_at >= activeSince) {
          result = {
            kind: 'forked',
            record: await insertSession(client, {
              ...candidate,
              parentId: match.id,
              role: match.role,
              roleLocator: roleLocatorOf(match.role_locator),
              roleContextProjectId: match.role_context_project_id,
              projectId: projectId ?? match.project_id,
            }),
          }
        } else {
          const updated = await client.query(
            `UPDATE agent_sessions
                SET last_seen_at = GREATEST(last_seen_at, $1), calls = calls + 1,
                    project_id = CASE WHEN $5::boolean THEN $6 ELSE project_id END
              WHERE owner = $2 AND id = $3 AND last_seen_at >= $4
            RETURNING ${COLUMNS}`,
            [
              candidate.lastSeenAt,
              candidate.owner,
              match.id,
              retainedSince,
              projectId !== undefined,
              projectId ?? null,
            ],
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
          AND NOT EXISTS (
            SELECT 1 FROM agent_session_cleanup_markers marker
             WHERE marker.owner = agent_sessions.owner AND marker.session_id = agent_sessions.id
          )
        ORDER BY last_seen_at DESC, id DESC LIMIT $3`,
      [owner, since, limit],
    )
    return (result.rows as AgentSessionRow[]).map(sessionOf)
  },
  setRole: async (owner, id, role) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await lockSession(client, owner, id)
      const selected = await client.query(
        // eslint-disable-next-line no-restricted-syntax -- outside the note-identity hierarchy: one agent session row, no tier below it
        `SELECT ${COLUMNS} FROM agent_sessions WHERE owner = $1 AND id = $2 FOR UPDATE`,
        [owner, id],
      )
      const before = selected.rows[0] as AgentSessionRow | undefined

      if (!before) {
        await client.query('COMMIT')
        return null
      }
      const requestedRoleLocator = serializeAbilityLocator(role.locator)
      let resolvedRoleLocator = requestedRoleLocator

      if (role.locator.source === 'owned' && role.locator.kind === 'role') {
        // A session row is the guard for this mutation, but a placement move may have
        // committed before the guard was acquired. Use a fresh post-guard statement,
        // then compare the LIVE locator so a stale repeat stays an observable no-op.
        const trail = await client.query(
          `SELECT to_locator, registry_note_id, manifest_note_id
             FROM ability_placement_trail WHERE from_locator = $1`,
          [requestedRoleLocator],
        )
        const evidence = trail.rows[0] as
          | {
              to_locator: string
              registry_note_id: string
              manifest_note_id: string
            }
          | undefined
        const live = resolveLiveRoleContextTarget(
          roleContextTargetOfLocator(role.locator),
          evidence
            ? {
                toLocator: evidence.to_locator,
                registryNoteId: evidence.registry_note_id,
                manifestNoteId: evidence.manifest_note_id,
              }
            : null,
        )
        resolvedRoleLocator = serializeAbilityLocator(live.locator)
      }
      const changed =
        before.role !== role.name ||
        before.role_locator !== resolvedRoleLocator ||
        before.role_context_project_id !== role.contextProjectId
      const row = changed
        ? ((
            await client.query(
              `UPDATE agent_sessions
                  SET role = $1,
                      role_locator = $2,
                      role_context_project_id = $3
                WHERE owner = $4 AND id = $5 RETURNING ${COLUMNS}`,
              [role.name, resolvedRoleLocator, role.contextProjectId, owner, id],
            )
          ).rows[0] as AgentSessionRow)
        : before

      if (role.locator.source === 'owned' && role.locator.kind === 'role') {
        if (resolvedRoleLocator !== row.role_locator) {
          throw new Error('invalid Owned Role placement trail destination')
        }
      }
      await client.query('COMMIT')
      return { record: sessionOf(row), changed }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
  prune: async (before) => {
    await ctx.ensureInit()
    const result = await ctx.required.query<{ owner: string }>(
      'DELETE FROM agent_sessions WHERE last_seen_at < $1 RETURNING owner',
      [before],
    )
    return [...new Set(result.rows.map(({ owner }) => owner))].sort()
  },
})
