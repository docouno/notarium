// OAuth "connected apps" surface: list/revoke/patch an authorized app's access
// across ALL its tokens, plus the public slug→id seam the consent flow reuses.
// A "connection" is an app (OAuth client), not a single access token.
// canon: docs/mcp-oauth.md#surfaces · docs/mcp-oauth.md#token-identity

import { HTTP_STATUS } from '@notarium/contract/http'

import { oauthPrincipalId } from '../../libs/principalId'
import { type AuthCtx, AuthError } from './authService'

export const createOAuthConnections = (ctx: AuthCtx) => ({
  /** Connected-apps list; [] when the host lacks the OAuth facet. */
  listConnections: async (userId: string) => {
    if (!ctx.oauthStore) {
      return []
    }
    const nowStr = ctx.nowIso()
    // Narrowing stores space ids; wire shows slugs. A space the registry no longer lists drops out.
    const slugs = await ctx.slugById()
    const toSlug = (id: string): string | undefined => (slugs ? slugs.get(id) : id)
    const allAccess = await ctx.oauthStore.listAccessForUser(userId)
    const liveAccess = allAccess.filter((t) => t.expiresAt > nowStr)
    // Include apps whose access tokens all expired but whose refresh is still live —
    // else a still-reachable app vanishes from the list and becomes unrevokable.
    // Refresh rows carry no lastUsedAt: they contribute presence + createdAt + scope only.
    const refresh = (await ctx.oauthStore.listRefreshForUser(userId)).filter(
      (t) => t.rotatedTo == null && t.expiresAt > nowStr,
    )
    // Source last-used from the max across ALL access rows, expired included: the ~1h
    // access row carries it, but once it expires the app lives on its 60-day refresh
    // (no lastUsedAt) — so an app idle longer than the access TTL would read "—".
    const lastUsedByClient = new Map<string, string>()

    for (const t of allAccess) {
      if (!t.lastUsedAt) {
        continue
      }
      const cur = lastUsedByClient.get(t.clientId)

      if (!cur || t.lastUsedAt > cur) {
        lastUsedByClient.set(t.clientId, t.lastUsedAt)
      }
    }
    // Scope/spaces travel together on every token of the app (minted and patched as
    // one), so the first row seen fixes them for the whole group.
    const byClient = new Map<
      string,
      { scope: 'read' | 'write'; spaces: string[] | null; createdAt: string }
    >()

    const note = (
      clientId: string,
      scope: 'read' | 'write',
      narrowing: string[] | null,
      createdAt: string,
    ) => {
      const cur = byClient.get(clientId)

      if (!cur) {
        byClient.set(clientId, { scope, spaces: narrowing, createdAt })
      } else if (createdAt < cur.createdAt) {
        cur.createdAt = createdAt
      }
    }

    for (const t of liveAccess) {
      note(t.clientId, t.scope, t.spaces, t.createdAt)
    }
    for (const t of refresh) {
      note(t.clientId, t.scope, t.spaces, t.createdAt)
    }
    const out: Array<{
      id: string
      appName: string | null
      scope: 'read' | 'write'
      spaces: string[] | null
      createdAt: string
      lastUsedAt: string | null
    }> = []

    for (const [clientId, agg] of byClient) {
      const client = await ctx.oauthStore.getClient(clientId)
      out.push({
        id: clientId,
        appName: client?.clientName ?? null,
        scope: agg.scope,
        spaces: agg.spaces
          ? agg.spaces.flatMap((s) => (toSlug(s) ? [toSlug(s) as string] : []))
          : null,
        createdAt: agg.createdAt,
        lastUsedAt: lastUsedByClient.get(clientId) ?? null,
      })
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    return out
  },

  /** Revoke a connected app (`id` = client id): kill every access AND refresh token
   *  and drop its live SSE. Reaching refresh directly matters — an app whose access
   *  all expired/were pruned still has a 60-day refresh that would survive a Disconnect.
   *  canon: docs/auth.md#sse-revoke-disconnect */
  revokeConnection: async (userId: string, clientId: string): Promise<void> => {
    if (!ctx.oauthStore) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    const access = (await ctx.oauthStore.listAccessForUser(userId)).filter(
      (t) => t.clientId === clientId,
    )
    const refresh = (await ctx.oauthStore.listRefreshForUser(userId)).filter(
      (t) => t.clientId === clientId,
    )

    if (!access.length && !refresh.length) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    const t = ctx.nowIso()

    for (const tok of access) {
      await ctx.oauthStore.updateAccess(tok.id, { revokedAt: t })
      ctx.dropSse((h) => h.principalId === oauthPrincipalId(userId, tok.id))
    }
    for (const tok of refresh) {
      await ctx.oauthStore.updateRefresh(tok.id, { revokedAt: t })
    }
  },

  /** Patch a connected app's scope and/or per-space narrowing WITHOUT re-consent,
   *  across BOTH access AND refresh rows — `refresh` mints the next family from the
   *  refresh row's scope+spaces, so patching access alone reverts at the hourly
   *  rotation. Narrowing arrives as wire slugs, stored as ids; an unknown slug is
   *  dropped (membership is validated upstream in the route). `spaces: null` widens
   *  back to all the owner's grants.
   */
  updateConnection: async (
    userId: string,
    clientId: string,
    patch: { scope?: 'read' | 'write'; spaces?: string[] | null },
  ): Promise<void> => {
    if (!ctx.oauthStore) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    const access = (await ctx.oauthStore.listAccessForUser(userId)).filter(
      (t) => t.clientId === clientId,
    )
    const refresh = (await ctx.oauthStore.listRefreshForUser(userId)).filter(
      (t) => t.clientId === clientId,
    )

    if (!access.length && !refresh.length) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    // Empty patch: return WITHOUT dropping SSE — it must not tear down the connector's live socket for nothing.
    if (patch.scope === undefined && patch.spaces === undefined) {
      return
    }
    const dbPatch: { scope?: 'read' | 'write'; spaces?: string[] | null } = {}

    if (patch.scope !== undefined) {
      dbPatch.scope = patch.scope
    }
    if (patch.spaces !== undefined) {
      dbPatch.spaces = patch.spaces === null ? null : await ctx.slugsToIds(patch.spaces)
    }
    for (const tok of access) {
      await ctx.oauthStore.updateAccess(tok.id, dbPatch)
      ctx.dropSse((h) => h.principalId === oauthPrincipalId(userId, tok.id))
    }
    for (const tok of refresh) {
      await ctx.oauthStore.updateRefresh(tok.id, dbPatch)
    }
  },

  /** Public seam: translate wire space slugs → stored ids, dropping any the registry
   *  no longer lists. No registry ⇒ id≡slug (identity). */
  spacesToIds: (slugs: string[]): Promise<string[]> => ctx.slugsToIds(slugs),
})
