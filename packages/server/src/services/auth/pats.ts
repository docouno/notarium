// The auth service's PAT concern: list, mint, patch and revoke a user's personal access tokens.
// Narrowing is stored as stable space ids, not wire slugs — a space rename never widens/breaks a token.
// canon: docs/auth.md#credentials

import { HTTP_STATUS } from '@notarium/contract/http'
import { patPrincipalId } from '../../libs/principalId'
import { mintPatToken, sha256 } from '../../libs/tokens'
import type { PatRecord } from '../metaDb'
import { type AuthCtx, AuthError } from './authService'

export const createPats = (ctx: AuthCtx) => ({
  listPats: async (userId: string) => {
    const slugs = await ctx.slugById()
    const toSlug = (id: string): string | undefined => (slugs ? slugs.get(id) : id)
    return (await ctx.db.listPats(userId))
      .filter((p) => p.revokedAt == null)
      .map((p) => ({
        id: p.id,
        name: p.name,
        scope: p.scope,
        spaces: p.spaces ? p.spaces.flatMap((s) => (toSlug(s) ? [toSlug(s) as string] : [])) : null,
        createdAt: p.createdAt,
        expiresAt: p.expiresAt,
        lastUsedAt: p.lastUsedAt,
      }))
  },

  createPat: async (
    userId: string,
    input: {
      name: string
      scope: 'read' | 'write'
      spaces?: string[] | null
      expiresAt?: string | null
    },
  ) => {
    if (input.expiresAt && input.expiresAt <= ctx.nowIso()) {
      throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'expiry must be in the future')
    }
    const slugs = await ctx.slugById()
    const toSlug = (id: string): string | undefined => (slugs ? slugs.get(id) : id)
    const spaceIds = input.spaces ? await ctx.slugsToIds(input.spaces) : null
    const { id, secret, token } = mintPatToken()
    const rec: PatRecord = {
      id,
      userId,
      name: input.name,
      secretHash: sha256(secret),
      scope: input.scope,
      spaces: spaceIds,
      expiresAt: input.expiresAt ?? null,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: ctx.nowIso(),
    }
    await ctx.db.insertPat(rec)
    return {
      token,
      pat: {
        id,
        name: rec.name,
        scope: rec.scope,
        spaces: spaceIds ? spaceIds.flatMap((s) => (toSlug(s) ? [toSlug(s) as string] : [])) : null,
        createdAt: rec.createdAt,
        expiresAt: rec.expiresAt,
        lastUsedAt: null,
      },
    }
  },

  /** Patch a live PAT in place; the secret is never re-minted.
   *  canon: docs/auth.md#sse-revoke-disconnect */
  updatePat: async (
    userId: string,
    id: string,
    patch: { name?: string; scope?: 'read' | 'write'; spaces?: string[] | null },
  ): Promise<void> => {
    const pat = await ctx.db.getPat(id)

    if (!pat || pat.userId !== userId || pat.revokedAt) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    const dbPatch: { name?: string; scope?: 'read' | 'write'; spaces?: string[] | null } = {}

    if (patch.name !== undefined) {
      dbPatch.name = patch.name
    }
    if (patch.scope !== undefined) {
      dbPatch.scope = patch.scope
    }
    if (patch.spaces !== undefined) {
      dbPatch.spaces = patch.spaces === null ? null : await ctx.slugsToIds(patch.spaces)
    }
    await ctx.db.updatePat(id, dbPatch)
    ctx.dropSse((h) => h.principalId === patPrincipalId(userId, id))
  },

  revokePat: async (userId: string, id: string): Promise<void> => {
    const pat = await ctx.db.getPat(id)

    if (!pat || pat.userId !== userId || pat.revokedAt) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    await ctx.db.updatePat(id, { revokedAt: ctx.nowIso() })
    ctx.dropSse((h) => h.principalId === patPrincipalId(userId, id))
  },
})
