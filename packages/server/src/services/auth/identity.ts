// The identity concern: rename an account and set or clear its e-mail. After the
// identity carrier every other row keys the account by `users.id`, so a rename is
// one UPDATE of one column — sessions, tokens, memberships, agent memory and the
// journal keep pointing at the same person. The UNIQUE keys arbitrate a race
// between two writers wanting the same handle or address; the loser gets a 409.
// canon: docs/auth.md#model

import { HTTP_STATUS } from '@notarium/contract/http'

import type { UserIdentityPatch, UserRecord } from '../metaDb'
import { type AuthCtx, AuthError } from './authService'

export const createIdentity = (ctx: AuthCtx) => ({
  /** Apply a handle and/or e-mail change to one account and tell the live world.
   *  Writing the current value is an idempotent success. The name freed by a rename is
   *  available at once — there is no alias history and no reservation window. */
  updateIdentity: async (userId: string, patch: UserIdentityPatch): Promise<UserRecord> => {
    const user = await ctx.db.getUserById(userId)

    if (!user) {
      throw new AuthError(HTTP_STATUS.NOT_FOUND, 'not found')
    }
    const next: UserIdentityPatch = {}

    if (patch.username !== undefined && patch.username !== user.username) {
      next.username = patch.username
    }
    if (patch.email !== undefined && patch.email !== user.email) {
      next.email = patch.email
    }
    if (next.username === undefined && next.email === undefined) {
      return user
    }
    // The pre-check is the fast path for the common collision; the unique key below
    // is the one that holds under a race.
    if (next.username !== undefined && (await ctx.db.getUser(next.username))) {
      throw new AuthError(HTTP_STATUS.CONFLICT, 'username is taken', 'username_taken')
    }
    const written = await ctx.db.updateUserIdentity(user.id, next)

    if (written.status === 'conflict') {
      throw new AuthError(
        HTTP_STATUS.CONFLICT,
        `${written.field} is taken`,
        written.field === 'username' ? 'username_taken' : 'email_taken',
      )
    }
    const renamed = (await ctx.db.getUserById(user.id)) as UserRecord

    if (next.username !== undefined) {
      // The follow-up runs BEFORE the nudge: `access` makes a tab refetch `me`, and a
      // tab that refetches while the personal space still wears the old slug caches it
      // — `rename` would not reach it, because that one is addressed to viewers of the
      // space. What fails in the follow-up is logged there, not raised, so the nudge is
      // not held hostage by it.
      await ctx.onUsernameChanged?.({ user: renamed, previousUsername: user.username })
      // Live tabs learn the new handle the way they learn a grant change: an `access`
      // nudge refetches `me`; every space the person is a member of re-reads its
      // member list, where the handle is shown.
      ctx.notifySse((h) => h.userId === user.id)
      for (const grant of await ctx.db.grantsFor(user.id)) {
        ctx.notifyMembersOf(grant.space)
      }
    }

    return renamed
  },
})
