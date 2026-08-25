// Personal-domain provisioning: resolve-or-mint the one personal space a user's
// agent-memory writes into. Idempotent, safe to call lazily on first touch.
// canon: docs/projects.md#personal-domain-as-a-working-space-13-2026-06-20 · docs/note-model.md#agent-memory

import { asciiSlug, uniqueSlug } from '@notarium/core'

import type { AuthService } from '../auth'
import type { Principal } from '../authz'
import type { SpaceManager } from './spaceManager'

// The personal-domain pointer (auth.personalSpaceOf) is the stable space id, not the
// slug — a slug rename never breaks it; only candidateSlug picks a human slug.

export type PersonalSpaceDeps = { auth: AuthService; spaces: SpaceManager }

/** Self-cap at 32 (SpaceSlug allows 64) to leave headroom for a uniqueness suffix. */
const SLUG_MAX = 32

/** SpaceSlug-safe slug base from a username; 'user' if it slugifies to empty. */
const personalSlugBase = (username: string): string => {
  const s = asciiSlug(username).slice(0, SLUG_MAX).replace(/-+$/, '')
  return s || 'user'
}

/** A candidate slug free of any live space's current slug or alias. Advisory only —
 *  the real claim is spaces.create, which races. */
const candidateSlug = (spaces: SpaceManager, username: string, tried: Set<string>): string =>
  uniqueSlug(personalSlugBase(username), (s) => !spaces.resolveId(s) && !tried.has(s), {
    maxLength: SLUG_MAX,
  })

/** Mint the space for `slug`; returns its id, or null if the slug was taken (race). */
const tryCreate = async (spaces: SpaceManager, slug: string): Promise<string | null> => {
  try {
    const rec = await spaces.create({ slug, displayName: 'Personal' })
    return rec.id
  } catch (err) {
    if ((err as { reason?: string }).reason !== 'space_exists') {
      throw err
    }

    return null
  }
}

// Per-process mint serialization: SpaceManager.create's has()-before-await guard is
// not atomic, so two concurrent first-touches could both "win" one slug. Cross-process
// races (multiple instances over one Postgres) are out of scope for single-process MVP.
let mintChain: Promise<unknown> = Promise.resolve()

const serializeMint = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = mintChain.then(fn, fn)
  mintChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** Honest-degradation target (P5): when no personal space can be minted, or the
 *  principal has no user record, agent-memory lands here instead of the write failing.
 *  null only on a host with no spaces.
 *  canon: docs/architecture.md#p5 */
const firstSpace = (spaces: SpaceManager): string | null => spaces.list()[0]?.id ?? null

/** Resolve a recorded personal domain by its id and re-assert ownership (idempotent).
 *  null = no pointer yet OR the pointed-at space is gone (partial-mint crash / external
 *  deletion) — the caller then mints a fresh one and overwrites the dangling pointer. */
const resolveExisting = async (
  { auth, spaces }: PersonalSpaceDeps,
  username: string,
): Promise<string | null> => {
  const existing = await auth.personalSpaceOf(username)

  if (!existing) {
    return null
  }
  if (!spaces.has(existing)) {
    return null
  }
  await auth.grantOwner(existing, username)
  return existing
}

const mint = async ({ auth, spaces }: PersonalSpaceDeps, username: string): Promise<string> => {
  // Re-check inside the serialized section: a concurrent mint may have just provisioned.
  const again = await resolveExisting({ auth, spaces }, username)

  if (again) {
    return again
  }

  const tried = new Set<string>()

  for (let attempt = 0; attempt < 10_000; attempt++) {
    const slug = candidateSlug(spaces, username, tried)
    tried.add(slug)
    const id = await tryCreate(spaces, slug)

    if (!id) {
      continue
    }
    // Record the pointer BEFORE the owner grant: a crash before this leaves an
    // unreachable empty space (harmless); recording it first lets a later crash heal
    // via resolveExisting instead of minting a duplicate.
    await auth.setPersonalSpace(username, id)
    await auth.grantOwner(id, username)
    return id
  }
  // Pathological: every candidate lost its create race. Degrade, don't spin.
  const fallback = firstSpace(spaces)

  if (!fallback) {
    throw new Error('cannot provision a personal space: the host has no spaces')
  }

  return fallback
}

/** Resolve the principal's personal space, minting on first touch (idempotent;
 *  concurrent first-touches recover from the create race). The none-mode / system
 *  principal owns the whole host, so its personal domain is the host's first space. */
export const ensurePersonalSpace = async (
  deps: PersonalSpaceDeps,
  principal: Principal,
): Promise<string> => {
  if (principal.system || !principal.username) {
    const home = firstSpace(deps.spaces)

    if (!home) {
      throw new Error('no space available for the personal domain')
    }

    return home
  }

  return ensurePersonalSpaceFor(deps, principal.username)
}

/** Resolve the personal space WITHOUT minting (read path): a GET surface (memory list,
 *  profile read) must not provision a space as a side effect of being viewed. null when
 *  there's no pointer or the space isn't live — the caller shows an honest empty state. */
export const peekPersonalSpace = async (
  { auth, spaces }: PersonalSpaceDeps,
  principal: Principal,
): Promise<string | null> => {
  if (principal.system || !principal.username) {
    return firstSpace(spaces)
  }
  const id = await auth.personalSpaceOf(principal.username)

  if (!id || !spaces.has(id)) {
    return null
  }
  // A credential narrowed by space away from the personal domain must not read it:
  // narrowing is stored as ids and peek returns an id, so the comparison is direct.
  // A cookie session carries `spaces: null` — the guard is inert for it.
  if (principal.spaces && !principal.spaces.has(id)) {
    return null
  }

  return id
}

/** ensurePersonalSpace keyed by username — for the auth flow (setup/accept-invite),
 *  before a Principal is in hand. */
export const ensurePersonalSpaceFor = async (
  deps: PersonalSpaceDeps,
  username: string,
): Promise<string> => {
  const existing = await resolveExisting(deps, username)

  if (existing) {
    return existing
  }
  // Operator-static host (engine can't mint namespaces): degrade to the first space (P5).
  if (!deps.spaces.capabilities.spaceCreate) {
    const fallback = firstSpace(deps.spaces)

    if (!fallback) {
      throw new Error('cannot provision a personal space: the host has no spaces')
    }

    return fallback
  }

  return serializeMint(() => mint(deps, username))
}
