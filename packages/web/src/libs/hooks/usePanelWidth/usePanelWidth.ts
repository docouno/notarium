import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useState } from 'react'

type PanelWidthOptions = {
  storageKey: string
  min: number
  maxVw: number
  /** Optional hard pixel ceiling applied on top of maxVw. */
  maxPx?: number
  def: number
  /** Which border carries the drag handle: 'left' (right aside) or 'right' (left rail). */
  edge: 'left' | 'right'
}

// Shared width + horizontal-resize logic for the two side panels (the left rail
// and the right aside). Width persists in localStorage and is clamped to
// [min px, max]; the max is the vw-based share (maxVw · viewport), optionally
// also capped by an absolute pixel ceiling (maxPx) so an ultra-wide monitor
// doesn't let the panel grow unbounded. We re-clamp on window resize so a
// narrowing viewport pulls an over-wide panel back in.
//
//   maxVw: fraction of the viewport width the panel may take (e.g. 0.25).
//   maxPx: optional hard pixel ceiling applied on top of maxVw (effective
//          max = min(maxVw · viewport, maxPx)).
//   edge:  which border carries the drag handle — 'left' (right aside, grows
//          when dragging left) or 'right' (left rail, grows when dragging right).
export const usePanelWidth = ({
  storageKey,
  min,
  maxVw,
  maxPx = Infinity,
  def,
  edge,
}: PanelWidthOptions): [number, (e: ReactMouseEvent) => void, (w: number) => void] => {
  const clamp = useCallback(
    (w: number) => {
      const max = Math.max(min, Math.min(Math.round(window.innerWidth * maxVw), maxPx))
      return Math.min(max, Math.max(min, w))
    },
    [min, maxVw, maxPx],
  )

  const [width, setWidth] = useState(() => {
    const v = parseInt(localStorage.getItem(storageKey) || '', 10)
    return clamp(Number.isFinite(v) ? v : def)
  })

  useEffect(() => {
    localStorage.setItem(storageKey, String(width))
  }, [storageKey, width])

  // Re-clamp when the window narrows so the vw-based max still holds.
  useEffect(() => {
    const onResize = () => setWidth((w) => clamp(w))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clamp])

  // Drag the panel's edge to resize; width persists across sessions.
  const startResize = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = width
      const sign = edge === 'left' ? -1 : 1 // left edge grows when dragging left
      const onMove = (ev: MouseEvent) => setWidth(clamp(startW + sign * (ev.clientX - startX)))

      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
      }
      document.body.style.cursor = 'col-resize'
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [width, clamp, edge],
  )

  // Clamped programmatic setter — used by a corner grip that drives width on the
  // X axis while another axis (a group's height) follows clientY in the same drag.
  const setWidthClamped = useCallback((w: number) => setWidth(clamp(w)), [clamp])

  return [width, startResize, setWidthClamped]
}
