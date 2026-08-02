import { type MouseEvent as ReactMouseEvent, useEffect, useRef, useState } from 'react'
import { ContextMenu, type MenuItem } from '../../core/ContextMenu'
import { IconCrosshair, IconEye, IconEyeOff, IconX } from '../../core/Icons'
import { singleChainOpen } from '../../libs/tree/tree'
import { FolderTree } from '../FolderTree'
import styles from './FolderFilter.module.scss'

// FolderFilter — the shared filter facet behind the Feed (#93) and the Memory
// (#13) asides: a section head (title + reset) + the FolderTree primitive + the
// per-row context menu (Show only this · Include/Exclude · Clear). One assembly so the
// two surfaces share not just the row primitive but the WHOLE filter — they
// can't drift (the bug that left Memory with a tree but no menu).
//
// INCLUSION model (#109): a selected set, empty = no filter = all. The caller owns
// the cascade vs flat semantics: nested folders pass `dirSelected` (subtree cascade)
// + a one-element solo; flat axes (Memory's user/project rows) pass plain membership
// + the same solo. The component is blind to which.
export type FolderFilterNode = {
  name: string
  path: string
  count: number
  children: FolderFilterNode[]
}

type FolderFilterProps = {
  /** Section heading (e.g. "Folders" | "Memory"). */
  title: string
  nodes: FolderFilterNode[]
  /** Is this folder/axis directly selected? (the accent mark) */
  isSelected: (path: string) => boolean
  /** Toggle one folder/axis in/out of the filter. */
  onToggle: (path: string) => void
  /** "Show only this" — select just this one. */
  onSolo: (path: string) => void
  /** Clear the whole filter. */
  onReset: () => void
  /** How many entries are selected — gates the reset (enabled / menu item shown). */
  selectedCount: number
  /** Row noun for the menu copy: "folder" → "Show only this folder"; omitted for
   *  axis-style rows → "Show only this". */
  noun?: string
  /** Colour swatch (Graph) or a neutral checkbox mark (default, the filter surfaces). */
  swatch?: boolean
  colorOf?: (path: string) => string
  maxDepth?: number
  /** data-testid for the facet root; the reset button gets `${testId}-reset`. */
  testId?: string
}

export const FolderFilter = ({
  title,
  nodes,
  isSelected,
  onToggle,
  onSolo,
  onReset,
  selectedCount,
  noun,
  swatch = false,
  colorOf,
  maxDepth,
  testId,
}: FolderFilterProps) => {
  // Reveal the single chain once the data arrives, VS Code-style (#98 item 3): drill
  // down while each level has exactly one folder, stop where it branches. A wide
  // first level therefore starts collapsed (not all-open as before). Harmless for
  // a flat axis list (Memory's user/project rows) — no children, nothing expands.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const seeded = useRef(false)
  useEffect(() => {
    if (!seeded.current && nodes.length) {
      setExpanded(new Set(singleChainOpen(nodes)))
      seeded.current = true
    }
  }, [nodes])
  const toggleExpand = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)

      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }

      return next
    })

  // Per-row actions live in a right-click menu (graph/feed parity), so the row
  // stays a clean mark + name + count.
  const [menu, setMenu] = useState<{ x: number; y: number; node: FolderFilterNode } | null>(null)

  const openMenu = (e: ReactMouseEvent, node: FolderFilterNode) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, node })
  }
  const suffix = noun ? ` ${noun}` : ''

  const menuItems = (node: FolderFilterNode): MenuItem[] => {
    const on = isSelected(node.path)
    const items: MenuItem[] = [
      {
        label: `Show only this${suffix}`,
        icon: <IconCrosshair size={15} />,
        onClick: () => onSolo(node.path),
      },
      {
        label: on ? `Exclude this${suffix}` : `Include this${suffix}`,
        icon: on ? <IconEyeOff size={15} /> : <IconEye size={15} />,
        onClick: () => onToggle(node.path),
      },
    ]

    if (selectedCount > 0) {
      items.push(
        { divider: true },
        { label: 'Clear filter', icon: <IconX size={15} />, onClick: onReset },
      )
    }

    return items
  }

  return (
    <div className={styles.facet} data-testid={testId}>
      <div className={styles.head}>
        {title}
        {/* The shared graph-aside reset primitive (styles/shared.scss): a fixed
            slot that shows only when actionable — same look + behaviour everywhere. */}
        <button
          className="gf-section-reset"
          onClick={onReset}
          disabled={selectedCount === 0}
          title="Clear filter"
          aria-label="Clear filter"
          data-testid={testId ? `${testId}-reset` : undefined}
        >
          <IconX size={13} />
        </button>
      </div>
      <div className={styles.tree}>
        {/* The filter's own loading/empty is HOST-owned (#220): the folder list is
            derived synchronously from the host's already-loaded data, so a cold-boot
            window where `nodes` is momentarily [] must NOT assert "no folders" (that
            was an empty-flash regression). GraphView hides its section when empty; the
            Feed aside shows the facet head with an empty tree — both correct, no text. */}
        <FolderTree
          swatch={swatch}
          colorOf={colorOf}
          maxDepth={maxDepth}
          nodes={nodes}
          expanded={expanded}
          onToggleExpand={toggleExpand}
          isSelected={isSelected}
          onToggle={onToggle}
          onRowContextMenu={openMenu}
        />
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.node)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
