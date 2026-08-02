import { useVirtualizer } from '@tanstack/react-virtual'
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import styles from './Sidebar.module.scss'

/** The explorer's fixed row height (px). MUST equal `.tree-vrow { height }` in
 *  Sidebar.module.scss — it's both the rendered row height (pinned in CSS) and the
 *  virtualizer's estimate, so the scroll total equals the rendered rows exactly.
 *
 *  Two things make explorer lists robust at any zoom/font (#68 item 7), neither using
 *  react-virtual's per-row `measureElement`:
 *   - rows render in NORMAL FLOW inside one offset container, so adjacent rows abut
 *     by construction — no per-row `transform: translateY` that the browser rounds
 *     independently and overlaps under fractional zoom (110% etc).
 *   - the row height is PINNED in CSS to this exact value (not content-driven, which
 *     drifts ~1px/row by font/zoom and made the last row eat the bottom padding).
 *  (`measureElement` is avoided — it snapped a row into place after mounting, which
 *  during a native drag's auto-scroll yanked the row out from under the cursor;
 *  measuring at runtime also raced and read zoomed px, so we don't measure at all.) */
export const EXPLORER_ROW_HEIGHT = 29

export const ExplorerVirtualRows = <Row,>({
  rows,
  scrollRef,
  visible,
  headH,
  activeId,
  revealNonce = 0,
  getKey,
  isActive,
  renderRow,
  ariaMultiselectable,
}: {
  rows: Row[]
  scrollRef: RefObject<HTMLDivElement | null>
  /** Whether the panel is shown — the list stays MOUNTED while the panel is
   *  CSS-hidden (#103), and a display:none element measures as 0, so `margin` must
   *  recompute when it becomes visible (else a reload-while-collapsed latches 0). */
  visible: boolean
  /** The floating panel head's measured height — drives .rail-scroll's padding-top,
   *  which shifts the list box; recompute `margin` when it changes (else a head that
   *  grows after mount, e.g. a wrapped space name, leaves the rows offset). */
  headH: number
  activeId: string | null
  /** Bumped by a host to re-arm the scroll for the already-active row (#161). */
  revealNonce?: number
  getKey: (row: Row, index: number) => string
  isActive: (row: Row, activeId: string) => boolean
  renderRow: (row: Row, index: number) => ReactNode
  ariaMultiselectable?: boolean
}) => {
  const boxRef = useRef<HTMLDivElement>(null)
  // The list sits below the scroll pane's other content (scopes, section head);
  // the virtualizer needs that offset to translate scrollTop into row space.
  const [margin, setMargin] = useState(0)
  useLayoutEffect(() => {
    // A hidden panel (display:none) measures as 0 — don't clobber a good margin
    // with a zero; recompute once it's actually shown (#103).
    if (!visible) {
      return
    }
    const box = boxRef.current
    const sc = scrollRef.current

    if (!box || !sc) {
      return
    }
    setMargin(box.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop)
  }, [scrollRef, visible, headH])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => EXPLORER_ROW_HEIGHT,
    overscan: 12,
    scrollMargin: margin,
    // Reveal aligns the row to 'start', i.e. `scrollPaddingStart` px below the
    // scroll container's TOP edge. But the frosted panel head floats OVER that top
    // edge (absolute, height `headH`) — so the inset MUST clear it, else the
    // revealed row lands UNDER the glass (#161: a short viewport made the head
    // taller than the old fixed 58px, hiding the row just above the visible
    // area). Header height + one row, so the immediate parent row stays visible
    // above the active row instead of it hugging the glass edge (the #68 intent,
    // now head-aware). `headH` is measured before the active row ever appears, so
    // it's never the 0 placeholder here. The 'auto' visibility probe below honours
    // the same inset, so a row merely tucked under the glass also re-scrolls clear.
    scrollPaddingStart: headH + EXPLORER_ROW_HEIGHT,
  })
  const totalSize = virtualizer.getTotalSize()
  const activeIndex = activeId ? rows.findIndex((row) => isActive(row, activeId)) : -1

  // Latest-value refs so the passive scroll listener (subscribed once) reads the
  // current rows/geometry without re-subscribing, and so `captureAnchor` agrees
  // whether it runs from the listener or from the layout effect.
  const rowsRef = useRef(rows)
  const marginRef = useRef(margin)
  const headHRef = useRef(headH)
  const getKeyRef = useRef(getKey)
  rowsRef.current = rows
  marginRef.current = margin
  headHRef.current = headH
  getKeyRef.current = getKey

  // ── Scroll anchoring (#242). The tree reflows constantly under a stable open
  // note — a folder above expands/collapses, a lazy listing lands, a DnD reorders
  // rows. The virtualizer keeps `scrollTop` numerically fixed across such a
  // change, so any rows inserted/removed ABOVE the viewport visually shove the
  // content the user is looking at. Native `overflow-anchor` can't help: the rows
  // above the window aren't in the DOM. So we anchor by hand — remember which row
  // sits at the top of the visible list and at what sub-row offset, and after a
  // reflow re-pin that same row to the same spot. Fixed row height (#68) makes the
  // math exact with no DOM measuring.
  const anchorRef = useRef<{ key: string; offset: number } | null>(null)
  const captureAnchor = useCallback(() => {
    const sc = scrollRef.current
    const r = rowsRef.current

    if (!sc || r.length === 0) {
      anchorRef.current = null
      return
    }
    // The reference line is the top of the UNOBSCURED list (below the floating
    // glass head), i.e. the first row the user actually sees — the least likely
    // to be the one their own collapse removes.
    const refLine = sc.scrollTop + headHRef.current
    let idx = Math.floor((refLine - marginRef.current) / EXPLORER_ROW_HEIGHT)
    idx = Math.max(0, Math.min(idx, r.length - 1))
    const rowTop = marginRef.current + idx * EXPLORER_ROW_HEIGHT
    anchorRef.current = { key: getKeyRef.current(r[idx], idx), offset: refLine - rowTop }
  }, [scrollRef])

  // Track manual scrolls into the anchor: no render fires while the user drags the
  // bar, so without this the anchor would be stale by the next reflow and re-pin to
  // the wrong place. Programmatic scrolls (reveal / anchoring below) re-enter here
  // too and just re-derive the same anchor — idempotent, no loop (no state change).
  useEffect(() => {
    const sc = scrollRef.current

    if (!sc) {
      return
    }
    const onScroll = () => captureAnchor()
    sc.addEventListener('scroll', onScroll, { passive: true })
    return () => sc.removeEventListener('scroll', onScroll)
  }, [scrollRef, captureAnchor])

  // The reveal INTENT: the scroll follows the active row into view ONLY when the
  // open note changes (`activeId`) or a host explicitly re-arms (`revealNonce`,
  // #161) — NOT on every reflow. Before #242 the effect re-probed on `activeIndex`/
  // `totalSize`, so expanding a folder above the open note yanked the scroll back
  // to it (the reported bug). The token latches per intent; anchoring (above) keeps
  // the position on the reflows the reveal now ignores. A SCOPE/VIEW switch (Files →
  // a focused project / Favorites) is deliberately NOT a reveal trigger once the note's
  // reveal has already SETTLED: the token is unchanged, so anchoring holds the visible
  // content in place (adjusting `scrollTop` to keep the glass-line row pinned where that
  // row survives the narrowed view, else leaving `scrollTop` as-is) rather than jumping
  // to the active note — a view swap is not "I opened this note". (A host that wants it
  // re-revealed bumps `revealNonce`, the #161 lever.) The
  // one exception is intended first-locate: if the note was opened while OUT of scope
  // (never a row, so its reveal never settled) and the switch makes it a row, the still-
  // armed reveal completes on that switch.
  const revealTokenRef = useRef('')
  const revealSettledRef = useRef(false)

  useLayoutEffect(() => {
    const sc = scrollRef.current

    if (!sc || sc.clientHeight === 0) {
      return
    }
    const token = `${activeId ?? ''}#${revealNonce}`

    if (token !== revealTokenRef.current) {
      revealTokenRef.current = token
      revealSettledRef.current = false // a fresh intent — arm the reveal
    }

    // ── Reveal: pursue the active row until it's in view, then settle. The intent
    // stays armed (revealSettledRef false) until the row is actually present AND
    // placed — so a deep-link / sync reveal completes once the row appears after
    // its lazy listing lands (activeIndex is −1 on the first passes), WITHOUT
    // re-firing forever the way the old latch-less effect did. While the row is
    // absent we fall THROUGH to anchoring below (not an early return): the note may
    // simply not be a row in this scope at all (Favorites / a focused project /
    // Memory with a doc open), and that view still deserves its scroll held (#242).
    if (activeId && !revealSettledRef.current && activeIndex >= 0) {
      // Probe visibility against the real viewport (overscan can mount a row below
      // it, but mounted ≠ visible). The top inset mirrors scrollPaddingStart so a
      // row tucked under the frosted head reads as hidden too. Row geometry is exact
      // arithmetic — the fixed EXPLORER_ROW_HEIGHT + scrollMargin means the
      // virtualizer's own `start` is always `margin + index*height` (no measureElement,
      // #68); the same formula the anchoring re-pin uses below.
      const rowStart = margin + activeIndex * EXPLORER_ROW_HEIGHT
      const rowEnd = rowStart + EXPLORER_ROW_HEIGHT
      const visibleStart = sc.scrollTop + headH + EXPLORER_ROW_HEIGHT
      const visibleEnd = sc.scrollTop + sc.clientHeight
      const fullyVisible = rowStart >= visibleStart && rowEnd <= visibleEnd
      const maxTop = Math.max(0, sc.scrollHeight - sc.clientHeight)

      if (fullyVisible || maxTop === 0) {
        revealSettledRef.current = true
        captureAnchor()
        return
      }
      const nextTop = Math.max(0, Math.min(rowStart - headH - EXPLORER_ROW_HEIGHT, maxTop))

      const apply = () => {
        sc.scrollTop = nextTop
        captureAnchor()
      }
      apply()
      revealSettledRef.current = true // one placement per intent; anchoring holds it thereafter
      // rAF re-applies survive a late virtualizer/browser mount reset in the next
      // couple of frames (the reason the old effect re-fired on every render).
      let secondFrame = 0
      const frame = requestAnimationFrame(() => {
        apply()
        secondFrame = requestAnimationFrame(apply)
      })

      return () => {
        cancelAnimationFrame(frame)
        if (secondFrame) {
          cancelAnimationFrame(secondFrame)
        }
      }
    }

    // ── No active reveal (a settled note, or none): the rows just reflowed under a
    // stable position. Re-pin the anchor so the view doesn't jump (#242).
    const anchor = anchorRef.current

    if (anchor) {
      const newIndex = rows.findIndex((row, i) => getKeyRef.current(row, i) === anchor.key)

      if (newIndex >= 0) {
        const maxTop = Math.max(0, sc.scrollHeight - sc.clientHeight)
        const desired = Math.max(
          0,
          Math.min(margin + newIndex * EXPLORER_ROW_HEIGHT + anchor.offset - headH, maxTop),
        )

        if (Math.abs(desired - sc.scrollTop) > 0.5) {
          sc.scrollTop = desired
        }
      }
      // else: the anchored row vanished (its fold was collapsed) — degrade to leaving
      // scrollTop where it is rather than guessing.
    }
    captureAnchor()
    // `totalSize` stays in deps as the reflow signal (it changes with the row count),
    // so the effect still re-runs on every expand/collapse/lazy-load to re-anchor.
  }, [activeId, activeIndex, revealNonce, scrollRef, margin, headH, totalSize, rows, captureAnchor])

  // The windowed rows render in NORMAL FLOW inside one offset container, instead
  // of each row carrying its own `translateY`. Why (#68 item 7): per-row transforms
  // are fractional under browser zoom (a "29px" row becomes 31.9px at 110%), and
  // the browser device-pixel-snaps each one independently, so adjacent rows end
  // up ~1px apart-or-overlapping. In flow, rows abut by construction at any
  // zoom/font; only the whole block carries the single fractional offset.
  const items = virtualizer.getVirtualItems()
  const windowStart = (items[0]?.start ?? 0) - margin
  return (
    <div
      ref={boxRef}
      className={styles.treeVirtual}
      style={{ height: totalSize }}
      role="tree"
      aria-multiselectable={ariaMultiselectable}
    >
      <div className={styles.treeWindow} style={{ transform: `translateY(${windowStart}px)` }}>
        {items.map((v) => {
          const row = rows[v.index]
          return (
            <div key={getKey(row, v.index)} data-index={v.index} className={styles.treeVrow}>
              {renderRow(row, v.index)}
            </div>
          )
        })}
      </div>
    </div>
  )
}
