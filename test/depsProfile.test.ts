// The two install profiles are a contract, and `deps:lean` names its workspaces one
// by one — npm has no "every workspace except this one" selector.
//
// A hand-written list drifts the moment a package is added, and it drifts SILENTLY:
// the missing workspace simply is not installed, so its own tests fail somewhere far
// from the cause, or worse, pass because nothing imported it. That already happened
// once — `packages/cli` landed on main while this list still had eight entries.

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const manifest = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'))

// The one workspace lean deliberately leaves out: a deps-only carrier for the ~660 MB
// native vector stack.
const CARRIER = '@notarium/engine-vector'

const workspaceNames = () =>
  readdirSync(join(root, 'packages')).map(
    (dir) => manifest(`packages/${dir}/package.json`).name as string,
  )

const selectedBy = (script: string) =>
  new Set([...script.matchAll(/--workspace=(\S+)/g)].map((match) => match[1]))

describe('dependency profiles', () => {
  const scripts = manifest('package.json').scripts as Record<string, string>

  it('installs every workspace except the vector carrier on the lean profile', () => {
    const selected = selectedBy(scripts['deps:lean'])
    const expected = workspaceNames().filter((name) => name !== CARRIER)

    expect([...selected].sort()).toEqual(expected.sort())
  })

  it('installs everything on the full profile, by selecting nothing', () => {
    // `npm ci` with no --workspace flags is the whole tree. Naming workspaces here
    // would be a second list to keep in sync for no gain.
    expect(selectedBy(scripts['deps:full']).size).toBe(0)
  })

  it('keeps the root package in the lean install', () => {
    // Without --include-workspace-root the root devDependencies (vitest, eslint, the
    // whole toolchain) are not installed, and nothing that a gate runs would exist.
    expect(scripts['deps:lean']).toContain('--include-workspace-root')
  })
})
