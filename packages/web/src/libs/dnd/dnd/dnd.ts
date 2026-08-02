import type { DragEvent as ReactDragEvent } from 'react'

// Shared drag-and-drop payload helpers for moving items in the folder tree.
//
// Native HTML5 DnD hides dataTransfer contents during `dragover` (you can read
// them only on `drop`), but we need the dragged item *while* hovering to decide
// whether a folder is a legal drop target (you can't drop a folder into itself
// or one of its own descendants). So we also stash the active payload in a
// module-level slot, set on dragstart and cleared on dragend.
//
// The payload is a SET, not a single item (#163 multi-select move): one drop can
// carry several notes/folders selected with ctrl/cmd/shift. A plain single drag
// is just a one-element set, so every code path is uniform — there's no separate
// "multi" kind. Per-item validity (`canDropInto`) is unchanged; `droppableInto`
// filters a set to the items that actually move (the rest are no-ops/illegal).

/** A dragged note: identity (note-id), its basename and its current folder. */
export type DragNoteItem = { kind: 'note'; id: string; fileName: string; srcFolder: string }
/** A dragged folder: identity is the directory path. */
export type DragFolderItem = { kind: 'folder'; id: string }
export type DragItem = DragNoteItem | DragFolderItem

export const DRAG_MIME = 'application/x-notarium-item'

/** The DataTransfer.types entry the browser exposes for a native OS-file drag —
 *  checked during dragover to tell an external-file import (#223) from an internal
 *  note/folder move (the two ride disjoint payloads). Case-sensitive, browser-fixed. */
export const NATIVE_FILE_DRAG_TYPE = 'Files'

/** Fallback drag payload MIME, written alongside DRAG_MIME so a drop outside the app
 *  is a clean no-op and a Firefox drag (which needs a text payload to start) works. */
export const TEXT_PLAIN_MIME = 'text/plain'

/** DOM data-attribute names carrying the tree/dropzone DnD contract ACROSS components
 *  (#223): the Sidebar publishes them in JSX, the window-level ImportDropZone reads them
 *  back via `closest`/`getAttribute`. These are plain `string`s to the DOM API — TS
 *  cannot type-check them, so a single source is the only guard that the setter and the
 *  reader agree (a silent rename would break drop-target resolution). Kept beside the
 *  MIME consts since they are the same class of DnD magic string (#56). */
export const DND_ATTRS = {
  /** The explorer's current scope-root folder (focused project's folder / space root),
   *  so a drop OUTSIDE the tree resolves to "the section you're in". */
  scopeRoot: 'data-scope-root',
  /** The open note's folder, so a content-zone (reader) drop lands next to it. */
  openFolder: 'data-open-folder',
  /** A tree ROW's drop-target folder, resolved at the section (note row → its parent). */
  dropFolder: 'data-drop-folder',
  /** Marks an element that owns its OWN native file drop (a file input), so the
   *  window-level dropzone stands off. */
  nativeFileDrop: 'data-native-file-drop',
} as const

/** Stable selection/identity key for an item ('note:<id>' / 'folder:<path>').
 *  Tagged by kind so a note-id can never collide with a folder path. */
export const dragKey = (item: DragItem): string => `${item.kind}:${item.id}`

let current: DragItem[] = []

/** Begin a drag carrying one item OR a whole set (the multi-select case). The
 *  payload is always stored as an array, so readers never branch on arity. */
export const startDrag = (e: ReactDragEvent, items: DragItem | DragItem[]): void => {
  const set = Array.isArray(items) ? items : [items]
  current = set
  e.dataTransfer.setData(DRAG_MIME, JSON.stringify(set))
  e.dataTransfer.setData(TEXT_PLAIN_MIME, set.map((i) => i.id).join('\n'))
  e.dataTransfer.effectAllowed = 'move'
}

export const endDrag = (): void => {
  current = []
}

/** The active drag set (empty if nothing is being dragged). */
export const currentDragItems = (): DragItem[] => current

// Read the payload on drop, falling back to the module slot if the browser
// withheld the data (e.g. a same-document drag without a fresh read).
export const readDrag = (e: ReactDragEvent): DragItem[] => {
  const raw = e.dataTransfer.getData(DRAG_MIME)

  if (raw) {
    try {
      const parsed = JSON.parse(raw) as DragItem[]

      if (Array.isArray(parsed)) {
        return parsed
      }
    } catch {
      /* fall through to the cached set */
    }
  }

  return current
}

// Can `item` be dropped into `destFolder` (''=root)? Rejects no-ops and the
// illegal folder-into-self / folder-into-descendant cases.
export const canDropInto = (item: DragItem | null | undefined, destFolder: string): boolean => {
  if (!item) {
    return false
  }
  const dest = destFolder || ''

  if (item.kind === 'folder') {
    if (item.id === dest) {
      return false
    } // onto itself
    const parent = item.id.includes('/') ? item.id.slice(0, item.id.lastIndexOf('/')) : ''

    if (parent === dest) {
      return false
    } // already sits here
    if (dest === item.id || dest.startsWith(item.id + '/')) {
      return false
    } // into a descendant

    return true
  }

  // note: reject when it already lives in the target folder
  return item.srcFolder !== dest
}

/** Resolve a shift-range selection (#163) over the flattened tree rows. `rows`
 *  is each row's drag payload in render order (null = a non-selectable row, e.g.
 *  a skeleton — skipped). The range spans inclusively from the anchor row to
 *  `index`, in either direction. Returns null if the anchor is no longer present
 *  (a collapsed/removed row) so the caller can degrade to a single-select — never
 *  an empty "click into nowhere". Pure, so the tricky index math is unit-tested. */
export const rangeSelect = (
  rows: readonly (DragItem | null)[],
  anchorKey: string,
  index: number,
): Map<string, DragItem> | null => {
  const aIdx = rows.findIndex((it) => it != null && dragKey(it) === anchorKey)

  if (aIdx < 0 || index < 0 || index >= rows.length) {
    return null
  }
  const [lo, hi] = aIdx <= index ? [aIdx, index] : [index, aIdx]
  const next = new Map<string, DragItem>()

  for (let i = lo; i <= hi; i++) {
    const it = rows[i]

    if (it) {
      next.set(dragKey(it), it)
    }
  }

  return next
}

/** The subset of a drag set that actually moves into `destFolder` — every item
 *  that passes `canDropInto`. The rest (already there, or a folder dropped into
 *  its own subtree) are silently skipped, so a mixed selection lands the legal
 *  members and no-ops the others (#163). */
export const droppableInto = (items: readonly DragItem[], destFolder: string): DragItem[] =>
  items.filter((i) => canDropInto(i, destFolder))

/** Would dropping this set into `destFolder` move at least one item? Drives the
 *  drop highlight — a set with no movable member (all already there / illegal)
 *  shows no highlight, exactly like a single same-folder no-op (§"don't fall
 *  through to root"). */
export const canDropAnyInto = (items: readonly DragItem[], destFolder: string): boolean =>
  items.some((i) => canDropInto(i, destFolder))
