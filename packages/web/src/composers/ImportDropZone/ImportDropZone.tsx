import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { DND_ATTRS, NATIVE_FILE_DRAG_TYPE } from '../../libs/dnd/dnd'
import { useSpace } from '../SpaceProvider'
import { captureDrop } from './dropEntries'
import { useDropImport } from './useFileImport'
import styles from './ImportDropZone.module.scss'

// Drag files or a folder into the window → import them as one outcome. Split by zone
// (see docs/drag-and-drop.md §10):
//   • the TREE (rail) — the Sidebar section owns it: it lights the exact target
//     folder ROW like an internal move (no extra label needed) and imports the drop.
//   • the CONTENT (reader) — owned HERE: the whole reader lights (a neutral dashed
//     wash) with a CENTERED card naming the target ("Drop to import into <folder>"),
//     so it's clear the file lands in the workspace root or the open note's folder.
// We deliberately DON'T draw a cursor-following label — it fought the OS's own drag
// badge (the "copy" cursor, which the page can't suppress). The centered card sits
// away from the cursor, so the two never overlap.
//
// Both zones synchronously snapshot the native Files payload before traversing it.
// The internal move keeps its separate application payload, so the paths do not collide.

const HIDE_MS = 250

const hasFiles = (dt: DataTransfer | null): boolean =>
  !!dt && Array.from(dt.types).includes(NATIVE_FILE_DRAG_TYPE)

const isNativeDropTarget = (t: EventTarget | null): boolean =>
  t instanceof Element && !!t.closest(`input[type="file"], [${DND_ATTRS.nativeFileDrop}]`)

/** Over the tree section? Then the Sidebar owns the highlight + the drop. */
const overTree = (el: Element | null): boolean => !!el?.closest(`[${DND_ATTRS.scopeRoot}]`)

const scopeRootOf = (): string =>
  document.querySelector(`[${DND_ATTRS.scopeRoot}]`)?.getAttribute(DND_ATTRS.scopeRoot) ?? ''

/** The CONTENT-zone target: with a note open, its folder (`data-open-folder`, the
 *  Sidebar publishes it) — drop it next to what you're reading — else the scope root. */
const contentTargetAt = (x: number, y: number): string => {
  const el = document.elementFromPoint(x, y)

  if (el?.closest('main')) {
    const open = document.querySelector(`[${DND_ATTRS.openFolder}]`)

    if (open) {
      return open.getAttribute(DND_ATTRS.openFolder) ?? ''
    }
  }

  return scopeRootOf()
}

const mainRect = (): DOMRect | null =>
  document.querySelector('main')?.getBoundingClientRect() ?? null

const folderLabel = (folder: string): string => folder || 'the workspace root'

type Drag = { folder: string; area: DOMRect }

export const ImportDropZone = () => {
  const { canWrite } = useSpace()
  const importDrop = useDropImport()
  // The active CONTENT-zone drag: the target folder + the reader rect to wash. null
  // when there's no content-zone drag (incl. while over the tree — the Sidebar shows
  // the folder-row highlight there).
  const [drag, setDrag] = useState<Drag | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const clearHide = () => {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current)
      }
      hideTimer.current = null
    }

    // Heartbeat: a continuous `dragover` keeps the wash alive; when the drag leaves the
    // window it stops and this fires. (No cursor tracking — the card is centred.)
    const scheduleHide = () => {
      clearHide()
      hideTimer.current = setTimeout(() => setDrag(null), HIDE_MS)
    }

    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer) || isNativeDropTarget(e.target)) {
        return
      }
      if (!overTree(document.elementFromPoint(e.clientX, e.clientY))) {
        e.preventDefault()
      }
    }

    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer) || isNativeDropTarget(e.target)) {
        return
      }
      const el = document.elementFromPoint(e.clientX, e.clientY)

      if (overTree(el)) {
        clearHide()
        setDrag(null) // the Sidebar lights the target folder row; nothing to draw here
        return
      }
      e.preventDefault()
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = canWrite ? 'copy' : 'none'
      }
      if (!canWrite) {
        setDrag(null)
        return
      }
      const area = mainRect()

      if (area) {
        setDrag({ folder: contentTargetAt(e.clientX, e.clientY), area })
        scheduleHide()
      }
    }

    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer) || isNativeDropTarget(e.target)) {
        return
      }
      const el = document.elementFromPoint(e.clientX, e.clientY)
      clearHide()
      setDrag(null)
      if (overTree(el)) {
        return
      } // the Sidebar section imports tree drops
      e.preventDefault()
      const dataTransfer = e.dataTransfer

      if (dataTransfer) {
        const capture = captureDrop(dataTransfer)

        void importDrop(capture, contentTargetAt(e.clientX, e.clientY))
      }
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
      clearHide()
    }
  }, [canWrite, importDrop])

  if (!drag || !canWrite) {
    return null
  }
  const PAD = 6
  const { area } = drag
  return createPortal(
    <div
      className={styles.zone}
      style={{
        left: area.left + PAD,
        top: area.top + PAD,
        width: area.width - 2 * PAD,
        height: area.height - 2 * PAD,
      }}
      data-testid="import-dropzone"
      aria-hidden
    >
      <div className={styles.card}>
        <span className={styles.icon} aria-hidden>
          ↓
        </span>
        <span className={styles.title}>Drop to import</span>
        <span className={styles.sub}>
          into <strong>{folderLabel(drag.folder)}</strong>
        </span>
      </div>
    </div>,
    document.body,
  )
}
