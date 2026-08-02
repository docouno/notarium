import {
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { type DragItem, dragKey, endDrag, rangeSelect, startDrag } from '../../../../libs/dnd/dnd'
import { DROP_FOLDER_ATTR } from '../../consts'
import { rowDragItem } from '../../helpers/explorerRows'
import type { DndBag, TreeRow } from '../../types'

export const useTreeSelection = (space: string) => {
  // Drag-and-drop + multi-selection state, shared into every tree row (#163).
  // `dropTarget` is the folder under the pointer (highlighted; ROOT = the "move
  // to project root" zone). `selection` is the multi-select set (a Map keyed by
  // dragKey → the item's drag payload, captured at CLICK time so a virtualized,
  // unmounted row stays selected — we never read it back from the DOM).
  // `draggingKeys` dims the rows in the active drag. `anchorRef` is the pivot for
  // a shift-range.
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [draggingKeys, setDraggingKeys] = useState<Set<string>>(() => new Set())
  const [selection, setSelection] = useState<Map<string, DragItem>>(() => new Map())
  const selectedKeys = useMemo(() => new Set(selection.keys()), [selection])
  const anchorRef = useRef<string | null>(null)
  // The flattened rows in render order — a ref so the click-time shift-range
  // reads the CURRENT rows without making the select callback depend on them
  // (assigned just below `treeRows`).
  const treeRowsRef = useRef<TreeRow[]>([])

  const clearSelection = useCallback(() => {
    setSelection(new Map())
    anchorRef.current = null
  }, [])

  // Apply a click to the selection: shift = range from the anchor over the
  // flattened rows (notes AND folders between, inclusive); ctrl/cmd = toggle this
  // row; plain = clear the set and just re-anchor here (so a following shift-click
  // ranges from it). The anchor survives a successful range; if it's gone the
  // shift degrades to a SINGLE-select (not an empty "click into nowhere").
  const onSelect = useCallback((item: DragItem, e: ReactMouseEvent, index: number) => {
    const key = dragKey(item)

    if (e.shiftKey) {
      const range = anchorRef.current
        ? rangeSelect(treeRowsRef.current.map(rowDragItem), anchorRef.current, index)
        : null

      if (range) {
        setSelection(range)
        return
      } // anchor preserved
      setSelection(new Map([[key, item]])) // degrade: select just this row
      anchorRef.current = key
      return
    }
    if (e.metaKey || e.ctrlKey) {
      setSelection((prev) => {
        const n = new Map(prev)

        if (n.has(key)) {
          n.delete(key)
        } else {
          n.set(key, item)
        }

        return n
      })
      anchorRef.current = key
      return
    }
    // plain click — drop any multi-selection, anchor here (guard the no-op clear
    // so an ordinary single-open click doesn't churn a fresh empty Map).
    setSelection((prev) => (prev.size ? new Map() : prev))
    anchorRef.current = key
  }, [])

  // Begin a drag from a row: the whole selection if the row is part of it, else
  // just this item (an unselected row drags alone — VS Code does the same). A
  // multi-drag gets a small "N items" drag-image so the count shows under the
  // cursor (the "one jest" feel of #163).
  const ghostRef = useRef<HTMLElement | null>(null)
  const beginDrag = useCallback(
    (item: DragItem, e: ReactDragEvent) => {
      const key = dragKey(item)
      const set = selection.size && selection.has(key) ? [...selection.values()] : [item]
      startDrag(e, set)
      setDraggingKeys(new Set(set.map(dragKey)))
      if (set.length > 1) {
        // Neutral count badge under the cursor — the same grey language as the drop
        // highlight (#103 dropped accent from DnD), not a primary-tinted pill.
        const ghost = document.createElement('div')
        ghost.textContent = `${set.length} items`
        ghost.style.cssText =
          'position:fixed;top:-1000px;left:-1000px;padding:4px 10px;border-radius: var(--radius-sm);background:var(--bg-elevated,#2a2a2a);color:var(--text,#fff);border:1px solid var(--border-strong,#555);font:500 12px/1 system-ui,sans-serif;white-space:nowrap;pointer-events:none;'
        document.body.appendChild(ghost)
        e.dataTransfer.setDragImage(ghost, 12, 14)
        ghostRef.current = ghost
      }
    },
    [selection],
  )

  const contextItems = useCallback(
    (item: DragItem): DragItem[] => {
      const key = dragKey(item)

      if (selection.size && selection.has(key)) {
        return [...selection.values()]
      }
      if (selection.size) {
        clearSelection()
      }

      return [item]
    },
    [selection, clearSelection],
  )

  // Drop the count badge at drag end (deterministic — survives an unmount mid-drag
  // far better than a stray setTimeout).
  const endItemDrag = useCallback(() => {
    endDrag()
    setDraggingKeys(new Set())
    setDropTarget(null)
    if (ghostRef.current) {
      ghostRef.current.remove()
      ghostRef.current = null
    }
  }, [])

  const dnd: DndBag = {
    dropTarget,
    setDropTarget,
    draggingKeys,
    selectedKeys,
    onSelect,
    beginDrag,
    contextItems,
    endItemDrag,
    clearSelection,
  }

  // Drop the multi-selection on a space switch (#163): its keys are this space's
  // paths/ids, meaningless in the next.
  useEffect(() => {
    clearSelection()
  }, [space, clearSelection])
  // Escape clears the tree selection (VS Code), but only when something IS
  // selected and focus isn't in a text field — so it never steals the rename
  // input's own Escape-cancel. No preventDefault, so other Escape handlers run.
  useEffect(() => {
    if (selection.size === 0) {
      return
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') {
        return
      }
      const t = e.target as HTMLElement | null

      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        return
      }
      clearSelection()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selection.size, clearSelection])
  // A plain click on the empty tree area (not a row) clears the selection — the
  // click-away that deselects. Rows carry data-drop-folder, so a click resolving
  // to one is a row click (its own handler ran); only genuinely empty space
  // clears. (A modifier-click on a row also resolves to its data-drop-folder, so
  // it's preserved.)
  const sectionClick = (e: ReactMouseEvent) => {
    if (!(e.target as HTMLElement).closest(`[${DROP_FOLDER_ATTR}]`)) {
      clearSelection()
    }
  }

  return {
    dnd,
    clearSelection,
    sectionClick,
    treeRowsRef,
    dropTarget,
    setDropTarget,
    setDraggingKeys,
  }
}
