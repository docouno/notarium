import { type RefObject, useLayoutEffect, useRef, useState } from 'react'
import { useScrollGlass } from '../../../../libs/hooks/useScrollGlass'
import { DEFAULT_TOP_CHROME_H } from '../../consts'

/** The floating top chrome + footer over the Trash list (frosted glass, #72/#185).
 *  Owns their refs, measured live heights and scroll-aware glass wiring. The footer
 *  stays mounted while visually hidden, so its height is reserved before selection;
 *  showing it never changes the list's scroll range. `structure` flags re-run the
 *  measure when the chrome's contents/visibility regime changes. */
export const useTrashChrome = (
  scrollRef: RefObject<HTMLDivElement | null>,
  structure: { showToolbar: boolean; showTabs: boolean; showFooter: boolean },
) => {
  const { showToolbar, showTabs, showFooter } = structure
  // The top chrome + footer float over the list as frosted glass (#72) — the list
  // scrolls UNDER them. Measure their live heights and reserve them as scroll padding,
  // the same way the rail head is measured (--panel-head-h). The footer ref is present
  // even without selection, so footH does not jump from zero when actions become visible.
  const topChromeRef = useRef<HTMLDivElement>(null)
  const footerRef = useRef<HTMLDivElement>(null)
  const [topH, setTopH] = useState(DEFAULT_TOP_CHROME_H)
  const [footH, setFootH] = useState(0)
  // Scroll-aware glass (#185): the top chrome gains its frost as the list scrolls under
  // it; the footer, mirrored — frosted while content remains BELOW it, flat once the
  // list is scrolled to its end (where only the empty bottom padding sits behind it).
  useScrollGlass(scrollRef, topChromeRef)
  useScrollGlass(scrollRef, footerRef, { edge: 'bottom', snapKey: showFooter })

  // Measure the floating chrome so the list pads exactly clear of it. Re-runs when the
  // toolbar/footer mount or unmount (structural toggles); a ResizeObserver catches size
  // changes within (font, zoom, a count growing a line). Layout effect so the padding is
  // right before paint — no first-frame jump.
  useLayoutEffect(() => {
    const measure = () => {
      setTopH(topChromeRef.current?.offsetHeight ?? DEFAULT_TOP_CHROME_H)
      setFootH(footerRef.current?.offsetHeight ?? 0)
    }
    measure()
    const ro = new ResizeObserver(measure)

    if (topChromeRef.current) {
      ro.observe(topChromeRef.current)
    }
    if (footerRef.current) {
      ro.observe(footerRef.current)
    }

    return () => ro.disconnect()
  }, [showToolbar, showTabs, showFooter])

  return { topChromeRef, footerRef, topH, footH }
}
