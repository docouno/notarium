import { patOfRow, type PatRow, userOfRow, type UserRow } from '../../rows'
import type { AuthPersistence, SpaceRole, UserRecord, UserWriteResult } from '../../types'
import type { SqliteDriverCtx } from './context'

const USER_COLUMNS =
  'id, username, email, display_name, password_hash, admin, disabled_at, created_at, personal_space'

/** The UNIQUE on `username` / `email` IS the arbiter: name the attribute that collided. */
const userConflictOf = (err: unknown): UserWriteResult | null => {
  const match = /UNIQUE constraint failed: users\.(username|email)/.exec(String(err))
  return match ? { status: 'conflict', field: match[1] as 'username' | 'email' } : null
}

export const createAuthFacet = (ctx: SqliteDriverCtx): AuthPersistence => ({
  userCount: async () => {
    await ctx.ensureInit()
    return (ctx.required.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n
  },
  createFirstUser: async (u: UserRecord) => {
    await ctx.ensureInit()
    // One conditional statement: node:sqlite runs it synchronously, without
    // yielding the event loop, so the NOT EXISTS guard and the insert are
    // atomic — concurrent setups can't both observe zero users.
    const res = ctx.required
      .prepare(
        `INSERT INTO users (${USER_COLUMNS})
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
      )
      .run(
        u.id,
        u.username,
        u.email,
        u.displayName,
        u.passwordHash,
        u.admin ? 1 : 0,
        u.disabledAt,
        u.createdAt,
        u.personalSpace,
      )
    return res.changes > 0
  },
  createUser: async (u: UserRecord) => {
    await ctx.ensureInit()
    try {
      ctx.required
        .prepare(`INSERT INTO users (${USER_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          u.id,
          u.username,
          u.email,
          u.displayName,
          u.passwordHash,
          u.admin ? 1 : 0,
          u.disabledAt,
          u.createdAt,
          u.personalSpace,
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
    const r = ctx.required.prepare('SELECT * FROM users WHERE username = ?').get(username) as
      UserRow | undefined
    return r ? userOfRow(r) : null
  },
  getUserByLogin: async (login: { username: string; email: string }) => {
    await ctx.ensureInit()
    const r = ctx.required
      .prepare(
        'SELECT * FROM users WHERE username = ? OR email = ? ORDER BY CASE WHEN username = ? THEN 0 ELSE 1 END LIMIT 1',
      )
      .get(login.username, login.email, login.username) as UserRow | undefined
    return r ? userOfRow(r) : null
  },
  getUserById: async (id: string) => {
    await ctx.ensureInit()
    const r = ctx.required.prepare('SELECT * FROM users WHERE id = ?').get(id) as
      UserRow | undefined
    return r ? userOfRow(r) : null
  },
  getUsersByIds: async (ids) => {
    if (ids.length === 0) {
      return []
    }
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare('SELECT * FROM users WHERE id IN (SELECT value FROM json_each(?)) ORDER BY username')
      .all(JSON.stringify([...new Set(ids)])) as UserRow[]
    return rows.map(userOfRow)
  },
  listUsers: async () => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare('SELECT * FROM users ORDER BY created_at, username')
      .all() as UserRow[]
    return rows.map(userOfRow)
  },
  updateUser: async (id, patch) => {
    await ctx.ensureInit()
    const sets: string[] = []
    const args: Array<string | number | null> = []

    if (patch.displayName !== undefined) {
      sets.push('display_name = ?')
      args.push(patch.displayName)
    }
    if (patch.passwordHash !== undefined) {
      sets.push('password_hash = ?')
      args.push(patch.passwordHash)
    }
    if (patch.admin !== undefined) {
      sets.push('admin = ?')
      args.push(patch.admin ? 1 : 0)
    }
    if (patch.disabledAt !== undefined) {
      sets.push('disabled_at = ?')
      args.push(patch.disabledAt)
    }
    if (patch.personalSpace !== undefined) {
      sets.push('personal_space = ?')
      args.push(patch.personalSpace)
    }
    if (!sets.length) {
      return
    }
    ctx.required.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args, id)
  },
  updateUserIdentity: async (id, patch) => {
    await ctx.ensureInit()
    const sets: string[] = []
    const args: Array<string | null> = []

    if (patch.username !== undefined) {
      sets.push('username = ?')
      args.push(patch.username)
    }
    if (patch.email !== undefined) {
      sets.push('email = ?')
      args.push(patch.email)
    }
    if (!sets.length) {
      return { status: 'written' }
    }
    try {
      ctx.required.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args, id)
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
    ctx.required
      .prepare(
        `INSERT INTO sessions (id_hash, user_id, created_at, last_used_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
      )
      .run(s.idHash, s.userId, s.createdAt, s.lastUsedAt, s.expiresAt)
  },
  getSession: async (idHash) => {
    await ctx.ensureInit()
    const r = ctx.required.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(idHash) as
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
    ctx.required
      .prepare('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id_hash = ?')
      .run(lastUsedAt, expiresAt, idHash)
  },
  deleteSession: async (idHash) => {
    await ctx.ensureInit()
    ctx.required.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash)
  },
  deleteSessionsFor: async (userId) => {
    await ctx.ensureInit()
    ctx.required.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
  },

  insertPat: async (p) => {
    await ctx.ensureInit()
    ctx.required
      .prepare(
        `INSERT INTO pats (id, user_id, name, secret_hash, scope, spaces, expires_at, last_used_at, revoked_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
      )
  },
  getPat: async (id) => {
    await ctx.ensureInit()
    const r = ctx.required.prepare('SELECT * FROM pats WHERE id = ?').get(id) as PatRow | undefined
    return r ? patOfRow(r) : null
  },
  listPats: async (userId) => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare('SELECT * FROM pats WHERE user_id = ? ORDER BY created_at, id')
      .all(userId) as PatRow[]
    return rows.map(patOfRow)
  },
  updatePat: async (id, patch) => {
    await ctx.ensureInit()
    const sets: string[] = []
    const args: Array<string | null> = []

    if (patch.lastUsedAt !== undefined) {
      sets.push('last_used_at = ?')
      args.push(patch.lastUsedAt)
    }
    if (patch.revokedAt !== undefined) {
      sets.push('revoked_at = ?')
      args.push(patch.revokedAt)
    }
    if (patch.scope !== undefined) {
      sets.push('scope = ?')
      args.push(patch.scope)
    }
    if (patch.spaces !== undefined) {
      sets.push('spaces = ?')
      args.push(patch.spaces == null ? null : JSON.stringify(patch.spaces))
    }
    if (patch.name !== undefined) {
      sets.push('name = ?')
      args.push(patch.name)
    }
    if (!sets.length) {
      return
    }
    ctx.required.prepare(`UPDATE pats SET ${sets.join(', ')} WHERE id = ?`).run(...args, id)
  },

  grantsFor: async (userId) => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare('SELECT space, role FROM space_members WHERE user_id = ? ORDER BY space')
      .all(userId) as Array<{ space: string; role: SpaceRole }>
    return rows.map((r) => ({ space: r.space, role: r.role }))
  },
  grantsForUsers: async (userIds) => {
    if (userIds.length === 0) {
      return []
    }
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare(
        `SELECT user_id, space, role FROM space_members
          WHERE user_id IN (SELECT value FROM json_each(?))
          ORDER BY user_id, space`,
      )
      .all(JSON.stringify([...new Set(userIds)])) as Array<{
      user_id: string
      space: string
      role: SpaceRole
    }>
    return rows.map((row) => ({ userId: row.user_id, space: row.space, role: row.role }))
  },
  membersOf: async (space) => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare(
        `SELECT m.user_id, m.role, u.username, u.display_name FROM space_members m
           JOIN users u ON u.id = m.user_id
           WHERE m.space = ? ORDER BY m.created_at, u.username`,
      )
      .all(space) as Array<{
      user_id: string
      role: SpaceRole
      username: string
      display_name: string
    }>
    return rows.map((r) => ({
      userId: r.user_id,
      username: r.username,
      displayName: r.display_name,
      role: r.role,
    }))
  },
  upsertMember: async (space, userId, role, createdAt) => {
    await ctx.ensureInit()
    ctx.required
      .prepare(
        `INSERT INTO space_members (space, user_id, role, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(space, user_id) DO UPDATE SET role = excluded.role`,
      )
      .run(space, userId, role, createdAt)
  },
  removeMember: async (space, userId) => {
    await ctx.ensureInit()
    ctx.required
      .prepare('DELETE FROM space_members WHERE space = ? AND user_id = ?')
      .run(space, userId)
  },
  spacesWithMembers: async () => {
    await ctx.ensureInit()
    const rows = ctx.required.prepare('SELECT DISTINCT space FROM space_members').all() as Array<{
      space: string
    }>
    return rows.map((r) => r.space)
  },

  insertOneTime: async (t) => {
    await ctx.ensureInit()
    ctx.required
      .prepare(
        `INSERT INTO one_time_tokens (id_hash, user_id, purpose, expires_at, used_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(t.idHash, t.userId, t.purpose, t.expiresAt, t.usedAt, t.createdAt)
  },
  getOneTime: async (idHash) => {
    await ctx.ensureInit()
    const r = ctx.required
      .prepare('SELECT * FROM one_time_tokens WHERE id_hash = ?')
      .get(idHash) as
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
    const res = ctx.required
      .prepare('UPDATE one_time_tokens SET used_at = ? WHERE id_hash = ? AND used_at IS NULL')
      .run(usedAt, idHash)
    return res.changes > 0
  },
  deleteOneTimesFor: async (userId) => {
    await ctx.ensureInit()
    ctx.required.prepare('DELETE FROM one_time_tokens WHERE user_id = ?').run(userId)
  },
})
