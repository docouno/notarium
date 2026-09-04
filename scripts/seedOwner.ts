// The catalog authors primary content as a canonical owner token (`sergey`); the REAL
// applier renders it as the configured INIT USER (SEED_USER, default `admin`), so the
// default login IS the content author and the "mine" heatmap/feed light up out of the
// box. Extracted from scripts/seed.ts as a PURE module so it can be unit-tested —
// seed.ts runs `run()` on import, so it can't be imported directly. See docs/seeds.md.

import {
  oauthPrincipalId,
  parsePrincipalId,
  patPrincipalId,
  PRINCIPAL_SCHEME,
  userPrincipalId,
} from '@notarium/server'

export type OwnerRemap = {
  /** A bare username: the catalog owner → the init user; anyone else unchanged. */
  asUser: (name: string) => string
  /** A journal principal (`user:<name>` / `pat:<name>:<id>` / `oauth:<name>:<id>` / `ui`
   *  / null): the owner's name segment → the init user, everything else (incl. a
   *  same-prefixed different user) unchanged. */
  remapPrincipal: (p?: string) => string | undefined
}

export const makeOwnerRemap = (catalogOwner: string, ownerUser: string): OwnerRemap => {
  const asUser = (name: string): string => (name === catalogOwner ? ownerUser : name)

  const remapPrincipal = (p?: string): string | undefined => {
    if (!p) {
      return p
    }
    const parts = p.split(':')

    // Every agent scheme, not just PATs: a connected app's principal names its owner
    // the same way, and skipping it left the catalog owner's OAuth rows pointing at a
    // handle the seeded stand never mints.
    if (
      (parts[0] === 'user' || parts[0] === 'pat' || parts[0] === 'oauth') &&
      parts[1] === catalogOwner
    ) {
      parts[1] = ownerUser
      return parts.join(':')
    }

    return p
  }

  return { asUser, remapPrincipal }
}

/** The convenience grant that makes a manual stand browsable must not punch
 * through personal-domain isolation. Explicit case memberships remain explicit. */
export const shouldAutoGrantSeedOwner = (input: {
  personalFor?: string
  primaryUsername: string
  asUser: (name: string) => string
}): boolean => !input.personalFor || input.asUser(input.personalFor) === input.primaryUsername

export const resolveSeedAgentDeltaCursorOwner = (input: {
  cursorOwner?: string
  sessionOwner?: string
  fallbackOwner: string
  asUser: (name: string) => string
}): string => {
  const explicit = input.cursorOwner ? input.asUser(input.cursorOwner) : undefined
  const bound = input.sessionOwner ? input.asUser(input.sessionOwner) : undefined

  if (explicit && bound && explicit !== bound) {
    throw new Error(`agent delta cursor owner ${explicit} does not match session owner ${bound}`)
  }

  return explicit ?? bound ?? input.fallbackOwner
}

export const resolveSeedAgentActivityOwner = (input: {
  kind: 'write' | 'retrieval'
  activityOwner?: string
  sessionOwner?: string
  fallbackOwner: string
  asUser: (name: string) => string
}): string => {
  const explicit = input.activityOwner ? input.asUser(input.activityOwner) : undefined
  const bound = input.sessionOwner ? input.asUser(input.sessionOwner) : undefined

  if (explicit && bound && explicit !== bound) {
    throw new Error(`agent ${input.kind} owner ${explicit} does not match session owner ${bound}`)
  }

  return bound ?? explicit ?? input.fallbackOwner
}

/** A catalog principal names its owner by handle; the meta-DB keys attribution by the
 *  stable user id. Rewrite the owner segment to the id the seed minted for that handle,
 *  leaving `ui`, an unknown scheme and an unknown (orphaned) handle exactly as authored. */
export const principalWithIds = (
  principal: string,
  userIdOf: (username: string) => string | undefined,
): string => {
  const parsed = parsePrincipalId(principal)
  const id = parsed ? userIdOf(parsed.userId) : undefined

  if (!parsed || !id) {
    return principal
  }
  if (parsed.scheme === PRINCIPAL_SCHEME.user) {
    return userPrincipalId(id)
  }

  return parsed.scheme === PRINCIPAL_SCHEME.pat
    ? patPrincipalId(id, parsed.keyId as string)
    : oauthPrincipalId(id, parsed.keyId as string)
}
