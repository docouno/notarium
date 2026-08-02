import type { GatewayStatePersistence } from '../../types'
import type { PgDriverCtx } from './context'

export const createGatewayFacet = (ctx: PgDriverCtx): GatewayStatePersistence => ({
  bookmarkGet: async (principalId, space) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      'SELECT last_rev FROM mcp_bookmarks WHERE principal_id = $1 AND space = $2',
      [principalId, space],
    )
    return (res.rows[0] as { last_rev: string } | undefined)?.last_rev ?? null
  },
  bookmarkSet: async (principalId, space, lastRev, updatedAt) => {
    await ctx.ensureInit()
    await ctx.required.query(
      `INSERT INTO mcp_bookmarks (principal_id, space, last_rev, updated_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (principal_id, space) DO UPDATE
           SET last_rev = EXCLUDED.last_rev, updated_at = EXCLUDED.updated_at
         WHERE mcp_bookmarks.last_rev::BIGINT < EXCLUDED.last_rev::BIGINT`,
      [principalId, space, lastRev, updatedAt],
    )
  },
  dedupGet: async (scope, key, sinceIso) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      'SELECT note_id, version_token FROM mcp_dedup WHERE scope = $1 AND key = $2 AND created_at > $3',
      [scope, key, sinceIso],
    )
    const r = res.rows[0] as { note_id: string; version_token: string } | undefined
    return r ? { noteId: r.note_id, versionToken: r.version_token } : null
  },
  dedupPut: async (scope, key, result, createdAt) => {
    await ctx.ensureInit()
    await ctx.required.query(
      `INSERT INTO mcp_dedup (scope, key, note_id, version_token, created_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (scope, key) DO UPDATE SET note_id = EXCLUDED.note_id, version_token = EXCLUDED.version_token, created_at = EXCLUDED.created_at`,
      [scope, key, result.noteId, result.versionToken, createdAt],
    )
  },
  dedupPrune: async (beforeIso) => {
    await ctx.ensureInit()
    await ctx.required.query('DELETE FROM mcp_dedup WHERE created_at < $1', [beforeIso])
  },
})
