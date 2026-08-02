// Password-lifecycle concern: change-own-password + the two operator (admin-CLI) recovery ops.
// canon: docs/auth.md#credentials · docs/auth.md#access-recovery-admin-cli

import { HTTP_STATUS } from '@notarium/contract/http'
import { hashPassword, verifyPassword } from '../../libs/passwords'
import { type AuthCtx, AuthError } from './authService'

export const createCredentials = (ctx: AuthCtx) => ({
  /** Change own password: invalidates ALL sessions (credential-change contract),
   *  then returns a fresh token so the calling tab stays logged in. */
  changePassword: async (
    username: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ sessionToken: string }> => {
    const user = await ctx.activeUser(username)

    if (!user || !user.passwordHash) {
      throw new AuthError(HTTP_STATUS.UNAUTHORIZED, 'unauthorized')
    }
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'current password is wrong', 'bad_password')
    }
    await ctx.db.updateUser(username, { passwordHash: await hashPassword(newPassword) })
    await ctx.db.deleteSessionsFor(username)
    return { sessionToken: await ctx.createSession(username) }
  },

  /** Operator reset (admin CLI): sets a password with NO current-credential proof —
   *  MUST stay host-only, never reachable over HTTP. */
  setPassword: async (username: string, newPassword: string): Promise<void> => {
    const user = await ctx.db.getUser(username)

    if (!user) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    await ctx.db.updateUser(username, { passwordHash: await hashPassword(newPassword) })
    await ctx.db.deleteSessionsFor(username)
    await ctx.db.deleteOneTimesFor(username)
  },

  /** Operator-minted admin (admin CLI): locked-out recovery, no invite round-trip.
   */
  createAdmin: async (username: string, password: string, displayName?: string): Promise<void> => {
    if (await ctx.db.getUser(username)) {
      throw new AuthError(HTTP_STATUS.CONFLICT, 'username is taken', 'username_taken')
    }
    await ctx.db.createUser({
      username,
      displayName: displayName?.trim() || username,
      passwordHash: await hashPassword(password),
      admin: true,
      disabledAt: null,
      createdAt: ctx.nowIso(),
      personalSpace: null,
    })
  },
})
