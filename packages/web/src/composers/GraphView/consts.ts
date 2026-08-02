// The Spacing slider reads 50–250%, but the layout floor felt a touch tight, so the
// whole scale is shifted +10% into the force model: the 50% end behaves like the old
// 60%, and the top gains the same 10. Kept off the displayed value so the dial stays
// a clean 50–250%. (The server pre-layout assumes the resulting default — core's
// DEFAULT_SPACING = 1 + this shift.)
export const SPACING_SHIFT = 0.1

// SSE-driven refetches are throttled: a burst of changed events (a delta poll
// landing many notes) folds into one /api/graph reload.
export const REFETCH_MIN_MS = 4000

// Typing in the Focus search re-scans every node title; debounced so the scan
// runs once per pause, not per keystroke (#62.5).
export const GRAPH_SCAN_DEBOUNCE_MS = 150

// Five deliberate space-bar taps, each within this gap of the last. Long enough
// to be comfortable, short enough that an idle press or two never adds up to it.
export const PULSE_TRIGGER_TAPS = 5
export const PULSE_TRIGGER_GAP_MS = 1500
// How long the space bar stays deaf after the gesture lands, so the tail of the
// run doesn't immediately silence the tune it just started.
export const PULSE_SETTLE_MS = 600
