// One-time invite/reset link redemption: inspect a live link, then accept it.
// canon: docs/auth.md#credentials

import { TOKEN_PURPOSE } from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { hashPassword } from '../../libs/passwords'
import { type AuthCtx, AuthError, type MeView } from './authService'

export const createInvites = (ctx: AuthCtx) => ({
  inviteInfo: async (token: string) => {
    const rec = await ctx.liveOneTime(token)

    if (!rec) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'invalid or expired link')
    }
    const user = await ctx.activeUserById(rec.userId)

    if (!user) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'invalid or expired link')
    }

    return { username: user.username, displayName: user.displayName, purpose: rec.purpose }
  },

  acceptInvite: async (
    token: string,
    password: string,
  ): Promise<{ me: MeView; sessionToken: string }> => {
    const rec = await ctx.liveOneTime(token)

    if (!rec) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'invalid or expired link')
    }
    if (!(await ctx.db.useOneTime(rec.idHash, ctx.nowIso()))) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'invalid or expired link') // single-use race loser
    }
    const user = await ctx.activeUserById(rec.userId)

    if (!user) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'invalid or expired link')
    }
    await ctx.db.updateUser(user.id, { passwordHash: await hashPassword(password) })
    if (rec.purpose === TOKEN_PURPOSE.reset) {
      await ctx.db.deleteSessionsFor(user.id)
    }

    return { me: await ctx.me(user.id), sessionToken: await ctx.createSession(user.id) }
  },
})
