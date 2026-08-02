import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ActivityResponse } from '@notarium/contract'
import { IconClock } from '../../core/Icons'
import { Skeleton } from '../../core/Skeleton'
import { buildHeatmap, defaultActivityWindow, type HeatCell } from '../../libs/activity'
import styles from './Dashboard.module.scss'

// The contribution heatmap (#33): GitHub-style week columns, intensity 0–4 from
// the journal aggregate (created/edited/deleted folded into a per-day total).
// Cells are always-square buttons that fill the width (resize scales them, never
// distorts). Every cell shares ONE `--cell` edge, and that edge is snapped to a
// whole number of DEVICE pixels (see `useDeviceSnappedGrid`), so rows and columns
// land on the device grid and never drift a pixel under fractional devicePixelRatio
// — OS display scaling (125/150%) or browser zoom (#219). CSS alone can't do this:
// it works in CSS px and can't see the effective scale; a fluid fractional cell
// (e.g. 14.98px) has its edges round unevenly per column once the ratio isn't 1.
// Hover shows a real floating tooltip (delegated off the grid — one
// listener for ~370 cells, not a native `title`). Weekday rows + month columns
// anchor the grid. Clicking a day drills the "what changed" feed.
//
// ── Skeleton loading — the reference pattern (#218) ──────────────────────────
// A loading heatmap is THIS component with `activity == null`, NOT a separate
// approximation. The grid's geometry (which weeks, which months, the DOW rail, the
// legend, the card padding) is DATA-INDEPENDENT: it's a pure function of the window,
// and the window is deterministic before the server answers (a trailing year, the
// same default the server uses — `defaultActivityWindow`). So we build the exact same
// grid with `buildHeatmap` over empty days and render it muted with one group shimmer.
// The load transition is then a per-cell COLOUR settle in place (see the
// `background-color` transition on `.heat-cell`) — never an unmount, a resize, or a
// reflow. The rules this encodes, reusable elsewhere:
//   1. Skeleton = the real layout in a loading STATE, not a parallel component — so it
//      is dimensionally identical by construction, not by hand-tuned guesswork.
//   2. Derive the skeleton from what is knowable pre-data (here: the fixed window).
//   3. Skeleton only on a COLD start (no data yet). On a refetch/scope-swap the caller
//      keeps the prior data visible (SWR) — never replace real content with a skeleton.
//   4. ONE coherent loading sweep (a grid overlay), not N per-cell shimmers (which read
//      as noisy flicker); the partial-week corners' empty `.heat-pad` gaps paint over it
//      (z-index) so the sheen never bleeds past the real cells. Honours
//      prefers-reduced-motion; the placeholders are aria-hidden + aria-busy.

const WEEKDAYS = ['', 'Mon', '', 'Wed', '', 'Fri', ''] // GitHub shows alternating

const cellLabel = (c: HeatCell): string => {
  if (!c.date) {
    return ''
  }
  if (c.total === 0) {
    return `${c.date} · no activity`
  }
  const parts = [
    c.created && `${c.created} created`,
    c.edited && `${c.edited} edited`,
    c.deleted && `${c.deleted} deleted`,
  ].filter(Boolean)
  return `${c.date} · ${c.total} ${c.total === 1 ? 'change' : 'changes'} (${parts.join(', ')})`
}

type Tip = {
  x: number
  y: number
  date: string
  total: number
  created: number
  edited: number
  deleted: number
}

/** Size the heatmap's cell + inter-cell gap to a whole number of DEVICE pixels (#219).
 *  Returns a ref for the `.heatInner` node. A cell whose CSS-px size is fractional (the
 *  fluid `(container − rail − gaps) / weeks`) paints fine at devicePixelRatio 1, but under
 *  a fractional ratio — OS display scaling (125/150%) or browser zoom — each column's
 *  edges round to the device grid independently, so cells sit a pixel apart and the
 *  lattice reads as crooked. CSS can't see the effective scale; `window.devicePixelRatio`
 *  folds in BOTH OS scale and zoom, so we compute an integer device cell/gap and set them
 *  back as CSS px (`deviceInt / dpr`) — the whole grid then lands on the device grid at
 *  any ratio. Recomputed on container resize and on ratio change (zoom / monitor move). */
const useDeviceSnappedGrid = (weeks: number) => {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current

    if (!el || weeks <= 0) {
      return
    }
    const DOW_RAIL = 30 // must match $dows
    const GAP = 3 // must match $gap
    let raf = 0
    let mql: MediaQueryList | null = null

    const apply = () => {
      const dpr = window.devicePixelRatio || 1
      const availCss = el.clientWidth - DOW_RAIL

      if (availCss <= 0) {
        return
      }
      const availD = Math.floor(availCss * dpr)
      const gapD = Math.max(1, Math.round(GAP * dpr))
      // floor: round the cell DOWN so the columns never overflow. Whole-device-px cells +
      // gaps can't tile an arbitrary width exactly, and because ONE shared cellD is floored
      // across the fixed `weeks` columns the per-column shortfall ACCUMULATES: the unused
      // remainder is `(availD - (weeks-1)*gapD) mod weeks`, i.e. up to (weeks-1) DEVICE px =
      // (weeks-1)/dpr css px — so up to ~`weeks` css px (≈50px for the year grid) at dpr 1,
      // about half that at dpr 2. It sits at the RIGHT edge OUTSIDE the grid box (.heat-grid
      // is `flex: 0 0 auto`, hugging its columns). That slack is the deliberate trade-off for
      // a device-perfect lattice: exact fill-width needs a fractional cell — which is exactly
      // what reintroduces the sub-pixel drift (#219). Straightness beats filling the last strip.
      const cellD = Math.max(1, Math.floor((availD - (weeks - 1) * gapD) / weeks))
      el.style.setProperty('--cell', `${cellD / dpr}px`)
      el.style.setProperty('--gap', `${gapD / dpr}px`)
    }

    const schedule = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(apply)
    }
    apply()
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    // devicePixelRatio has no change event; a resolution media query fires once when it
    // changes, then must be re-armed at the new ratio.
    const arm = () => {
      mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      mql.addEventListener('change', onRatio, { once: true })
    }

    const onRatio = () => {
      apply()
      arm()
    }
    arm()
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
      mql?.removeEventListener('change', onRatio)
    }
  }, [weeks])
  return ref
}

export const ActivityHeatmap = ({
  activity,
  tz,
  selected,
  onSelectDay,
}: {
  /** null = the aggregate hasn't loaded yet → render the skeleton grid (the SAME
   *  geometry, muted + shimmering), so data arrival is a colour settle, not a jump. */
  activity: ActivityResponse | null
  tz: number
  selected: string | null
  onSelectDay: (date: string) => void
}) => {
  const loading = activity == null
  // Build the grid from the loaded window, or — while loading — the identical
  // default window with no days (every cell empty). Same geometry either way.
  const hm = useMemo(() => {
    const win = activity ?? { days: [], ...defaultActivityWindow(Date.now()) }
    return buildHeatmap(win.days, win.from, win.to, tz)
  }, [activity, tz])
  const innerRef = useDeviceSnappedGrid(hm.weeks.length)
  const [tip, setTip] = useState<Tip | null>(null)

  // One delegated hover handler for the whole grid (cheap for ~370 cells). Inert
  // while loading — skeleton cells carry no `data-date`, so nothing resolves.
  const onOver = (e: ReactMouseEvent) => {
    if (loading) {
      return
    }
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-date]')

    if (!el) {
      return
    }
    const r = el.getBoundingClientRect()
    const d = el.dataset
    setTip({
      x: r.left + r.width / 2,
      y: r.top,
      date: d.date as string,
      total: Number(d.total),
      created: Number(d.created),
      edited: Number(d.edited),
      deleted: Number(d.deleted),
    })
  }

  const tipParts = tip
    ? [
        tip.created && `${tip.created} created`,
        tip.edited && `${tip.edited} edited`,
        tip.deleted && `${tip.deleted} deleted`,
      ].filter(Boolean)
    : []

  return (
    <section
      className={styles.heatmapCard}
      data-testid="activity-heatmap"
      aria-busy={loading || undefined}
    >
      <h2 className={styles.cardTitle}>
        <IconClock size={15} /> Activity
        <span className={styles.heatTotal}>
          {loading ? (
            <Skeleton w={150} h={11} />
          ) : (
            `${hm.totalEvents} ${hm.totalEvents === 1 ? 'change' : 'changes'} in the last year`
          )}
        </span>
      </h2>
      <div className={styles.heatScroll}>
        <div
          ref={innerRef}
          className={styles.heatInner}
          style={{ '--weeks': hm.weeks.length } as CSSProperties}
        >
          <div className={styles.heatMonths}>
            {hm.months.map((m, i) => (
              <span
                key={`${m.label}-${i}`}
                className={styles.heatMonth}
                style={{ gridColumn: m.weekIndex + 1 }}
              >
                {m.label}
              </span>
            ))}
          </div>
          <div className={styles.heatBody}>
            <div className={styles.heatDows} aria-hidden>
              {WEEKDAYS.map((d, i) => (
                <span key={i}>{d}</span>
              ))}
            </div>
            <div
              className={styles.heatGrid}
              role="grid"
              aria-label="Activity by day"
              data-loading={loading || undefined}
              onMouseOver={onOver}
              onMouseLeave={() => setTip(null)}
            >
              {hm.weeks.map((week, wi) => (
                <div key={wi} className={styles.heatWeek} role="row">
                  {week.map((cell, di) =>
                    cell.date ? (
                      <button
                        key={cell.date}
                        type="button"
                        role="gridcell"
                        className={styles.heatCell}
                        // While loading, cells are inert muted placeholders: no level
                        // colour, no drill target, hidden from AT (the section is
                        // aria-busy). Data arrival just sets data-level → colour settle.
                        data-level={loading ? undefined : cell.level}
                        data-skeleton={loading || undefined}
                        data-selected={(!loading && selected === cell.date) || undefined}
                        data-date={loading ? undefined : cell.date}
                        data-total={loading ? undefined : cell.total}
                        data-created={loading ? undefined : cell.created}
                        data-edited={loading ? undefined : cell.edited}
                        data-deleted={loading ? undefined : cell.deleted}
                        aria-label={loading ? undefined : cellLabel(cell)}
                        aria-hidden={loading || undefined}
                        disabled={loading || undefined}
                        onClick={loading ? undefined : () => onSelectDay(cell.date as string)}
                        data-testid={!loading && cell.total > 0 ? 'heat-cell-active' : undefined}
                      />
                    ) : (
                      <span
                        key={`pad-${wi}-${di}`}
                        role="gridcell"
                        className={styles.heatPad}
                        aria-hidden
                      />
                    ),
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className={styles.heatLegend}>
            <span>Less</span>
            {[0, 1, 2, 3, 4].map((l) => (
              <span key={l} className={styles.heatCell} data-level={l} data-legend />
            ))}
            <span>More</span>
          </div>
        </div>
      </div>
      {tip && (
        <div className={styles.heatTip} style={{ left: tip.x, top: tip.y }} role="tooltip">
          <span className={styles.heatTipDate}>{tip.date}</span>
          <span className={styles.heatTipBody}>
            {tip.total === 0
              ? 'No activity'
              : `${tip.total} ${tip.total === 1 ? 'change' : 'changes'} · ${tipParts.join(', ')}`}
          </span>
        </div>
      )}
    </section>
  )
}
