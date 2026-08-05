// The catalog authors primary content as a canonical owner token (`sergey`); the REAL
// applier renders it as the configured INIT USER (SEED_USER, default `admin`), so the
// default login IS the content author and the "mine" heatmap/feed light up out of the
// box. Extracted from scripts/seed.ts as a PURE module so it can be unit-tested —
// seed.ts runs `run()` on import, so it can't be imported directly. See docs/seeds.md.

export type OwnerRemap = {
  /** A bare username: the catalog owner → the init user; anyone else unchanged. */
  asUser: (name: string) => string
  /** A journal principal (`user:<name>` / `pat:<name>:<id>` / `ui` / null): the owner's
   *  name segment → the init user, everything else (incl. a same-prefixed different user)
   *  unchanged. */
  remapPrincipal: (p?: string) => string | undefined
}

export const makeOwnerRemap = (catalogOwner: string, ownerUser: string): OwnerRemap => {
  const asUser = (name: string): string => (name === catalogOwner ? ownerUser : name)

  const remapPrincipal = (p?: string): string | undefined => {
    if (!p) {
      return p
    }
    const parts = p.split(':')

    if ((parts[0] === 'user' || parts[0] === 'pat') && parts[1] === catalogOwner) {
      parts[1] = ownerUser
      return parts.join(':')
    }

    return p
  }

  return { asUser, remapPrincipal }
}

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
