// Auth user-admin: list users, create/invite, and the admin user-patch.
// canon: docs/auth.md#model

import { TOKEN_PURPOSE } from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { mintUserId } from '../../libs/tokens'
import type { UserRecord } from '../metaDb'
import { type AuthCtx, AuthError } from './authService'
import { createIdentity } from './identity'

const userView = (u: UserRecord) => ({
  username: u.username,
  email: u.email,
  displayName: u.displayName,
  admin: u.admin,
  disabled: u.disabledAt != null,
  hasPassword: u.passwordHash != null,
  createdAt: u.createdAt,
})

export const createUsers = (ctx: AuthCtx) => ({
  listUsers: async () => (await ctx.db.listUsers()).map(userView),

  createUser: async (input: {
    username: string
    email?: string
    displayName?: string
    admin?: boolean
  }) => {
    if (await ctx.db.getUser(input.username)) {
      throw new AuthError(HTTP_STATUS.CONFLICT, 'username is taken', 'username_taken')
    }
    const written = await ctx.db.createUser({
      id: mintUserId(),
      username: input.username,
      email: input.email ?? null,
      displayName: input.displayName?.trim() || input.username,
      passwordHash: null,
      admin: Boolean(input.admin),
      disabledAt: null,
      createdAt: ctx.nowIso(),
      personalSpace: null,
    })

    if (written.status === 'conflict') {
      throw new AuthError(
        HTTP_STATUS.CONFLICT,
        `${written.field} is taken`,
        written.field === 'username' ? 'username_taken' : 'email_taken',
      )
    }
    const user = (await ctx.db.getUser(input.username)) as UserRecord
    const link = await ctx.mintLink(user.id, TOKEN_PURPOSE.invite)
    return { user: userView(user), ...link }
  },

  /** Mint a fresh credential link for an existing user. canon: docs/auth.md#credentials */
  inviteUser: async (username: string) => {
    const user = await ctx.db.getUser(username)

    if (!user || user.disabledAt) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    const link = await ctx.mintLink(
      user.id,
      user.passwordHash ? TOKEN_PURPOSE.reset : TOKEN_PURPOSE.invite,
    )
    return { user: userView(user), ...link }
  },

  /** `actorUserId` is the admin's own stable id — the self-lockout guard compares
   *  identities, not handles. `username` in the patch renames; the route is addressed
   *  by the current handle and the answer carries the new one. */
  patchUser: async (
    actorUserId: string | null,
    username: string,
    patch: {
      username?: string
      email?: string | null
      displayName?: string
      admin?: boolean
      disabled?: boolean
    },
  ) => {
    const user = await ctx.db.getUser(username)

    if (!user) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    // Self-lockout guards — a host must stay administrable.
    if (user.id === actorUserId && patch.disabled === true) {
      throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'cannot disable yourself', 'self_lockout')
    }
    if (patch.admin === false && user.admin) {
      const admins = (await ctx.db.listUsers()).filter((u) => u.admin && u.disabledAt == null)

      if (admins.length === 1 && admins[0].id === user.id) {
        throw new AuthError(HTTP_STATUS.BAD_REQUEST, 'cannot demote the last admin', 'last_admin')
      }
    }
    // Identity goes FIRST, because it is the only half that can still be refused: a
    // taken handle or address answers 409 from inside updateIdentity, and the two
    // writes share no transaction. Applied the other way round, a refused patch would
    // leave displayName rewritten — and, on the disable path, sessions already deleted
    // and the socket already torn down.
    if (patch.username !== undefined || patch.email !== undefined) {
      await createIdentity(ctx).updateIdentity(user.id, {
        ...(patch.username !== undefined ? { username: patch.username } : {}),
        ...(patch.email !== undefined ? { email: patch.email } : {}),
      })
    }
    await ctx.db.updateUser(user.id, {
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.admin !== undefined ? { admin: patch.admin } : {}),
      ...(patch.disabled !== undefined ? { disabledAt: patch.disabled ? ctx.nowIso() : null } : {}),
    })
    if (patch.disabled === true) {
      // disabledAt is already durable: remove live delivery authority before any
      // cleanup await can expose owner-private frames in the committed-disabled gap.
      ctx.dropSse((h) => h.userId === user.id)
      await ctx.db.deleteSessionsFor(user.id)
      await ctx.db.deleteOneTimesFor(user.id)
    }

    return userView((await ctx.db.getUserById(user.id)) as UserRecord)
  },
})
