import type {
  Dispatch,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  SetStateAction,
} from 'react'
import type { ProjectRow } from '@notarium/contract'
import type { MenuItem } from '../../core/ContextMenu'
import type { DragItem } from '../../libs/dnd/dnd'
import type { SkeletonNode } from '../../libs/tree/tree'
import type { NoteView } from '../../libs/wire'

// Which tree item is being renamed in place (the rename input replaces its row).
export type Renaming = { kind: 'note' | 'folder'; id: string }

// Drag-and-drop + multi-selection state shared down into every tree row (#163):
// which folder the pointer is over (highlighted), which items are being dragged
// (dimmed) and which are SELECTED (the multi-select set), plus the verbs a row
// fires — select on click, begin/end a (possibly multi-item) drag.
export type DndBag = {
  dropTarget: string | null
  setDropTarget: Dispatch<SetStateAction<string | null>>
  /** Keys (dragKey) of the rows currently being dragged — one for a plain drag,
   *  the whole set for a multi-drag; drives the `.dragging` dim. */
  draggingKeys: Set<string>
  /** Keys of the SELECTED rows (the multi-select set); drives `.selected`. */
  selectedKeys: Set<string>
  /** A click on a row — applies ctrl/cmd toggle, shift range, or (plain) a reset
   *  that just re-anchors and clears the set. `index` is the row's position in
   *  the flattened tree (for shift-range); -1 / unselectable rows skip ranging. */
  onSelect: (item: DragItem, e: ReactMouseEvent, index: number) => void
  /** Begin a drag from this row: the whole selection if the row is in it, else
   *  just this item. Sets the drag payload + the dim set + a count drag-image. */
  beginDrag: (item: DragItem, e: ReactDragEvent) => void
  /** The context-menu target set: selected row → whole selection, unselected row →
   *  just that row (and clears the stale selection highlight). */
  contextItems: (item: DragItem) => DragItem[]
  /** End the active drag — clears the payload, the dim set and any highlight. */
  endItemDrag: () => void
  /** Drop the multi-select set (plain click elsewhere / Escape). */
  clearSelection: () => void
}

// The shared "tree actions" bag passed down to every row: rename/menu state plus
// the CRUD verbs (wired to useNoteActions). Kept as one object so a deep row reaches
// every action without prop-drilling each one.
export type TreeApi = {
  renaming: Renaming | null
  menuTarget: string | null
  openMenu: (e: ReactMouseEvent, items: MenuItem[], targetId: string) => void
  startRename: (kind: 'note' | 'folder', id: string) => void
  commitRename: (kind: 'note' | 'folder', item: NoteView | SkeletonNode, value: string) => void
  cancelRename: () => void
  onNewInFolder: (folder: string) => void
  onNewFolder: (parent: string) => void
  onDuplicate: (note: NoteView) => void
  onDeleteNote: (note: NoteView) => void
  onDeleteFolder: (node: SkeletonNode) => void
  onDeleteItems: (items: readonly DragItem[]) => void
  copyText: (text: string, meta?: { label?: string; subject?: string }) => void
  // Projects (#13): the tree's view of the project model. `projectAt` drives
  // the folder badge AND the menu's Mark/Unmark choice; the actions and the
  // capability gate flow from ProjectsProvider through the Sidebar.
  projectAt: (path: string) => ProjectRow | undefined
  canManageProjects: boolean
  onMarkFolder: (node: SkeletonNode) => void
  onUnmarkFolder: (project: ProjectRow) => void
  isNoteFavorite: (id: string) => boolean
  isProjectFavorite: (id: string) => boolean
  folderFavorite: (path: string) => boolean
  onToggleNoteFavorite: (note: NoteView) => void
  onToggleFolderFavorite: (node: SkeletonNode) => void
  onToggleProjectFavorite: (project: ProjectRow) => void
  /** Focus the explorer on a single project (#164) — a read-only view action,
   *  available to readers too (it doesn't write). */
  onFocusProject: (path: string) => void
  /** Open a folder's PAGE surface (#212) — navigates to its page (the durable
   *  `/folder/<id>` when identified, else `/files/<path>`), which shows the page
   *  body (its `index.md`) if one exists, else a virtual page with the children
   *  summary. Merely opening it never writes `index.md`. */
  onOpenFolderPage: (node: SkeletonNode) => void
  /** The page href of a folder row (#214) — the same id-preferred rule as
   *  `onOpenFolderPage`, exposed so the row can render a real `<a>` (native
   *  middle-click / open-in-new-tab / copy-link) for its inline go-to-page action. */
  folderPageHref: (node: SkeletonNode) => string
  /** «Pin to agent context» (#165): can this note be pinned (has a target the
   *  agent scan reaches), and the pin action. The tree lacks the note's tags, so
   *  it only offers pin (idempotent) — unpin lives in the reader / Context constructor. */
  canPin: (note: NoteView) => boolean
  onPinNote: (note: NoteView) => void
  /** Export a folder subtree as a ZIP (#105 tail of #17) — a read-only action
   *  (it reads, doesn't write), so available to readers too. Enqueues an async
   *  export job scoped to the folder and surfaces progress via a toast. */
  onExportFolder: (node: SkeletonNode) => void
  /** The active space's write capability (#111 reader-gating): a reader's tree
   *  is read-only — no rename/create/delete/move, no drag. */
  canWrite: boolean
}

export type MenuState = { x: number; y: number; items: MenuItem[]; targetId: string | null }

// ── The flattened, virtualized tree (#64, sized for 10k+ notes) ─────────────
// The nested structure renders as one flat list of rows (folders, notes,
// loading shimmers), windowed by a virtualizer over the rail's scroll pane:
// only rows near the viewport are mounted, scrolled-past ones unmount. Folder
// nesting survives as `depth` (indent) + the openSet; DnD precedence survives
// as per-row targets (data-drop-folder, resolved at the section — see dropFolderAt).

export type TreeRow =
  | { kind: 'folder'; node: SkeletonNode; depth: number }
  | { kind: 'note'; note: NoteView; depth: number }
  | { kind: 'skeleton'; id: string; folder: string; depth: number; seed: number }
