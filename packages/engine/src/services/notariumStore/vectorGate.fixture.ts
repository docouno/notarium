// The vec0 gate every vector-path suite sits behind, and the reason it prints.
// canon: docs/dev-environment.md#invariants

import type { SuiteFactory, TestFunction } from '@vitest/runner'
import { describe, it } from 'vitest'

import { createNodeSqliteDriver } from '../../libs/sql'

/** The marker test/skipSummary.ts groups by, so a closed gate reports WHY instead of
 *  an anonymous bump in the skip count. */
export const VECTOR_GATE = '[gate: vector (make deps-vector)]'

/** Is the vector channel exercisable here? The native stack is an optional install
 *  unit, so "no" is a legitimate answer, not a failure. Probed once per module load —
 *  the answer cannot change mid-run. */
export const vectorAvailable = ((): boolean => {
  try {
    const driver = createNodeSqliteDriver(':memory:', { vec: true })

    // close() is async: a bare call would surface a failure as an unhandled rejection
    // past this catch, and report the gate as OPEN on a driver that never closed.
    void driver.close().catch(() => {})

    return true
  } catch {
    return false
  }
})()

/** `describe` for a suite that needs vec0 — runs it where the stack loads, elsewhere
 *  skips it under a name carrying the gate. */
export const describeVector = (name: string, fn: SuiteFactory): void => {
  const suite = vectorAvailable ? describe : describe.skip

  suite(vectorAvailable ? name : `${name} ${VECTOR_GATE}`, fn)
}

/** The single-case form, for a vec0-gated test inside a suite that is NOT gated. */
export const itVector = (name: string, fn: TestFunction, timeout?: number): void => {
  const test = vectorAvailable ? it : it.skip

  test(vectorAvailable ? name : `${name} ${VECTOR_GATE}`, fn, timeout)
}
