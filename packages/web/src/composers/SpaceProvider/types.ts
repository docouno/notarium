import type { PatchSpaceRequest, Space } from '@notarium/contract'

export type SpaceContextValue = {
  /** The active space slug — every space-scoped api call threads it. */
  space: string
  /** All spaces this host serves, in display order — the personal domain is
   *  filtered OUT (management surfaces must not list it as a workspace). */
  spaces: Space[]
  /** The user's personal domain (#13), exposed separately so the chrome can
   *  offer an explicit "Personal" destination + resolve its name, without
   *  leaking it into the workspace list. null on a host without one. */
  personalSpace: Space | null
  capabilities: { spaceCreate: boolean; providers: boolean }
  /** Can the principal mutate content in the ACTIVE space (role ≥ writer, own
   *  personal domain, or a 'none' host)? The single switch the chrome reads to
   *  hide every create/edit/delete affordance from a reader — who would otherwise
   *  see them, act, and get a server rejection (the misleading read-only bug). */
  canWrite: boolean
  /** Navigate to another space's home (also adopted as last-active). */
  switchSpace: (slug: string) => void
  /** Mint a space from a human name (capability-gated) and switch into it — the server
   *  derives the URL handle (#123, any language). */
  createSpace: (displayName: string) => Promise<void>
  /** Rename the ACTIVE space (#100 phase 4 / #123) — slug and/or display name (owner-need,
   *  gated by canManageSpace in the chrome). Swaps the fresh row in; the URL
   *  canonicalisation effect then redirects this tab's `/s/<old>/…` to the new slug
   *  and adopts it. Other tabs follow via the server's `rename` SSE nudge. */
  renameSpace: (patch: PatchSpaceRequest) => Promise<Space>
  /** A space-free surface learned its content's real space (the note detail's
   *  `space` field) — adopt it so the chrome scopes correctly. */
  reportNoteSpace: (slug: string) => void
  /** Re-fetch the membership-filtered space list — the list is otherwise loaded
   *  once at boot, but it changes at runtime when access does (#111 revoke, #110
   *  archive). Keeps the switcher honest after a grant disappears. */
  reloadSpaces: () => void
  /** The principal's DELETED spaces (#110) that they can manage — the source for the
   *  Trash → Spaces tab (restore / permanent delete). Empty until something is deleted;
   *  each row carries `archivedAt` (the deletion time). */
  archivedSpaces: Space[]
  /** Re-fetch the archived-spaces list — called on the #111 `access` SSE nudge so an
   *  owner's other tab picks up a space archived/restored elsewhere without a reload. */
  reloadArchived: () => void
  /** Archive a space (#110 soft-delete): stop serving it (data stays whole, restore
   *  reverses it). If it's the ACTIVE space, navigates to a readable fallback
   *  (personal / first other) afterwards. Owner-need (gated in the chrome). */
  archiveSpace: (slug: string) => Promise<void>
  /** Restore an archived space by its stable id (#110) — it returns to the switcher. */
  restoreSpace: (id: string) => Promise<void>
  /** Permanently purge an archived space by id (#110) — IRREVERSIBLE. `confirm` is the
   *  space's current slug, verified server-side. */
  purgeSpace: (id: string, confirm: string) => Promise<void>
}
