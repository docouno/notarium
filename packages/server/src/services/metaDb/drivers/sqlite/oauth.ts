import { accessOfRow, type OAuthAccessRow, type OAuthRefreshRow, refreshOfRow } from '../../rows'
import type {
  OAuthAccessRecord,
  OAuthClientRecord,
  OAuthCodeRecord,
  OAuthPersistence,
  OAuthRefreshRecord,
} from '../../types'
import type { SqliteDriverCtx } from './context'

export const createOAuthFacet = (ctx: SqliteDriverCtx): OAuthPersistence => ({
  upsertClient: async (c: OAuthClientRecord) => {
    await ctx.ensureInit()
    ctx.required
      .prepare(
        `INSERT INTO oauth_clients (client_id, kind, redirect_uris, client_name, created_at, last_seen, activated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(client_id) DO UPDATE SET
             kind = excluded.kind,
             redirect_uris = excluded.redirect_uris,
             client_name = excluded.client_name,
             last_seen = excluded.last_seen,
             activated_at = COALESCE(oauth_clients.activated_at, excluded.activated_at)`,
      )
      .run(
        c.clientId,
        c.kind,
        JSON.stringify(c.redirectUris),
        c.clientName,
        c.createdAt,
        c.lastSeen,
        c.activatedAt,
      )
  },
  upsertPendingClient: async (c, maxPending, pendingBeforeIso) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(
        `DELETE FROM oauth_clients
         WHERE activated_at IS NULL AND created_at < ?
           AND NOT EXISTS (SELECT 1 FROM oauth_auth_codes c WHERE c.client_id = oauth_clients.client_id AND c.used_at IS NULL AND c.expires_at >= ?)
           AND NOT EXISTS (SELECT 1 FROM oauth_access_tokens a WHERE a.client_id = oauth_clients.client_id AND a.revoked_at IS NULL AND a.expires_at >= ?)
           AND NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens r WHERE r.client_id = oauth_clients.client_id AND r.revoked_at IS NULL AND r.rotated_to IS NULL AND r.expires_at >= ?)`,
      ).run(pendingBeforeIso, pendingBeforeIso, pendingBeforeIso, pendingBeforeIso)
      const existing = db
        .prepare('SELECT 1 AS yes FROM oauth_clients WHERE client_id = ?')
        .get(c.clientId)

      if (!existing) {
        const pending = db
          .prepare('SELECT COUNT(*) AS count FROM oauth_clients WHERE activated_at IS NULL')
          .get() as { count: number }

        if (pending.count >= maxPending) {
          db.exec('COMMIT')
          return false
        }
      }
      db.prepare(
        `INSERT INTO oauth_clients (client_id, kind, redirect_uris, client_name, created_at, last_seen, activated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(client_id) DO UPDATE SET
           kind = excluded.kind,
           redirect_uris = excluded.redirect_uris,
           client_name = excluded.client_name,
           last_seen = excluded.last_seen,
           activated_at = COALESCE(oauth_clients.activated_at, excluded.activated_at)`,
      ).run(
        c.clientId,
        c.kind,
        JSON.stringify(c.redirectUris),
        c.clientName,
        c.createdAt,
        c.lastSeen,
        c.activatedAt,
      )
      db.exec('COMMIT')
      return true
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  },
  getClient: async (clientId) => {
    await ctx.ensureInit()
    const r = ctx.required
      .prepare('SELECT * FROM oauth_clients WHERE client_id = ?')
      .get(clientId) as
      | {
          client_id: string
          kind: string
          redirect_uris: string
          client_name: string | null
          created_at: string
          last_seen: string
          activated_at: string | null
        }
      | undefined

    if (!r) {
      return null
    }

    return {
      clientId: r.client_id,
      kind: r.kind as OAuthClientRecord['kind'],
      redirectUris: JSON.parse(r.redirect_uris) as string[],
      clientName: r.client_name,
      createdAt: r.created_at,
      lastSeen: r.last_seen,
      activatedAt: r.activated_at,
    }
  },
  activateClient: async (clientId, activatedAt, pendingBeforeIso) => {
    await ctx.ensureInit()
    const result = ctx.required
      .prepare(
        `UPDATE oauth_clients
         SET activated_at = COALESCE(activated_at, ?)
         WHERE client_id = ? AND (activated_at IS NOT NULL OR created_at >= ?)`,
      )
      .run(activatedAt, clientId, pendingBeforeIso)
    return result.changes > 0
  },

  insertCode: async (c: OAuthCodeRecord) => {
    await ctx.ensureInit()
    ctx.required
      .prepare(
        `INSERT INTO oauth_auth_codes
             (code_hash, client_id, username, redirect_uri, scope, spaces, code_challenge, code_challenge_method, expires_at, used_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.codeHash,
        c.clientId,
        c.username,
        c.redirectUri,
        c.scope,
        c.spaces == null ? null : JSON.stringify(c.spaces),
        c.codeChallenge,
        c.codeChallengeMethod,
        c.expiresAt,
        c.usedAt,
        c.createdAt,
      )
  },
  getCode: async (codeHash) => {
    await ctx.ensureInit()
    const r = ctx.required
      .prepare('SELECT * FROM oauth_auth_codes WHERE code_hash = ?')
      .get(codeHash) as
      | {
          code_hash: string
          client_id: string
          username: string
          redirect_uri: string
          scope: string
          spaces: string | null
          code_challenge: string
          code_challenge_method: string
          expires_at: string
          used_at: string | null
          created_at: string
        }
      | undefined

    if (!r) {
      return null
    }

    return {
      codeHash: r.code_hash,
      clientId: r.client_id,
      username: r.username,
      redirectUri: r.redirect_uri,
      scope: r.scope,
      spaces: r.spaces == null ? null : (JSON.parse(r.spaces) as string[]),
      codeChallenge: r.code_challenge,
      codeChallengeMethod: r.code_challenge_method,
      expiresAt: r.expires_at,
      usedAt: r.used_at,
      createdAt: r.created_at,
    }
  },
  useCode: async (codeHash, usedAt) => {
    await ctx.ensureInit()
    const res = ctx.required
      .prepare('UPDATE oauth_auth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL')
      .run(usedAt, codeHash)
    return res.changes > 0
  },

  insertAccess: async (t: OAuthAccessRecord) => {
    await ctx.ensureInit()
    ctx.required
      .prepare(
        `INSERT INTO oauth_access_tokens
             (id, token_hash, username, client_id, scope, spaces, expires_at, refresh_id, revoked_at, created_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.id,
        t.tokenHash,
        t.username,
        t.clientId,
        t.scope,
        t.spaces == null ? null : JSON.stringify(t.spaces),
        t.expiresAt,
        t.refreshId,
        t.revokedAt,
        t.createdAt,
        t.lastUsedAt,
      )
  },
  getAccess: async (id) => {
    await ctx.ensureInit()
    const r = ctx.required.prepare('SELECT * FROM oauth_access_tokens WHERE id = ?').get(id) as
      OAuthAccessRow | undefined
    return r ? accessOfRow(r) : null
  },
  updateAccess: async (id, patch) => {
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
    if (!sets.length) {
      return
    }
    ctx.required
      .prepare(`UPDATE oauth_access_tokens SET ${sets.join(', ')} WHERE id = ?`)
      .run(...args, id)
  },
  listAccessForUser: async (username) => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare(
        'SELECT * FROM oauth_access_tokens WHERE username = ? AND revoked_at IS NULL ORDER BY created_at',
      )
      .all(username) as OAuthAccessRow[]
    return rows.map(accessOfRow)
  },

  insertRefresh: async (t: OAuthRefreshRecord) => {
    await ctx.ensureInit()
    ctx.required
      .prepare(
        `INSERT INTO oauth_refresh_tokens
             (id, token_hash, username, client_id, scope, spaces, expires_at, rotated_to, revoked_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.id,
        t.tokenHash,
        t.username,
        t.clientId,
        t.scope,
        t.spaces == null ? null : JSON.stringify(t.spaces),
        t.expiresAt,
        t.rotatedTo,
        t.revokedAt,
        t.createdAt,
      )
  },
  getRefresh: async (id) => {
    await ctx.ensureInit()
    const r = ctx.required.prepare('SELECT * FROM oauth_refresh_tokens WHERE id = ?').get(id) as
      OAuthRefreshRow | undefined
    return r ? refreshOfRow(r) : null
  },
  updateRefresh: async (id, patch) => {
    await ctx.ensureInit()
    const sets: string[] = []
    const args: Array<string | null> = []

    if (patch.rotatedTo !== undefined) {
      sets.push('rotated_to = ?')
      args.push(patch.rotatedTo)
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
    if (!sets.length) {
      return
    }
    ctx.required
      .prepare(`UPDATE oauth_refresh_tokens SET ${sets.join(', ')} WHERE id = ?`)
      .run(...args, id)
  },
  claimRefreshRotation: async (id, rotatedAt) => {
    await ctx.ensureInit()
    const res = ctx.required
      .prepare(
        'UPDATE oauth_refresh_tokens SET rotated_to = ? WHERE id = ? AND rotated_to IS NULL AND revoked_at IS NULL',
      )
      .run(rotatedAt, id)
    return res.changes > 0
  },
  listRefreshForUser: async (username) => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare(
        'SELECT * FROM oauth_refresh_tokens WHERE username = ? AND revoked_at IS NULL ORDER BY created_at',
      )
      .all(username) as OAuthRefreshRow[]
    return rows.map(refreshOfRow)
  },

  pruneExpired: async (beforeIso, pendingBeforeIso) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.prepare('DELETE FROM oauth_auth_codes WHERE expires_at < ?').run(beforeIso)
    db.prepare('DELETE FROM oauth_access_tokens WHERE expires_at < ?').run(beforeIso)
    db.prepare('DELETE FROM oauth_refresh_tokens WHERE expires_at < ?').run(beforeIso)
    db.prepare(
      `DELETE FROM oauth_clients
       WHERE activated_at IS NULL AND created_at < ?
         AND NOT EXISTS (SELECT 1 FROM oauth_auth_codes c WHERE c.client_id = oauth_clients.client_id AND c.used_at IS NULL AND c.expires_at >= ?)
         AND NOT EXISTS (SELECT 1 FROM oauth_access_tokens a WHERE a.client_id = oauth_clients.client_id AND a.revoked_at IS NULL AND a.expires_at >= ?)
         AND NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens r WHERE r.client_id = oauth_clients.client_id AND r.revoked_at IS NULL AND r.rotated_to IS NULL AND r.expires_at >= ?)`,
    ).run(pendingBeforeIso, beforeIso, beforeIso, beforeIso)
  },
})
