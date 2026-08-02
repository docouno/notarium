import type { DragEvent as ReactDragEvent } from 'react'
import { NATIVE_FILE_DRAG_TYPE } from '../../../../libs/dnd/dnd'
import { DROP_FOLDER_ATTR } from '../../consts'

/** The target folder of whatever row is under the pointer ('' = root: either a
 *  root-level row or the empty area below the rows). Deepest row wins by DOM
 *  nesting — `closest` walks up from the actual event target. */
export const dropFolderAt = (e: ReactDragEvent): string =>
  (e.target as HTMLElement).closest(`[${DROP_FOLDER_ATTR}]`)?.getAttribute(DROP_FOLDER_ATTR) ?? ''

/** An OS file drag (external-file import #223), not an internal note/folder move —
 *  the two ride disjoint DataTransfer payloads (`Files` vs the custom mime), so the
 *  section handles each without conflict. `types` is readable during `dragover`. */
export const isFileDrag = (e: ReactDragEvent): boolean =>
  Array.from(e.dataTransfer.types).includes(NATIVE_FILE_DRAG_TYPE)
