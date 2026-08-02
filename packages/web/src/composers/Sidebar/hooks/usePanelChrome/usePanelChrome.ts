import { useLayoutEffect, useRef, useState } from 'react'
import { useScrollGlass } from '../../../../libs/hooks/useScrollGlass'

export const usePanelChrome = () => {
  const railScrollRef = useRef<HTMLDivElement>(null)
  // The panel head floats over the scroll (absolute), so the tree needs a top
  // inset equal to its height to clear it. The head's height is dynamic (wordmark +
  // switcher + search), so measure it live into --panel-head-h rather than pinning a
  // magic number. Guard 0 (a display:none collapse measures 0 — keep the last good
  // value, #103) so reopening doesn't briefly drop the inset and flash the tree
  // under the head. The virtualizer's scrollMargin is measured live, so it follows
  // the padding automatically.
  const panelHeadRef = useRef<HTMLDivElement>(null)
  const [panelHeadH, setPanelHeadH] = useState(0)
  // Scroll-aware edge (#194): the rail head shares the ONE scroll-glass primitive
  // (#185) with the topbar and Trash, instead of a self-rolled scroll handler. The
  // hook drives --glass-lift (0→1) from how far the tree has scrolled under the head;
  // the head's bespoke edge-only box-shadow (Sidebar.module.scss) reads that lift —
  // the frost stays ALWAYS on in the narrow panel (#72), only the hairline + shadow
  // ride the scroll. Defaults reproduce the old ramp: span 36, edge 'top', so the lift
  // VALUE at any scrollTop equals the old min(scrollTop/36, 1) and a slow scrollbar
  // drag still tracks 1:1 (per-frame deltas stay under maxStep). What the shared hook
  // ADDS — the rate-limit #194 deliberately adopts (it comes with the primitive) — is
  // easing a discrete JUMP (wheel notch, track click, fling) over a few frames instead
  // of snapping, and re-syncing the lift when a view swap clamps scrollTop with no
  // scroll event (the old seed effect ran only once). The primitive also freezes the
  // lift while the panel is display:none-collapsed, so the edge is right on reopen.
  useScrollGlass(railScrollRef, panelHeadRef)
  useLayoutEffect(() => {
    const el = panelHeadRef.current

    if (!el) {
      return
    }
    const measure = () => {
      const h = el.offsetHeight

      if (h > 0) {
        setPanelHeadH(h)
      }
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return { railScrollRef, panelHeadRef, panelHeadH }
}
