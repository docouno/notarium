import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { NOTE_CLASS } from '@notarium/contract/enums'
import { directoryOf, isFolderPageNote } from '@notarium/core'
import { effectiveSlug } from '@notarium/core/slug'
import { useEditing } from '../../composers/EditingProvider'
import { FolderChildrenSummary } from '../../composers/FolderChildrenSummary'
import { type NoteError, useNotes } from '../../composers/NotesProvider'
import { useSpace } from '../../composers/SpaceProvider'
import { Splash } from '../../composers/Splash'
import { Button } from '../../core/Button'
import { useDialog } from '../../core/Dialog'
import { IconDocPage, IconSync, IconX } from '../../core/Icons'
import { Skeleton, SkeletonText } from '../../core/Skeleton'
import { StateView } from '../../core/StateView'
import { useToast } from '../../core/Toast'
import { PARTIAL_RESTORE_CONFIRMATION } from '../../libs/revisions/revisions'
import {
  feedRoute,
  feedTagRoute,
  noteRouteForClass,
  parseAppPath,
  trashRoute,
} from '../../libs/routing/routePaths'
import { api } from '../../services/api'
import { DeletedNoteView } from '../../widgets/DeletedNoteView'
import { NoteReader } from '../../widgets/NoteReader'
import styles from './NotePage.module.scss'

// `/n/<id>/<slug>` (and the surface namespace `/m`) — a note, addressed by identity (#51). NotesProvider resolves
// the id (its location effect); this page renders whatever the reader holds: a
// loading note, the open note, or — when the open failed — a styled state screen
// (#65) instead of a blank page. A failed open keeps its own /n/<id> URL, so the
// state shows here and the browser back button returns where the user came from.
export const NotePage = () => {
  const { mode, note, noteError, knownNotes, navigating, openNote, reloadNote } = useNotes()
  const { openOrCreateFromWiki } = useEditing()
  const { space, canWrite } = useSpace()
  const { confirm } = useDialog()
  const toast = useToast()
  const navigate = useNavigate()
  const location = useLocation()
  const [trashBusy, setTrashBusy] = useState(false)

  // Canonical URL (#100 phase 1, #169): once the note is in hand, replace a bare/stale/
  // wrong slug tail with the note's current slug and the correct namespace:
  // user docs → /n/<id>/<slug>, agent-memory → /m/<id>/<slug>. `replace` keeps it
  // out of history (no back-button trap); a deleted note keeps its bare URL.
  useEffect(() => {
    if (!note?.id || note.deleted) {
      return
    }
    const parsed = parseAppPath(location.pathname)

    if (parsed.kind !== 'note' && parsed.kind !== 'memoryNote') {
      return
    }
    // Only canonicalise the URL of the note we actually HAVE (#128). The effect
    // re-runs on every pathname change, but mid-navigation `note` still holds the
    // PREVIOUS note while the next one loads (NotePage keeps old content under the
    // skeleton, #68): without this guard a switch to /n/<B> recomputed the OLD
    // note A's slug and replace-navigated the URL back to /n/<A>/<slug> — so B
    // never opened. Covers every restart where URL-id ≠ loaded-id (tree/wiki
    // click, cold deep-link, an SSE reload landing on a moved-on URL), not just
    // the click. Once B lands (parsed.id === note.id) the effect appends its slug.
    if (parsed.id !== note.id) {
      return
    }
    const want = effectiveSlug(note.slug, note.title || '')
    const target = noteRouteForClass(note.id, note.class, want)

    if (target && target !== location.pathname) {
      navigate(target, { replace: true, state: location.state })
    }
  }, [note, location.pathname, location.state, navigate])

  if (mode !== 'read') {
    return <Splash />
  }

  if (noteError) {
    return (
      <NoteErrorState
        error={noteError}
        onRetry={reloadNote}
        onLeave={() => navigate(feedRoute(space))}
      />
    )
  }

  // A note-shaped skeleton (not a generic spinner, not the home Splash) while a
  // note loads — the URL already told us we're opening a note, so the shell
  // matches the destination (#65 no-flicker). `navigating` is true on a cold
  // open AND when switching to a DIFFERENT note (#68 item 3): in the latter case
  // `note` still holds the PREVIOUS note, so gating on it would leave the old
  // content on screen until the new one lands — the skeleton replaces it instead.
  // An in-place refresh (reloadNote, no `loading`) keeps the note, no flash.
  if (navigating) {
    return <NoteSkeleton />
  }
  if (!note) {
    return null
  }

  // A DELETED note (#79) opened by link: its last state, read-only, under a
  // "deleted" banner with Restore / Delete forever. The page owns the transport
  // (the widget never reaches services), the banner owns the actions.
  if (note.deleted) {
    return (
      <DeletedNoteView
        note={note}
        notes={knownNotes}
        onOpenWikiLink={openNote}
        onUnresolvedWiki={openOrCreateFromWiki}
        canManage={canWrite}
        busy={trashBusy}
        onRestore={() => {
          void (async () => {
            if (note.restoreAvailability === 'partial') {
              const ok = await confirm(PARTIAL_RESTORE_CONFIRMATION)

              if (!ok) {
                return
              }
            }
            setTrashBusy(true)
            try {
              const { revisions } = await api.revisionsGet(note.id, { limit: 1 })
              const tombstone = revisions[0]

              if (!tombstone) {
                throw new Error('Deleted note has no restore revision')
              }
              await api.trashRestore(space, note.id, tombstone.revisionId)
              await reloadNote() // now live → the normal reader takes over
            } catch (e) {
              toast.error((e as Error).message)
              setTrashBusy(false)
            }
          })()
        }}
        onPurge={() => {
          void (async () => {
            const ok = await confirm({
              title: 'Delete permanently?',
              message: `“${note.title ?? 'This note'}” will be erased for good, with its history. This can’t be undone.`,
              confirmLabel: 'Delete forever',
              danger: true,
            })

            if (!ok) {
              return
            }
            setTrashBusy(true)
            try {
              await api.trashPurge(space, { ids: [note.id] })
              navigate(trashRoute(space)) // gone for good → back to the trash
            } catch (e) {
              toast.error((e as Error).message)
              setTrashBusy(false)
            }
          })()
        }}
      />
    )
  }

  const folderSummary =
    note.space &&
    note.filePath &&
    (note.class === undefined || note.class === NOTE_CLASS.userDoc) &&
    isFolderPageNote(note.filePath) ? (
      <FolderChildrenSummary space={note.space} folderPath={directoryOf(note.filePath)} />
    ) : null

  return (
    <NoteReader
      note={note}
      notes={knownNotes}
      onOpenWikiLink={openNote}
      // A link the session cache can't resolve: ask the server, then open it
      // (real but unloaded) or offer to create it (a genuine ghost — #65
      // variant C). The current note rides along as the backlink source.
      onUnresolvedWiki={openOrCreateFromWiki}
      // A tag chip → the tag's feed (#109), SPA-navigated within this space.
      onOpenTag={(tag) => navigate(feedTagRoute(space, tag))}
      afterContent={folderSummary}
    />
  )
}

// A reader-shaped placeholder: a title block + a couple of paragraph runs inside
// the same `.doc` container the real note uses, so there's no layout shift when
// the content swaps in.
const NoteSkeleton = () => (
  <article className="doc" data-testid="note-skeleton">
    <div className={styles.skeleton} aria-hidden="true">
      <Skeleton w="55%" h={32} radius={8} />
      <div className={styles.skeletonBody}>
        <SkeletonText lines={3} />
        <SkeletonText lines={4} lastWidth="45%" />
      </div>
    </div>
  </article>
)

// The reader's failure screen — one component, three faces keyed off the
// machine-readable cause the transport already carries (#51/#54). 'notFound' is
// benign (the note's gone — offer a way out); 'unavailable' is retryable (engine
// warming up); 'generic' is a real error (show the reason, offer retry).
const NoteErrorState = ({
  error,
  onRetry,
  onLeave,
}: {
  error: NoteError
  onRetry: () => void
  onLeave: () => void
}) => {
  if (error.kind === 'notFound') {
    return (
      <StateView
        tone="muted"
        code="Not found"
        icon={<IconDocPage size={30} />}
        title="This note isn’t here"
        description="It doesn’t exist, or it was moved or deleted. The link that brought you here may be stale — your other notes are unaffected."
        testId="note-not-found"
        actions={
          <Button variant="primary" onClick={onLeave}>
            Go to feed
          </Button>
        }
      />
    )
  }
  if (error.kind === 'unavailable') {
    return (
      <StateView
        tone="muted"
        code="Offline"
        icon={<IconSync size={30} />}
        title="Reaching the knowledge engine…"
        description="It’s starting up or briefly unreachable — your note is safe and nothing was lost. This usually clears in a moment."
        testId="note-unavailable"
        actions={
          <Button variant="primary" onClick={onRetry}>
            Try again
          </Button>
        }
      />
    )
  }

  return (
    <StateView
      tone="error"
      code="Error"
      icon={<IconX size={30} />}
      title="Couldn’t open this note"
      description={error.message || 'Something went wrong loading this note.'}
      testId="note-error"
      actions={
        <Button variant="primary" onClick={onRetry}>
          Try again
        </Button>
      }
    />
  )
}
