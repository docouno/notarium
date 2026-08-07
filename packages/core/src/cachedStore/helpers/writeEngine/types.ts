import type { IdentityRegistry } from '../../../identity'
import type { KnowledgeStore } from '../../../knowledgeStore'
import type { RevisionJournal } from '../../../revisionJournal'
import type { PreviewCache } from '../../caches/previewCache'
import type { DirectoryIndex } from '../directoryIndex'
import type { Snapshot } from '../snapshot'

/** What the read-model write path needs from the store that owns it. */
export type WriteHost = {
  inner: KnowledgeStore
  snap: Snapshot
  identity: IdentityRegistry
  journal: RevisionJournal
  previewCache: PreviewCache
  dirs: DirectoryIndex
  iso: () => string
  reconcileSoon: () => void
  afterNotesReady: (patch: () => void) => void
  /** Re-read source bodies and derive their edges against the current snapshot.
   *  Used after a target disappears, when a deduped old edge no longer contains
   *  enough information to distinguish human and stable-id link intents. */
  rederiveSources: (sourceIds: readonly string[]) => Promise<void>
  /** Re-resolve every graph-visible source after directory/alias context changes.
   *  The host coalesces this across a bulk bracket. */
  rederiveGraphContext: () => Promise<void>
  /** Refresh folder path history after its host-side move finalizer. */
  refreshFolderAliases: () => Promise<boolean>
  /** Hide a transient multi-step graph patch from readers until it is coherent. */
  beginGraphTransition: () => () => void
  /** Mark the inner engine's authoritative id→path projection stale after a
   *  snapshot mutation that precedes its public changed event. */
  markInnerLinkIdentitiesDirty: () => void
  /** Lazily publish the current snapshot id→path map before an exact inner read. */
  syncInnerLinkIdentities: () => void
  /** Close public identity-bearing reads before a create can reach the inner
   *  engine; the returned release is idempotent and mandatory on every path. */
  beginIdentityPublication: () => () => void
  /** Register registry/snapshot identity dirt before it becomes observable. */
  markIdentityPublicationPending: () => void
  /** Settle registered identity dirt through the owning publication/repair hook. */
  flushIdentityPublication: () => Promise<void>
  /** Preserve the pre-mutation population for a broad repair after retry. */
  rememberIdentityRepair: (before: ReadonlySet<string>) => void
  emitChanged: (upserts: string[], removed: string[]) => void
  isBulkActive: () => boolean
}
