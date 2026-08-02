// In-memory AuthPersistence for the e2e fake (#10): plain Maps behind the
// same interface the SQLite/PG facets implement, so the production
// AuthService (hashing, sessions, invites, can()-grants) runs UNCHANGED over
// a world the harness can reset instantly. Deterministic and dependency-free —
// the executable-spec posture of #18.

import type {
  AuthPersistence,
  MemberRecord,
  OneTimeTokenRecord,
  PatRecord,
  SessionRecord,
  UserRecord,
} from '@notarium/server'

export class InMemoryAuthPersistence implements AuthPersistence {
  private users = new Map<string, UserRecord>()
  private sessions = new Map<string, SessionRecord>()
  private pats = new Map<string, PatRecord>()
  private members = new Map<string, MemberRecord>() // `${space}\0${username}`
  private oneTimes = new Map<string, OneTimeTokenRecord>()

  clear(): void {
    this.users.clear()
    this.sessions.clear()
    this.pats.clear()
    this.members.clear()
    this.oneTimes.clear()
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
    this.users.set(user.username, { ...user })
    return true
  }
  async createUser(user: UserRecord): Promise<void> {
    if (this.users.has(user.username)) {
      throw new Error(`duplicate username ${user.username}`)
    }
    this.users.set(user.username, { ...user })
  }
  async getUser(username: string): Promise<UserRecord | null> {
    const u = this.users.get(username)
    return u ? { ...u } : null
  }
  async listUsers(): Promise<UserRecord[]> {
    return [...this.users.values()].map((u) => ({ ...u }))
  }
  async updateUser(
    username: string,
    patch: Partial<
      Pick<UserRecord, 'displayName' | 'passwordHash' | 'admin' | 'disabledAt' | 'personalSpace'>
    >,
  ): Promise<void> {
    const u = this.users.get(username)

    if (u) {
      Object.assign(u, patch)
    }
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
  async deleteSessionsFor(username: string): Promise<void> {
    for (const [k, s] of this.sessions) {
      if (s.username === username) {
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
  async listPats(username: string): Promise<PatRecord[]> {
    return [...this.pats.values()]
      .filter((p) => p.username === username)
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

  private memberKey(space: string, username: string): string {
    return `${space}\0${username}`
  }
  async grantsFor(username: string): Promise<Array<{ space: string; role: MemberRecord['role'] }>> {
    return [...this.members.values()]
      .filter((m) => m.username === username)
      .map((m) => ({ space: m.space, role: m.role }))
  }
  async membersOf(
    space: string,
  ): Promise<Array<{ username: string; displayName: string; role: MemberRecord['role'] }>> {
    return [...this.members.values()]
      .filter((m) => m.space === space && this.users.has(m.username))
      .map((m) => ({
        username: m.username,
        displayName: this.users.get(m.username)?.displayName ?? m.username,
        role: m.role,
      }))
  }
  async upsertMember(
    space: string,
    username: string,
    role: MemberRecord['role'],
    createdAt: string,
  ): Promise<void> {
    const key = this.memberKey(space, username)
    const cur = this.members.get(key)

    if (cur) {
      cur.role = role
    } else {
      this.members.set(key, { space, username, role, createdAt })
    }
  }
  async removeMember(space: string, username: string): Promise<void> {
    this.members.delete(this.memberKey(space, username))
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
  async deleteOneTimesFor(username: string): Promise<void> {
    for (const [k, t] of this.oneTimes) {
      if (t.username === username) {
        this.oneTimes.delete(k)
      }
    }
  }
}
