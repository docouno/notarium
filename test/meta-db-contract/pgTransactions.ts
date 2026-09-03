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
  /** Levels of `LEVELS_NO_STATEMENT_CAN_ENTER` this transaction enters with NO helper,
   *  and the reason each one has no key to hand a helper. Only a sweep belongs here: it
   *  is defined by a lifecycle column (a space, a note, a purge fence) and the keys of
   *  the level are exactly what it cannot name. The value is the reason, read by a
   *  human; the KEY is checked, both ways — a level listed here that turns out to call
   *  a helper is as red as one that does not and is not listed. */
  sweeps?: Partial<Record<LockLevel, string>>
  /** The migration transaction runs on its own `pg.Client` before the pool exists,
   *  so the live observer (which patches the pool) cannot see it. */
  pooled?: false
}

export const PG_TRANSACTIONS: readonly PgTransaction[] = [
  // Outside the hierarchy entirely: no tiered table, no tiered lock.
  { id: 'auth.createFirstUser', levels: [] },
  // Session diagnostics are serialized by their own owner/session advisory-key
  // domain. They never enter the note-identity lock hierarchy.
  { id: 'agentCalls.appendDetail', levels: [] },
  { id: 'agentCalls.bind', levels: [] },
  { id: 'agentCalls.deleteSession', levels: [] },
  { id: 'agentCalls.expireSession', levels: [] },
  { id: 'agentCalls.finalize', levels: [] },
  { id: 'agentCalls.maintain', levels: [] },
  { id: 'agentCalls.recoverInterrupted', levels: [] },
  { id: 'agentCalls.resumeCleanup', levels: [] },
  { id: 'retrievalLog.append', levels: [] },
  { id: 'sessions.startNamed', levels: [] },
  { id: 'sessions.setRole', levels: [] },
  { id: 'sessions.touch', levels: [] },
  { id: 'oauth.upsertPendingClient', levels: [] },
  { id: 'pgMetaDb.grantMemberToActiveSpace', levels: [] },
  { id: 'causalOutbox.append', levels: [] },
  { id: 'installationGeneration.acquireBackupFreeze', levels: [] },
  { id: 'installationGeneration.compareAndSet', levels: [] },
  { id: 'installationGeneration.renewBackupFreeze', levels: [] },
  { id: 'secretKeyring.admitReadable', levels: ['L5k'] },
  { id: 'secretKeyring.projectActive', levels: ['L5k'] },
  { id: 'secretKeyring.projectRotationActive', levels: ['L5k'] },
  { id: 'secretKeyring.replaceNonRetiredWith', levels: ['L5k'] },
  { id: 'credentials.create', levels: ['L5k', 'L5c'] },
  { id: 'credentials.mutate', levels: ['L5k', 'L5c', 'L5r', 'L5a'] },
  { id: 'credentials.deleteIfUnreferenced', levels: ['L5c'] },
  { id: 'providerResources.create', levels: ['L5k', 'L5c', 'L5r'] },
  { id: 'providerResources.replaceIfRuntimeEpoch', levels: ['L5k', 'L5c', 'L5r', 'L5a'] },
  // The resource delete enters L5a through the attachment FK cascade. As with the
  // import-path cascade below, the live observer sees only the explicit parent DML.
  { id: 'providerResources.delete', levels: ['L5r', 'L5a'] },
  // The conditional validate write reads the referenced credential row under the
  // same fence, so it enters L5c before L5r like every other two-facet member.
  { id: 'providerResources.recordLastCheck', levels: ['L5c', 'L5r'] },
  {
    id: 'providerAttachments.offerProviderAttachment',
    levels: ['L3s', 'L5c', 'L5r', 'L5a'],
  },
  {
    id: 'providerAttachments.acceptProviderAttachment',
    levels: ['L3s', 'L5c', 'L5r', 'L5a'],
  },
  { id: 'providerAttachments.detachProviderAttachment', levels: ['L3s', 'L5r', 'L5a'] },
  { id: 'pgMetaDb.retargetProviderCredential', levels: ['L5c', 'L5r', 'L5a'] },
  { id: 'pgMetaDb.removeMemberAndProviderAttachments', levels: ['L3s', 'L5r', 'L5a'] },
  // The journal tail. It points at nothing and nothing points at it, so its only
  // ordering duty is to stay last; the durable send-fence is an advisory on the
  // logical call, taken at the same level as the insert it protects.
  { id: 'providerCallLog.intent', levels: ['L5g'] },
  { id: 'providerCiphertexts.purgeUnreadable', levels: ['L5k', 'L5c', 'L5r'] },
  { id: 'providerCiphertexts.rewrapBatch', levels: ['L5k', 'L5c', 'L5r'] },
  { id: 'providerCiphertexts.retireKeys', levels: ['L5k'] },
  { id: 'restoreOperations.transition', levels: [] },
  { id: 'restoreTerminal.finalize', levels: [] },
  { id: 'spaceLifecycle.transition', levels: [] },

  // Tier 4 — the registry a binding points at, then the ability tables. `set` and
  // `grantProject` read the project rows under a share lock and write the binding
  // after, which is the order a whole-space purge has to take too. Above both, the
  // same tier-3 stripes the preference twin takes: they prove the ability this policy
  // is ABOUT is not purged, and they are what keeps the answer true to COMMIT. L3n is
  // absent from a run whose caller does not know the registry note — a run is a
  // SUBSEQUENCE of what is registered.
  { id: 'abilityAvailability.set', levels: ['L3s', 'L3n', 'L4f', 'L4a'] },
  { id: 'abilityAvailability.grantProject', levels: ['L3s', 'L3n', 'L4f', 'L4a'] },
  { id: 'abilityAvailability.reserve', levels: ['L3s', 'L4f', 'L4a'] },
  { id: 'abilityAvailability.finalize', levels: ['L3s', 'L3n', 'L4a'] },
  { id: 'abilityAvailability.cancel', levels: ['L4a'] },
  // Nothing to fence: removing owner state cannot outlive anything.
  { id: 'abilityAvailability.clear', levels: ['L4a'] },
  { id: 'abilityCreate.accept', levels: ['L1', 'L3s', 'L4f', 'L4a'] },
  { id: 'abilityCreate.reject', levels: ['L1', 'L4a'] },
  { id: 'abilityCreate.finalize', levels: [] },
  {
    id: 'abilityCreate.commit',
    levels: ['L1', 'L3t', 'L3s', 'L3n', 'L3b', 'L3t', 'L4a'],
    exempt: 'append-cas',
  },
  // The project parent row is L4f like any other `folders` lock. The child cursor
  // tables are outside the hierarchy, so this transaction enters one level and
  // nothing else — but it DOES enter it, which the entry it replaced (an inline
  // `FOR KEY SHARE` under `levels: []`, excused as "outside the hierarchy") denied.
  { id: 'agentDeltaCursors.advance', levels: ['L4f'] },
  // Spans tiers 3 and 4: it proves the exact Space and note are not purged before it
  // writes the override that would outlive them. One Space, one note, both known
  // before the first lock — so no wide-scan mutex, which the criterion in `lockOrder`
  // never granted it.
  { id: 'abilityPreferences.setEnabled', levels: ['L3s', 'L3n', 'L4p'] },

  // Reference writers: identity first, then their own facet.
  { id: 'favorites.add', levels: ['L1', 'L2a'] },
  { id: 'favorites.removeByEntity', levels: ['L1', 'L2a'] },
  { id: 'contextSets.addItem', levels: ['L1', 'L2c'] },
  { id: 'contextSets.addItems', levels: ['L1', 'L2c'] },
  { id: 'contextSets.removeItem', levels: ['L1', 'L2c'] },
  { id: 'contextSets.reorderItems', levels: ['L1', 'L2c'] },
  { id: 'contextSets.attach', levels: ['L2b'] },
  { id: 'contextSets.detach', levels: ['L2b'] },
  {
    id: 'contextSets.deleteSet',
    levels: ['L2b', 'L2c'],
    sweeps: {
      L2b: 'deleting a set removes every attachment of that set and has no Role package key',
    },
  },
  { id: 'scopePins.addPin', levels: ['L1', 'L2d'] },
  { id: 'scopePins.removePin', levels: ['L2d'] },
  { id: 'contextOrder.setOrder', levels: ['L1', 'L2d', 'L2e', 'L2f'] },
  // Changing where a Role belongs rewrites every durable pointer at its old
  // placement. It never touches identity: the notes it re-targets are named by rows
  // it is moving, not resolved from a client's ids.
  { id: 'abilityPlacement.moveOwnedRolePlacement', levels: ['L2b', 'L2d', 'L2e', 'L2f', 'L4p'] },

  // Invalidation from outside a run (#302): one transaction shape, two callers —
  // a cancel and a reaper candidate. Nothing below L0j: the point is to WAIT for a
  // fenced write, not to touch the hierarchy.
  { id: 'jobInvalidation.withJobFence', levels: ['L0j'] },

  // Import reservations (#302). L0j is the per-job fence: it outranks identity, and
  // every one of these holds it across what it protects.
  //
  // `closeForJob` declares L1p although no statement of its own names that table:
  // `DELETE FROM import_reservations` takes it through the ON DELETE CASCADE of
  // the import-reservation path FK. A cascade is an acquisition like any other, and the register is
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
  { id: 'activityProjection.preparePgActivityProjection', levels: ['L3s', 'L3t'] },
  {
    id: 'activityProjection.maintainPgActivityProjectionProgressBatch',
    levels: ['L3s', 'L3t'],
  },
  {
    id: 'activityProjection.maintainPgActivityProjectionFinalBatch',
    levels: ['L3s', 'L3t'],
  },
  { id: 'activityProjection.maintainPgActivityProjectionGc', levels: ['L3t'] },
  { id: 'revisions.append', levels: ['L3t', 'L3s', 'L3n', 'L3b', 'L3t'], exempt: 'append-cas' },
  { id: 'restoreOperations.accept', levels: ['L3n'] },
  {
    id: 'restoreTerminal.commit',
    levels: ['L1', 'L3t', 'L3s', 'L3n', 'L3b', 'L3t'],
    exempt: 'append-cas',
  },
  {
    // The owner state of a purged package goes last, below the revision tier where
    // its tables sit.
    id: 'revisions.purgeNotes',
    levels: ['L3m', 'L3n', 'L3t', 'L3b', 'L3t', 'L4a', 'L4p'],
    exempt: 'wide-scan',
    sweeps: {
      L4p: "every owner's override of a note gone for good, found by (space_id, registry_note_id) — the two keys a purge has, and the one it has not is the LOCATOR the level is keyed by. It is ordered against `setEnabled` by the note stripe (L3n) above, which that transaction takes before its own L4p.",
    },
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
      'L4f',
      'L4a',
      'L4p',
      'L5a',
    ],
    exempt: 'wide-scan',
    sweeps: {
      L2b: 'every attachment whose target lived in this Space, deleted by target_space without one Role package key',
      L2d: 'every pin whose SCOPE lived in this Space, deleted by `target_space`. A whole Space is not a target: the level is keyed by the (kind, id) a pin hangs on, and a purge holds the Space row and the tier-3 stripes instead — which is what a pin writer waits behind.',
      L4p: 'every override of this Space, by `space_id`, for every owner and every package at once — the same sweep `purgeNotes` makes for one note, with the same missing key.',
    },
  },

  { id: 'runPgMigrations.runPgMigrations', levels: [], pooled: false },
]

export const pooledPgTransactions = (): readonly PgTransaction[] =>
  PG_TRANSACTIONS.filter((transaction) => transaction.pooled !== false)
