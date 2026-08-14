import { type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import { IconChevron } from '../../core/Icons'
import { cx } from '../../libs/cx/cx'
import styles from './FolderTree.module.scss'

// FolderTree — the shared folder INCLUSION filter behind the Graph (focus a set of
// folders) and the Feed facet (#93/#109). One primitive owns the tree mechanics:
// recursion, indentation, expand/collapse and the row anatomy (chevron · mark ·
// name · count). The mark + row show SELECTION (membership in the filter), not
// visibility — nothing selected = no filter = everything shown:
//
//   • swatch (default) — the mark is the folder's group colour (Graph's colour
//                        axis), shown always as a legend; selection = the accent row.
//   • swatch={false}   — a NEUTRAL checkbox-style mark (the Feed facet): filled
//                        accent = selected, hollow = not.
//
// Per-row actions beyond the primary click (e.g. "Show only this folder") are NOT
// baked in: the caller passes `onRowContextMenu(e, node)` and owns the menu, so the
// component stays generic about *what* a folder can do.
//
// Node shape: { name, path, count, children: [] } (see buildFolderTree). Expansion
// is controlled by the caller so it can seed/persist it. `maxDepth` (optional)
// caps how deep the tree renders.
type FolderNode = {
  name: string
  path: string
  count: number
  /** Some remote facets can preserve a selected row while its count is unavailable. */
  showCount?: boolean
  children: FolderNode[]
}

type FolderTreeProps = {
  nodes: FolderNode[]
  expanded: Set<string>
  onToggleExpand: (path: string) => void
  maxDepth?: number
  onRowContextMenu?: (e: ReactMouseEvent, node: FolderNode) => void
  /** Is this folder directly in the filter? (the accent mark — a child covered by a
   *  selected ancestor is not itself "selected", mirroring the tag chips.) */
  isSelected: (path: string) => boolean
  onToggle: (path: string) => void
  colorOf?: (path: string) => string
  /** Paint the mark a colour swatch (default), or a neutral checkbox mark (`false`)
   *  for surfaces with no colour axis (#93). */
  swatch?: boolean
}

type FolderTreeCtx = Omit<FolderTreeProps, 'nodes'>

export const FolderTree = ({
  nodes,
  expanded,
  onToggleExpand,
  maxDepth,
  onRowContextMenu,
  isSelected,
  onToggle,
  colorOf,
  swatch = true,
}: FolderTreeProps) => {
  const ctx: FolderTreeCtx = {
    expanded,
    onToggleExpand,
    maxDepth,
    onRowContextMenu,
    isSelected,
    onToggle,
    colorOf,
    swatch,
  }
  return (
    <div className={styles.ftree} role="tree">
      {nodes.map((n) => (
        <FolderRow key={n.path} node={n} depth={0} ctx={ctx} />
      ))}
    </div>
  )
}

const FolderRow = ({
  node,
  depth,
  ctx,
}: {
  node: FolderNode
  depth: number
  ctx: FolderTreeCtx
}) => {
  const { expanded, onToggleExpand, maxDepth } = ctx
  const canDescend = maxDepth == null || depth + 1 < maxDepth
  const hasChildren = node.children.length > 0 && canDescend
  const open = hasChildren && expanded.has(node.path)

  const on = ctx.isSelected(node.path)

  return (
    <>
      <div
        className={cx(styles.ftreeRow, on && styles.on)}
        style={{ '--depth': depth } as CSSProperties}
        role="treeitem"
        aria-expanded={hasChildren ? open : undefined}
        onContextMenu={ctx.onRowContextMenu ? (e) => ctx.onRowContextMenu?.(e, node) : undefined}
      >
        {hasChildren ? (
          <button
            className={styles.ftreeChev}
            onClick={() => onToggleExpand(node.path)}
            title={open ? 'Collapse' : 'Expand'}
            aria-label={open ? 'Collapse' : 'Expand'}
            tabIndex={-1}
          >
            <IconChevron size={12} className={open ? styles.open : ''} />
          </button>
        ) : (
          <span className={styles.ftreeChev} aria-hidden="true" />
        )}

        <button
          className={styles.ftreeMain}
          onClick={() => ctx.onToggle(node.path)}
          title={node.path}
          aria-pressed={on}
        >
          <span className={styles.ftreeMark}>
            <span
              className={styles.ftreeSwatch}
              style={
                {
                  '--c':
                    ctx.swatch === false
                      ? 'var(--text-dim)'
                      : ctx.colorOf?.(node.path) || 'var(--text-faint)',
                } as CSSProperties
              }
            />
          </span>
          <span className={styles.ftreeName}>{node.name}</span>
          {node.showCount !== false && <span className={styles.ftreeCount}>{node.count}</span>}
        </button>
      </div>

      {open &&
        node.children.map((c) => <FolderRow key={c.path} node={c} depth={depth + 1} ctx={ctx} />)}
    </>
  )
}
