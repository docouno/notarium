import { useRef, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router'
import { NOTE_CLASS } from '@notarium/contract/enums'
import { useChrome } from '../../composers/ChromeProvider'
import { useEditing } from '../../composers/EditingProvider'
import { useFavorites } from '../../composers/FavoritesProvider'
import { useFeed } from '../../composers/FeedProvider'
import { useHotkeys } from '../../composers/HotkeysProvider'
import { NoteInspector } from '../../composers/NoteInspector'
import { useNotes } from '../../composers/NotesProvider'
import { OmniSearch } from '../../composers/OmniSearch'
import { useProjects } from '../../composers/ProjectsProvider'
import { useSpace } from '../../composers/SpaceProvider'
import { useSync } from '../../composers/SyncProvider'
import { useNoteActions } from '../../composers/useNoteActions'
import { Aside } from '../../core/Aside'
import { AsideGroups } from '../../core/AsideGroups'
import { Button } from '../../core/Button'
import { ContextMenu } from '../../core/ContextMenu'
import {
  IconEdit,
  IconEye,
  IconKey,
  IconMore,
  IconPanelRight,
  IconPin,
  IconPlus,
  IconStar,
  IconStarFilled,
  IconTrash,
} from '../../core/Icons'
import { IconToggle } from '../../core/IconToggle'
import { useCopy, useToast } from '../../core/Toast'
import { canPinNote, isPinned, noteFolderOf } from '../../libs/agentPin'
import { cx } from '../../libs/cx/cx'
import { editorBindings } from '../../libs/hotkeys'
import { feedRoute, graphRoute, parseAppPath } from '../../libs/routing/routePaths'
import { api } from '../../services/api/api'
import { EditorBody } from '../../widgets/EditorBody'
import { EditorMeta } from '../../widgets/EditorMeta'
import { FeedAside } from '../../widgets/FeedAside'
import { HistoryTimeline, RevisionView } from '../../widgets/NoteHistory'
import { Breadcrumbs } from '../Breadcrumbs'
import { PageFrame } from '../PageFrame'
import { FEED_LAYOUT } from './consts'
import { buildTrail } from './helpers/breadcrumbs'
import { useEditorPreview } from './hooks/useEditorPreview'
import { useNoteHistory } from './hooks/useNoteHistory'
import styles from './DocumentLayout.module.scss'

// Frame for all document pages (Home / Feed / folder browse / note): document
// actions in the shared topbar, the content column and the right aside. The
// generic shell (rail toggle, gutters, the scrolling main) is PageFrame; this
// layout only supplies the document-specific slots. The edit overlay lives here
// — a draft replaces the page content under the same frame, whatever route it
// started from.

export const DocumentLayout = () => {
  const { space, canWrite, personalSpace } = useSpace()
  const { projects } = useProjects()
  const toast = useToast()
  const copy = useCopy()
  const { note, mode, folders, activeId, openNote, reloadNote, tree } = useNotes()
  const {
    isEditing,
    draft,
    editor,
    saving,
    startEdit,
    startFolderPageEdit,
    saveDraft,
    cancelEdit,
    ensureCanLeaveDraft,
    startNew,
    createFromGhost,
    guarded,
  } = useEditing()
  const {
    theme,
    asideOpen,
    toggleAside,
    setGraphFocus,
    editorMode,
    focusMode,
    setFocusMode,
    typewriter,
    toggleFocus,
    toggleTypewriter,
  } = useChrome()
  const { deleteNote } = useNoteActions()
  const { resolved } = useHotkeys()
  const feed = useFeed()
  const favorites = useFavorites()
  const { subscribe } = useSync()
  const location = useLocation()
  const navigate = useNavigate()

  const {
    historySel,
    setHistorySel,
    historyRefresh,
    setHistoryRefresh,
    historyNoteId,
    historySource,
  } = useNoteHistory({ mode, isEditing, activeId, subscribe })

  // Topbar overflow menu (the ⋮ button): viewport coords, or null when closed.
  const [actionMenu, setActionMenu] = useState<{ x: number; y: number } | null>(null)
  const kebabRef = useRef<HTMLButtonElement>(null)

  const { editorPreview, setEditorPreview, editorKey } = useEditorPreview(draft)

  // Cancel guards against a destructive misclick: with unsaved edits it confirms
  // first (and the button itself goes red); with nothing changed it just closes.
  // ensureCanLeaveDraft already no-ops (returns true, no dialog) when the draft is
  // clean, so this is the whole rule.
  const handleCancel = async () => {
    if (await ensureCanLeaveDraft()) {
      cancelEdit()
    }
  }

  const feedActive = location.pathname === feedRoute(space) && !isEditing
  const reading = mode === 'read' && !isEditing
  const parsedPath = parseAppPath(location.pathname)
  const virtualFolderPath = parsedPath.kind === 'files' ? parsedPath.path : null
  const virtualFolder =
    !isEditing && virtualFolderPath
      ? tree?.folders.find((f) => f.path === virtualFolderPath && !f.pageNoteId)
      : undefined

  // The cross-cutting search (#190) lives CENTRED in the shared topbar on every
  // document page (Home / Feed / note / files), bar-anchored so it never drifts.
  // It's a wide-screen affordance: PageFrame drops it entirely on a topbar too
  // narrow to seat it (search stays reachable via the rail icon / Cmd+P / `/`). On
  // the Feed the field reflects/drives the live `?q=` in place; elsewhere it hands
  // off to the Feed (`/s/<space>/feed?q=…`).
  const topbarSearch = (
    <OmniSearch
      value={feedActive ? feed.q : undefined}
      onSubmit={feedActive ? feed.setQ : undefined}
    />
  )

  // The panel toggle is a single button that lives in the topbar while the aside
  // is closed and moves into the aside header (replacing a close control) while
  // it's open — kept at the same right-edge position so it doesn't jump.
  // A DELETED note (#79) reads under a "deleted" banner that owns the mode's
  // actions (Restore / Delete forever) — the document actions (Edit, kebab) and
  // the inspector step back, exactly like the revision-history banner does.
  const deletedNote = !!note?.deleted
  const canPanel = (reading && note && !deletedNote) || isEditing || feedActive
  const panelToggle = (
    <IconToggle
      icon={<IconPanelRight size={15} />}
      active={asideOpen}
      onClick={toggleAside}
      title={asideOpen ? 'Collapse panel' : 'Open panel'}
    />
  )

  const trail = buildTrail({ note, virtualFolder, feedActive, tree, space })
  const crumbs = <Breadcrumbs trail={trail} />

  // «Pin to agent context» (#165): membership in always-load. Shown only where the
  // pin has a target the agent's scan reaches (the personal domain or a marked
  // project ancestor) — otherwise it would surface nowhere, so it's hidden. The
  // reader has the note's frontmatter, so it can offer pin OR unpin.
  // Favorite (#42) is personal UI state, not a write to the file — so unlike Edit
  // it's offered to READERS too (no canWrite gate). A first-class star lives in the
  // topbar action row (a one-click toggle), not in the content body: it's a note
  // action, and note actions live here alongside Edit and the ⋮ overflow.
  const isFavorite = !!note && favorites.isNoteFavorite(note.id)

  const toggleFavorite = () => {
    if (!note?.id) {
      return
    }
    void favorites.toggleNote({ id: note.id }).catch((e) => toast.error((e as Error).message))
  }
  const notePinned = isPinned(note?.frontmatter)
  const pinnable =
    canWrite &&
    canPinNote({
      noteSpace: note?.space,
      noteFolder: noteFolderOf(note?.filePath),
      personalSlug: personalSpace?.slug ?? null,
      projects,
    })

  const togglePin = async () => {
    if (!note?.id) {
      return
    }
    setActionMenu(null)
    try {
      const r = await api.notePin(note.id, !notePinned)
      await reloadNote()
      toast.success(
        r.pinned ? 'Pinned — the agent will always load this.' : 'Unpinned from agent context.',
      )
    } catch {
      toast.error('Couldn’t update agent context.')
    }
  }

  const actions = (
    <>
      {/* Document actions, plus a ⋮ overflow for secondary/destructive ones. */}
      {/* While a revision is on screen the document actions step back —
          the banner owns that mode's actions (restore / back). */}
      {/* Favorite star — a reader affordance too (personal state, not a write).
          Hidden for agent-memory notes (#42): favorites resolve within the active
          space's store, but a personal-memory note keeps chrome on the space being
          audited, so a favorite there would 404 — don't offer an always-failing star. */}
      {reading && note && !historySel && !deletedNote && note.class !== NOTE_CLASS.agentMemory && (
        <Button
          variant="ghost"
          icon
          active={isFavorite}
          title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          aria-pressed={isFavorite}
          data-testid="note-favorite"
          onClick={toggleFavorite}
        >
          {isFavorite ? <IconStarFilled size={15} /> : <IconStar size={15} />}
        </Button>
      )}
      {reading && note && !historySel && !deletedNote && canWrite && (
        <Button variant="ghost" onClick={startEdit}>
          <IconEdit size={15} /> Edit
        </Button>
      )}
      {virtualFolder && !historySel && canWrite && (
        <Button
          variant="ghost"
          onClick={() => void startFolderPageEdit(virtualFolder.path, virtualFolder.name)}
        >
          <IconEdit size={15} /> Edit
        </Button>
      )}
      {isEditing && (
        <>
          {/* Red when there are unsaved edits (a discard would lose work) — the
              click then confirms; clean drafts close silently. */}
          <Button
            variant={editor.dirty ? 'danger' : 'ghost'}
            onClick={() => void handleCancel()}
            disabled={saving}
          >
            Cancel
          </Button>
          {/* Edit ↔ Preview toggle, left of Save: shows the rendered draft without
              a save, label flips to the action it switches TO. */}
          <Button variant="ghost" onClick={() => setEditorPreview((p) => !p)} disabled={saving}>
            {editorPreview ? (
              <>
                <IconEdit size={15} /> Edit
              </>
            ) : (
              <>
                <IconEye size={15} /> Preview
              </>
            )}
          </Button>
          {/* Demoted to reader mid-edit (#111): drop Save (the write); Cancel
              stays so they can leave the editor. saveDraft also root-guards. */}
          {canWrite && (
            <Button
              variant="primary"
              onClick={() => void saveDraft(editor.buildPayload())}
              disabled={!editor.canSave || saving}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          )}
        </>
      )}
      {note && (reading || isEditing) && !historySel && !deletedNote && (
        <Button
          ref={kebabRef}
          variant="ghost"
          icon
          active={!!actionMenu}
          title="More actions"
          onClick={() =>
            setActionMenu((m) => {
              if (m) {
                return null
              } // already open → toggle closed
              const r = kebabRef.current!.getBoundingClientRect()
              return { x: r.left, y: r.bottom + 6 }
            })
          }
        >
          <IconMore size={15} />
        </Button>
      )}
      {!isEditing && mode === 'empty' && canWrite && (
        <Button variant="ghost" onClick={() => void startNew()}>
          <IconPlus size={15} /> New
        </Button>
      )}

      {/* The panel toggle lives here only while the aside is collapsed;
          when open it sits in the aside header instead. */}
      {canPanel && !asideOpen && (
        <>
          <span className={styles.actionSep} />
          {panelToggle}
        </>
      )}
    </>
  )

  // History timeline for the inspector — built here (it owns the revision API and
  // the CAS handshake) and handed to NoteInspector as a ready node; the selected
  // revision swaps the main column (below). null while there's no note → no tab.
  const historyContent =
    historyNoteId && historySource ? (
      <HistoryTimeline
        key={activeId}
        source={historySource}
        refreshToken={historyRefresh}
        selectedId={historySel?.revision.revisionId ?? null}
        onSelect={setHistorySel}
      />
    ) : null

  // The right aside. Reading → the panel inspector (Graph / Links / Backlinks /
  // Meta / History in resizable, tabbed groups, #35). Editing → the editable meta.
  // Feed → the folder facet. Only mounted when open and the page has one (canPanel).
  const asideNode =
    !asideOpen || !canPanel ? null : isEditing ? (
      <Aside title="Note details" headerAction={panelToggle}>
        <EditorMeta editor={editor} folders={folders} />
      </Aside>
    ) : feedActive ? (
      <AsideGroups
        panels={[{ id: 'filter', label: 'Filters', render: () => <FeedAside feed={feed} /> }]}
        defaultLayout={FEED_LAYOUT}
        storageKey={null}
        headerAction={panelToggle}
      />
    ) : (
      <NoteInspector
        note={note}
        activeId={activeId}
        space={space}
        theme={theme}
        onOpen={openNote}
        onOpenTag={(tag) => navigate(`${feedRoute(space)}?tag=${encodeURIComponent(tag)}`)}
        onCreateFromGhost={createFromGhost}
        onOpenInGraph={guarded((id: string) => {
          setGraphFocus(id)
          navigate(graphRoute(space))
        })}
        historyContent={historyContent}
        headerAction={panelToggle}
      />
    )

  return (
    <>
      <PageFrame
        topbarLeft={crumbs}
        topbarCenter={topbarSearch}
        topbarActions={actions}
        aside={asideNode}
        // While editing, the scroll area is a flex column so the body stretches
        // and the bottom status bar sits at the window bottom even for a short
        // note (sticky bottom:0 alone only pins once content overflows). The bottom
        // scrollbar inset (#176) rides ONLY when the status bar is actually shown —
        // Preview hides it, so drop the inset there to avoid a phantom bottom cap.
        contentClassName={
          isEditing
            ? cx(styles.editingScroll, !editorPreview && styles.editorStatusInset)
            : undefined
        }
      >
        {/* No global error banner here anymore (#65): list-load failures show in
            the sidebar (where the list lives), note-open failures as a state
            screen on NotePage, and action failures as toasts. */}
        {/* The editing surface follows the global Source/WYSIWYM setting (#116, #180);
            the Edit/Preview button in the topbar flips raw↔rendered within it. */}
        {isEditing && draft && (
          <EditorBody
            key={editorKey}
            editor={editor}
            preview={editorPreview}
            mode={editorMode === 'wysiwym' ? 'wysiwym' : 'source'}
            focus={focusMode}
            typewriter={typewriter}
            onSetFocus={setFocusMode}
            onToggleFocus={toggleFocus}
            onToggleTypewriter={toggleTypewriter}
            editorKeys={editorBindings(resolved)}
          />
        )}

        {!isEditing && historySel && historySource && (
          <RevisionView
            key={historySel.revision.revisionId}
            source={historySource}
            revision={historySel.revision}
            isLatest={historySel.isLatest}
            restorable={canWrite}
            onBack={() => setHistorySel(null)}
            onRestored={() => {
              setHistorySel(null)
              // Back to the reader (now the restored, live content) and force
              // the timeline to refetch so the new 'Restored' row shows up — the
              // server has already committed it, so this never races the append.
              setHistoryRefresh((n) => n + 1)
              void reloadNote()
            }}
          />
        )}

        {!isEditing && !historySel && <Outlet />}
      </PageFrame>

      {actionMenu && (
        <ContextMenu
          x={actionMenu.x}
          y={actionMenu.y}
          ignoreRef={kebabRef}
          items={[
            // The stable notarium-id (#232) — a reader affordance too (no write
            // gate), the reference an agent drops straight into get_note.
            ...(note
              ? [
                  {
                    label: 'Copy note id',
                    icon: <IconKey size={14} />,
                    onClick: () => copy(note.id, { label: 'note id', subject: note.title }),
                  },
                ]
              : []),
            ...(pinnable
              ? [
                  {
                    label: notePinned ? 'Unpin from agent context' : 'Pin to agent context',
                    icon: <IconPin size={14} />,
                    onClick: () => void togglePin(),
                  },
                ]
              : []),
            ...(canWrite
              ? [
                  { divider: true },
                  {
                    label: 'Delete',
                    icon: <IconTrash size={14} />,
                    danger: true,
                    onClick: () => void deleteNote(),
                  },
                ]
              : []),
          ]}
          onClose={() => setActionMenu(null)}
        />
      )}
    </>
  )
}
