// The npm floor is enforced by npm itself, not by anything in this repository — which
// leaves the declaration it enforces unguarded. Dropping `.npmrc` or the `engines` block
// is SILENT: the install stops refusing and starts warning (removing `engines` prints
// nothing at all), succeeds, and writes a lockfile with the root `@hono/node-server`
// override dropped — npm/cli issue 9659, the exact breakage this repository pins against.
// Every other gate stays green, because none of them reads these two files.
//
// The pin lines in the contours need no such test: drop one and the very next install
// refuses. These three fields are the only part of the mechanism that fails quietly.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

// The npm/cli 9659 fix landed in 11.18.0: below it a root override whose target sits
// behind a workspace link is dropped from the lockfile npm writes.
const FIX = { major: 11, minor: 18 }

describe('toolchain declaration', () => {
  const manifest = JSON.parse(read('package.json')) as {
    engines?: Record<string, string>
    packageManager?: string
  }

  it('declares an npm floor at or above the npm/cli 9659 fix', () => {
    const floor = /^>=(\d+)\.(\d+)/.exec(manifest.engines?.npm ?? '')

    expect(
      floor,
      `engines.npm must be ">=<major>.<minor>", got ${manifest.engines?.npm}`,
    ).not.toBeNull()

    const [major, minor] = [Number(floor![1]), Number(floor![2])]
    expect(major * 1000 + minor).toBeGreaterThanOrEqual(FIX.major * 1000 + FIX.minor)
  })

  it('declares a Node floor, so the refusal covers both halves of the toolchain', () => {
    expect(manifest.engines?.node).toMatch(/^>=\d+/)
  })

  it('names one exact npm for the contours to install', () => {
    expect(manifest.packageManager).toMatch(/^npm@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+.*)?$/)
  })

  it('turns the floor into a refusal rather than a warning', () => {
    const npmrc = read('.npmrc')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith(';') && !line.startsWith('#'))

    expect(npmrc).toContain('engine-strict=true')
  })

  it('installs the declared npm before the fields benchmark dependency contour', () => {
    const makefile = read('Makefile')
    const target = makefile.slice(
      makefile.indexOf('bench-fields-snapshot:'),
      makefile.indexOf('write-perf-gate:'),
    )

    expect(target).toContain('pinned_npm=')
    expect(target).toContain('npm i -g')
    expect(target.indexOf('npm i -g')).toBeLessThan(target.indexOf('npm run deps:lean'))
  })
})
