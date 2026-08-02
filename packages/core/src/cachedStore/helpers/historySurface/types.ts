import type { IdentityRegistry } from '../../../identity'
import type { WriteInput, WriteResult } from '../../../knowledgeStore'
import type { RevisionJournal } from '../../../revisionJournal'

/** What the trash/history surface needs from the read-model that owns it. Narrow
 *  and purpose-specific (no read-model-internal types leak): the class adapts its
 *  own methods to this shape when it composes {@link HistorySurface}. */
export type HistoryHost = {
  journal: RevisionJournal
  identity: IdentityRegistry
  /** This store's space — trash ops verify a tombstone's space matches. */
  space: string
  /** The read-model's write chokepoint — restore/undelete ride the same CAS path. */
  write: (input: WriteInput) => Promise<WriteResult>
  /** The same write path when the caller already owns the outer mutation
   *  admission scope required by a trash lease. */
  writeAdmitted: (input: WriteInput) => Promise<WriteResult>
  /** Broadcast a snapshot change (a restore healed inbound ghosts). */
  emitChanged: (upserts: string[], removed: string[]) => void
  /** Re-pull the journal's past titles into the snapshot (within-session
   *  restore window) so a rename→delete→restore in one session heals aliases. */
  reloadHistoricalNames: () => Promise<void>
  /** Rebuild the link index and re-resolve ghosts against it; true when an edge
   *  moved (the restore made an inbound [[Old Title]] resolve). */
  reresolveGhostsFromIndex: () => boolean
  /** Enter/leave a bulk-write bracket — batch undelete coalesces like an import. */
  beginBulk: () => void
  endBulk: () => Promise<void>
}
