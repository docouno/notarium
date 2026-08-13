import { Button } from '../../core/Button'
import { IconClock, IconTrash } from '../../core/Icons'
import { StickyBar } from '../../core/StickyBar'
import { authorLabel } from '../../libs/author'
import { absoluteDate } from '../../libs/datetime'
import { recoveryPresentation } from '../../libs/revisions/revisions'
import type { NoteDetailView, NoteView } from '../../libs/wire'
import { NoteReader } from '../NoteReader'
import styles from './DeletedNoteView.module.scss'

// A DELETED note opened by /n/<id> (#79): its last journaled state, read-only,
// under a banner that spans the content width (mirrors the revision-history
// banner). The banner owns the mode's actions — Restore (resurrect, same note-id)
// and Delete forever (purge) — so the topbar's Edit/kebab step back. An honest
// gap (the body never passed through us) shows a note instead of the content.
// Presentational: the host (NotePage) wires the actions to the transport, exactly
// as the history banner takes a source-port — a widget never reaches services.
type DeletedNoteViewProps = {
  note: NoteDetailView
  notes?: NoteView[]
  onOpenWikiLink?: (id: string) => void
  onUnresolvedWiki?: (target: string) => void
  /** Resurrect the note (same note-id). */
  onRestore: () => void
  /** Erase it for good (with confirmation, owned by the host). */
  onPurge: () => void
  /** An action is in flight — both buttons disable. */
  busy?: boolean
  /** May the viewer act (restore/purge = space:write)? Default true; a reader
   *  (#111) passes false — the deleted note stays readable, but the banner offers
   *  no actions instead of buttons the server would reject. */
  canManage?: boolean
}

export const DeletedNoteView = ({
  note,
  notes,
  onOpenWikiLink,
  onUnresolvedWiki,
  onRestore,
  onPurge,
  busy = false,
  canManage = true,
}: DeletedNoteViewProps) => {
  const who = authorLabel(note.deletedBy) // null deletedBy → "outside Notarium"
  // Old servers exposed only the content-presence boolean. Fail closed when the
  // authoritative predicate is absent: readable historical bytes are not proof
  // that publishing them is safe.
  const restoreAvailability = note.restoreAvailability ?? (note.restorable ? 'unknown' : 'gap')
  const canRestore = restoreAvailability === 'full' || restoreAvailability === 'partial'
  const recovery = recoveryPresentation(restoreAvailability)
  return (
    <div className={styles.view} data-testid="deleted-note-view">
      <StickyBar className={styles.banner} data-testid="deleted-banner">
        <span className={styles.info}>
          <IconTrash size={14} />
          <span>In the trash</span>
          <span className={styles.dot}>·</span>
          <IconClock size={12} />
          <span>
            deleted {note.deletedAt ? absoluteDate(note.deletedAt) : ''} by {who.text}
          </span>
        </span>
        {canManage && (
          <div className={styles.actions}>
            <Button
              variant="warning"
              onClick={onRestore}
              disabled={busy || !canRestore}
              title={
                (!canRestore ? recovery.reason : undefined) ??
                (restoreAvailability === 'partial' ? recovery.reason : undefined)
              }
              data-testid="deleted-restore"
            >
              {busy ? 'Working…' : 'Restore'}
            </Button>
            <Button variant="danger" onClick={onPurge} disabled={busy} data-testid="deleted-purge">
              Delete forever
            </Button>
          </div>
        )}
      </StickyBar>

      {!canRestore && note.restorable ? (
        <div className={styles.unavailable} data-testid="deleted-restore-unavailable">
          <strong>{recovery.label}.</strong> {recovery.reason}
        </div>
      ) : null}

      {note.source ? (
        <pre
          className={styles.source}
          tabIndex={0}
          aria-label="Deleted note source"
          data-testid="deleted-source"
        >
          {note.source.encoding === 'base64' ? `base64\n${note.source.data}` : note.source.data}
        </pre>
      ) : note.restorable ? (
        <NoteReader
          note={note}
          notes={notes}
          onOpenWikiLink={onOpenWikiLink}
          onUnresolvedWiki={onUnresolvedWiki}
        />
      ) : (
        <div className={styles.gap} data-testid="deleted-gap">
          <strong>{recovery.label}.</strong> {recovery.reason}
        </div>
      )}
    </div>
  )
}
