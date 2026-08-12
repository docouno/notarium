import { describe, expect, it } from 'vitest'
import type { ActivityDay } from '@notarium/contract'
import type { GraphView } from '../wire'
import {
  activityBreakdown,
  buildHeatmap,
  dayRangeUtc,
  defaultActivityWindow,
  folderCrumbs,
  heatCellLabel,
  levelOf,
  localDayOf,
  orphanCountOf,
  orphansOf,
} from './activity'

const day = (date: string, total: number, parts: Partial<ActivityDay> = {}): ActivityDay => ({
  date,
  created: parts.created ?? total,
  edited: parts.edited ?? 0,
  deleted: parts.deleted ?? 0,
  unavailable: parts.unavailable ?? 0,
  total,
})

describe('localDayOf', () => {
  it('shifts a late-UTC instant into the next local day for an eastern tz', () => {
    // 23:30 UTC + 60min = 00:30 next day.
    expect(localDayOf('2026-06-10T23:30:00.000Z', 60)).toBe('2026-06-11')
    expect(localDayOf('2026-06-10T23:30:00.000Z', 0)).toBe('2026-06-10')
  })
  it('shifts an early-UTC instant into the previous local day for a western tz', () => {
    expect(localDayOf('2026-06-10T01:00:00.000Z', -120)).toBe('2026-06-09')
  })
})

describe('dayRangeUtc', () => {
  it('round-trips: every instant in the range maps back to the same local day', () => {
    const tz = 180 // UTC+3
    const { from, to } = dayRangeUtc('2026-06-10', tz)
    expect(localDayOf(from, tz)).toBe('2026-06-10')
    expect(localDayOf(new Date(Date.parse(to) - 1).toISOString(), tz)).toBe('2026-06-10')
    // The day before `from` is the previous local day (half-open boundary).
    expect(localDayOf(new Date(Date.parse(from) - 1).toISOString(), tz)).toBe('2026-06-09')
  })
  it('UTC+0 day starts at midnight UTC', () => {
    expect(dayRangeUtc('2026-06-10', 0)).toEqual({
      from: '2026-06-10T00:00:00.000Z',
      to: '2026-06-11T00:00:00.000Z',
    })
  })
})

describe('levelOf', () => {
  it('is 0 only for no activity; any activity is at least 1', () => {
    expect(levelOf(0, 10)).toBe(0)
    expect(levelOf(1, 10)).toBe(1)
  })
  it('scales to the busiest day and caps at 4', () => {
    expect(levelOf(10, 10)).toBe(4)
    expect(levelOf(5, 10)).toBe(2)
    expect(levelOf(100, 10)).toBe(4)
  })
  it('a max of 1 makes any active day full', () => {
    expect(levelOf(1, 1)).toBe(4)
  })
})

describe('buildHeatmap', () => {
  it('lays out dense Sun→Sat week columns spanning the window, filling zeros', () => {
    // A 2-week window (Mon 2026-06-01 .. Sun 2026-06-14), UTC.
    const hm = buildHeatmap(
      [day('2026-06-02', 3), day('2026-06-09', 1)],
      '2026-06-01T00:00:00.000Z',
      '2026-06-15T00:00:00.000Z',
      0,
    )
    // First column is the Sunday on/before Jun 1 = May 31; Jun 1 is a Monday.
    expect(hm.weeks[0][0].date).toBe(null) // May 31 padding (before window)
    expect(hm.weeks[0][1].date).toBe('2026-06-01')
    // The two active days land with their counts; everything else is a zero cell.
    const jun2 = hm.weeks[0][2]
    expect(jun2).toMatchObject({ date: '2026-06-02', total: 3, level: 4 })
    const jun9 = hm.weeks[1][2]
    expect(jun9).toMatchObject({ date: '2026-06-09', total: 1 })
    expect(jun9.level).toBeGreaterThan(0)
    expect(hm.maxTotal).toBe(3)
    expect(hm.totalEvents).toBe(4)
  })

  it('includes TODAY when from/to are now-based instants sharing a time-of-day (regression)', () => {
    // The window the server sends: to = now, from = ~53 weeks earlier at the SAME
    // time-of-day. Today must appear as the last cell, not be dropped on the
    // exclusive `to` bound (the bug: cells inherited the time-of-day).
    const to = '2026-06-25T20:06:00.000Z'
    const from = '2025-06-19T20:06:00.000Z'
    const hm = buildHeatmap([day('2026-06-25', 2)], from, to, 0)
    const cells = hm.weeks.flat().filter((c) => c.date)
    const last = cells[cells.length - 1]
    expect(last).toMatchObject({ date: '2026-06-25', total: 2 })
  })

  it('emits a month label at the column where a month first appears', () => {
    const hm = buildHeatmap([], '2026-05-28T00:00:00.000Z', '2026-06-10T00:00:00.000Z', 0)
    const labels = hm.months.map((m) => m.label)
    expect(labels).toContain('May')
    expect(labels).toContain('Jun')
  })
})

describe('defaultActivityWindow (#218 skeleton-grid geometry)', () => {
  it('spans 53 weeks back from `now`, matching the server default', () => {
    const now = Date.parse('2026-06-25T20:06:00.000Z')
    const { from, to } = defaultActivityWindow(now)
    expect(to).toBe('2026-06-25T20:06:00.000Z')
    expect(Date.parse(to) - Date.parse(from)).toBe(53 * 7 * 86_400_000)
  })

  it('the SKELETON grid is dimensionally identical to the LOADED grid over the same window', () => {
    // The load-flash fix (#218) rests on this: a heatmap built with NO days (skeleton)
    // has the exact same week columns + month labels as one built with days, as long as
    // the window matches. So the transition is a colour swap, never a resize.
    const now = Date.parse('2026-06-25T20:06:00.000Z')
    const { from, to } = defaultActivityWindow(now)
    const skeleton = buildHeatmap([], from, to, 0)
    const loaded = buildHeatmap([day('2026-06-25', 4), day('2026-03-01', 2)], from, to, 0)
    expect(skeleton.weeks.length).toBe(loaded.weeks.length)
    expect(skeleton.weeks.length).toBeGreaterThanOrEqual(53)
    expect(skeleton.months.map((m) => `${m.label}@${m.weekIndex}`)).toEqual(
      loaded.months.map((m) => `${m.label}@${m.weekIndex}`),
    )
    // Every cell is present in both; only levels differ (skeleton is all-zero).
    expect(skeleton.weeks.flat().filter((c) => c.date).length).toBe(
      loaded.weeks.flat().filter((c) => c.date).length,
    )
    expect(skeleton.totalEvents).toBe(0)
    expect(loaded.totalEvents).toBe(6)
  })
})

const realNode = (id: string, degree: number, title = id): GraphView['nodes'][number] => ({
  id,
  title,
  filePath: `${id}.md`,
  folder: '',
  ghost: false,
  degree,
})

describe('orphansOf', () => {
  const graph: GraphView = {
    nodes: [
      realNode('a', 5, 'Alpha'),
      realNode('b', 2, 'Bravo'),
      realNode('c', 0, 'Charlie'),
      realNode('d', 0, 'Delta'),
      {
        id: 'g',
        title: 'Ghost',
        ghost: true,
        folder: '',
        degree: 9,
        target: 'x',
        prefillTitle: 'X',
        creatable: true,
      },
    ],
    links: [],
  }
  it('orphans are degree-0 real notes with an honest total (ghosts excluded)', () => {
    const o = orphansOf(graph, 1)
    expect(o.total).toBe(2)
    expect(o.items.map((n) => n.id)).toEqual(['c'])
  })
  it('an unbounded window returns every orphan, title-ordered', () => {
    expect(orphansOf(graph, Infinity).items.map((n) => n.id)).toEqual(['c', 'd'])
  })
  it('null graph is safe', () => {
    expect(orphansOf(null, 5)).toEqual({ items: [], total: 0 })
  })
  it('orphanCountOf counts degree-0 real notes (ghosts excluded), null-safe', () => {
    expect(orphanCountOf(graph)).toBe(2)
    expect(orphanCountOf(null)).toBe(0)
  })
})

describe('folderCrumbs', () => {
  it('splits a folder path into cumulative, clickable segments', () => {
    expect(folderCrumbs('Frontend/Backend')).toEqual([
      { name: 'Frontend', path: 'Frontend' },
      { name: 'Backend', path: 'Frontend/Backend' },
    ])
  })
  it('a single-segment path is one crumb', () => {
    expect(folderCrumbs('notes')).toEqual([{ name: 'notes', path: 'notes' }])
  })
  it('root, null and undefined yield no crumbs', () => {
    expect(folderCrumbs('')).toEqual([])
    expect(folderCrumbs(null)).toEqual([])
    expect(folderCrumbs(undefined)).toEqual([])
  })
  it('drops empty segments from leading/doubled/trailing slashes (no bad-path link)', () => {
    expect(folderCrumbs('/a//b/')).toEqual([
      { name: 'a', path: 'a' },
      { name: 'b', path: 'a/b' },
    ])
  })
})

describe('journal gaps in the heatmap (#327)', () => {
  it('counts an unavailable day as activity without attributing it to a kind', () => {
    const from = '2026-06-01T00:00:00.000Z'
    const to = '2026-06-08T00:00:00.000Z'
    const hm = buildHeatmap([day('2026-06-03', 3, { created: 1, unavailable: 2 })], from, to, 0)
    const cell = hm.weeks.flat().find((c) => c.date === '2026-06-03')!

    expect(cell).toMatchObject({ total: 3, created: 1, edited: 0, deleted: 0, unavailable: 2 })
    // Intensity is the day's whole activity: a gap is real work, just unreadable.
    expect(cell.level).toBeGreaterThan(0)
    expect(hm.totalEvents).toBe(3)
  })

  it('draws a day made of gaps ALONE as a lit cell, not as an empty one', () => {
    // The mixed day above cannot see this: it is lit by its `created` count either
    // way. Only a day with nothing but gaps proves the gap reaches the intensity.
    const hm = buildHeatmap(
      [day('2026-06-03', 2, { created: 0, unavailable: 2 })],
      '2026-06-01T00:00:00.000Z',
      '2026-06-08T00:00:00.000Z',
      0,
    )
    const cell = hm.weeks.flat().find((c) => c.date === '2026-06-03')!

    expect(cell).toMatchObject({ total: 2, created: 0, edited: 0, deleted: 0, unavailable: 2 })
    expect(cell.level).toBeGreaterThan(0)
    expect(hm.totalEvents).toBe(2)
    expect(heatCellLabel(cell)).toBe('2026-06-03 · 2 changes (2 unavailable)')
  })

  it('names the gap in the accessible label and the tooltip, pluralized with the rest', () => {
    const cell = {
      date: '2026-06-03',
      total: 4,
      created: 1,
      edited: 0,
      deleted: 1,
      unavailable: 2,
      level: 2 as const,
    }

    expect(activityBreakdown(cell)).toEqual(['1 created', '1 deleted', '2 unavailable'])
    expect(heatCellLabel(cell)).toBe('2026-06-03 · 4 changes (1 created, 1 deleted, 2 unavailable)')
    // A day with ONLY gaps still reads as activity, never as "no activity".
    expect(
      heatCellLabel({
        date: '2026-06-04',
        total: 1,
        created: 0,
        edited: 0,
        deleted: 0,
        unavailable: 1,
        level: 1,
      }),
    ).toBe('2026-06-04 · 1 change (1 unavailable)')
    expect(
      heatCellLabel({
        date: '2026-06-05',
        total: 0,
        created: 0,
        edited: 0,
        deleted: 0,
        unavailable: 0,
        level: 0,
      }),
    ).toBe('2026-06-05 · no activity')
  })

  it('gives every generated empty cell an explicit zero gap count', () => {
    const hm = buildHeatmap([], '2026-06-01T00:00:00.000Z', '2026-06-08T00:00:00.000Z', 0)

    for (const cell of hm.weeks.flat()) {
      expect(cell.unavailable).toBe(0)
    }
  })
})
