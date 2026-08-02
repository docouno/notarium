import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// packages/cli is the one workspace that leaves this repository as an npm tarball,
// so it carries its own copies of the licence texts — npm cannot reach outside a
// package directory. Copies drift silently; this is the gate that makes them not.
const at = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8')

describe('published CLI legal corpus', () => {
  it.each(['LICENSE', 'NOTICE'])('ships %s identical to the repository root', (file) => {
    expect(at(`packages/cli/${file}`)).toBe(at(file))
  })

  it('publishes those copies rather than leaving them out of the tarball', () => {
    const manifest = JSON.parse(at('packages/cli/package.json')) as { files: string[] }

    expect(manifest.files).toContain('NOTICE')
  })
})

describe('published CLI manifest', () => {
  // npm drops a bin path written with a './' prefix from the published metadata and
  // says so only in a publish warning — `npm pack` still shows the path intact, so
  // the tarball looks right while the installed package has no executable at all.
  it('declares its bin without a relative prefix npm would reject', () => {
    const manifest = JSON.parse(at('packages/cli/package.json')) as {
      bin: Record<string, string>
    }

    for (const target of Object.values(manifest.bin)) {
      expect(target.startsWith('./')).toBe(false)
    }
  })
})
