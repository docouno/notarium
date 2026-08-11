// The gate every real-filesystem package publish sits behind, and the reason it
// prints. canon: docs/dev-environment.md#invariants

import type { SuiteFactory, TestFunction } from '@vitest/runner'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { renameNoReplace } from '@notarium/engine'

/** The markers test/skipSummary.ts groups by. TWO of them, because the gate
 *  closes for two unrelated reasons and only one of them is a verdict about the
 *  machine: an unmapped platform is a permanent property no command changes,
 *  while an unavailable runtime (no interpreter, a filesystem or kernel without
 *  the syscall) is a property of THIS environment. */
export const ATOMIC_PUBLISH_GATE_PLATFORM =
  '[gate: atomic no-replace (no renameat2 on this platform)]'
export const ATOMIC_PUBLISH_GATE_RUNTIME =
  '[gate: atomic no-replace (primitive unavailable on this runtime)]'

/** Probed once per module load with a real publication — neither a platform nor
 *  an interpreter changes mid-run. The probe is asynchronous, so the marker is
 *  settled by a top-level await before any `describe` asks for it, and the gate
 *  closes on ANY failure: a probe that cannot publish into a private temporary
 *  directory means the suites behind it can prove nothing either way. */
const closedBecause = await (async (): Promise<string | null> => {
  let root: string | undefined
  let marker: string | null = null

  try {
    root = await mkdtemp(join(tmpdir(), 'nt-atomic-publish-gate-'))
    await mkdir(join(root, 'source'))
    await renameNoReplace(join(root, 'source'), join(root, 'target'))
  } catch (err) {
    const failure = err as NodeJS.ErrnoException & { cause?: unknown }

    marker =
      failure.code === 'ENOTSUP' && failure.cause === undefined
        ? ATOMIC_PUBLISH_GATE_PLATFORM
        : ATOMIC_PUBLISH_GATE_RUNTIME
  }
  if (root) {
    await rm(root, { recursive: true, force: true }).catch(() => {
      marker = ATOMIC_PUBLISH_GATE_RUNTIME
    })
  }

  return marker
})()

/** Can a package be published atomically here? "No" is a legitimate answer, not
 *  a failure — the in-memory leg of the contract runs regardless. */
export const atomicPublishAvailable = closedBecause === null

/** Kept as a named export so a suite can carry the reason it sat out without
 *  knowing which of the two applied. */
export const ATOMIC_PUBLISH_GATE = closedBecause ?? ATOMIC_PUBLISH_GATE_PLATFORM

/** `describe` for a suite that publishes onto a real filesystem. */
export const describeAtomicPublish = (name: string, fn: SuiteFactory): void => {
  const suite = atomicPublishAvailable ? describe : describe.skip

  suite(atomicPublishAvailable ? name : `${name} ${ATOMIC_PUBLISH_GATE}`, fn)
}

/** The single-case form, for a publishing test inside a suite that is NOT gated. */
export const itAtomicPublish = (name: string, fn: TestFunction, timeout?: number): void => {
  const test = atomicPublishAvailable ? it : it.skip

  test(atomicPublishAvailable ? name : `${name} ${ATOMIC_PUBLISH_GATE}`, fn, timeout)
}
