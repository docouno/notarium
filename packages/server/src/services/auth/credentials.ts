// Password-lifecycle concern: change-own-password + the two operator (admin-CLI) recovery ops.
// canon: docs/auth.md#credentials · docs/auth.md#access-recovery-admin-cli

import { HTTP_STATUS } from '@notarium/contract/http'
import { hashPassword, verifyPassword } from '../../libs/passwords'
import { mintUserId } from '../../libs/tokens'
import { type AuthCtx, AuthError } from './authService'

export const createCredentials = (ctx: AuthCtx) => ({
  /** Change own password: invalidates ALL sessions (credential-change contract),
   *  then returns a fresh token so the calling tab stays logged in. */
  changePassword: async (
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ sessionToken: string }> => {
    const user = await ctx.activeUserById(userId)

    if (!user || !user.passwordHash) {
      throw new AuthError(HTTP_STATUS.UNAUTHORIZED, 'unauthorized')
    }
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'current password is wrong', 'bad_password')
    }
    await ctx.db.updateUser(user.id, { passwordHash: await hashPassword(newPassword) })
    await ctx.db.deleteSessionsFor(user.id)
    return { sessionToken: await ctx.createSession(user.id) }
  },

  /** Operator reset (admin CLI): sets a password with NO current-credential proof —
   *  MUST stay host-only, never reachable over HTTP. */
  setPassword: async (username: string, newPassword: string): Promise<void> => {
    const user = await ctx.db.getUser(username)

    if (!user) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    await ctx.db.updateUser(user.id, { passwordHash: await hashPassword(newPassword) })
    await ctx.db.deleteSessionsFor(user.id)
    await ctx.db.deleteOneTimesFor(user.id)
  },

  /** Operator-minted admin (admin CLI): locked-out recovery, no invite round-trip.
   */
  createAdmin: async (username: string, password: string, displayName?: string): Promise<void> => {
    if (await ctx.db.getUser(username)) {
      throw new AuthError(HTTP_STATUS.CONFLICT, 'username is taken', 'username_taken')
    }
    const written = await ctx.db.createUser({
      id: mintUserId(),
      username,
      email: null,
      displayName: displayName?.trim() || username,
      passwordHash: await hashPassword(password),
      admin: true,
      disabledAt: null,
      createdAt: ctx.nowIso(),
      personalSpace: null,
    })

    if (written.status === 'conflict') {
      throw new AuthError(HTTP_STATUS.CONFLICT, 'username is taken', 'username_taken')
    }
  },
})
