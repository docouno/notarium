// The gate's REASON, not its verdict: a skipped suite has to say which of the two
// closed it, because only one of them is the reader's to fix. #317 made this reachable
// — sqlite-vec became an ordinary dependency, so a checkout installed before that lacks
// the package while every supported platform can load it, and a single
// platform-blaming message would tell a contributor their machine cannot run 47 tests
// that one install enables.

import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

/** Load the gate fresh under a resolver that fails for `sqlite-vec` the way the given
 *  scenario would. Fresh, because the real module probes once at import — correct in
 *  production (neither an install nor a platform changes mid-run) and useless here. */
const gateUnder = async (failure: 'missing' | 'unloadable') => {
  const mod = createRequire(import.meta.url)('node:module') as {
    _resolveFilename: (request: string, ...rest: unknown[]) => string
  }
  const real = mod._resolveFilename

  mod._resolveFilename = function (request: string, ...rest: unknown[]) {
    if (request === 'sqlite-vec') {
      const err = new Error(
        failure === 'missing'
          ? "Cannot find module 'sqlite-vec'"
          : 'dlopen failed: wrong ELF class',
      ) as NodeJS.ErrnoException

      // The resolver's own code is the discriminator — a binary that fails to LOAD
      // surfaces as some other error, and the gate must not read it as "not installed".
      if (failure === 'missing') {
        err.code = 'MODULE_NOT_FOUND'
      }
      throw err
    }

    return real.call(this, request, ...rest)
  }
  try {
    vi.resetModules()

    return await import('./vectorGate.fixture')
  } finally {
    mod._resolveFilename = real
  }
}

describe('vec0 gate reason', () => {
  it('names the install when the package is simply not there', async () => {
    const gate = await gateUnder('missing')

    expect(gate.vectorAvailable).toBe(false)
    expect(gate.VECTOR_GATE).toBe(gate.VECTOR_GATE_MISSING)
    expect(gate.VECTOR_GATE).toContain('deps:lean')
  })

  it('blames the platform for anything else, promising the reader nothing', async () => {
    const gate = await gateUnder('unloadable')

    expect(gate.vectorAvailable).toBe(false)
    expect(gate.VECTOR_GATE).toBe(gate.VECTOR_GATE_PLATFORM)
    expect(gate.VECTOR_GATE).not.toContain('npm')
  })

  // The canary for the whole point of #317: where the extension is installed AND the
  // platform can load it, the gate must be OPEN. Without this, the two cases above
  // would still pass with vec0 back inside the carrier, or with a sqlite-vec release
  // that ships no prebuilt for this platform — the gate would close, 47 tests would
  // skip, and every lane would stay green. `test/depsProfile.test.ts` pins the manifest
  // half of that invariant; this pins the half that only the running process knows.
  //
  // It is itself gated, and on the two conditions that make "open" a fair demand,
  // because asserting it unconditionally would turn the designed skips into failures:
  // a checkout installed before #317 has no sqlite-vec, and a musl host cannot dlopen
  // the glibc-only binary. Both are states this commit exists to accommodate, and both
  // are announced by the skip line rather than an assertion error.
  const runtimeCanRunVec0 = ((): boolean => {
    // glibcVersionRuntime is absent on musl — the one platform fact that decides
    // whether a loadable prebuilt exists at all.
    const header = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } }

    if (!header?.header?.glibcVersionRuntime) {
      return false
    }
    try {
      createRequire(import.meta.url).resolve('sqlite-vec')

      return true
    } catch {
      return false
    }
  })()
  const CANARY_GATE = '[gate: vec0 canary (needs a glibc host with sqlite-vec installed)]'
  const canary = runtimeCanRunVec0 ? it : it.skip

  canary(
    runtimeCanRunVec0
      ? 'reports the channel open where the extension is installed and loadable'
      : `reports the channel open where the extension is installed and loadable ${CANARY_GATE}`,
    async () => {
      vi.resetModules()

      const gate = await import('./vectorGate.fixture')

      expect(gate.vectorAvailable).toBe(true)
    },
  )
})
