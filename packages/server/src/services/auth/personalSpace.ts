// Personal-domain seam of the auth service: read/write of a user's
// `personalSpace` pointer + the "is this space a personal domain" belt.
// canon: docs/projects.md#personal-domain-as-a-working-space-13-2026-06-20

import { type AuthCtx } from './authService'

export const createPersonalSpace = (ctx: AuthCtx) => ({
  /** PEEK that never provisions — a read surface must not mint a space as
   *  a side effect (provisioning lives in ensurePersonalSpace). */
  personalSpaceOf: async (username: string): Promise<string | null> => {
    const user = await ctx.db.getUser(username)
    return user?.personalSpace ?? null
  },

  setPersonalSpace: async (username: string, slug: string): Promise<void> => {
    await ctx.db.updateUser(username, { personalSpace: slug })
  },

  /** Is this space someone's personal domain? Security belt: such a space
   *  must NEVER gain a SECOND member — that would hand another principal
   *  space:read to the owner's private about-user memory. */
  isPersonalSpace: async (space: string): Promise<boolean> => {
    if (!space || !ctx.persistence) {
      return false
    }

    return (await ctx.db.listUsers()).some((u) => u.personalSpace === space)
  },

  /** Self-service (self:manage) rename of SELF only — carries no
   *  admin/disabled lever, unlike the admin user-patch path. */
  setDisplayName: async (username: string, displayName: string): Promise<void> => {
    await ctx.db.updateUser(username, { displayName: displayName.trim() || username })
  },
})
