import { type RefObject, useEffect, useRef } from 'react'

type DismissRef = RefObject<HTMLElement | null> | undefined

type UseDismissOptions = {
  /** Pointer events inside any of these elements don't dismiss (the popover, its trigger). */
  inside?: ReadonlyArray<DismissRef>
  /** Also dismiss on scroll/resize/contextmenu — for a popover pinned to a screen point. */
  viewport?: boolean
}

// The open transient: scroll/resize that fire as a SIDE EFFECT of opening (the
// browser bringing a below-the-fold trigger into view, a layout settle as async
// content lands) must not dismiss a popover the user just opened — those events can
// arrive a frame or two after mount. A short grace window after binding ignores
// viewport scroll/resize only; a genuine user scroll-to-dismiss comes well later,
// and pointerdown/Escape (real dismiss gestures) stay immediate throughout.
const VIEWPORT_GRACE_MS = 400

// Dismiss-on-outside-interaction for popovers and menus: a pointerdown outside the
// `inside` refs, or Escape, calls onDismiss; `viewport` adds scroll/resize/contextmenu
// for a popover anchored to a fixed screen point. Gated by `active` so it only listens
// while open. The latest onDismiss/inside are read through refs, so the listeners are
// bound once per active/viewport change instead of re-binding on every parent render.
export const useDismiss = (
  active: boolean,
  onDismiss: () => void,
  opts: UseDismissOptions = {},
) => {
  const { inside = [], viewport = false } = opts
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss
  const insideRef = useRef(inside)
  insideRef.current = inside

  useEffect(() => {
    if (!active) {
      return undefined
    }
    const boundAt = Date.now()
    const dismiss = () => onDismissRef.current()

    // Dismiss unless the interaction happened INSIDE the popover or its trigger.
    // Shared by pointerdown, contextmenu AND scroll: a scroll whose target is the
    // popover itself (a tall menu with its own overflow-y scroll) must NOT close it
    // — only a scroll of the page/anchor behind it should. The page's scroll
    // container isn't in `inside`, so it still dismisses; the menu's own scroll is.
    const onInteractOutside = (e: Event) => {
      const target = e.target as Node

      if (insideRef.current.some((r) => r?.current?.contains(target))) {
        return
      }
      dismiss()
    }

    // Scroll/resize within the open transient is the browser settling the just-opened
    // popover into view, not a user gesture — ignore it (see VIEWPORT_GRACE_MS).
    const onViewport = (e: Event) => {
      if (Date.now() - boundAt < VIEWPORT_GRACE_MS) {
        return
      }
      onInteractOutside(e)
    }

    const onResize = () => {
      if (Date.now() - boundAt < VIEWPORT_GRACE_MS) {
        return
      }
      dismiss()
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dismiss()
      }
    }
    // Capture phase + window so a pointerdown/scroll inside any nested container still
    // dismisses (the ContextMenu contract), and consistently for the simpler menus too.
    window.addEventListener('mousedown', onInteractOutside, true)
    window.addEventListener('keydown', onKey)
    if (viewport) {
      window.addEventListener('contextmenu', onInteractOutside, true)
      window.addEventListener('scroll', onViewport, true)
      window.addEventListener('resize', onResize)
    }

    return () => {
      window.removeEventListener('mousedown', onInteractOutside, true)
      window.removeEventListener('keydown', onKey)
      if (viewport) {
        window.removeEventListener('contextmenu', onInteractOutside, true)
        window.removeEventListener('scroll', onViewport, true)
        window.removeEventListener('resize', onResize)
      }
    }
  }, [active, viewport])
}
