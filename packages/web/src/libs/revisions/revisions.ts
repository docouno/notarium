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
  stateFormat: NoteRevision['stateFormat']
  restoreAvailability: NoteRevision['restoreAvailability']
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

type RevisionDetailBaseView = RevisionView & { tags: string[] }

export type RevisionDetailView =
  | (RevisionDetailBaseView & {
      contentMode: 'markdown'
      content: string
      snapshot: string | null
    })
  | (RevisionDetailBaseView & {
      contentMode: 'source'
      content: null
      snapshot: null
      source: { encoding: 'utf8' | 'base64'; data: string }
    })
  | (RevisionDetailBaseView & {
      contentMode: 'gap'
      content: null
      snapshot: null
    })

export const revisionView = (r: NoteRevision): RevisionView => ({
  revisionId: r.revisionId,
  noteId: r.noteId,
  kind: r.kind,
  principal: r.principal,
  author: r.author,
  createdAt: r.createdAt,
  contentHash: r.contentHash,
  stateFormat: r.stateFormat,
  restoreAvailability: r.restoreAvailability,
  baseRevisionId: r.baseRev,
  sourceRevisionId: r.sourceRev,
  title: r.title,
  charsAdded: r.charsAdded,
  charsRemoved: r.charsRemoved,
  unavailableReason: r.unavailableReason ?? null,
})

export const revisionDetailView = (r: NoteRevisionDetail): RevisionDetailView => {
  const base = { ...revisionView(r), tags: r.tags }

  return r.contentMode === 'source'
    ? { ...base, contentMode: r.contentMode, content: null, snapshot: null, source: r.source }
    : r.contentMode === 'markdown'
      ? { ...base, contentMode: r.contentMode, content: r.content, snapshot: r.snapshot }
      : { ...base, contentMode: r.contentMode, content: null, snapshot: null }
}

export type RecoveryPresentation = {
  kind: 'complete' | 'partial' | 'source-only' | 'record-only' | 'host-unavailable'
  label: string
  reason: string
}

export const PARTIAL_RESTORE_CONFIRMATION = {
  title: 'Restore this partial copy?',
  message:
    'The note body and known fields will be restored, but metadata that was never captured cannot be recovered.',
  confirmLabel: 'Restore partial copy',
} as const

/** User-facing recovery outcomes. The wire keeps the precise integrity enum;
 * product surfaces speak in terms of what the person can still recover. */
export const recoveryPresentation = (
  availability: NoteRevision['restoreAvailability'],
): RecoveryPresentation => {
  switch (availability) {
    case 'full':
      return {
        kind: 'complete',
        label: 'Ready to restore',
        reason: 'A complete deleted copy is available.',
      }
    case 'partial':
      return {
        kind: 'partial',
        label: 'Partial restore',
        reason:
          'This older copy contains the note body and known fields, but metadata that was never captured cannot be recovered.',
      }
    case 'opaque':
      return {
        kind: 'source-only',
        label: 'Source only',
        reason:
          'The original source can still be inspected, but Notarium cannot safely recreate it as a live note.',
      }
    case 'blocked':
      return {
        kind: 'source-only',
        label: 'Source only',
        reason:
          'The deleted copy refers to protected system identity. Its contents can be inspected, but it cannot be recreated safely.',
      }
    case 'unknown':
      return {
        kind: 'source-only',
        label: 'Source only',
        reason:
          'A deleted copy is available to inspect, but Notarium could not prove that recreating it would be safe.',
      }
    case 'gap':
      return {
        kind: 'record-only',
        label: 'No copy',
        reason:
          'Notarium recorded the deletion, but the note content was never captured. There is no copy to restore.',
      }
    case 'unreadable':
      // `record-only`, same as a gap: what a person can DO is identical — no inspection
      // and no restore — and the wire enum keeps the two causes apart for the words.
      return {
        kind: 'record-only',
        label: 'Unreadable copy',
        reason:
          'A copy was saved, but this version of Notarium can no longer read it, so it cannot be inspected or restored.',
      }
    case 'capability-unavailable':
      return {
        kind: 'host-unavailable',
        label: 'Restore unavailable',
        reason:
          'This server can show deleted copies, but it cannot publish them with crash-safe restore.',
      }
  }
}

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
   *  `reason: 'version-conflict'`. */
  restore: (revisionId: string) => Promise<void>
}
