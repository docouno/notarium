import type { AuthSession, InviteInfo, Me, SetupRequest } from '@notarium/contract'
import { req } from './client'

export const authApi = {
  // ── auth (#10) ──────────────────────────────────────────────────────────────
  // The session rides an HttpOnly cookie set/cleared by the server — these
  // methods never see a credential beyond the login/setup/invite bodies.
  /** The boot endpoint — the only data route an anonymous client may hit. */
  authSessionGet: () => req<AuthSession>('/api/auth/session'),
  login: (username: string, password: string) =>
    req<Me>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => req<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  /** First-run only: mint the host owner. 404 once any user exists. */
  setup: (input: SetupRequest) =>
    req<Me>('/api/auth/setup', { method: 'POST', body: JSON.stringify(input) }),
  /** The token travels in a POST body (it rode the URL fragment, which never
   *  reaches the server) — 404 = dead/expired/used link. */
  inviteInfo: (token: string) =>
    req<InviteInfo>('/api/auth/invite-info', { method: 'POST', body: JSON.stringify({ token }) }),
  acceptInvite: (token: string, password: string) =>
    req<Me>('/api/auth/accept-invite', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    }),
}
