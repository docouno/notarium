import type { InteractiveSignal } from '../../../libs/backgroundScheduler'

/** What the bulk-write bracket needs from the read-model that owns it. */
export type BulkHost = {
  /** The process-global scheduler's interactive side — a streaming import
   *  marks itself busy so background embeds in OTHER spaces yield to it too. */
  scheduler?: InteractiveSignal
  /** Pause/resume the engine's own embedding backfill (this space's loop). */
  suspendBackground: () => void
  resumeBackground: () => void
  /** Make the buffered notes' ids durable BEFORE the coalesced `changed` announces
   *  them (the host's resolveNote reads the meta-DB). */
  flushIdentity: () => Promise<void>
  /** Publish the latest snapshot id→path map to a path-keyed inner engine before
   *  the same notes become observable. Synchronous by contract. */
  syncLinkIdentities: () => void
  /** Re-map a detached batch through the final superseded-id projection. */
  canonicalizeChanged: (
    upserts: readonly string[],
    removed: readonly string[],
  ) => { upserts: string[]; removed: string[] }
  /** Broadcast the merged bulk `changed` to subscribers. */
  dispatchChanged: (upserts: string[], removed: string[], folders: string[]) => void
  /** Current folders of the given note-ids (recomputed fresh at flush time). */
  foldersOf: (ids: string[]) => string[]
  /** One catch-up delta poll once the burst is over (advances the cursor). */
  poll: () => void
  /** Kick the single graph re-enrichment suppressed during the burst. */
  refreshGraph: () => void
  /** Publish one coalesced resolver-context rebuild before the FINAL bulk
   *  batch exposes its state. Progressive timer batches only hand off the debt. */
  flushGraphContext: () => Promise<void>
  /** Release a deferred graph barrier when the store is torn down mid-bulk. */
  abandonGraphContext: () => void
}
