import type { AuthMode, AuthSession, Me } from '@notarium/contract'
import { AUTH_MODE, SPACE_ROLE } from '@notarium/contract/enums'

// The access health verdict (#111): given a fresh session and the space the UI
// is currently sitting in, decide whether the principal still has a usable
// footing. This is the AUTHORITY half of the runtime-access-loss detector — the
// SSE drop / a 403·404 on the active space are only TRIGGERS; the truth is the
// session's live grants (`me.spaces` + `me.personalSpace`), which the server
// recomputes on every request. Deliberately pure so it can be reasoned about
// (and unit-tested) without React: it never fetches, it classifies.
//
// We don't try to tell revoke from archive (#110) from delete apart — the wire
// can't (anti-enumeration #16: a non-member gets the same 404 as "no such
// space"), and the user-facing answer is identical: "this space is gone, here's
// another". A disabled user collapses into `session-lost` (the server kills the
// session, so `me` is null) — which is correct: a disabled user IS logged out.

export type AccessVerdict =
  /** The active space is still reachable (or the host is mode 'none', a virtual
   *  all-access principal that can't lose a grant). Keep running. */
  | { kind: 'ok' }
  /** No principal anymore — expired/revoked cookie or a disabled account. The
   *  app falls back to the login screen (the existing AuthGate machinery). */
  | { kind: 'session-lost' }
  /** Still signed in, but the active space dropped out of the grants — membership
   *  was revoked, or the space was archived/deleted. Show the takeover. */
  | { kind: 'space-lost' }

/** Does a grant match `space` by its CURRENT slug OR a past one (#123)? When a space is
 *  renamed, `me.spaces` carries the new slug + the old slug(s) in `aliases`, while the
 *  client's `active` lags a render on the old one — matching the alias keeps the rename
 *  from reading as a lost grant. The alias only ever belongs to a space the principal
 *  HOLDS (the server builds it from the held grant's own history), so this never widens
 *  access. Narrow cosmetic edge: if a held grant's retired alias happens to equal some
 *  OTHER (un-held) space's current slug, sitting on that slug reads as `ok` rather than
 *  a takeover — harmless, since the server still resolves slug→id and denies the data. */
const matchesSpace = (s: Me['spaces'][number], space: string): boolean =>
  s.slug === space || Boolean(s.aliases?.includes(space))

/** Does this principal still hold a grant on `activeSpace`? Personal domain
 *  counts — it's a real owned space, just filtered out of the workspace list. */
const hasAccess = (me: Me, activeSpace: string): boolean =>
  me.personalSpace === activeSpace || me.spaces.some((s) => matchesSpace(s, activeSpace))

export const classifyAccess = (session: AuthSession, activeSpace: string): AccessVerdict => {
  // Mode 'none' is the single all-access principal (desktop/dev): there are no
  // memberships to lose, so an SSE drop there is always a transient blip, never
  // a revocation. (`me` is null in this mode — guard before the null check.)
  if (session.mode === AUTH_MODE.none) {
    return { kind: 'ok' }
  }
  if (!session.me) {
    return { kind: 'session-lost' }
  }

  return hasAccess(session.me, activeSpace) ? { kind: 'ok' } : { kind: 'space-lost' }
}

/** Can this principal mutate content in `space`? The client mirror of the
 *  server's `can(space:write)` (authz.ts): role ≥ writer, the single principal
 *  on a 'none' host, or one's own personal domain (owned). Host-admin does NOT
 *  count — the server's admin override is for management/recovery only, never
 *  data writes, so trusting `admin` here would re-show the very affordances the
 *  server then rejects (the reader bug, one tier up). A reader gets false → the
 *  chrome hides every create/edit/delete affordance instead of misleading them. */
export const canWriteSpace = (me: Me | null, mode: AuthMode, space: string): boolean => {
  if (mode === AUTH_MODE.none) {
    return true
  }
  if (!me) {
    return false
  }
  if (me.personalSpace === space) {
    return true
  }
  // Alias-tolerant (#123) via matchesSpace: a just-renamed active slug still matches its
  // grant through the past-slug aliases, so the write chrome never flashes read-only.
  const role = me.spaces.find((s) => matchesSpace(s, space))?.role
  return role === SPACE_ROLE.owner || role === SPACE_ROLE.writer
}

/** Can this principal MANAGE `space` (rename it, future space settings)? The client
 *  mirror of the server's can(space:manage) (authz.ts): role 'owner', a host admin
 *  (the recovery override for an owner-need management act — legitimate here, unlike
 *  data writes, #121), or the single principal on a 'none' host. Alias-tolerant like
 *  the rest, so a just-renamed active slug keeps the management surface available. A
 *  writer/reader gets false → the General (rename) tab stays hidden from them. */
export const canManageSpace = (me: Me | null, mode: AuthMode, space: string): boolean => {
  if (mode === AUTH_MODE.none) {
    return true
  }
  if (!me) {
    return false
  }
  if (me.admin) {
    return true
  }
  if (me.personalSpace === space) {
    return true
  }
  const role = me.spaces.find((s) => matchesSpace(s, space))?.role
  return role === SPACE_ROLE.owner
}

/** Where to send a principal who just lost `lostSpace`: their personal domain
 *  first (the landing home, #99 — and one they can never be revoked from), else
 *  the first other space they can still read, else null (nothing left → the
 *  "no spaces" face). Never returns `lostSpace` itself. */
export const fallbackSpace = (me: Me, lostSpace: string): string | null => {
  if (me.personalSpace && me.personalSpace !== lostSpace) {
    return me.personalSpace
  }
  const other = me.spaces.find((s) => s.slug !== lostSpace)
  return other?.slug ?? null
}

/** Append a space grant to a grants list if absent — the pure core of the client's
 *  optimistic grant when a space is created (#154): the creator owns what they minted, so
 *  the affordance can light up without waiting on the session re-pull. Idempotent: returns
 *  the SAME array reference when the slug is already held (the caller skips a needless
 *  state write, and a held role is never silently downgraded). A freshly minted space has
 *  no past slugs, so the appended grant carries no `aliases`. */
export const withGrant = (
  spaces: Me['spaces'],
  slug: string,
  role: Me['spaces'][number]['role'],
): Me['spaces'] => (spaces.some((s) => s.slug === slug) ? spaces : [...spaces, { slug, role }])
