// In-memory OAuthPersistence for the e2e fake (#96): plain Maps behind the same
// interface the SQLite/PG facets implement, so the production OAuth facade
// (discovery, authorize, token, refresh, revoke) and the auth chokepoint run
// UNCHANGED over a world the harness can reset instantly — the #18 posture.

import type {
  OAuthAccessRecord,
  OAuthClientRecord,
  OAuthCodeRecord,
  OAuthPersistence,
  OAuthRefreshRecord,
} from '@notarium/server'

export class InMemoryOAuthPersistence implements OAuthPersistence {
  private clients = new Map<string, OAuthClientRecord>()
  private codes = new Map<string, OAuthCodeRecord>()
  private access = new Map<string, OAuthAccessRecord>()
  private refresh = new Map<string, OAuthRefreshRecord>()

  clear(): void {
    this.clients.clear()
    this.codes.clear()
    this.access.clear()
    this.refresh.clear()
  }

  async upsertClient(c: OAuthClientRecord): Promise<void> {
    const existing = this.clients.get(c.clientId)
    this.clients.set(c.clientId, {
      ...c,
      redirectUris: [...c.redirectUris],
      createdAt: existing?.createdAt ?? c.createdAt,
      activatedAt: existing?.activatedAt ?? c.activatedAt,
    })
  }
  async upsertPendingClient(
    c: OAuthClientRecord,
    maxPending: number,
    pendingBeforeIso: string,
  ): Promise<boolean> {
    this.prunePending(pendingBeforeIso, pendingBeforeIso)
    const existing = this.clients.get(c.clientId)
    const pending = [...this.clients.values()].filter((client) => client.activatedAt == null).length

    if (!existing && pending >= maxPending) {
      return false
    }
    await this.upsertClient(c)
    return true
  }
  async getClient(clientId: string): Promise<OAuthClientRecord | null> {
    const c = this.clients.get(clientId)
    return c ? { ...c, redirectUris: [...c.redirectUris] } : null
  }
  async activateClient(
    clientId: string,
    activatedAt: string,
    pendingBeforeIso: string,
  ): Promise<boolean> {
    const client = this.clients.get(clientId)

    if (!client || (client.activatedAt == null && client.createdAt < pendingBeforeIso)) {
      return false
    }
    client.activatedAt ??= activatedAt
    return true
  }

  async insertCode(c: OAuthCodeRecord): Promise<void> {
    this.codes.set(c.codeHash, { ...c })
  }
  async getCode(codeHash: string): Promise<OAuthCodeRecord | null> {
    const c = this.codes.get(codeHash)
    return c ? { ...c } : null
  }
  async useCode(codeHash: string, usedAt: string): Promise<boolean> {
    const c = this.codes.get(codeHash)

    if (!c || c.usedAt) {
      return false
    }
    c.usedAt = usedAt
    return true
  }

  async insertAccess(t: OAuthAccessRecord): Promise<void> {
    this.access.set(t.id, { ...t })
  }
  async getAccess(id: string): Promise<OAuthAccessRecord | null> {
    const t = this.access.get(id)
    return t ? { ...t } : null
  }
  async updateAccess(
    id: string,
    patch: Partial<Pick<OAuthAccessRecord, 'lastUsedAt' | 'revokedAt' | 'scope' | 'spaces'>>,
  ): Promise<void> {
    const t = this.access.get(id)

    if (!t) {
      return
    }
    if (patch.lastUsedAt !== undefined) {
      t.lastUsedAt = patch.lastUsedAt
    }
    if (patch.revokedAt !== undefined) {
      t.revokedAt = patch.revokedAt
    }
    if (patch.scope !== undefined) {
      t.scope = patch.scope
    }
    if (patch.spaces !== undefined) {
      t.spaces = patch.spaces == null ? null : [...patch.spaces]
    }
  }
  async listAccessForUser(username: string): Promise<OAuthAccessRecord[]> {
    return [...this.access.values()]
      .filter((t) => t.username === username && t.revokedAt == null)
      .map((t) => ({ ...t }))
  }

  async insertRefresh(t: OAuthRefreshRecord): Promise<void> {
    this.refresh.set(t.id, { ...t })
  }
  async getRefresh(id: string): Promise<OAuthRefreshRecord | null> {
    const t = this.refresh.get(id)
    return t ? { ...t } : null
  }
  async updateRefresh(
    id: string,
    patch: Partial<Pick<OAuthRefreshRecord, 'rotatedTo' | 'revokedAt' | 'scope' | 'spaces'>>,
  ): Promise<void> {
    const t = this.refresh.get(id)

    if (!t) {
      return
    }
    if (patch.rotatedTo !== undefined) {
      t.rotatedTo = patch.rotatedTo
    }
    if (patch.revokedAt !== undefined) {
      t.revokedAt = patch.revokedAt
    }
    if (patch.scope !== undefined) {
      t.scope = patch.scope
    }
    if (patch.spaces !== undefined) {
      t.spaces = patch.spaces == null ? null : [...patch.spaces]
    }
  }
  async claimRefreshRotation(id: string, rotatedAt: string): Promise<boolean> {
    const t = this.refresh.get(id)

    if (!t || t.rotatedTo != null || t.revokedAt != null) {
      return false
    }
    t.rotatedTo = rotatedAt
    return true
  }
  async listRefreshForUser(username: string): Promise<OAuthRefreshRecord[]> {
    return [...this.refresh.values()]
      .filter((t) => t.username === username && t.revokedAt == null)
      .map((t) => ({ ...t }))
  }

  async pruneExpired(beforeIso: string, pendingBeforeIso: string): Promise<void> {
    for (const [k, c] of this.codes) {
      if (c.expiresAt < beforeIso) {
        this.codes.delete(k)
      }
    }
    for (const [k, t] of this.access) {
      if (t.expiresAt < beforeIso) {
        this.access.delete(k)
      }
    }
    for (const [k, t] of this.refresh) {
      if (t.expiresAt < beforeIso) {
        this.refresh.delete(k)
      }
    }
    this.prunePending(pendingBeforeIso, beforeIso)
  }

  private prunePending(pendingBeforeIso: string, credentialBeforeIso: string): void {
    for (const [id, client] of this.clients) {
      if (client.activatedAt != null || client.createdAt >= pendingBeforeIso) {
        continue
      }
      const referenced =
        [...this.codes.values()].some(
          (code) =>
            code.clientId === id && code.usedAt == null && code.expiresAt >= credentialBeforeIso,
        ) ||
        [...this.access.values()].some(
          (token) =>
            token.clientId === id &&
            token.revokedAt == null &&
            token.expiresAt >= credentialBeforeIso,
        ) ||
        [...this.refresh.values()].some(
          (token) =>
            token.clientId === id &&
            token.revokedAt == null &&
            token.rotatedTo == null &&
            token.expiresAt >= credentialBeforeIso,
        )

      if (!referenced) {
        this.clients.delete(id)
      }
    }
  }
}
