import type { MouseEvent as ReactMouseEvent } from 'react'
import { Link } from 'react-router'
import {
  IconChevron,
  IconDocPage,
  IconFolder,
  IconFolderKanban,
  IconFolderOpen,
} from '../../core/Icons'
import { cx } from '../../libs/cx/cx'
import { type DragItem, dragKey } from '../../libs/dnd/dnd'
import type { SkeletonNode } from '../../libs/tree/tree'
import { folderMenuItems } from './helpers/menuItems'
import { RenameInput } from './RenameInput'
import type { DndBag, TreeApi } from './types'
import styles from './Sidebar.module.scss'

// A folder's own row. A plain click expands/collapses (no "selected folder"
// state — canon §3 preserved for the common gesture); a ctrl/cmd/shift-click adds
// it to the multi-select set instead (#163). A drag source (move the whole
// subtree, or the whole selection if it's part of one), a drop target (its row
// AND every row of its subtree declare its folder via data-drop-folder — the
// flat-row translation of "drop anywhere inside the region"), and a right-click
// target.
export const FolderRow = ({
  node,
  depth,
  index,
  isOpen,
  active,
  toggle,
  dnd,
  tree,
}: {
  node: SkeletonNode
  depth: number
  index: number
  isOpen: boolean
  active: boolean
  toggle: (path: string) => void
  dnd: DndBag
  tree: TreeApi
}) => {
  const hasChildren = node.children.length > 0 || node.direct > 0
  const { dropTarget } = dnd
  const item: DragItem = { kind: 'folder', id: node.path }
  const key = dragKey(item)
  const selected = dnd.selectedKeys.has(key)
  const dragging = dnd.draggingKeys.has(key)
  const editing = tree.renaming && tree.renaming.kind === 'folder' && tree.renaming.id === node.path

  // Plain click: expand + reset the selection (drop any multi-select; canon §3 —
  // a plain folder click never highlights the folder). Modifier click: select,
  // don't expand (matches VS Code — ctrl/cmd-click a folder selects without
  // opening it). One handler so the chevron and the name row agree (a modifier
  // click on either selects; a plain click on either toggles + clears). A reader
  // (no canWrite) can never select — a row click just toggles, no dead highlight.
  const onRowClick = (e: ReactMouseEvent) => {
    if (!tree.canWrite) {
      toggle(node.path)
      return
    }
    const modified = e.metaKey || e.ctrlKey || e.shiftKey

    if (modified) {
      e.preventDefault()
    }
    dnd.onSelect(item, e, index) // modifier → select; plain → clear + re-anchor
    if (!modified) {
      toggle(node.path)
    }
  }
  // The folder glyph (#13/#164): a marked project ALWAYS shows the briefcase
  // (folder-kanban), open or closed — the SHAPE is the only project signal now
  // (no accent tint; same colour as a plain folder). A plain folder keeps the
  // open/closed swap (folder-open ↔ folder). The chevron already conveys a
  // project's expanded state, so the project keeps its distinct icon throughout.
  const isProject = Boolean(tree.projectAt(node.path))
  const folderGlyph = isProject ? (
    <IconFolderKanban size={15} />
  ) : isOpen ? (
    <IconFolderOpen size={15} />
  ) : (
    <IconFolder size={15} />
  )
  return (
    <div
      className={cx(
        styles.navItem,
        active && styles.active,
        dropTarget === node.path && styles.dropTarget,
        selected && styles.selected,
        dragging && styles.dragging,
        tree.menuTarget === node.path && styles.contextTarget,
      )}
      style={{ paddingLeft: depth * 12 }}
      data-testid="tree-folder"
      data-path={node.path}
      data-drop-folder={node.path}
      role="treeitem"
      aria-level={depth + 1}
      // Its page is the current surface (#214): mark it like the active note row.
      aria-current={active ? 'page' : undefined}
      aria-selected={selected}
      aria-expanded={hasChildren ? isOpen : undefined}
      onContextMenu={(e) => {
        const items = dnd.contextItems(item)
        tree.openMenu(e, folderMenuItems(node, tree, items), node.path)
      }}
    >
      {hasChildren ? (
        <button className={styles.chevBtn} onClick={onRowClick} aria-label="Toggle folder">
          <span className={cx(styles.chev, isOpen && styles.open)}>
            <IconChevron size={13} />
          </span>
        </button>
      ) : (
        <span className={styles.chevSpacer} />
      )}
      {editing ? (
        <span className={styles.navItemBtn}>
          {folderGlyph}
          <RenameInput
            initial={node.name}
            onCommit={(v) => tree.commitRename('folder', node, v)}
            onCancel={tree.cancelRename}
          />
        </span>
      ) : (
        <button
          className={styles.navItemBtn}
          onClick={onRowClick}
          draggable={tree.canWrite}
          onDragStart={(e) => dnd.beginDrag(item, e)}
          onDragEnd={() => dnd.endItemDrag()}
        >
          {isProject ? (
            <span
              className={styles.projectIcon}
              title="Project"
              data-testid="project-badge"
              aria-label="Project"
            >
              {folderGlyph}
            </span>
          ) : (
            folderGlyph
          )}
          <span className={styles.navLabel}>{node.name}</span>
        </button>
      )}
      {/* Go-to-page (#214): a neat trailing action that opens the folder's page,
          while the row body stays a toggle. A real <a> (native middle-click /
          open-in-new-tab / copy-link) on the same id-preferred href; hover/focus-
          reveal keeps the tree quiet. draggable=false + stopPropagation so it never
          starts a row drag or bubbles into the toggle; the wrapper's
          data-drop-folder still resolves drops onto it to this folder. */}
      {!editing && node.path && (
        <Link
          className={styles.rowAction}
          to={tree.folderPageHref(node)}
          draggable={false}
          onClick={(e) => e.stopPropagation()}
          title="Open page"
          aria-label={`Open ${node.name} page`}
          data-testid="folder-open-page"
        >
          <IconDocPage size={15} />
        </Link>
      )}
    </div>
  )
}
