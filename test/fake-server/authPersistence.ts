// In-memory AuthPersistence for the e2e fake (#10): plain Maps behind the
// same interface the SQLite/PG facets implement, so the production
// AuthService (hashing, sessions, invites, can()-grants) runs UNCHANGED over
// a world the harness can reset instantly. Deterministic and dependency-free —
// the executable-spec posture of #18. Users key by their stable id, exactly like
// the meta-DB after the identity carrier; the handle is a secondary index.

import type {
  AuthPersistence,
  MemberRecord,
  OneTimeTokenRecord,
  PatRecord,
  SessionRecord,
  UserIdentityPatch,
  UserRecord,
  UserWriteResult,
} from '@notarium/server'

export class InMemoryAuthPersistence implements AuthPersistence {
  private users = new Map<string, UserRecord>() // by stable id
  private sessions = new Map<string, SessionRecord>()
  private pats = new Map<string, PatRecord>()
  private members = new Map<string, MemberRecord>() // `${space}\0${userId}`
  private oneTimes = new Map<string, OneTimeTokenRecord>()

  clear(): void {
    this.users.clear()
    this.sessions.clear()
    this.pats.clear()
    this.members.clear()
    this.oneTimes.clear()
  }

  private byUsername(username: string): UserRecord | undefined {
    for (const user of this.users.values()) {
      if (user.username === username) {
        return user
      }
    }

    return undefined
  }

  /** The unique keys ARE the check, mirroring the drivers' UNIQUE constraints: a
   *  colliding handle or address is the `conflict` outcome, never a thrown error. */
  private conflictOf(candidate: {
    id?: string
    username?: string
    email?: string | null
  }): UserWriteResult | null {
    for (const user of this.users.values()) {
      if (user.id === candidate.id) {
        continue
      }
      if (candidate.username !== undefined && user.username === candidate.username) {
        return { status: 'conflict', field: 'username' }
      }
      if (candidate.email != null && user.email === candidate.email) {
        return { status: 'conflict', field: 'email' }
      }
    }

    return null
  }

  async userCount(): Promise<number> {
    return this.users.size
  }
  async createFirstUser(user: UserRecord): Promise<boolean> {
    // Single-threaded JS: no await between the check and the set, so this is
    // atomic by construction — the production drivers earn the same via a
    // conditional INSERT (SQLite) / advisory lock (PG).
    if (this.users.size > 0) {
      return false
    }
    this.users.set(user.id, { ...user })
    return true
  }
  async createUser(user: UserRecord): Promise<UserWriteResult> {
    if (this.users.has(user.id)) {
      throw new Error(`duplicate user id ${user.id}`)
    }
    const conflict = this.conflictOf(user)

    if (conflict) {
      return conflict
    }
    this.users.set(user.id, { ...user })
    return { status: 'written' }
  }
  async getUser(username: string): Promise<UserRecord | null> {
    const u = this.byUsername(username)
    return u ? { ...u } : null
  }
  async getUserByLogin(login: { username: string; email: string }): Promise<UserRecord | null> {
    const byHandle = this.byUsername(login.username)

    if (byHandle) {
      return { ...byHandle }
    }
    for (const user of this.users.values()) {
      if (user.email !== null && user.email === login.email) {
        return { ...user }
      }
    }

    return null
  }
  async getUserById(id: string): Promise<UserRecord | null> {
    const u = this.users.get(id)
    return u ? { ...u } : null
  }
  async getUsersByIds(ids: readonly string[]): Promise<UserRecord[]> {
    return [...new Set(ids)].flatMap((id) => {
      const u = this.users.get(id)
      return u ? [{ ...u }] : []
    })
  }
  async listUsers(): Promise<UserRecord[]> {
    return [...this.users.values()].map((u) => ({ ...u }))
  }
  async updateUser(
    id: string,
    patch: Partial<
      Pick<UserRecord, 'displayName' | 'passwordHash' | 'admin' | 'disabledAt' | 'personalSpace'>
    >,
  ): Promise<void> {
    const u = this.users.get(id)

    if (u) {
      Object.assign(u, patch)
    }
  }
  async updateUserIdentity(id: string, patch: UserIdentityPatch): Promise<UserWriteResult> {
    const u = this.users.get(id)

    if (!u) {
      return { status: 'written' }
    }
    const conflict = this.conflictOf({ id, ...patch })

    if (conflict) {
      return conflict
    }
    if (patch.username !== undefined) {
      u.username = patch.username
    }
    if (patch.email !== undefined) {
      u.email = patch.email
    }

    return { status: 'written' }
  }

  async insertSession(s: SessionRecord): Promise<void> {
    this.sessions.set(s.idHash, { ...s })
  }
  async getSession(idHash: string): Promise<SessionRecord | null> {
    const s = this.sessions.get(idHash)
    return s ? { ...s } : null
  }
  async touchSession(idHash: string, lastUsedAt: string, expiresAt: string): Promise<void> {
    const s = this.sessions.get(idHash)

    if (s) {
      Object.assign(s, { lastUsedAt, expiresAt })
    }
  }
  async deleteSession(idHash: string): Promise<void> {
    this.sessions.delete(idHash)
  }
  async deleteSessionsFor(userId: string): Promise<void> {
    for (const [k, s] of this.sessions) {
      if (s.userId === userId) {
        this.sessions.delete(k)
      }
    }
  }

  async insertPat(p: PatRecord): Promise<void> {
    this.pats.set(p.id, { ...p, spaces: p.spaces ? [...p.spaces] : null })
  }
  async getPat(id: string): Promise<PatRecord | null> {
    const p = this.pats.get(id)
    return p ? { ...p, spaces: p.spaces ? [...p.spaces] : null } : null
  }
  async listPats(userId: string): Promise<PatRecord[]> {
    return [...this.pats.values()]
      .filter((p) => p.userId === userId)
      .map((p) => ({ ...p, spaces: p.spaces ? [...p.spaces] : null }))
  }
  async updatePat(
    id: string,
    patch: Partial<Pick<PatRecord, 'lastUsedAt' | 'revokedAt' | 'scope' | 'spaces' | 'name'>>,
  ): Promise<void> {
    const p = this.pats.get(id)

    if (!p) {
      return
    }
    if (patch.lastUsedAt !== undefined) {
      p.lastUsedAt = patch.lastUsedAt
    }
    if (patch.revokedAt !== undefined) {
      p.revokedAt = patch.revokedAt
    }
    if (patch.scope !== undefined) {
      p.scope = patch.scope
    }
    if (patch.name !== undefined) {
      p.name = patch.name
    }
    // Clone the narrowing list (null = all) — the stored record must not alias
    // the caller's array, mirroring insertPat.
    if (patch.spaces !== undefined) {
      p.spaces = patch.spaces ? [...patch.spaces] : null
    }
  }

  private memberKey(space: string, userId: string): string {
    return `${space}\0${userId}`
  }
  async grantsFor(userId: string): Promise<Array<{ space: string; role: MemberRecord['role'] }>> {
    return [...this.members.values()]
      .filter((m) => m.userId === userId)
      .map((m) => ({ space: m.space, role: m.role }))
  }
  async grantsForUsers(
    userIds: readonly string[],
  ): Promise<Array<{ userId: string; space: string; role: MemberRecord['role'] }>> {
    const wanted = new Set(userIds)
    return [...this.members.values()]
      .filter((m) => wanted.has(m.userId))
      .map((m) => ({ userId: m.userId, space: m.space, role: m.role }))
  }
  async membersOf(space: string): Promise<
    Array<{
      userId: string
      username: string
      displayName: string
      role: MemberRecord['role']
    }>
  > {
    return [...this.members.values()]
      .filter((m) => m.space === space && this.users.has(m.userId))
      .map((m) => {
        const user = this.users.get(m.userId)!
        return {
          userId: m.userId,
          username: user.username,
          displayName: user.displayName,
          role: m.role,
        }
      })
  }
  async upsertMember(
    space: string,
    userId: string,
    role: MemberRecord['role'],
    createdAt: string,
  ): Promise<void> {
    const key = this.memberKey(space, userId)
    const cur = this.members.get(key)

    if (cur) {
      cur.role = role
    } else {
      this.members.set(key, { space, userId, role, createdAt })
    }
  }
  async removeMember(space: string, userId: string): Promise<void> {
    this.members.delete(this.memberKey(space, userId))
  }
  async spacesWithMembers(): Promise<string[]> {
    return [...new Set([...this.members.values()].map((m) => m.space))]
  }

  async insertOneTime(t: OneTimeTokenRecord): Promise<void> {
    this.oneTimes.set(t.idHash, { ...t })
  }
  async getOneTime(idHash: string): Promise<OneTimeTokenRecord | null> {
    const t = this.oneTimes.get(idHash)
    return t ? { ...t } : null
  }
  async useOneTime(idHash: string, usedAt: string): Promise<boolean> {
    const t = this.oneTimes.get(idHash)

    if (!t || t.usedAt) {
      return false
    }
    t.usedAt = usedAt
    return true
  }
  async deleteOneTimesFor(userId: string): Promise<void> {
    for (const [k, t] of this.oneTimes) {
      if (t.userId === userId) {
        this.oneTimes.delete(k)
      }
    }
  }
}
