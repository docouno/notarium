import type { MembersResponse, SpaceRole } from '@notarium/contract'
import { req, sp } from './client'

export const membersApi = {
  // ── space membership (#10): /api/s/<slug>/members ───────────────────────────
  // Mutations answer with the fresh member list — callers swap, never re-fetch.
  membersGet: (space: string) =>
    req<MembersResponse>(`${sp(space)}/members`).then((d) => d.members),
  memberPut: (space: string, username: string, role: SpaceRole) =>
    req<MembersResponse>(`${sp(space)}/members/${encodeURIComponent(username)}`, {
      method: 'PUT',
      body: JSON.stringify({ role }),
    }).then((d) => d.members),
  memberRemove: (space: string, username: string) =>
    req<MembersResponse>(`${sp(space)}/members/${encodeURIComponent(username)}`, {
      method: 'DELETE',
    }).then((d) => d.members),
}
