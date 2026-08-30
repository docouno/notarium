import { patOfRow, type PatRow, userOfRow, type UserRow } from '../../rows'
import type { AuthPersistence, SpaceRole, UserRecord } from '../../types'
import type { SqliteDriverCtx } from './context'

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
        `INSERT INTO users (username, display_name, password_hash, admin, disabled_at, created_at, personal_space)
           SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
      )
      .run(
        u.username,
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
    ctx.required
      .prepare(
        `INSERT INTO users (username, display_name, password_hash, admin, disabled_at, created_at, personal_space)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        u.username,
        u.displayName,
        u.passwordHash,
        u.admin ? 1 : 0,
        u.disabledAt,
        u.createdAt,
        u.personalSpace,
      )
  },
  getUser: async (username: string) => {
    await ctx.ensureInit()
    const r = ctx.required.prepare('SELECT * FROM users WHERE username = ?').get(username) as
      UserRow | undefined
    return r ? userOfRow(r) : null
  },
  getUsers: async (usernames) => {
    if (usernames.length === 0) {
      return []
    }
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare(
        'SELECT * FROM users WHERE username IN (SELECT value FROM json_each(?)) ORDER BY username',
      )
      .all(JSON.stringify([...new Set(usernames)])) as UserRow[]
    return rows.map(userOfRow)
  },
  listUsers: async () => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare('SELECT * FROM users ORDER BY created_at, username')
      .all() as UserRow[]
    return rows.map(userOfRow)
  },
  updateUser: async (username, patch) => {
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
    ctx.required
      .prepare(`UPDATE users SET ${sets.join(', ')} WHERE username = ?`)
      .run(...args, username)
  },

  insertSession: async (s) => {
    await ctx.ensureInit()
    ctx.required
      .prepare(
        `INSERT INTO sessions (id_hash, username, created_at, last_used_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
      )
      .run(s.idHash, s.username, s.createdAt, s.lastUsedAt, s.expiresAt)
  },
  getSession: async (idHash) => {
    await ctx.ensureInit()
    const r = ctx.required.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(idHash) as
      | {
          id_hash: string
          username: string
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
      username: r.username,
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
  deleteSessionsFor: async (username) => {
    await ctx.ensureInit()
    ctx.required.prepare('DELETE FROM sessions WHERE username = ?').run(username)
  },

  insertPat: async (p) => {
    await ctx.ensureInit()
    ctx.required
      .prepare(
        `INSERT INTO pats (id, username, name, secret_hash, scope, spaces, expires_at, last_used_at, revoked_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.id,
        p.username,
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
  listPats: async (username) => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare('SELECT * FROM pats WHERE username = ? ORDER BY created_at, id')
      .all(username) as PatRow[]
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

  grantsFor: async (username) => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare('SELECT space, role FROM space_members WHERE username = ? ORDER BY space')
      .all(username) as Array<{ space: string; role: SpaceRole }>
    return rows.map((r) => ({ space: r.space, role: r.role }))
  },
  grantsForUsers: async (usernames) => {
    if (usernames.length === 0) {
      return []
    }
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare(
        `SELECT username, space, role FROM space_members
          WHERE username IN (SELECT value FROM json_each(?))
          ORDER BY username, space`,
      )
      .all(JSON.stringify([...new Set(usernames)])) as Array<{
      username: string
      space: string
      role: SpaceRole
    }>
    return rows.map((row) => ({ ...row }))
  },
  membersOf: async (space) => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare(
        `SELECT m.username, m.role, u.display_name FROM space_members m
           JOIN users u ON u.username = m.username
           WHERE m.space = ? ORDER BY m.created_at, m.username`,
      )
      .all(space) as Array<{ username: string; role: SpaceRole; display_name: string }>
    return rows.map((r) => ({ username: r.username, displayName: r.display_name, role: r.role }))
  },
  upsertMember: async (space, username, role, createdAt) => {
    await ctx.ensureInit()
    ctx.required
      .prepare(
        `INSERT INTO space_members (space, username, role, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(space, username) DO UPDATE SET role = excluded.role`,
      )
      .run(space, username, role, createdAt)
  },
  removeMember: async (space, username) => {
    await ctx.ensureInit()
    ctx.required
      .prepare('DELETE FROM space_members WHERE space = ? AND username = ?')
      .run(space, username)
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
        `INSERT INTO one_time_tokens (id_hash, username, purpose, expires_at, used_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(t.idHash, t.username, t.purpose, t.expiresAt, t.usedAt, t.createdAt)
  },
  getOneTime: async (idHash) => {
    await ctx.ensureInit()
    const r = ctx.required
      .prepare('SELECT * FROM one_time_tokens WHERE id_hash = ?')
      .get(idHash) as
      | {
          id_hash: string
          username: string
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
      username: r.username,
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
  deleteOneTimesFor: async (username) => {
    await ctx.ensureInit()
    ctx.required.prepare('DELETE FROM one_time_tokens WHERE username = ?').run(username)
  },
})
