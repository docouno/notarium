// Note-history view shapes (#12) and their wire mappers — thin shape guards
// since contract v2 (#54; the server's twin lives in
// packages/server/src/services/api/wire.ts). In libs so both the api service
// and the presentational NoteHistory widget can speak these shapes without
// crossing the layer rules (widgets never import services).

import type {
  Author,
  NoteRevision,
  NoteRevisionDetail,
  RevisionKind,
  RevisionUnavailableReason,
} from '@notarium/contract'

export type RevisionView = {
  revisionId: string
  noteId: string
  kind: RevisionKind
  principal: string | null
  /** The resolved, privacy-filtered writer (#13) — the display twin of
   *  `principal`. null for an external state with no writer. */
  author: Author | null
  createdAt: string
  /** null = an honest gap: the journal saw the change but has no body. */
  contentHash: string | null
  baseRevisionId: string | null
  sourceRevisionId: string | null
  title: string
  /** Human label for the version. Auto-numbered (v1..vN) in the UI today; the
   *  slot is here so user-given names land without a UI change once a rename
   *  feature persists them (then the wire mapper fills it instead of null). */
  name?: string | null
  /** "+N −M" counters vs the chain parent; null = unknown (gap/legacy row). */
  charsAdded: number | null
  charsRemoved: number | null
  /** Set when the server WITHHELD this row rather than failed to capture it
   *  (#327). Without it a gap is indistinguishable from a real unsigned
   *  external edit, and the UI words it as one. */
  unavailableReason: RevisionUnavailableReason | null
}

export type RevisionDetailView = RevisionView & {
  content: string | null
  tags: string[]
}

export const revisionView = (r: NoteRevision): RevisionView => ({
  revisionId: r.revisionId,
  noteId: r.noteId,
  kind: r.kind,
  principal: r.principal,
  author: r.author,
  createdAt: r.createdAt,
  contentHash: r.contentHash,
  baseRevisionId: r.baseRev,
  sourceRevisionId: r.sourceRev,
  title: r.title,
  charsAdded: r.charsAdded,
  charsRemoved: r.charsRemoved,
  unavailableReason: r.unavailableReason ?? null,
})

export const revisionDetailView = (r: NoteRevisionDetail): RevisionDetailView => ({
  ...revisionView(r),
  content: r.content,
  tags: r.tags,
})

/** The widget's data port: the host wires it to the transport (the api
 *  service today, anything else tomorrow — the widget is host-agnostic). */
export type NoteHistorySource = {
  list: (opts: {
    offset: number
    limit: number
  }) => Promise<{ revisions: RevisionView[]; total: number }>
  detail: (revisionId: string) => Promise<RevisionDetailView>
  /** Roll the note back to this revision. The host owns the CAS handshake
   *  (fresh token + the restore call); a conflict rejects with
   *  `reason: 'version_conflict'`. */
  restore: (revisionId: string) => Promise<void>
}
