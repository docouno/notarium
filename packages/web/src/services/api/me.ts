import type {
  ConnectionPatchRequest,
  ConnectionsResponse,
  Me,
  MeMemory,
  PatCreateRequest,
  PatCreateResponse,
  PatPatchRequest,
  PatsResponse,
  Profile,
  ProfilePutRequest,
} from '@notarium/contract'
import { req } from './client'

export const meApi = {
  // ── self-service (#10): /api/me ─────────────────────────────────────────────
  meGet: () => req<Me>('/api/me'),
  passwordChange: (currentPassword: string, newPassword: string) =>
    req<{ ok: true }>('/api/me/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  patsGet: () => req<PatsResponse>('/api/me/tokens').then((d) => d.tokens),
  /** The response's `token` is the bearer secret, shown exactly once — the
   *  server stores a hash and honestly can't repeat it. */
  patCreate: (input: PatCreateRequest) =>
    req<PatCreateResponse>('/api/me/tokens', { method: 'POST', body: JSON.stringify(input) }),
  /** Change a live token's scope/narrowing without re-minting (#162). */
  patPatch: (id: string, input: PatPatchRequest) =>
    req<{ ok: true }>(`/api/me/tokens/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  patRevoke: (id: string) =>
    req<{ ok: true }>(`/api/me/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // ── connected apps (#96): the user's OAuth connections (claude.ai/chatgpt) ──
  connectionsGet: () => req<ConnectionsResponse>('/api/me/connections').then((d) => d.connections),
  /** Change a connected app's access level read↔write (#162) and/or per-space
   *  narrowing (#181) without re-consent. */
  connectionUpdate: (id: string, input: ConnectionPatchRequest) =>
    req<{ ok: true }>(`/api/me/connections/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  connectionRevoke: (id: string) =>
    req<{ ok: true }>(`/api/me/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // ── the personal layer (#13): /api/me/memory + /api/me/profile ──────────────
  // Me-scoped — the personal-domain slug never crosses the wire. Memory is the
  // agent-authored audit feed; the profile is the human-authored always-load
  // note + display name. Individual memory notes use the id-addressed routes
  // above (noteGet/noteSave/noteRemove/revisionsGet) — they are ordinary notes.
  meMemoryGet: () => req<MeMemory>('/api/me/memory').then((d) => d.categories),
  profileGet: () => req<Profile>('/api/me/profile'),
  profilePut: (input: ProfilePutRequest) =>
    req<Profile>('/api/me/profile', { method: 'PUT', body: JSON.stringify(input) }),
}
