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
  emitChanged: (upserts: string[], removed: string[]) => void
  isBulkActive: () => boolean
}
