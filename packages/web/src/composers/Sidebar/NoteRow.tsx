import { type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { Link } from 'react-router'
import { IconDoc } from '../../core/Icons'
import { Skeleton } from '../../core/Skeleton'
import { cx } from '../../libs/cx/cx'
import { type DragItem, dragKey } from '../../libs/dnd/dnd'
import { noteRoute } from '../../libs/routing/routePaths'
import type { NoteView } from '../../libs/wire'
import { ViewTypeIcon } from '../../widgets/ViewBlock'
import { noteMenuItems } from './helpers/menuItems'
import { baseName, dirOfPath } from './helpers/paths'
import { RenameInput } from './RenameInput'
import type { DndBag, TreeApi } from './types'
import styles from './Sidebar.module.scss'

// A note leaf in the tree. A real <Link>: plain click navigates in-app via the
// router (the unsaved-edits blocker covers it), middle-click falls through to
// the browser natively, and Ctrl/Cmd/Shift-click is owned by tree multi-select
// (#163). It's a drag source (move the file) and, since the flat-row model, also
// a drop surface FOR ITS PARENT folder (dropping onto a child file lands in that
// folder — same behaviour the nested regions gave). Right-click opens its
// context menu.
export const NoteRow = ({
  note,
  depth,
  index = -1,
  selectable = true,
  activeId,
  movedId,
  onOpen,
  noteHref,
  dnd,
  tree,
}: {
  note: NoteView
  depth: number
  index?: number
  selectable?: boolean
  activeId: string | null
  movedId?: string | null
  onOpen: (id: string) => void
  noteHref?: (note: NoteView) => string | null
  dnd: DndBag
  tree: TreeApi
}) => {
  const id = note.id
  const href = noteHref?.(note) ?? noteRoute(note.id)
  const parent = dirOfPath(note.filePath)
  const item: DragItem = { kind: 'note', id, fileName: baseName(note.filePath), srcFolder: parent }
  const key = dragKey(item)
  const selected = selectable && dnd.selectedKeys.has(key)
  const dragging = dnd.draggingKeys.has(key)
  const editing = tree.renaming && tree.renaming.kind === 'note' && tree.renaming.id === id
  const icon = note.viewType ? (
    <ViewTypeIcon viewType={note.viewType} size={14} />
  ) : (
    <IconDoc size={14} />
  )

  // A modifier-click drives multi-select in the tree (#163), overriding the
  // anchor's native new-tab (canon §2 change) — middle-click + the context
  // menu's "Open in new tab" keep that affordance. A plain click clears the set
  // and lets the Link navigate (the href-less fallback opens via onOpen). In
  // search results (selectable=false) the row stays a plain link — modified
  // clicks fall through to the browser unchanged. A reader (no canWrite) can't
  // move, so selecting is a dead gesture — skip it and let a modifier-click open
  // a new tab natively (the affordance a writer trades for select).
  const handleClick = (e: ReactMouseEvent) => {
    if (!selectable || !tree.canWrite) {
      return
    }
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      e.preventDefault()
      e.stopPropagation()
    }
    dnd.onSelect(item, e, index)
  }
  const rowProps = {
    className: cx(styles.navItemBtn, styles.noteRow),
    'data-testid': 'tree-note',
    'data-id': id,
    // `aria-current` is the stable, SCSS-hash-proof signal that this note is
    // the open one (the `.active` class on the wrapper is presentational).
    'aria-current': (activeId === id ? 'page' : undefined) as 'page' | undefined,
    onContextMenu: (e: ReactMouseEvent) => {
      const items = dnd.contextItems(item)
      tree.openMenu(e, noteMenuItems(note, id, tree, items, href), id)
    },
    onClick: handleClick,
    // A reader can't move notes — no drag (the menu already hides the rest).
    draggable: tree.canWrite,
    onDragStart: (e: ReactDragEvent) => dnd.beginDrag(item, e),
    onDragEnd: () => dnd.endItemDrag(),
  }
  return (
    <div
      className={cx(
        styles.navItem,
        activeId === id && styles.active,
        selected && styles.selected,
        movedId === id && styles.justMoved,
        dragging && styles.dragging,
        tree.menuTarget === id && styles.contextTarget,
      )}
      style={{ paddingLeft: depth * 12 }}
      data-drop-folder={parent}
      data-view-type={note.viewType}
      role={selectable ? 'treeitem' : undefined}
      aria-level={selectable ? depth + 1 : undefined}
      aria-selected={selectable ? selected : undefined}
    >
      <span className={styles.chevSpacer} />
      {editing ? (
        <span className={cx(styles.navItemBtn, styles.noteRow)}>
          {icon}
          <RenameInput
            initial={note.title}
            onCommit={(v) => tree.commitRename('note', note, v)}
            onCancel={tree.cancelRename}
          />
        </span>
      ) : href ? (
        <Link to={href} {...rowProps}>
          {icon}
          <span className={styles.navLabel}>{note.title}</span>
        </Link>
      ) : (
        // No filePath (shouldn't happen for real notes) — still openable. A plain
        // click opens; a modifier-click (handled above) was already prevented.
        <a
          {...rowProps}
          onClick={(e) => {
            handleClick(e)
            if (!e.defaultPrevented) {
              e.preventDefault()
              onOpen(id)
            }
          }}
        >
          {icon}
          <span className={styles.navLabel}>{note.title}</span>
        </a>
      )}
    </div>
  )
}

// Shimmer row for a folder listing that hasn't arrived yet (#64: notes load
// lazily on expand) — without it a slow window reads as "the folder is empty".
// Geometry mirrors NoteRow EXACTLY: the shimmer bar sits inside a label-sized
// line box (.note-skeleton-label = 1lh of the same font), so the real rows
// land at the same height with no per-row jump. It carries its folder's drop
// target so a drag over it behaves like the real rows will.
export const NoteRowSkeleton = ({
  folder,
  depth,
  seed,
}: {
  folder: string
  depth: number
  seed: number
}) => (
  <div className={styles.navItem} style={{ paddingLeft: depth * 12 }} data-drop-folder={folder}>
    <span className={styles.chevSpacer} />
    <span className={cx(styles.navItemBtn, styles.noteRow)} aria-hidden="true">
      <Skeleton w={14} h={14} radius={4} />
      <span
        className={cx(styles.navLabel, styles.noteSkeletonLabel)}
        style={{ width: `${52 + ((seed * 17) % 31)}%` }}
      >
        <Skeleton w="100%" h={9} radius={4} />
      </span>
    </span>
  </div>
)
