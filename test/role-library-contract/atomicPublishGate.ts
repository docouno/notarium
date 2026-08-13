// The gate every real-filesystem package publish sits behind, and the reason it
// prints. canon: docs/dev-environment.md#invariants

import type { SuiteFactory, TestFunction } from '@vitest/runner'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

// By module path: the gate needs the raw primitive to probe with, and the engine
// barrel deliberately exposes only the provider. The marker texts come from the
// same place the engine's own suites read them — one text per environment, or
// the skip summary splits one cause into two groups.
import {
  ATOMIC_NO_REPLACE_PLATFORM_GATE,
  ATOMIC_NO_REPLACE_RUNTIME_GATE,
} from '../../packages/engine/src/libs/files/atomicNoReplaceGate.fixture'
import { renameNoReplace } from '../../packages/engine/src/libs/files/renameNoReplace'

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
        ? ATOMIC_NO_REPLACE_PLATFORM_GATE
        : ATOMIC_NO_REPLACE_RUNTIME_GATE
  }
  if (root) {
    await rm(root, { recursive: true, force: true }).catch(() => {
      marker = ATOMIC_NO_REPLACE_RUNTIME_GATE
    })
  }

  return marker
})()

/** Can a package be published atomically here? "No" is a legitimate answer, not
 *  a failure — the in-memory leg of the contract runs regardless. */
export const atomicPublishAvailable = closedBecause === null

/** Kept as a named export so a suite can carry the reason it sat out without
 *  knowing which of the two applied. */
export const ATOMIC_PUBLISH_GATE = closedBecause ?? ATOMIC_NO_REPLACE_PLATFORM_GATE

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
