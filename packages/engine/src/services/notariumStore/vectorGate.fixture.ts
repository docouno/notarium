// The vec0 gate every vector-path suite sits behind, and the reason it prints.
// canon: docs/dev-environment.md#invariants

import type { SuiteFactory, TestFunction } from '@vitest/runner'
import { describe, it } from 'vitest'

import { createNodeSqliteDriver } from '../../libs/sql'

/** The markers test/skipSummary.ts groups by, so a closed gate reports WHY instead of
 *  an anonymous bump in the skip count. TWO of them, because the gate closes for two
 *  unrelated reasons and only one of them is the reader's to fix:
 *
 *  - the package is not installed — an INSTALL question, answered by a command;
 *  - the package is installed but its prebuilt binary cannot load (musl) — a PLATFORM
 *    verdict, which no command changes.
 *
 *  Collapsing them is a real hazard, not a nicety: `sqlite-vec` became an ordinary
 *  dependency in #317, so a checkout that installed BEFORE that lacks it, and a single
 *  platform-blaming message would tell a contributor their machine cannot run 47 tests
 *  that one `npm run deps:lean` would enable. `test/release/fullDepsGate.ts` states the
 *  same principle for its own gate: install and capability "usually coincide and must
 *  not be conflated". */
export const VECTOR_GATE_MISSING = '[gate: vec0 (npm run deps:lean)]'
export const VECTOR_GATE_PLATFORM = '[gate: vec0 (no native binary on this platform)]'

/** Which of the two applies here, or null when the channel works. Probed once per
 *  module load — neither an install nor a platform can change mid-run.
 *
 *  The distinction is drawn on the resolver's own answer (MODULE_NOT_FOUND), not on
 *  message text: a load failure of the binary surfaces as some other error, and
 *  anything unrecognised is reported as the platform verdict — the conservative side,
 *  since it promises the reader nothing. */
const closedBecause = ((): string | null => {
  try {
    const driver = createNodeSqliteDriver(':memory:', { vec: true })

    // close() is async: a bare call would surface a failure as an unhandled rejection
    // past this catch, and report the gate as OPEN on a driver that never closed.
    void driver.close().catch(() => {})

    return null
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'MODULE_NOT_FOUND'
      ? VECTOR_GATE_MISSING
      : VECTOR_GATE_PLATFORM
  }
})()

/** Is the vector channel exercisable here? "No" is a legitimate answer — on musl by
 *  platform, on a stale tree until the next install — not a failure. */
export const vectorAvailable = closedBecause === null

/** Kept as a named export so a suite can carry the reason it sat out without knowing
 *  which of the two applied. */
export const VECTOR_GATE = closedBecause ?? VECTOR_GATE_PLATFORM

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
