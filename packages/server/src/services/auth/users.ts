// Auth user-admin: list users, create/invite, and the admin user-patch.
// canon: docs/auth.md#model

import { TOKEN_PURPOSE } from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import type { UserRecord } from '../metaDb'
import { type AuthCtx, AuthError } from './authService'

const userView = (u: UserRecord) => ({
  username: u.username,
  displayName: u.displayName,
  admin: u.admin,
  disabled: u.disabledAt != null,
  hasPassword: u.passwordHash != null,
  createdAt: u.createdAt,
})

export const createUsers = (ctx: AuthCtx) => ({
  listUsers: async () => (await ctx.db.listUsers()).map(userView),

  createUser: async (input: { username: string; displayName?: string; admin?: boolean }) => {
    if (await ctx.db.getUser(input.username)) {
      throw new AuthError(HTTP_STATUS.CONFLICT, 'username is taken', 'username_taken')
    }
    await ctx.db.createUser({
      username: input.username,
      displayName: input.displayName?.trim() || input.username,
      passwordHash: null,
      admin: Boolean(input.admin),
      disabledAt: null,
      createdAt: ctx.nowIso(),
      personalSpace: null,
    })
    const user = await ctx.db.getUser(input.username)
    const link = await ctx.mintLink(input.username, TOKEN_PURPOSE.invite)
    return { user: userView(user as UserRecord), ...link }
  },

  /** Mint a fresh credential link for an existing user. canon: docs/auth.md#credentials */
  inviteUser: async (username: string) => {
    const user = await ctx.db.getUser(username)

    if (!user || user.disabledAt) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    const link = await ctx.mintLink(
      username,
      user.passwordHash ? TOKEN_PURPOSE.reset : TOKEN_PURPOSE.invite,
    )
    return { user: userView(user), ...link }
  },

  patchUser: async (
    actor: string,
    username: string,
    patch: { displayName?: string; admin?: boolean; disabled?: boolean },
  ) => {
    const user = await ctx.db.getUser(username)

    if (!user) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    // Self-lockout guards — a host must stay administrable.
    if (username === actor && patch.disabled === true) {
      throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'cannot disable yourself', 'self_lockout')
    }
    if (patch.admin === false && user.admin) {
      const admins = (await ctx.db.listUsers()).filter((u) => u.admin && u.disabledAt == null)

      if (admins.length === 1 && admins[0].username === username) {
        throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'cannot demote the last admin', 'last_admin')
      }
    }
    await ctx.db.updateUser(username, {
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.admin !== undefined ? { admin: patch.admin } : {}),
      ...(patch.disabled !== undefined ? { disabledAt: patch.disabled ? ctx.nowIso() : null } : {}),
    })
    if (patch.disabled === true) {
      // disabledAt is already durable: remove live delivery authority before any
      // cleanup await can expose owner-private frames in the committed-disabled gap.
      ctx.dropSse((h) => h.username === username)
      await ctx.db.deleteSessionsFor(username)
      await ctx.db.deleteOneTimesFor(username)
    }

    return userView((await ctx.db.getUser(username)) as UserRecord)
  },
})
