import { useEffect } from 'react'

// Auto-hide scrollbars (#176). ONE document-level controller — no per-component wiring —
// that fades every scrollable surface's WebKit scrollbar to nothing after a short idle,
// and snaps it back on scroll or when the pointer nears the bar's edge. Mounted once
// (AppShell); it self-manages any scroller it sees a `scroll` event from, so a future
// container is covered for free.
//
// Why a per-frame JS opacity var and not a CSS transition: WebKit does NOT animate
// `::-webkit-scrollbar-thumb` — it repaints instantly (like on :hover) — so smoothness
// has to come from JS writing `--sb-op` each frame, exactly the pattern useScrollGlass
// (#185) already uses for `--glass-lift`. The thumb colour reads that var (styles/base.scss);
// a scroller we never touch leaves it unset (default 1 → always visible, unchanged).
//
// Reveal is deliberately NOT whole-container hover (that would keep the bar on while you
// read over the content): only SCROLLING, or the pointer entering the thin gutter band at
// the right edge, brings it back.

const IDLE_MS = 1400 // rest this long with no scroll / edge-hover → begin fading out
const FADE_MS = 220 // fade-out duration once idle
const EDGE_BAND = 22 // px from the right edge that count as "pointer on the bar"
const MOVE_GATE_MS = 50 // pointermove throttle (cheap; the walk + rect are gated to ~20/s)

type State = { op: number; lastActive: number }

export const useAutoHideScrollbars = (): void => {
  useEffect(() => {
    // Reduce-motion opts out entirely: leave every bar at its default (always visible,
    // thin) — never register or fade. base.scss pins the same so the two agree.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return undefined
    }

    // Per-element opacity state; `active` are the ones currently animating (or shown),
    // iterated by the single rAF loop. WeakMap so a removed node's state is collectable.
    const state = new WeakMap<HTMLElement, State>()
    const active = new Set<HTMLElement>()
    let raf = 0
    let lastFrame = 0

    const tick = (now: number): void => {
      const dt = lastFrame ? now - lastFrame : 16
      lastFrame = now
      for (const el of active) {
        const s = state.get(el)

        if (!s) {
          active.delete(el)
          continue
        }
        // Snap to full on activity, ease to 0 once idle (instant show, smooth hide).
        if (now - s.lastActive < IDLE_MS) {
          s.op = 1
        } else {
          s.op = Math.max(0, s.op - dt / FADE_MS)
        }
        el.style.setProperty('--sb-op', s.op.toFixed(3))
        // Settled hidden: stop animating but KEEP --sb-op:0 inline (removing it would
        // fall back to the default 1 and flash the bar back on).
        if (s.op === 0) {
          active.delete(el)
        }
      }
      raf = active.size ? requestAnimationFrame(tick) : 0
      if (!raf) {
        lastFrame = 0
      }
    }

    // Mark a scroller live: full opacity now, re-arm the idle clock, ensure the loop runs.
    const poke = (el: HTMLElement): void => {
      let s = state.get(el)

      if (!s) {
        s = { op: 1, lastActive: 0 }
        state.set(el, s)
      }
      s.op = 1
      s.lastActive = performance.now()
      el.style.setProperty('--sb-op', '1')
      active.add(el)
      if (!raf) {
        lastFrame = 0
        raf = requestAnimationFrame(tick)
      }
    }

    // scroll doesn't bubble, but a CAPTURE listener on document still receives it on the
    // way down — so this one handler catches every scroller, present or future. A scroll
    // event's target is by definition a scroll container, so no overflow probe is needed.
    const onScroll = (e: Event): void => {
      const el = e.target

      if (el instanceof HTMLElement) {
        poke(el)
      }
    }

    const isScrollable = (el: HTMLElement): boolean => {
      if (el.scrollHeight <= el.clientHeight + 1) {
        return false
      }
      const oy = getComputedStyle(el).overflowY
      return oy === 'auto' || oy === 'scroll'
    }

    // Nearest scrollable ancestor of a node (incl. itself) — used only on the throttled
    // pointermove, so the getComputedStyle walk runs at most ~20×/s.
    const scrollerOf = (node: EventTarget | null): HTMLElement | null => {
      let el = node instanceof HTMLElement ? node : null

      while (el && el !== document.body) {
        if (isScrollable(el)) {
          return el
        }
        el = el.parentElement
      }

      return null
    }

    let lastMove = 0

    const onMove = (e: PointerEvent): void => {
      const now = performance.now()

      if (now - lastMove < MOVE_GATE_MS) {
        return
      }
      lastMove = now
      const el = scrollerOf(e.target)

      if (!el) {
        return
      }
      // Reveal only when the pointer is in the right-edge gutter band (where the bar
      // lives), not anywhere over the content — the bar shouldn't sit on while reading.
      const r = el.getBoundingClientRect()

      if (e.clientX <= r.right && r.right - e.clientX <= EDGE_BAND) {
        poke(el)
      }
    }

    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    document.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions)
      document.removeEventListener('pointermove', onMove)
      if (raf) {
        cancelAnimationFrame(raf)
      }
    }
  }, [])
}
