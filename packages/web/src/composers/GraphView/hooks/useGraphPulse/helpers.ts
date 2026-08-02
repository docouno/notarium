// Who a keystroke belongs to. Both rules exist because the page underneath keeps
// working while the gesture is being typed: the mode may not steal a key that
// something else legitimately owns.

/** A keystroke belongs to whatever the user is typing into — never to us. The
 *  double negation is load-bearing: `isContentEditable` is undefined outside a real
 *  browser, and the raw expression would then return undefined from a `: boolean`. */
export const isTyping = (el: Element | null): boolean =>
  el instanceof HTMLElement &&
  (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || !!el.isContentEditable)

// The graph page is full of buttons (zoom, fit, panel toggles, aside tabs, tree
// rows) and on a focused control the space bar is its ACTIVATION — five taps there
// are five clicks the user meant, not a secret handshake.
const FOCUSABLE = 'button, a[href], input, textarea, select, [role="button"], [tabindex]'

/** Whether a space-bar tap may count towards the gesture: only with focus resting
 *  on the page itself, and never behind a modal (the app's own key dispatcher
 *  stands down for those too, so we match it). */
export const gestureAllowed = (el: Element | null): boolean => {
  if (document.querySelector('[aria-modal="true"]')) {
    return false
  }

  return !el || el === document.body || !el.closest(FOCUSABLE)
}
