// Env → the host's space set + the legacy-row adoption target.
// canon: docs/spaces.md#deployment-notarium-engine-69

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { AUTH_MODE, SpaceSlugSchema } from '@notarium/contract'

import type { SpaceConfig } from './server'

/** Resolves env (+ authMode) into the host's space set, spacesRoot, and legacy adoption target.
 *  spacesRoot is decided HERE (not re-read in main.ts) so the mode and the root can't disagree; it
 *  gates spaceCreate/purge. defaultSpacesRoot applies ONLY zero-config — an explicit topology must
 *  not silently gain runtime space creation over a root the operator never named. */
export const spacesFromEnv = (
  env: NodeJS.ProcessEnv,
  authMode: 'password' | 'none',
  defaultSpacesRoot: string,
): { spaces: SpaceConfig[]; adoptLegacyInto?: string; spacesRoot?: string } => {
  // engine is a P8 placeholder — 'notarium' is the only implementation.
  // canon: docs/architecture.md#p8
  const engineOf = (raw: string | undefined, where: string): SpaceConfig['engine'] => {
    const engine = raw || 'notarium'

    if (engine !== 'notarium') {
      throw new Error(`${where}: engine must be "notarium", got "${engine}"`)
    }

    return engine
  }
  const explicitSpacesRoot = env.SPACES_ROOT?.trim() || undefined
  const raw = env.SPACES_CONFIG?.trim()

  if (raw) {
    const text = raw.startsWith('{') ? raw : readFileSync(raw, 'utf8')
    const parsed = JSON.parse(text) as {
      spaces?: Array<{
        slug?: string
        displayName?: string
        engine?: string
        notesDir?: string
        indexDb?: string
      }>
    }

    if (!parsed.spaces?.length) {
      throw new Error('SPACES_CONFIG: "spaces" is empty')
    }
    const spaces = parsed.spaces.map((s): SpaceConfig => {
      const slug = SpaceSlugSchema.safeParse(s.slug)

      if (!slug.success) {
        throw new Error(`SPACES_CONFIG: bad space slug "${s.slug}"`)
      }
      const engine = engineOf(s.engine, `SPACES_CONFIG: space "${s.slug}"`)

      if (!s.notesDir) {
        throw new Error(`SPACES_CONFIG: space "${s.slug}" has no notesDir`)
      }

      return {
        slug: slug.data,
        displayName: s.displayName,
        engine,
        notesDir: s.notesDir,
        indexDb: s.indexDb,
      }
    })
    return { spaces, spacesRoot: explicitSpacesRoot }
  }
  // Legacy single-space envs (bare, non-Docker run): ENGINE + NOTES_DIR define one 'main' space.
  // Tested BEFORE zero-config and keyed on its OWN envs: the mode is chosen by what the operator
  // NAMED, never by omission — omission is what makes zero-config zero-config.
  if (env.ENGINE?.trim() || env.NOTES_DIR?.trim()) {
    const slug = 'main'
    const engine = engineOf(env.ENGINE, 'ENGINE')

    if (!env.NOTES_DIR) {
      throw new Error('a single-space run needs NOTES_DIR')
    }

    return {
      spaces: [{ slug, engine, notesDir: env.NOTES_DIR }],
      adoptLegacyInto: slug,
      spacesRoot: explicitSpacesRoot,
    }
  }
  // Zero-config default: a notes root and nothing else; the shape depends on auth mode
  // (password = start with no spaces, none = one 'main' home space).
  const root = explicitSpacesRoot ?? defaultSpacesRoot

  if (authMode === AUTH_MODE.none) {
    return {
      spaces: [
        { slug: 'main', displayName: 'Home', engine: 'notarium', notesDir: join(root, 'main') },
      ],
      spacesRoot: root,
    }
  }

  return { spaces: [], spacesRoot: root }
}
