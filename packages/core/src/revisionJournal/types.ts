// The revision journal's persistence port and append-input shapes. The
// journal is the second tenant of the meta-DB (after the identity registry):
// an append-only history of every note state that passed through Notarium or was
// noticed by the delta sync. Full snapshots, deduplicated by content hash into
// a content-addressed blob table — never diffs. The revision domain vocabulary
// (Revision, RevisionKind, Activity*, AuthorFilter) is the port's — imported up.
// canon: docs/note-history.md#model · docs/architecture.md#p2

import type { AgentWriteAttribution, RevisionKind, RevisionPersistence } from '../knowledgeStore'
import type { BackgroundGate } from '../libs/backgroundScheduler'
import type { DocumentState, LogicalNoteState } from '../libs/markdown'

export type JournalRecordInput = {
  noteId: string
  kind: Exclude<RevisionKind, 'merge'>
  /** Server-built attribution id: 'user:<userId>' | 'pat:<userId>:<patId>'
   *  | 'oauth:<userId>:<tokenId>' (gateway) | 'ui' (AUTH_MODE=none)
   *  | null (external states have nobody to name). */
  principal: string | null
  /** Agent owner + optional session snapshot. External/human states omit it. */
  agent?: AgentWriteAttribution
  /** The body at this state, normalized the way read() serves it (the same
   *  view the version token hashes — restore round-trips through the CAS
   *  path). null = honestly unknown (an external gap). */
  content: string | null
  /** The complete canonical state. Omitted/null is reserved for honest gaps and
   * compatibility tests/legacy writers; production writes provide it whenever
   * the live note was readable. */
  logicalState?: LogicalNoteState | null
  documentState?: DocumentState | null
  title: string
  /** The note's model class for class-scoped delta queries. undefined =
   *  unknown here — the journal carries the prior revision's class forward (a
   *  note's class is immutable, so this is exact for any journaled note). */
  class?: string | null
  /** undefined = unknown (e.g. a delta body without frontmatter) — the journal
   *  carries the last known tags forward instead of fabricating a change. */
  tags?: string[]
  /** The note's CUSTOM display slug at this state: a string sets
   *  it, `null` records "no custom slug" (an explicit/collapsed clear), `undefined`
   *  = unknown here ⇒ the journal carries the prior revision's slug forward (a save
   *  that didn't address slug, a body-less external/delete). */
  slug?: string | null
  /** Restore provenance: which revision was written back. */
  sourceRevisionId?: string
  /** The pre-write state, journaled as an 'external' baseline when this is the
   *  note's first journaled revision — so even the first edit has a "before"
   *  to diff against and roll back to. */
  baseline?: {
    content: string
    logicalState?: LogicalNoteState | null
    documentState?: DocumentState | null
    title: string
    tags?: string[]
    slug?: string | null
  }
}

export type JournalOptions = {
  persistence: RevisionPersistence
  space: string
  scheduler?: BackgroundGate
  onActivityProjectionReady?: () => void
  now?: () => Date
}
