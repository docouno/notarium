import type {
  Config,
  HostAboutResponse,
  PatchSpaceRequest,
  RestoreSpacesResponse,
  Space,
  SpacesResponse,
} from '@notarium/contract'
import { req, sp } from './client'

export const spacesApi = {
  // ── host-level ──────────────────────────────────────────────────────────────
  configGet: () => req<Config>('/api/config'),
  /** Host About / diagnostics (#97): version + search capability, plus an
   *  admin-only deployment block (runtime/embedder/spaces). The SPA's own version
   *  is a build constant (libs/buildInfo) — this is the SERVER's view. */
  aboutGet: (signal?: AbortSignal) => req<HostAboutResponse>('/api/about', { signal }),
  spacesGet: () => req<SpacesResponse>('/api/spaces').then((d) => d.spaces),
  /** Mint a space from a human NAME (#69/#123) — the server derives the URL handle
   *  (slugify, any language), soft-suffixes a clash and falls back to an id-shaped
   *  handle when the name doesn't romanise. Capability-gated by /api/config; a static
   *  host answers 404. */
  spaceCreate: (displayName: string) =>
    req<Space>('/api/spaces', { method: 'POST', body: JSON.stringify({ displayName }) }),
  /** Rename a space (#100 phase 4 / #123) — change its slug and/or display name. An
   *  owner-need management act; a changed slug retires the old one into the alias
   *  history (so a bookmarked `/s/<old>` URL keeps resolving). The server 409s a slug
   *  already in use, 400s a slug pinned by host config. Answers the fresh wire row. */
  patchSpace: (space: string, patch: PatchSpaceRequest) =>
    req<Space>(sp(space), { method: 'PATCH', body: JSON.stringify(patch) }),
  /** Archive a space (#110 soft-delete) — stop serving it (it drops from /api/spaces +
   *  me.spaces, routes 404) while its data/journal/index stay whole; restore reverses
   *  it. Owner-need; the slug stays reserved. Slug-addressed (the space is still live). */
  archiveSpace: (space: string) => req<{ ok: boolean }>(sp(space), { method: 'DELETE' }),
  /** The principal's ARCHIVED spaces (#110) — the restore/purge surface. Filtered to
   *  the spaces the caller can manage; each row carries `archivedAt`. [] on a host
   *  without a registry. */
  archivedSpaces: () => req<SpacesResponse>('/api/spaces/archived').then((d) => d.spaces),
  /** Restore an archived space by its STABLE id (#110) — served again, with all its
   *  content and history. Id-addressed (an archived space has no live slug route). */
  restoreSpace: (id: string) =>
    req<Space>(`/api/spaces/${encodeURIComponent(id)}/restore`, { method: 'POST' }),
  /** Best-effort batch restore of archived spaces (#184): one host-level round-trip
   *  for a mixed-trash multi-select. Returns the restored rows plus per-id failures. */
  restoreSpaces: (ids: string[]) =>
    req<RestoreSpacesResponse>('/api/spaces/restore-many', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  /** Permanently purge an archived space by id (#110) — IRREVERSIBLE. `confirm` must
   *  equal the space's current slug (a server belt against id mistakes). */
  purgeSpace: (id: string, confirm: string) =>
    req<{ ok: boolean }>(`/api/spaces/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirm }),
    }),
}
