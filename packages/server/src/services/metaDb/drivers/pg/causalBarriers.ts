import type pg from 'pg'
import { type CausalBarrierKey, type CausalBarrierKind, planCausalBarriers } from '@notarium/core'

export type CausalBarrierMode = 'exclusive' | 'shared'

/** Acquire one predeclared causal plan in the project-wide total order. The
 * two-int advisory namespace keeps kinds domain-separated; PostgreSQL builds
 * the JSON tuple so trigger-only writers can derive the exact same key. */
export const lockCausalBarriers = async (
  client: pg.PoolClient,
  keys: readonly CausalBarrierKey[],
  modeFor: (kind: CausalBarrierKind) => CausalBarrierMode = () => 'exclusive',
): Promise<readonly CausalBarrierKey[]> => {
  const plan = planCausalBarriers(keys)

  for (const barrier of plan) {
    const fn =
      modeFor(barrier.kind) === 'shared' ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock'
    await client.query(
      `SELECT ${fn}(hashtext($1), hashtext(to_json(ARRAY[$2, $3]::text[])::text))`,
      [`notarium:causal:${barrier.kind}`, barrier.space, barrier.key],
    )
  }

  return plan
}
