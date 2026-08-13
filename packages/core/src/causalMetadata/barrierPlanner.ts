import { CAUSAL_BARRIER_KIND, type CausalBarrierKey, type CausalBarrierKind } from './types'

const ORDER: readonly CausalBarrierKind[] = [
  CAUSAL_BARRIER_KIND.installationGeneration,
  CAUSAL_BARRIER_KIND.spaceLifecycle,
  CAUSAL_BARRIER_KIND.note,
  CAUSAL_BARRIER_KIND.address,
  CAUSAL_BARRIER_KIND.ownerProof,
  CAUSAL_BARRIER_KIND.operation,
  CAUSAL_BARRIER_KIND.blob,
  CAUSAL_BARRIER_KIND.outbox,
]

const rank = new Map(ORDER.map((kind, index) => [kind, index]))

export const causalBarrierKeyId = ({ kind, space, key }: CausalBarrierKey): string =>
  `${kind}\0${space ?? ''}\0${key}`

/** Validate, deduplicate and totally order the complete finite key set before a
 * transaction starts. Callers must never discover another key while holding
 * any returned barrier. */
export const planCausalBarriers = (
  input: readonly CausalBarrierKey[],
): readonly CausalBarrierKey[] => {
  const unique = new Map<string, CausalBarrierKey>()

  for (const candidate of input) {
    if (!rank.has(candidate.kind)) {
      throw new Error(`unknown causal barrier kind: ${String(candidate.kind)}`)
    }
    if (!candidate.key || candidate.key.includes('\0')) {
      throw new Error('causal barrier key must be non-empty and NUL-free')
    }
    if (candidate.space?.includes('\0')) {
      throw new Error('causal barrier space must be NUL-free')
    }
    if (
      candidate.kind !== CAUSAL_BARRIER_KIND.installationGeneration &&
      (!candidate.space || !candidate.space.trim())
    ) {
      throw new Error(`${candidate.kind} barrier requires a space`)
    }
    if (candidate.kind === CAUSAL_BARRIER_KIND.installationGeneration && candidate.space != null) {
      throw new Error('installation-generation barrier must be installation-wide')
    }
    unique.set(causalBarrierKeyId(candidate), { ...candidate })
  }

  return [...unique.values()].sort((left, right) => {
    const byKind = rank.get(left.kind)! - rank.get(right.kind)!

    if (byKind) {
      return byKind
    }
    const bySpace = (left.space ?? '').localeCompare(right.space ?? '')

    return bySpace || left.key.localeCompare(right.key)
  })
}

export const assertCausalBarrierPlan = (keys: readonly CausalBarrierKey[]): void => {
  const planned = planCausalBarriers(keys)

  if (
    planned.length !== keys.length ||
    planned.some(
      (candidate, index) => causalBarrierKeyId(candidate) !== causalBarrierKeyId(keys[index]),
    )
  ) {
    throw new Error('causal barrier keys were not acquired from one canonical plan')
  }
}
