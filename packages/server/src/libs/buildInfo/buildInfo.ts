// Build identity (version + commit + build time + source revision) for /api/about
// and `notarium version`. Production (tsup) inlines these as string literals via
// `define`, so the container never touches package.json or git at runtime; an
// unbundled dev run (tsx) recovers what it can and leaves builtAt/source null
// (P5: honest null over a fabricated value). A RELEASED image gets all four from
// the release entrypoint — canon: docs/release.md#identity.

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type BuildInfo = {
  version: string
  commit: string | null
  builtAt: string | null
  /** URL of the exact revision this build came from — the released image's own
   *  pointer back to its source. Empty outside a release build: a local `docker
   *  build` has no published revision to name, and guessing one would be a lie.
   *  canon: docs/release.md#identity */
  source: string | null
}

// Dev fallback only; five `..` from this file = repo root.
const devVersion = (): string => {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const devCommit = (): string | null => {
  try {
    return (
      execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim() || null
    )
  } catch {
    return null
  }
}

// `=== undefined` (not `||`) AND read process.env INLINE (not via a const): the
// build-time define replaces each reference with a string literal, so an empty sha
// still folds to false and esbuild tree-shakes devVersion/devCommit out. A `||`
// gate or a const leaves an empty sha un-inlined and ships a doomed `git rev-parse`
// spawn into the git-less runtime image. Unset env (tsx dev run) ⇒ fallback runs.
export const buildInfo: BuildInfo = {
  version: process.env.NOTARIUM_VERSION === undefined ? devVersion() : process.env.NOTARIUM_VERSION,
  commit:
    process.env.NOTARIUM_GIT_SHA === undefined ? devCommit() : process.env.NOTARIUM_GIT_SHA || null,
  builtAt:
    process.env.NOTARIUM_BUILD_TIME === undefined ? null : process.env.NOTARIUM_BUILD_TIME || null,
  // No dev fallback: outside a release build there IS no published revision to name.
  source: process.env.NOTARIUM_SOURCE_URL || null,
}
