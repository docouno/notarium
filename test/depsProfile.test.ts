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

import { itFullDeps } from './release/fullDepsGate'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const manifest = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'))

// The one workspace lean deliberately leaves out: a deps-only carrier for the ~360 MB
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

  // #317: the carrier exists to exclude the ~360MB embedder, and nothing else. vec0 was
  // swept in with it, which closed the vector gate on every lean run and on every fresh
  // checkout — so 47 tests reported on `main` instead of on the change, and a flipped
  // write-path default reached `main` with three of them red. The gate's failure mode is
  // a SILENT skip, so putting vec0 back inside the carrier would go green everywhere and
  // be visible only to whoever reads the skip line and disbelieves it. These two cases
  // are that reader.
  it('declares vec0 outside the carrier, so every profile can exercise it', () => {
    const engine = manifest('packages/engine/package.json').dependencies as Record<string, string>
    const carrier = manifest('packages/engine-vector/package.json').dependencies as Record<
      string,
      string
    >

    expect(Object.keys(engine)).toContain('sqlite-vec')
    expect(Object.keys(carrier)).not.toContain('sqlite-vec')
    expect(selectedBy(scripts['deps:lean'])).toContain('@notarium/engine')
  })

  it('keeps the heavy embedder inside the carrier, so the exclusion still buys something', () => {
    const declaredOutsideCarrier = readdirSync(join(root, 'packages'))
      .filter((dir) => dir !== 'engine-vector')
      .flatMap((dir) => Object.keys(manifest(`packages/${dir}/package.json`).dependencies ?? {}))

    expect(declaredOutsideCarrier).not.toContain('@huggingface/transformers')
    expect(Object.keys(manifest('packages/engine-vector/package.json').dependencies)).toContain(
      '@huggingface/transformers',
    )
  })

  // onnxruntime-node's Linux postinstall downloads CUDA/TensorRT providers by
  // default from a NuGet CDN. Notarium's embedder is deliberately CPU-only, so that
  // payload is both dead weight and an otherwise invisible second package host in
  // every full install. The upstream environment flag belongs to the canonical npm
  // script, which both Docker stages call too: a custom .npmrc key works only by
  // relying on npm's deprecated forwarding of unknown config into lifecycle envs.
  it('keeps every full install on the CPU-only onnxruntime payload', () => {
    expect(scripts['deps:full']).toMatch(/^ONNXRUNTIME_NODE_INSTALL=skip npm ci\b/)
  })

  it('declares the provider transport client in the server runtime graph', () => {
    const server = manifest('packages/server/package.json').dependencies as Record<string, string>

    expect(Object.keys(server)).toContain('undici')
  })

  itFullDeps('contains no unused Linux GPU execution providers after a full install', () => {
    const linuxRuntime = join(root, 'node_modules/onnxruntime-node/bin/napi-v6/linux/x64')
    const gpuProviders = readdirSync(linuxRuntime).filter((file) => /cuda|tensorrt/i.test(file))

    expect(gpuProviders).toEqual([])
  })

  it('keeps the root package in the lean install', () => {
    // Without --include-workspace-root the root devDependencies (vitest, eslint, the
    // whole toolchain) are not installed, and nothing that a gate runs would exist.
    expect(scripts['deps:lean']).toContain('--include-workspace-root')
  })
})
