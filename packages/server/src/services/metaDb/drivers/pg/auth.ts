import { patOfRow, type PatRow, userOfRow, type UserRow } from '../../rows'
import type { AuthPersistence, SpaceRole, UserRecord, UserWriteResult } from '../../types'
import type { PgDriverCtx } from './context'

const SETUP_LOCK_KEY = 0x6e74_5365 // 'ntSe'

/** Postgres reports the collision as a unique violation on the named constraint —
 *  the ANSWER, not a fault: the handle or the address is already somebody's. */
const UNIQUE_VIOLATION = '23505'
const USER_UNIQUE_FIELD: Record<string, 'username' | 'email'> = {
  users_username_key: 'username',
  users_email_key: 'email',
}

const userConflictOf = (err: unknown): UserWriteResult | null => {
  const { code, constraint } = (err ?? {}) as { code?: string; constraint?: string }
  const field = code === UNIQUE_VIOLATION && constraint ? USER_UNIQUE_FIELD[constraint] : undefined
  return field ? { status: 'conflict', field } : null
}

const USER_COLUMNS =
  'id, username, email, display_name, password_hash, admin, disabled_at, created_at, personal_space'

const userArgs = (u: UserRecord) => [
  u.id,
  u.username,
  u.email,
  u.displayName,
  u.passwordHash,
  u.admin,
  u.disabledAt,
  u.createdAt,
  u.personalSpace,
]

export const createAuthFacet = (ctx: PgDriverCtx): AuthPersistence => ({
  userCount: async () => {
    await ctx.ensureInit()
    const res = await ctx.required.query('SELECT COUNT(*) AS n FROM users')
    return Number(res.rows[0].n)
  },
  createFirstUser: async (u: UserRecord) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      // Both load-bearing: the advisory lock serializes concurrent setups so the NOT EXISTS guard can't race two first-run inserts.
      // canon: docs/auth.md#deployment-the-single-instance-invariant
      // eslint-disable-next-line no-restricted-syntax -- outside the note-identity hierarchy: first-run setup, no tier below it
      await client.query('SELECT pg_advisory_xact_lock($1)', [SETUP_LOCK_KEY])
      const res = await client.query(
        `INSERT INTO users (${USER_COLUMNS})
           SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9 WHERE NOT EXISTS (SELECT 1 FROM users)`,
        userArgs(u),
      )
      await client.query('COMMIT')
      return (res.rowCount ?? 0) > 0
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  },
  createUser: async (u: UserRecord) => {
    await ctx.ensureInit()
    try {
      await ctx.required.query(
        `INSERT INTO users (${USER_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        userArgs(u),
      )
    } catch (err) {
      const conflict = userConflictOf(err)

      if (conflict) {
        return conflict
      }
      throw err
    }

    return { status: 'written' }
  },
  getUser: async (username: string) => {
    await ctx.ensureInit()
    const res = await ctx.required.query('SELECT * FROM users WHERE username = $1', [username])
    return res.rows[0] ? userOfRow(res.rows[0] as UserRow) : null
  },
  getUserByLogin: async (login: { username: string; email: string }) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      'SELECT * FROM users WHERE username = $1 OR email = $2 ORDER BY CASE WHEN username = $1 THEN 0 ELSE 1 END LIMIT 1',
      [login.username, login.email],
    )
    return res.rows[0] ? userOfRow(res.rows[0] as UserRow) : null
  },
  getUserById: async (id: string) => {
    await ctx.ensureInit()
    const res = await ctx.required.query('SELECT * FROM users WHERE id = $1', [id])
    return res.rows[0] ? userOfRow(res.rows[0] as UserRow) : null
  },
  getUsersByIds: async (ids) => {
    if (ids.length === 0) {
      return []
    }
    await ctx.ensureInit()
    const result = await ctx.required.query(
      'SELECT * FROM users WHERE id = ANY($1::text[]) ORDER BY username',
      [[...new Set(ids)]],
    )
    return (result.rows as UserRow[]).map(userOfRow)
  },
  listUsers: async () => {
    await ctx.ensureInit()
    const res = await ctx.required.query('SELECT * FROM users ORDER BY created_at, username')
    return (res.rows as UserRow[]).map(userOfRow)
  },
  updateUser: async (id, patch) => {
    await ctx.ensureInit()
    const sets: string[] = []
    const args: Array<string | boolean | null> = []

    if (patch.displayName !== undefined) {
      args.push(patch.displayName)
      sets.push(`display_name = $${args.length}`)
    }
    if (patch.passwordHash !== undefined) {
      args.push(patch.passwordHash)
      sets.push(`password_hash = $${args.length}`)
    }
    if (patch.admin !== undefined) {
      args.push(patch.admin)
      sets.push(`admin = $${args.length}`)
    }
    if (patch.disabledAt !== undefined) {
      args.push(patch.disabledAt)
      sets.push(`disabled_at = $${args.length}`)
    }
    if (patch.personalSpace !== undefined) {
      args.push(patch.personalSpace)
      sets.push(`personal_space = $${args.length}`)
    }
    if (!sets.length) {
      return
    }
    args.push(id)
    await ctx.required.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${args.length}`, args)
  },
  updateUserIdentity: async (id, patch) => {
    await ctx.ensureInit()
    const sets: string[] = []
    const args: Array<string | null> = []

    if (patch.username !== undefined) {
      args.push(patch.username)
      sets.push(`username = $${args.length}`)
    }
    if (patch.email !== undefined) {
      args.push(patch.email)
      sets.push(`email = $${args.length}`)
    }
    if (!sets.length) {
      return { status: 'written' }
    }
    args.push(id)
    try {
      await ctx.required.query(
        `UPDATE users SET ${sets.join(', ')} WHERE id = $${args.length}`,
        args,
      )
    } catch (err) {
      const conflict = userConflictOf(err)

      if (conflict) {
        return conflict
      }
      throw err
    }

    return { status: 'written' }
  },

  insertSession: async (s) => {
    await ctx.ensureInit()
    await ctx.required.query(
      `INSERT INTO sessions (id_hash, user_id, created_at, last_used_at, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
      [s.idHash, s.userId, s.createdAt, s.lastUsedAt, s.expiresAt],
    )
  },
  getSession: async (idHash) => {
    await ctx.ensureInit()
    const res = await ctx.required.query('SELECT * FROM sessions WHERE id_hash = $1', [idHash])
    const r = res.rows[0] as
      | {
          id_hash: string
          user_id: string
          created_at: string
          last_used_at: string | null
          expires_at: string
        }
      | undefined

    if (!r) {
      return null
    }

    return {
      idHash: r.id_hash,
      userId: r.user_id,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      expiresAt: r.expires_at,
    }
  },
  touchSession: async (idHash, lastUsedAt, expiresAt) => {
    await ctx.ensureInit()
    await ctx.required.query(
      'UPDATE sessions SET last_used_at = $1, expires_at = $2 WHERE id_hash = $3',
      [lastUsedAt, expiresAt, idHash],
    )
  },
  deleteSession: async (idHash) => {
    await ctx.ensureInit()
    await ctx.required.query('DELETE FROM sessions WHERE id_hash = $1', [idHash])
  },
  deleteSessionsFor: async (userId) => {
    await ctx.ensureInit()
    await ctx.required.query('DELETE FROM sessions WHERE user_id = $1', [userId])
  },

  insertPat: async (p) => {
    await ctx.ensureInit()
    await ctx.required.query(
      `INSERT INTO pats (id, user_id, name, secret_hash, scope, spaces, expires_at, last_used_at, revoked_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        p.id,
        p.userId,
        p.name,
        p.secretHash,
        p.scope,
        p.spaces == null ? null : JSON.stringify(p.spaces),
        p.expiresAt,
        p.lastUsedAt,
        p.revokedAt,
        p.createdAt,
      ],
    )
  },
  getPat: async (id) => {
    await ctx.ensureInit()
    const res = await ctx.required.query('SELECT * FROM pats WHERE id = $1', [id])
    return res.rows[0] ? patOfRow(res.rows[0] as PatRow) : null
  },
  listPats: async (userId) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      'SELECT * FROM pats WHERE user_id = $1 ORDER BY created_at, id',
      [userId],
    )
    return (res.rows as PatRow[]).map(patOfRow)
  },
  updatePat: async (id, patch) => {
    await ctx.ensureInit()
    const sets: string[] = []
    const args: Array<string | null> = []

    if (patch.lastUsedAt !== undefined) {
      args.push(patch.lastUsedAt)
      sets.push(`last_used_at = $${args.length}`)
    }
    if (patch.revokedAt !== undefined) {
      args.push(patch.revokedAt)
      sets.push(`revoked_at = $${args.length}`)
    }
    if (patch.scope !== undefined) {
      args.push(patch.scope)
      sets.push(`scope = $${args.length}`)
    }
    if (patch.spaces !== undefined) {
      args.push(patch.spaces == null ? null : JSON.stringify(patch.spaces))
      sets.push(`spaces = $${args.length}`)
    }
    if (patch.name !== undefined) {
      args.push(patch.name)
      sets.push(`name = $${args.length}`)
    }
    if (!sets.length) {
      return
    }
    args.push(id)
    await ctx.required.query(`UPDATE pats SET ${sets.join(', ')} WHERE id = $${args.length}`, args)
  },

  grantsFor: async (userId) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      'SELECT space, role FROM space_members WHERE user_id = $1 ORDER BY space',
      [userId],
    )
    return (res.rows as Array<{ space: string; role: SpaceRole }>).map((r) => ({
      space: r.space,
      role: r.role,
    }))
  },
  grantsForUsers: async (userIds) => {
    if (userIds.length === 0) {
      return []
    }
    await ctx.ensureInit()
    const result = await ctx.required.query(
      `SELECT user_id, space, role FROM space_members
        WHERE user_id = ANY($1::text[])
        ORDER BY user_id, space`,
      [[...new Set(userIds)]],
    )
    return (result.rows as Array<{ user_id: string; space: string; role: SpaceRole }>).map(
      (row) => ({ userId: row.user_id, space: row.space, role: row.role }),
    )
  },
  membersOf: async (space) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      `SELECT m.user_id, m.role, u.username, u.display_name FROM space_members m
         JOIN users u ON u.id = m.user_id
         WHERE m.space = $1 ORDER BY m.created_at, u.username`,
      [space],
    )
    return (
      res.rows as Array<{
        user_id: string
        role: SpaceRole
        username: string
        display_name: string
      }>
    ).map((r) => ({
      userId: r.user_id,
      username: r.username,
      displayName: r.display_name,
      role: r.role,
    }))
  },
  upsertMember: async (space, userId, role, createdAt) => {
    await ctx.ensureInit()
    await ctx.required.query(
      `INSERT INTO space_members (space, user_id, role, created_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (space, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [space, userId, role, createdAt],
    )
  },
  removeMember: async (space, userId) => {
    await ctx.ensureInit()
    await ctx.required.query('DELETE FROM space_members WHERE space = $1 AND user_id = $2', [
      space,
      userId,
    ])
  },
  spacesWithMembers: async () => {
    await ctx.ensureInit()
    const res = await ctx.required.query('SELECT DISTINCT space FROM space_members')
    return (res.rows as Array<{ space: string }>).map((r) => r.space)
  },

  insertOneTime: async (t) => {
    await ctx.ensureInit()
    await ctx.required.query(
      `INSERT INTO one_time_tokens (id_hash, user_id, purpose, expires_at, used_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
      [t.idHash, t.userId, t.purpose, t.expiresAt, t.usedAt, t.createdAt],
    )
  },
  getOneTime: async (idHash) => {
    await ctx.ensureInit()
    const res = await ctx.required.query('SELECT * FROM one_time_tokens WHERE id_hash = $1', [
      idHash,
    ])
    const r = res.rows[0] as
      | {
          id_hash: string
          user_id: string
          purpose: 'invite' | 'reset'
          expires_at: string
          used_at: string | null
          created_at: string
        }
      | undefined

    if (!r) {
      return null
    }

    return {
      idHash: r.id_hash,
      userId: r.user_id,
      purpose: r.purpose,
      expiresAt: r.expires_at,
      usedAt: r.used_at,
      createdAt: r.created_at,
    }
  },
  useOneTime: async (idHash, usedAt) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      'UPDATE one_time_tokens SET used_at = $1 WHERE id_hash = $2 AND used_at IS NULL',
      [usedAt, idHash],
    )
    return (res.rowCount ?? 0) > 0
  },
  deleteOneTimesFor: async (userId) => {
    await ctx.ensureInit()
    await ctx.required.query('DELETE FROM one_time_tokens WHERE user_id = $1', [userId])
  },
})
