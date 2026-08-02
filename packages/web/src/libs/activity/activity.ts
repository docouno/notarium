// Pure helpers behind the Home dashboard's Activity half (#33). Kept out of the
// composer so the heatmap-grid layout, the intensity scale, the orphan derivation
// and the day↔UTC conversion are unit-testable without React.
//
// All day math is done on the UTC instant SHIFTED east by the client's tz offset
// (minutes, JS `-getTimezoneOffset()`), then read with UTC getters — the same
// "shift then take the calendar date" the server aggregate does, so a cell's
// date matches the bucket the server counted into. No local Date construction
// (which would re-apply the runtime's own zone).

import type { ActivityDay } from '@notarium/contract'
import { ACTIVITY_WEEKS, DAY_MS } from '@notarium/contract/time'

import type { GraphRealNodeView, GraphView } from '../wire'

/** The local calendar day (YYYY-MM-DD) of a UTC instant under `tz`. */
export const localDayOf = (iso: string, tz: number): string => dayStr(Date.parse(iso) + tz * 60_000)

/** Format a shifted-epoch (already in "local" terms) as YYYY-MM-DD via UTC getters. */
const dayStr = (shiftedMs: number): string => {
  const d = new Date(shiftedMs)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** The UTC [from, to) instants that bound a local calendar day under `tz` — what
 *  the heatmap passes to the events endpoint when a cell is clicked. `date` is a
 *  local YYYY-MM-DD; local midnight is `tz` minutes east of the UTC instant. */
export const dayRangeUtc = (date: string, tz: number): { from: string; to: string } => {
  const [y, m, d] = date.split('-').map(Number)
  const localMidnight = Date.UTC(y, m - 1, d)
  const fromMs = localMidnight - tz * 60_000
  return { from: new Date(fromMs).toISOString(), to: new Date(fromMs + DAY_MS).toISOString() }
}

/** The trailing-year window the heatmap spans by DEFAULT — 53 weeks back from
 *  `now`, EXACTLY the server's own default (packages/server .../api.ts `/activity`).
 *  Kept here so a SKELETON grid, built before the server answers, has the identical
 *  week/month structure as the loaded grid: the load transition is then a per-cell
 *  colour swap, never a resize. `now` is a parameter so a caller pins one instant
 *  (and the unit test stays pure). */
export const defaultActivityWindow = (now: number): { from: string; to: string } => ({
  from: new Date(now - ACTIVITY_WEEKS * 7 * DAY_MS).toISOString(),
  to: new Date(now).toISOString(),
})

export type HeatLevel = 0 | 1 | 2 | 3 | 4

export type HeatCell = {
  /** Local YYYY-MM-DD, or null for a padding cell outside the window. */
  date: string | null
  total: number
  created: number
  edited: number
  deleted: number
  level: HeatLevel
}

export type Heatmap = {
  /** Week columns, chronological; each is 7 cells (Sun→Sat, GitHub order). */
  weeks: HeatCell[][]
  /** Month labels above the grid: the column where each month first appears. */
  months: Array<{ label: string; weekIndex: number }>
  maxTotal: number
  totalEvents: number
}

const EMPTY_CELL: HeatCell = { date: null, total: 0, created: 0, edited: 0, deleted: 0, level: 0 }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Intensity 0–4 for a day's event count, scaled to the window's busiest day so
 *  the palette always spans (a base where the max is 2 still shows contrast).
 *  Any activity is at least level 1; only a literal zero is level 0. */
export const levelOf = (total: number, maxTotal: number): HeatLevel => {
  if (total <= 0) {
    return 0
  }
  if (maxTotal <= 1) {
    return 4
  }

  return Math.min(4, Math.ceil((total / maxTotal) * 4)) as HeatLevel
}

/** Build the GitHub-style contribution grid spanning [from, to) (UTC ISO) under
 *  `tz`: weeks as columns from the Sunday on/before the first day through the
 *  week of the last day. Server `days` (local-dated aggregates) fill the cells;
 *  every other in-window day is an explicit zero so the grid is dense. */
export const buildHeatmap = (
  days: readonly ActivityDay[],
  from: string,
  to: string,
  tz: number,
): Heatmap => {
  const byDate = new Map(days.map((d) => [d.date, d]))
  const maxTotal = days.reduce((m, d) => Math.max(m, d.total), 0)
  const totalEvents = days.reduce((s, d) => s + d.total, 0)

  // First/last local day, FLOORED to local midnight (work in the tz-shifted space,
  // read with UTC getters). Crucial: `from`/`to` are `now`-based instants carrying
  // a time-of-day, and `to` is exclusive — without flooring, the cells inherit that
  // time-of-day and TODAY lands exactly on the `to` bound, so `cellMs > lastDay`
  // drops it. Flooring makes every cell midnight-aligned and includes today.
  const firstDay = Math.floor((Date.parse(from) + tz * 60_000) / DAY_MS) * DAY_MS
  const lastDay = Math.floor((Date.parse(to) - 1 + tz * 60_000) / DAY_MS) * DAY_MS
  // Back up to the Sunday that starts the first column.
  const firstWeekday = new Date(firstDay).getUTCDay() // 0 = Sun
  const gridStartMs = firstDay - firstWeekday * DAY_MS

  const weeks: HeatCell[][] = []
  const months: Array<{ label: string; weekIndex: number }> = []
  let lastMonth = -1

  for (let weekMs = gridStartMs; weekMs <= lastDay; weekMs += 7 * DAY_MS) {
    const week: HeatCell[] = []

    for (let i = 0; i < 7; i++) {
      const cellMs = weekMs + i * DAY_MS

      if (cellMs < firstDay || cellMs > lastDay) {
        week.push(EMPTY_CELL)
        continue
      }
      const date = dayStr(cellMs)
      const hit = byDate.get(date)
      week.push(
        hit
          ? { ...hit, level: levelOf(hit.total, maxTotal) }
          : { date, total: 0, created: 0, edited: 0, deleted: 0, level: 0 },
      )
    }
    // Month label: tag the column where a new month's FIRST day lands.
    const monthAnchor = new Date(Math.max(weekMs, firstDay))
    const mon = monthAnchor.getUTCMonth()

    if (mon !== lastMonth) {
      months.push({ label: MONTHS[mon], weekIndex: weeks.length })
      lastMonth = mon
    }
    weeks.push(week)
  }

  return { weeks, months, maxTotal, totalEvents }
}

/** Real notes with no links — degree-0, non-ghost. The single source of the orphan
 *  criterion (shared by the count and the ordered list). */
const orphanNodes = (graph: GraphView | null): GraphRealNodeView[] => {
  if (!graph) {
    return []
  }

  return graph.nodes.filter((node): node is GraphRealNodeView => !node.ghost && node.degree === 0)
}

/** Just the orphan COUNT — for the Health pill metric, which needs the number, not
 *  the list. Skips the title sort orphansOf does (wasted work for a count). */
export const orphanCountOf = (graph: GraphView | null): number => orphanNodes(graph).length

/** The graph's orphans (#33): real notes with no links — "needs attention".
 *  Returns the windowed list (title-ordered) plus the honest full count (so a
 *  surface can say "+N more"). */
export const orphansOf = (
  graph: GraphView | null,
  n: number,
): { items: GraphRealNodeView[]; total: number } => {
  const all = orphanNodes(graph).sort((a, b) => a.title.localeCompare(b.title))
  return { items: all.slice(0, n), total: all.length }
}

/** One breadcrumb segment of a note's folder path (#217): the segment `name` and
 *  the CUMULATIVE folder `path` up to and including it — the address the feed links
 *  each crumb to (folderRoute). */
export type FolderCrumb = { name: string; path: string }

/** Split a note's folder path ('Frontend/Backend') into clickable breadcrumb
 *  segments, each carrying its cumulative path ([{Frontend, 'Frontend'},
 *  {Backend, 'Frontend/Backend'}]). Empty ('' root) or null (unknown/deleted) →
 *  no crumbs (the feed then shows just the title). Empty segments (a leading or
 *  doubled slash) are dropped so a crumb never links to a bad path. */
export const folderCrumbs = (path: string | null | undefined): FolderCrumb[] => {
  if (!path) {
    return []
  }
  const crumbs: FolderCrumb[] = []
  let acc = ''

  for (const seg of path.split('/')) {
    if (!seg) {
      continue
    }
    acc = acc ? `${acc}/${seg}` : seg
    crumbs.push({ name: seg, path: acc })
  }

  return crumbs
}
