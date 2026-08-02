// The full-install gate the native half of the license corpus sits behind, and the
// reason it prints. canon: docs/dev-environment.md#invariants

import type { TestFunction } from '@vitest/runner'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

/** The marker test/skipSummary.ts groups by, so a closed gate reports WHY instead of
 *  an anonymous bump in the skip count. */
export const FULL_DEPS_GATE = '[gate: full deps (make deps-vector)]'

/** The manifests the corpus reads a name, a version and a source ref out of. They
 *  arrive with the @notarium/engine-vector carrier, which the default checkout omits
 *  on purpose (#200) — so "absent" is a legitimate install profile, not a break.
 *
 *  Deliberately NOT the vector gate: that one probes whether the native vec0 driver
 *  LOADS, which is a runtime capability. This asks whether the packages are on disk,
 *  which is an install question. They usually coincide and must not be conflated —
 *  a checkout where the files are present but the driver refuses would skip a suite
 *  that would have passed, under a reason that was not true. */
const NATIVE_MANIFESTS = [
  'node_modules/onnxruntime-common',
  'node_modules/onnxruntime-node',
  'node_modules/onnxruntime-web',
  'node_modules/onnxruntime-web/node_modules/onnxruntime-common',
]

/** Is the FULL dependency tree installed here? Probed once per module load — an
 *  install cannot appear mid-run. */
export const fullDepsInstalled = NATIVE_MANIFESTS.every((dir) =>
  existsSync(join(root, dir, 'package.json')),
)

/** `it` for a case that needs the full install, inside a suite that does not. Runs it
 *  where the tree is complete, elsewhere skips it under a name carrying the gate. */
export const itFullDeps = (name: string, fn: TestFunction, timeout?: number): void => {
  const test = fullDepsInstalled ? it : it.skip

  test(fullDepsInstalled ? name : `${name} ${FULL_DEPS_GATE}`, fn, timeout)
}
