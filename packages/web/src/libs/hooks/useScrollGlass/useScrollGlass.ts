import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react'

// Scroll-aware glass chrome (#185). A floating glass bar should rest near-flat when
// nothing has scrolled past it — glass is only meaningful once content slides under
// it — and gain its frost, lit edge and grain IN PROPORTION to how far content has
// scrolled beneath it. This writes that fraction (0→1) into a CSS var `--glass-lift`
// on the bar; the matching material lives in the global `.glass-scroll` utility
// (styles/glass.scss). Generalised from the rail head's original edge-only lift (#72)
// — from "edge only" to the whole material, plus a bottom edge and a jerk-smoother —
// and then the rail head was folded back onto it (#194): it drives this same
// --glass-lift and keeps only its bespoke edge-only box-shadow (frost always on).
//
// `edge`:
//   'top'    — a top bar: lift tracks scrollTop (flat at the top of the list).
//   'bottom' — a bottom bar: lift tracks the distance still BELOW the bar (flat once
//              the list is scrolled to its end, full while content remains under it).
//
// Smoothing: a raw scroll position drives the lift frame-for-frame, which reads great
// on a smooth scroll but SNAPS on a discrete jump (a wheel notch, a scrollbar-track
// click, a fling) — scrollTop leaps in one frame, so the lift would too. We rate-limit
// the lift's change per animation frame (`maxStep`): a smooth scroll moves less than
// that per frame and stays 1:1 (no lag — the property the proportional model is for),
// while a big jump is spread over a few frames so the glass eases in instead of
// slamming on. NOT a fixed-duration transition (that decouples from the scrollbar drag
// speed — the reason CSS transitions were rejected here): the ceiling is per-frame, so
// the pace still follows the scroll, just without the discontinuity.
// The scroll fraction (0→1) a bar's glass should show — the PURE core of the primitive
// (the ramp above), split out from the DOM/rAF hook so the algorithm #194 unified is
// unit-testable in the node layer (the hook itself stays verified live). Returns
// `current` UNCHANGED when it can't measure: a display:none / detached scroll pane
// reports every metric as 0, and a bar over it must KEEP its resting edge — not reset to
// flat and then fade back in when it reappears (the sidebar-collapse round-trip, #194; a
// laid-out, visible scroll pane always has a non-zero clientHeight). A missing element
// (pre-attach) seeds flat (0).
export const liftFromMetrics = (
  sc: { scrollTop: number; scrollHeight: number; clientHeight: number } | null,
  cfg: { span: number; edge: 'top' | 'bottom' },
  current: number,
): number => {
  if (!sc) {
    return 0
  }
  if (sc.clientHeight === 0 && sc.scrollHeight === 0) {
    return current
  }
  const dist = cfg.edge === 'top' ? sc.scrollTop : sc.scrollHeight - sc.clientHeight - sc.scrollTop
  return Math.min(Math.max(dist, 0) / cfg.span, 1)
}

export const useScrollGlass = (
  scrollRef: RefObject<HTMLElement | null>,
  barRef: RefObject<HTMLElement | null>,
  opts: {
    span?: number
    edge?: 'top' | 'bottom'
    maxStep?: number
    /** Re-snap the material before paint when a persistent bar changes visibility or
     *  content regime without replacing its DOM element. */
    snapKey?: string | number | boolean
  } = {},
): void => {
  // Latest config in a ref so the long-lived listener/rAF closures read fresh values
  // without re-attaching. span = scrolled px that reach full glass; maxStep = max lift
  // change per frame (the jerk ceiling).
  const cfg = useRef({ span: 36, edge: 'top' as 'top' | 'bottom', maxStep: 0.08 })
  cfg.current = { span: opts.span ?? 36, edge: opts.edge ?? 'top', maxStep: opts.maxStep ?? 0.08 }

  const target = useRef(0) // where the lift WANTS to be (raw scroll-derived)
  const current = useRef(0) // where it IS this frame (rate-limited toward target)
  const raf = useRef(0)
  const painted = useRef<HTMLElement | null>(null) // the bar element the lift was last written to
  const snappedKey = useRef(opts.snapKey)

  // Read the live metrics off the scroll element and hand them to the pure lift math.
  const measure = (): number => liftFromMetrics(scrollRef.current, cfg.current, current.current)

  const tick = (): void => {
    const t = target.current
    const delta = t - current.current
    const { maxStep } = cfg.current
    // 1:1 when the move is small (smooth scroll); capped when it's a jump.
    current.current += Math.abs(delta) <= maxStep ? delta : Math.sign(delta) * maxStep
    barRef.current?.style.setProperty('--glass-lift', String(current.current))
    raf.current = current.current === t ? 0 : requestAnimationFrame(tick)
  }

  const kick = (): void => {
    target.current = measure()
    if (!raf.current && current.current !== target.current) {
      raf.current = requestAnimationFrame(tick)
    }
  }

  // Self-attach a passive scroll listener so several bars can ride ONE scroll element
  // (the Trash top chrome AND its footer) without threading an onScroll prop.
  useEffect(() => {
    const sc = scrollRef.current

    if (!sc) {
      return undefined
    }
    sc.addEventListener('scroll', kick, { passive: true })
    return () => {
      sc.removeEventListener('scroll', kick)
      if (raf.current) {
        cancelAnimationFrame(raf.current)
      }
      raf.current = 0
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRef])

  // Re-sync after every commit: content can grow/shrink with NO scroll event (a route
  // swap, the Trash page appending rows, the browser clamping scrollTop), which moves
  // the target — especially for the bottom edge (it depends on live scrollHeight). The
  // rAF easing then carries the lift from wherever it is to the new target. The work is
  // a single layout read (cheap; no write here — the write is deferred to the rAF tick).
  // DELIBERATELY no dependency array: adding one (e.g. [scrollRef]) would stop the
  // re-sync on those no-scroll content changes and strand a bottom-edge bar.
  //
  // ON (RE)MOUNT of the bar — or a caller-declared `snapKey` regime change — SNAP
  // instead of easing. A bar can appear OVER content already scrolled under it, so it
  // must show its resting material on the FIRST visible paint, not fade in.
  // Two reasons the plain re-sync leaves it flat: (1) an appearance is not a scroll
  // jump, so the maxStep easing (for wheel notches / scrollbar flings) doesn't belong;
  // (2) while an element is absent or invisible, an eased intermediate value is not a
  // meaningful visible state. So: when the element first appears/swaps, or `snapKey`
  // says a persistent element became visible, snap `current` to the freshly measured
  // target and WRITE the lift synchronously here, before paint.
  useLayoutEffect(() => {
    const el = barRef.current

    if (el && (el !== painted.current || !Object.is(snappedKey.current, opts.snapKey))) {
      painted.current = el
      snappedKey.current = opts.snapKey
      if (raf.current) {
        cancelAnimationFrame(raf.current)
        raf.current = 0
      }
      target.current = measure()
      current.current = target.current
      el.style.setProperty('--glass-lift', String(current.current))
      return
    }
    if (!el) {
      painted.current = null
      snappedKey.current = opts.snapKey
    }
    kick()
  })
}
