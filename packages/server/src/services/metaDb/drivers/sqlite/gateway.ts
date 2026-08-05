import type { GatewayStatePersistence } from '../../types'
import type { SqliteDriverCtx } from './context'

export const createGatewayFacet = (ctx: SqliteDriverCtx): GatewayStatePersistence => ({
  dedupGet: async (scope, key, sinceIso) => {
    await ctx.ensureInit()
    const r = ctx.required
      .prepare(
        'SELECT note_id, version_token FROM mcp_dedup WHERE scope = ? AND key = ? AND created_at > ?',
      )
      .get(scope, key, sinceIso) as { note_id: string; version_token: string } | undefined
    return r ? { noteId: r.note_id, versionToken: r.version_token } : null
  },
  dedupPut: async (scope, key, result, createdAt) => {
    await ctx.ensureInit()
    ctx.required
      .prepare(
        `INSERT INTO mcp_dedup (scope, key, note_id, version_token, created_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(scope, key) DO UPDATE SET note_id = excluded.note_id, version_token = excluded.version_token, created_at = excluded.created_at`,
      )
      .run(scope, key, result.noteId, result.versionToken, createdAt)
  },
  dedupPrune: async (beforeIso) => {
    await ctx.ensureInit()
    ctx.required.prepare('DELETE FROM mcp_dedup WHERE created_at < ?').run(beforeIso)
  },
})
