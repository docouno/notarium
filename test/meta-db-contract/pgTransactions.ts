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
  { id: 'causalOutbox.append', levels: [] },
  { id: 'installationGeneration.acquireBackupFreeze', levels: [] },
  { id: 'installationGeneration.compareAndSet', levels: [] },
  { id: 'installationGeneration.renewBackupFreeze', levels: [] },
  { id: 'restoreOperations.transition', levels: [] },
  { id: 'restoreTerminal.finalize', levels: [] },
  { id: 'spaceLifecycle.transition', levels: [] },

  // Reference writers: identity first, then their own facet.
  { id: 'favorites.add', levels: ['L1', 'L2a'] },
  { id: 'favorites.removeByEntity', levels: ['L1', 'L2a'] },
  { id: 'contextSets.addItem', levels: ['L1', 'L2c'] },
  { id: 'contextSets.removeItem', levels: ['L2c'] },
  { id: 'contextSets.reorderItems', levels: ['L2c'] },
  { id: 'contextSets.deleteSet', levels: ['L2b', 'L2c'] },
  { id: 'scopePins.addPin', levels: ['L1', 'L2d'] },
  { id: 'contextOrder.setOrder', levels: ['L1', 'L2d', 'L2e', 'L2f'] },

  // Invalidation from outside a run (#302): one transaction shape, two callers —
  // a cancel and a reaper candidate. Nothing below L0j: the point is to WAIT for a
  // fenced write, not to touch the hierarchy.
  { id: 'jobInvalidation.withJobFence', levels: ['L0j'] },

  // Import reservations (#302). L0j is the per-job fence: it outranks identity, and
  // every one of these holds it across what it protects.
  //
  // `closeForJob` declares L1p although no statement of its own names that table:
  // `DELETE FROM import_reservations` takes it through the ON DELETE CASCADE of
  // migration 0010. A cascade is an acquisition like any other, and the register is
  // where an acquisition becomes a stated fact — the live observer levels a
  // statement by its TARGET table, so this one is invisible to it by construction.
  // The order is the only one available: the cascade fires under the parent's L1r,
  // and deleting the claims by hand first would take L1p ahead of L1r.
  { id: 'importReservations.reserve', levels: ['L0j', 'L1r', 'L1p'] },
  { id: 'importReservations.adopt', levels: ['L0j', 'L1r'] },
  { id: 'importReservations.withFencedWrite', levels: ['L0j', 'L1r', 'L1p'] },
  { id: 'importReservations.closeForJob', levels: ['L0j', 'L1r', 'L1p'] },

  // Identity itself.
  { id: 'identity.claimMany', levels: ['L1'] },
  { id: 'identity.mergeLegacyNameAlias', levels: ['L1'] },
  { id: 'ownerProofs.adopt', levels: ['L1'] },
  {
    // Takes the mutex through the quarantine closure, and re-enters L3t for the
    // target note's own rows — which the closure, by construction, never contains.
    id: 'identity.settleFileClaim',
    levels: ['L1', 'L2a', 'L2c', 'L2d', 'L2e', 'L2f', 'L3m', 'L3s', 'L3n', 'L3t'],
    exempt: 'wide-scan',
  },

  // Revisions.
  { id: 'revisions.append', levels: ['L3t', 'L3s', 'L3n', 'L3b', 'L3t'], exempt: 'append-cas' },
  { id: 'restoreOperations.accept', levels: ['L3n'] },
  {
    id: 'restoreTerminal.commit',
    levels: ['L1', 'L3t', 'L3s', 'L3n', 'L3b', 'L3t'],
    exempt: 'append-cas',
  },
  {
    id: 'revisions.purgeNotes',
    levels: ['L3m', 'L3n', 'L3t', 'L3b', 'L3t'],
    exempt: 'wide-scan',
  },
  {
    id: 'pgMetaDb.purgeSpace',
    levels: [
      'L1',
      // A purged space takes its imports' destination claims with it (#302). L1p is
      // the cascade of the header delete, exactly as in `closeForJob` above.
      'L1r',
      'L1p',
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
