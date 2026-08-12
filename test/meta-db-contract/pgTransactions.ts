// The register of every PostgreSQL transaction in the meta-DB and the lock levels it
// takes, in order. Two tests read it: `pgTransactionRegistry.test.ts` (portable — is
// every transaction declared, and is its declaration monotone?) and
// `pgLockOrder.test.ts` (live — does it actually take what it declared?).
//
// A new transaction has to be entered here or the portable test fails by name. That
// is the point: the lock order used to be prose, and every transaction re-derived it.
// canon: packages/server/src/services/metaDb/drivers/pg/lockOrder.ts

import type { LockLevel } from '../../packages/server/src/services/metaDb/drivers/pg/lockOrder'

/** A FACT about the transaction that changes how tier 3 is judged, not a plea. Both
 *  are named in `lockOrder`. */
export type PgTransactionExemption =
  /** Takes the wide-scan mutex, so its order INSIDE tier 3 is the mutex itself: it may
   *  dip between tier-3 levels and re-enter them, because its key set is discovered
   *  from rows it already holds. Declaring it requires declaring `L3m`. */
  | 'wide-scan'
  /** `revisions.append` upserts the CAS blob before the stripes and again after. */
  | 'append-cas'

export type PgTransaction = {
  /** `<module>.<method>` — exactly what the source scan derives. */
  id: string
  /** The levels it may take, in order. A run must be a SUBSEQUENCE of this: data
   *  decides how many facets a settlement touches, the order is not data's business. */
  levels: readonly LockLevel[]
  exempt?: PgTransactionExemption
  /** The migration transaction runs on its own `pg.Client` before the pool exists,
   *  so the live observer (which patches the pool) cannot see it. */
  pooled?: false
}

export const PG_TRANSACTIONS: readonly PgTransaction[] = [
  // Outside the hierarchy entirely: no tiered table, no tiered lock.
  { id: 'auth.createFirstUser', levels: [] },
  { id: 'sessions.startNamed', levels: [] },
  { id: 'sessions.setRole', levels: [] },
  { id: 'agentDeltaCursors.advance', levels: [] },
  { id: 'oauth.upsertPendingClient', levels: [] },
  { id: 'pgMetaDb.grantMemberToActiveSpace', levels: [] },

  // Reference writers: identity first, then their own facet.
  { id: 'favorites.add', levels: ['L1', 'L2a'] },
  { id: 'favorites.removeByEntity', levels: ['L1', 'L2a'] },
  { id: 'contextSets.addItem', levels: ['L1', 'L2c'] },
  { id: 'contextSets.removeItem', levels: ['L2c'] },
  { id: 'contextSets.reorderItems', levels: ['L2c'] },
  { id: 'contextSets.deleteSet', levels: ['L2b', 'L2c'] },
  { id: 'scopePins.addPin', levels: ['L1', 'L2d'] },
  { id: 'contextOrder.setOrder', levels: ['L1', 'L2d', 'L2e', 'L2f'] },

  // Identity itself.
  { id: 'identity.claimMany', levels: ['L1'] },
  {
    // Takes the mutex through the quarantine closure, and re-enters L3t for the
    // target note's own rows — which the closure, by construction, never contains.
    id: 'identity.settleFileClaim',
    levels: ['L1', 'L2a', 'L2c', 'L2d', 'L2e', 'L2f', 'L3m', 'L3s', 'L3n', 'L3t'],
    exempt: 'wide-scan',
  },

  // Revisions.
  { id: 'revisions.append', levels: ['L3t', 'L3s', 'L3n', 'L3b', 'L3t'], exempt: 'append-cas' },
  {
    id: 'revisions.purgeNotes',
    levels: ['L3m', 'L3n', 'L3t', 'L3b', 'L3t'],
    exempt: 'wide-scan',
  },
  {
    id: 'pgMetaDb.purgeSpace',
    levels: [
      'L1',
      'L2a',
      'L2b',
      'L2c',
      'L2d',
      'L2e',
      'L2f',
      'L3m',
      'L3s',
      'L3t',
      'L3n',
      'L3b',
      'L3t',
    ],
    exempt: 'wide-scan',
  },

  { id: 'runPgMigrations.runPgMigrations', levels: [], pooled: false },
]

export const pooledPgTransactions = (): readonly PgTransaction[] =>
  PG_TRANSACTIONS.filter((transaction) => transaction.pooled !== false)
