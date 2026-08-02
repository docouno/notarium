import type {
  InviteLink,
  User,
  UserCreateRequest,
  UserPatchRequest,
  UsersResponse,
} from '@notarium/contract'
import { req } from './client'

export const usersApi = {
  // ── user management (#10, admin): /api/users ────────────────────────────────
  usersGet: () => req<UsersResponse>('/api/users').then((d) => d.users),
  /** Creating a user answers with the one-time invite link's SPA path — the
   *  client prefixes its own origin (no SMTP; handed over out-of-band). */
  userCreate: (input: UserCreateRequest) =>
    req<InviteLink>('/api/users', { method: 'POST', body: JSON.stringify(input) }),
  /** Re-invite / password-reset: a fresh one-time link for an existing user. */
  userInvite: (username: string) =>
    req<InviteLink>(`/api/users/${encodeURIComponent(username)}/invite`, { method: 'POST' }),
  userPatch: (username: string, patch: UserPatchRequest) =>
    req<User>(`/api/users/${encodeURIComponent(username)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
}
