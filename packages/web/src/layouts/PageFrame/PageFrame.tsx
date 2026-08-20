import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import { useChrome } from '../../composers/ChromeProvider'
import { IconPanelLeft } from '../../core/Icons'
import { IconToggle } from '../../core/IconToggle'
import { cx } from '../../libs/cx/cx'
import { useMainInert } from '../../libs/hooks/useMainInert'
import { useScrollGlass } from '../../libs/hooks/useScrollGlass'
import styles from './PageFrame.module.scss'

// The shared app frame: the main column with its topbar — left is ALWAYS the
// sidebar-collapse toggle, then a page-supplied title/breadcrumb and optional
// actions — over a scrolling content area, plus an OPTIONAL right aside. Document
// pages, the settings surface and any future page reuse this so the rail toggle
// and content gutters live in exactly one place; a page only fills the slots it
// needs (no aside? omit it; no actions? omit them). Full-bleed pages that own
// their own chrome (the graph) don't use this and float their own toggle.
//
// The topbar is a 3-column grid `1fr auto 1fr`: the centre slot (the #190 search)
// is anchored to the BAR's true centre regardless of how wide the breadcrumb or
// the actions are — so it never drifts page to page. The side tracks are equal,
// the breadcrumb truncates within its track. The inline search is a WIDE-SCREEN
// affordance: below `SEARCH_MIN_BAR` of topbar width it's dropped entirely (no
// shrunk field, no icon — search stays one click away via the rail Search icon /
// Cmd+P / `/`). Tied to the BAR width, not the viewport, so a collapsed sidebar
// (more room) brings it back at a smaller window. Proper responsive layout is a
// separate task; this is the honest interim cut.

/** Min topbar inner width to show the inline search (≈ a 1600px window with the
 *  sidebar open). Below it the field has no comfortable room — drop it. */
const SEARCH_MIN_BAR = 1320

type PageFrameProps = {
  /** Topbar left region (breadcrumb, page title…). */
  topbarLeft?: ReactNode
  /** Topbar centre region (the cross-cutting search, #190) — bar-centred. */
  topbarCenter?: ReactNode
  /** Topbar right region (page actions, view toggles). */
  topbarActions?: ReactNode
  /** Right aside column; omit for pages without one (e.g. settings). */
  aside?: ReactNode
  /** Extra class on the scrolling content wrapper. */
  contentClassName?: string
  /** Native inert is used while a narrow full-screen aside covers the page. */
  contentInert?: boolean
  children: ReactNode
}

/** Shared divider between page actions and a view-level topbar control. */
export const TopbarActionSeparator = () => (
  <span className={styles.actionSep} data-testid="topbar-action-separator" aria-hidden="true" />
)

export const PageFrame = ({
  topbarLeft,
  topbarCenter,
  topbarActions,
  aside,
  contentClassName,
  contentInert = false,
  children,
}: PageFrameProps) => {
  const { narrowLayout, leftPanelOpen, toggleLeftPanel } = useChrome()
  const topbarRef = useRef<HTMLDivElement>(null)
  const [showSearch, setShowSearch] = useState(true)

  // Scroll-aware glass (#185): the topbar rests near-flat and gains its frost in
  // proportion to how far the content has scrolled under it (the hook self-attaches
  // to the content pane and writes the lift onto the topbar — the same `topbarRef`
  // the width test below measures).
  const scrollRef = useRef<HTMLDivElement>(null)
  useScrollGlass(scrollRef, topbarRef)
  useMainInert(contentInert)

  // Show the inline search only when the bar is wide enough to seat it comfortably;
  // below that, drop it (it lives in Spotlight on narrower screens). Bar width, not
  // viewport, so a collapsed sidebar brings it back sooner. Depend on WHETHER there's
  // a centre slot, not its node identity — `topbarCenter` is a fresh element every
  // render, so keying the effect on it would tear down + rebuild the observer on each
  // commit (e.g. every keystroke in the search).
  const hasCenter = !!topbarCenter
  useLayoutEffect(() => {
    if (!hasCenter) {
      setShowSearch(false)
      return undefined
    }
    const bar = topbarRef.current

    if (!bar) {
      return undefined
    }
    const measure = () => {
      const cs = getComputedStyle(bar)
      const inner = bar.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      setShowSearch(inner >= SEARCH_MIN_BAR)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(bar)
    return () => ro.disconnect()
  }, [hasCenter])

  return (
    <>
      <main className={cx('main', styles.frame)}>
        <div
          ref={topbarRef}
          className={cx(styles.topbar, 'glass', 'glass-scroll', 'glass-edge-bottom')}
        >
          <div className={styles.topbarLead}>
            <IconToggle
              icon={<IconPanelLeft size={15} />}
              active={leftPanelOpen}
              onClick={toggleLeftPanel}
              title={
                narrowLayout
                  ? leftPanelOpen
                    ? 'Close sidebar'
                    : 'Open sidebar'
                  : leftPanelOpen
                    ? 'Collapse sidebar'
                    : 'Expand sidebar'
              }
            />
            <div className={styles.topbarLeft}>{topbarLeft}</div>
          </div>
          <div className={styles.topbarCenter}>{showSearch ? topbarCenter : null}</div>
          <div className={styles.topbarActions}>{topbarActions}</div>
        </div>
        <div
          ref={scrollRef}
          data-testid="content-scroll"
          className={cx(styles.contentScroll, contentClassName)}
        >
          {children}
        </div>
      </main>
      {aside}
    </>
  )
}
