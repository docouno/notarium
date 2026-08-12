import type { PoolClient } from 'pg'

import type { LockHold, LockLevel } from './lockOrder'

export type RevisionLockNamespace = 'blob' | 'note' | 'space'
export type RevisionLockMode = 'exclusive' | 'shared'

/** The stripe namespaces are three separate levels, taken in this order. */
const LEVEL_OF_NAMESPACE: Readonly<Record<RevisionLockNamespace, LockLevel>> = {
  space: 'L3s',
  note: 'L3n',
  blob: 'L3b',
}

// Bound whole-space/batch purge lock cardinality independently of note count.
// Space ids remain exact (one lock); high-cardinality note/blob keys share
// deterministic stripes. A collision only reduces concurrency. This mask is
// also embedded in the database lifecycle trigger; changing it needs a migration.
export const REVISION_LOCK_STRIPE_MASK = 63

/** Serialize revision CAS ownership across replicas. All callers acquire
 * space -> note -> blob and sort within one namespace; hash collisions only
 * serialize unrelated writes and cannot weaken correctness. */
export const lockRevisionKeys = async (
  client: PoolClient,
  namespace: RevisionLockNamespace,
  keys: readonly string[],
  mode: RevisionLockMode = 'exclusive',
): Promise<{ lock: LockHold }> => {
  const lockFunction = mode === 'shared' ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock'
  const uniqueKeys = [...new Set(keys)].sort()
  const level = LEVEL_OF_NAMESPACE[namespace]
  const taken = { lock: { level, scope: 'keys' as const, declared: uniqueKeys, held: uniqueKeys } }

  if (!uniqueKeys.length) {
    return taken
  }
  if (namespace === 'space') {
    for (const key of uniqueKeys) {
      await client.query(`SELECT ${lockFunction}(hashtext($1), hashtext($2))`, [
        `notarium:revision:${namespace}`,
        key,
      ])
    }

    return taken
  }

  const stripeRows = await client.query(
    `SELECT DISTINCT (hashtext(value) & $2::integer) AS stripe
       FROM unnest($1::text[]) AS input(value)
      ORDER BY stripe`,
    [uniqueKeys, REVISION_LOCK_STRIPE_MASK],
  )

  for (const { stripe } of stripeRows.rows as Array<{ stripe: number }>) {
    await client.query(`SELECT ${lockFunction}(hashtext($1), $2)`, [
      `notarium:revision:${namespace}`,
      stripe,
    ])
  }

  return taken
}
