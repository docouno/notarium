export type WatchControllerOptions = {
  /** The engine's external-change watcher (P5) — absent ⇒ poll-only. */
  watch?: (onChange: () => void) => (() => void) | null
  /** Run a reconcile now — the guarded poll the store fires on a coalesced signal. */
  reconcile: () => void
  /** Can a reconcile run right now? False while boot still owns the snapshot
   *  (cold/notes) or a poll is already in flight → the signal re-arms instead. */
  reconcileReady: () => boolean
  /** Has the store stopped? A stopped store neither arms nor fires. */
  stopped: () => boolean
}
