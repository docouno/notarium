import { accessOfRow, type OAuthAccessRow, type OAuthRefreshRow, refreshOfRow } from '../../rows'
import type {
  OAuthAccessRecord,
  OAuthClientRecord,
  OAuthCodeRecord,
  OAuthPersistence,
  OAuthRefreshRecord,
} from '../../types'
import type { PgDriverCtx } from './context'

export const createOAuthFacet = (ctx: PgDriverCtx): OAuthPersistence => ({
  upsertClient: async (c: OAuthClientRecord) => {
    await ctx.ensureInit()
    await ctx.required.query(
      `INSERT INTO oauth_clients (client_id, kind, redirect_uris, client_name, created_at, last_seen, activated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (client_id) DO UPDATE SET
           kind = EXCLUDED.kind,
           redirect_uris = EXCLUDED.redirect_uris,
           client_name = EXCLUDED.client_name,
           last_seen = EXCLUDED.last_seen,
           activated_at = COALESCE(oauth_clients.activated_at, EXCLUDED.activated_at)`,
      [
        c.clientId,
        c.kind,
        JSON.stringify(c.redirectUris),
        c.clientName,
        c.createdAt,
        c.lastSeen,
        c.activatedAt,
      ],
    )
  },
  upsertPendingClient: async (c, maxPending, pendingBeforeIso) => {
    await ctx.ensureInit()
    const db = await ctx.required.connect()

    try {
      await db.query('BEGIN')
      // Serialize the count+insert decision across every server process. A plain
      // SELECT count under READ COMMITTED lets two registrations claim the last slot.
      // eslint-disable-next-line no-restricted-syntax -- outside the note-identity hierarchy: the OAuth client table has no tier
      await db.query('LOCK TABLE oauth_clients IN SHARE ROW EXCLUSIVE MODE')
      await db.query(
        `DELETE FROM oauth_clients oc
         WHERE oc.activated_at IS NULL AND oc.created_at < $1
           AND NOT EXISTS (SELECT 1 FROM oauth_auth_codes c WHERE c.client_id = oc.client_id AND c.used_at IS NULL AND c.expires_at >= $1)
           AND NOT EXISTS (SELECT 1 FROM oauth_access_tokens a WHERE a.client_id = oc.client_id AND a.revoked_at IS NULL AND a.expires_at >= $1)
           AND NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens r WHERE r.client_id = oc.client_id AND r.revoked_at IS NULL AND r.rotated_to IS NULL AND r.expires_at >= $1)`,
        [pendingBeforeIso],
      )
      const existing = await db.query('SELECT 1 FROM oauth_clients WHERE client_id = $1', [
        c.clientId,
      ])

      if (!existing.rows.length) {
        const count = await db.query(
          'SELECT COUNT(*)::integer AS count FROM oauth_clients WHERE activated_at IS NULL',
        )

        if ((count.rows[0]?.count ?? 0) >= maxPending) {
          await db.query('COMMIT')
          return false
        }
      }
      await db.query(
        `INSERT INTO oauth_clients (client_id, kind, redirect_uris, client_name, created_at, last_seen, activated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (client_id) DO UPDATE SET
           kind = EXCLUDED.kind,
           redirect_uris = EXCLUDED.redirect_uris,
           client_name = EXCLUDED.client_name,
           last_seen = EXCLUDED.last_seen,
           activated_at = COALESCE(oauth_clients.activated_at, EXCLUDED.activated_at)`,
        [
          c.clientId,
          c.kind,
          JSON.stringify(c.redirectUris),
          c.clientName,
          c.createdAt,
          c.lastSeen,
          c.activatedAt,
        ],
      )
      await db.query('COMMIT')
      return true
    } catch (err) {
      await db.query('ROLLBACK')
      throw err
    } finally {
      db.release()
    }
  },
  getClient: async (clientId) => {
    await ctx.ensureInit()
    const r = (
      await ctx.required.query('SELECT * FROM oauth_clients WHERE client_id = $1', [clientId])
    ).rows[0] as
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
    const result = await ctx.required.query(
      `UPDATE oauth_clients
       SET activated_at = COALESCE(activated_at, $1)
       WHERE client_id = $2 AND (activated_at IS NOT NULL OR created_at >= $3)`,
      [activatedAt, clientId, pendingBeforeIso],
    )
    return (result.rowCount ?? 0) > 0
  },

  insertCode: async (c: OAuthCodeRecord) => {
    await ctx.ensureInit()
    await ctx.required.query(
      `INSERT INTO oauth_auth_codes
           (code_hash, client_id, username, redirect_uri, scope, spaces, code_challenge, code_challenge_method, expires_at, used_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
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
      ],
    )
  },
  getCode: async (codeHash) => {
    await ctx.ensureInit()
    const r = (
      await ctx.required.query('SELECT * FROM oauth_auth_codes WHERE code_hash = $1', [codeHash])
    ).rows[0] as
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
    const res = await ctx.required.query(
      'UPDATE oauth_auth_codes SET used_at = $1 WHERE code_hash = $2 AND used_at IS NULL',
      [usedAt, codeHash],
    )
    return (res.rowCount ?? 0) > 0
  },

  insertAccess: async (t: OAuthAccessRecord) => {
    await ctx.ensureInit()
    await ctx.required.query(
      `INSERT INTO oauth_access_tokens
           (id, token_hash, username, client_id, scope, spaces, expires_at, refresh_id, revoked_at, created_at, last_used_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
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
      ],
    )
  },
  getAccess: async (id) => {
    await ctx.ensureInit()
    const r = (await ctx.required.query('SELECT * FROM oauth_access_tokens WHERE id = $1', [id]))
      .rows[0] as OAuthAccessRow | undefined
    return r ? accessOfRow(r) : null
  },
  updateAccess: async (id, patch) => {
    await ctx.ensureInit()
    const sets: string[] = []
    const args: Array<string | null> = []

    if (patch.lastUsedAt !== undefined) {
      sets.push(`last_used_at = $${sets.length + 1}`)
      args.push(patch.lastUsedAt)
    }
    if (patch.revokedAt !== undefined) {
      sets.push(`revoked_at = $${sets.length + 1}`)
      args.push(patch.revokedAt)
    }
    if (patch.scope !== undefined) {
      sets.push(`scope = $${sets.length + 1}`)
      args.push(patch.scope)
    }
    if (patch.spaces !== undefined) {
      sets.push(`spaces = $${sets.length + 1}`)
      args.push(patch.spaces == null ? null : JSON.stringify(patch.spaces))
    }
    if (!sets.length) {
      return
    }
    await ctx.required.query(
      `UPDATE oauth_access_tokens SET ${sets.join(', ')} WHERE id = $${args.length + 1}`,
      [...args, id],
    )
  },
  listAccessForUser: async (username) => {
    await ctx.ensureInit()
    const rows = (
      await ctx.required.query(
        'SELECT * FROM oauth_access_tokens WHERE username = $1 AND revoked_at IS NULL ORDER BY created_at',
        [username],
      )
    ).rows as OAuthAccessRow[]
    return rows.map(accessOfRow)
  },

  insertRefresh: async (t: OAuthRefreshRecord) => {
    await ctx.ensureInit()
    await ctx.required.query(
      `INSERT INTO oauth_refresh_tokens
           (id, token_hash, username, client_id, scope, spaces, expires_at, rotated_to, revoked_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
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
      ],
    )
  },
  getRefresh: async (id) => {
    await ctx.ensureInit()
    const r = (await ctx.required.query('SELECT * FROM oauth_refresh_tokens WHERE id = $1', [id]))
      .rows[0] as OAuthRefreshRow | undefined
    return r ? refreshOfRow(r) : null
  },
  updateRefresh: async (id, patch) => {
    await ctx.ensureInit()
    const sets: string[] = []
    const args: Array<string | null> = []

    if (patch.rotatedTo !== undefined) {
      sets.push(`rotated_to = $${sets.length + 1}`)
      args.push(patch.rotatedTo)
    }
    if (patch.revokedAt !== undefined) {
      sets.push(`revoked_at = $${sets.length + 1}`)
      args.push(patch.revokedAt)
    }
    if (patch.scope !== undefined) {
      sets.push(`scope = $${sets.length + 1}`)
      args.push(patch.scope)
    }
    if (patch.spaces !== undefined) {
      sets.push(`spaces = $${sets.length + 1}`)
      args.push(patch.spaces == null ? null : JSON.stringify(patch.spaces))
    }
    if (!sets.length) {
      return
    }
    await ctx.required.query(
      `UPDATE oauth_refresh_tokens SET ${sets.join(', ')} WHERE id = $${args.length + 1}`,
      [...args, id],
    )
  },
  claimRefreshRotation: async (id, rotatedAt) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      'UPDATE oauth_refresh_tokens SET rotated_to = $1 WHERE id = $2 AND rotated_to IS NULL AND revoked_at IS NULL',
      [rotatedAt, id],
    )
    return (res.rowCount ?? 0) > 0
  },
  listRefreshForUser: async (username) => {
    await ctx.ensureInit()
    const rows = (
      await ctx.required.query(
        'SELECT * FROM oauth_refresh_tokens WHERE username = $1 AND revoked_at IS NULL ORDER BY created_at',
        [username],
      )
    ).rows as OAuthRefreshRow[]
    return rows.map(refreshOfRow)
  },

  pruneExpired: async (beforeIso, pendingBeforeIso) => {
    await ctx.ensureInit()
    await ctx.required.query('DELETE FROM oauth_auth_codes WHERE expires_at < $1', [beforeIso])
    await ctx.required.query('DELETE FROM oauth_access_tokens WHERE expires_at < $1', [beforeIso])
    await ctx.required.query('DELETE FROM oauth_refresh_tokens WHERE expires_at < $1', [beforeIso])
    await ctx.required.query(
      `DELETE FROM oauth_clients oc
       WHERE oc.activated_at IS NULL AND oc.created_at < $1
         AND NOT EXISTS (SELECT 1 FROM oauth_auth_codes c WHERE c.client_id = oc.client_id AND c.used_at IS NULL AND c.expires_at >= $2)
         AND NOT EXISTS (SELECT 1 FROM oauth_access_tokens a WHERE a.client_id = oc.client_id AND a.revoked_at IS NULL AND a.expires_at >= $2)
         AND NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens r WHERE r.client_id = oc.client_id AND r.revoked_at IS NULL AND r.rotated_to IS NULL AND r.expires_at >= $2)`,
      [pendingBeforeIso, beforeIso],
    )
  },
})
