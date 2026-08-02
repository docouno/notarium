import { describe, expect, it } from 'vitest'
import { liftFromMetrics } from './useScrollGlass'

// Pure lift math of the scroll-glass primitive (#185), with the #194 freeze-when-hidden
// rule. The DOM/rAF wiring of the hook is verified live; this pins the algorithm the
// rail head, topbar and Trash now all share — so a refactor that weakens the guard or
// the ramp fails here instead of silently regressing the "no visual change" contract.

const top = { span: 36, edge: 'top' as const }
// A tall pane: 500px viewport over 1000px of content, so 500px of scroll range.
const tall = (scrollTop: number) => ({ scrollTop, scrollHeight: 1000, clientHeight: 500 })

describe('liftFromMetrics — the shared scroll→lift ramp (#185/#194)', () => {
  it('edge "top": lift is the scrolled fraction over `span`, clamped to 1', () => {
    expect(liftFromMetrics(tall(0), top, 0)).toBe(0)
    expect(liftFromMetrics(tall(18), top, 0)).toBe(0.5) // half the 36px ramp
    expect(liftFromMetrics(tall(20), top, 0)).toBeCloseTo(20 / 36) // 0.555… (matches live)
    expect(liftFromMetrics(tall(36), top, 0)).toBe(1) // full ramp
    expect(liftFromMetrics(tall(200), top, 0)).toBe(1) // clamped past the ramp
  })

  it('reproduces the old rail formula min(scrollTop/36, 1) at the default span', () => {
    for (const s of [0, 5, 12, 18, 30, 36, 100]) {
      expect(liftFromMetrics(tall(s), top, 0.3)).toBe(Math.min(s / 36, 1))
    }
  })

  it('clamps a negative scrollTop (elastic overscroll) to 0, not a negative lift', () => {
    expect(liftFromMetrics(tall(-8), top, 0.7)).toBe(0)
  })

  it('honours a custom span', () => {
    expect(liftFromMetrics(tall(30), { span: 60, edge: 'top' }, 0)).toBe(0.5)
  })

  it('edge "bottom": lift tracks the distance still BELOW the bar (flat at the end)', () => {
    // range = scrollHeight - clientHeight = 500.
    expect(liftFromMetrics(tall(500), { span: 36, edge: 'bottom' }, 1)).toBe(0) // scrolled to end
    expect(liftFromMetrics(tall(500 - 36), { span: 36, edge: 'bottom' }, 0)).toBe(1) // 36px of content left below
    expect(liftFromMetrics(tall(500 - 18), { span: 36, edge: 'bottom' }, 0)).toBe(0.5)
    expect(liftFromMetrics(tall(0), { span: 36, edge: 'bottom' }, 0)).toBe(1) // whole list below the bar
  })

  describe('#194 freeze-when-hidden: a display:none / detached pane reports all-zero metrics', () => {
    const hidden = { scrollTop: 0, scrollHeight: 0, clientHeight: 0 }

    it('FREEZES at the current lift instead of resetting to 0 (no fade-in on reopen)', () => {
      expect(liftFromMetrics(hidden, top, 1)).toBe(1) // was scrolled → stays lit through the collapse
      expect(liftFromMetrics(hidden, top, 0.42)).toBe(0.42)
      expect(liftFromMetrics(hidden, top, 0)).toBe(0)
    })

    it('re-derives the true lift once the pane is laid out again (reveal)', () => {
      // Frozen at 1 while hidden, then reopened at the top of the list → back to flat.
      expect(liftFromMetrics(tall(0), top, 1)).toBe(0)
      // Frozen at 0 while hidden, reopened deep-scrolled → lit.
      expect(liftFromMetrics(tall(36), top, 0)).toBe(1)
    })

    it('does NOT trigger for a visible-but-empty pane (non-zero clientHeight)', () => {
      // An empty tree still has a laid-out viewport (clientHeight) and its head padding
      // (scrollHeight), so it measures a real 0 — flat — not a frozen stale value.
      expect(liftFromMetrics({ scrollTop: 0, scrollHeight: 132, clientHeight: 500 }, top, 1)).toBe(
        0,
      )
    })

    it('requires BOTH metrics zero to freeze — a content-but-zero-viewport pane still ramps', () => {
      // Only a display:none / detached pane zeros BOTH metrics; a pane with content but a
      // 0 viewport (clientHeight 0, scrollHeight > 0) is NOT the hidden case, so it must
      // compute the real ramp, not hold a stale value. This pins the guard's `&&` (a
      // looser `||` would wrongly freeze such a pane at the stale 0.5).
      expect(liftFromMetrics({ scrollTop: 40, scrollHeight: 132, clientHeight: 0 }, top, 0.5)).toBe(
        1,
      )
    })
  })

  it('a missing element (pre-attach) seeds flat (0), matching the old mount seed', () => {
    expect(liftFromMetrics(null, top, 0.9)).toBe(0)
  })
})
