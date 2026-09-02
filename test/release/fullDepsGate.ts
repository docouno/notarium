// The full-install gate the native half of the license corpus sits behind, and the
// reason it prints. canon: docs/dev-environment.md#invariants

import type { TestFunction } from '@vitest/runner'
import { it } from 'vitest'
import { fullDepsInstalled } from './fullDepsProfile'

export { fullDepsInstalled } from './fullDepsProfile'

/** The marker test/skipSummary.ts groups by, so a closed gate reports WHY instead of
 *  an anonymous bump in the skip count. */
export const FULL_DEPS_GATE = '[gate: full deps (make deps-vector)]'

/** `it` for a case that needs the full install, inside a suite that does not. Runs it
 *  where the tree is complete, elsewhere skips it under a name carrying the gate. */
export const itFullDeps = (name: string, fn: TestFunction, timeout?: number): void => {
  const test = fullDepsInstalled ? it : it.skip

  test(fullDepsInstalled ? name : `${name} ${FULL_DEPS_GATE}`, fn, timeout)
}
