// Membership reads + mutations for a space, plus boot-time owner grants;
// mutations nudge live SSE clients.
// canon: docs/auth.md#model · docs/auth.md#sse-revoke-disconnect

import { AUTH_MODE, SPACE_ROLE } from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import type { SpaceRole } from '../authz'
import { type AuthCtx, AuthError } from './authService'

export const createMemberships = (ctx: AuthCtx) => ({
  membersOf: (space: string) => ctx.db.membersOf(space),

  putMember: async (space: string, username: string, role: SpaceRole) => {
    const user = await ctx.db.getUser(username)

    if (!user || user.disabledAt) {
      throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'no such user', 'no_such_user')
    }
    const members = await ctx.db.membersOf(space)
    const current = members.find((m) => m.username === username)

    if (current?.role === SPACE_ROLE.owner && role !== SPACE_ROLE.owner) {
      const owners = members.filter((m) => m.role === SPACE_ROLE.owner)

      if (owners.length === 1) {
        throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'a space needs an owner', 'last_owner')
      }
    }
    await ctx.db.upsertMember(space, username, role, ctx.nowIso())
    // Match by user, not space: the subject's open stream may be on any space, so
    // nudge all of theirs (they also get the members-list signal below — harmless).
    ctx.notifySse((h) => h.username === username)
    ctx.notifyMembersOf(space)
    return ctx.db.membersOf(space)
  },

  removeMember: async (space: string, username: string) => {
    const members = await ctx.db.membersOf(space)
    const current = members.find((m) => m.username === username)

    if (!current) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    if (
      current.role === SPACE_ROLE.owner &&
      members.filter((m) => m.role === SPACE_ROLE.owner).length === 1
    ) {
      throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'a space needs an owner', 'last_owner')
    }
    await ctx.db.removeMember(space, username)
    // Revoke = disconnect: drop the member's channels on THIS space only; their
    // OTHER-space streams stay (still legit) but get nudged to de-list this one.
    ctx.dropSse((h) => h.username === username && h.space === space)
    ctx.notifySse((h) => h.username === username && h.space !== space)
    ctx.notifyMembersOf(space)
    return ctx.db.membersOf(space)
  },

  /** Mint the owner row for a runtime-created space. */
  grantOwner: async (space: string, username: string): Promise<void> => {
    await ctx.db.upsertMember(space, username, SPACE_ROLE.owner, ctx.nowIso())
  },

  /** Boot heal: spaces with no members get owner rows for every active admin.
   *  EXCEPTION: a personal domain that lost its owner is healed to ONLY its
   *  rightful owner, never the admin fan-out — fanning out would hand every admin
   *  space:read to that owner's private about-user memory. */
  ensureOwners: async (spaceSlugs: string[]): Promise<void> => {
    if (ctx.mode !== AUTH_MODE.password) {
      return
    }
    const owned = new Set(await ctx.db.spacesWithMembers())
    const orphans = spaceSlugs.filter((s) => !owned.has(s))

    if (!orphans.length) {
      return
    }
    const users = await ctx.db.listUsers()
    const personalOwner = new Map(
      users.filter((u) => u.personalSpace).map((u) => [u.personalSpace as string, u.username]),
    )
    const admins = users.filter((u) => u.admin && u.disabledAt == null)
    const t = ctx.nowIso()

    for (const slug of orphans) {
      const owner = personalOwner.get(slug)

      if (owner) {
        await ctx.db.upsertMember(slug, owner, SPACE_ROLE.owner, t)
        continue
      }
      for (const a of admins) {
        await ctx.db.upsertMember(slug, a.username, SPACE_ROLE.owner, t)
      }
    }
  },
})
