import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bucketLabel,
  bucketStart,
  isoWeek,
  startOfDay,
  startOfWeek,
  toDate,
} from '../../packages/web/src/libs/feed/feedDates'

// Date logic of the Feed (#32). The spec that must survive #19: date-only strings
// parse to a *local* day (no UTC drift), ISO weeks are Monday-based with the
// year-1-holds-first-Thursday rule, week starts are Monday. Relative labels read
// "now", so those tests pin the clock.

describe('toDate', () => {
  it('parses a date-only string as a LOCAL day (no UTC back-shift)', () => {
    const d = toDate('2026-06-04')!
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(5) // June (0-based)
    expect(d.getDate()).toBe(4) // never 3 — the #32 local-parse guarantee
    expect(d.getHours()).toBe(0)
  })
  it('parses a full ISO timestamp', () => {
    expect(toDate('2026-06-04T08:30:00Z')!.getFullYear()).toBe(2026)
  })
  it('returns null for empty or invalid input', () => {
    expect(toDate('')).toBeNull()
    expect(toDate(null as unknown as string)).toBeNull()
    expect(toDate('not-a-date')).toBeNull()
  })
})

describe('isoWeek', () => {
  it('puts 2026-01-01 (a Thursday) in week 1', () => {
    expect(isoWeek(toDate('2026-01-01')!.getTime())).toEqual({ week: 1, year: 2026 })
  })
  it('rolls 2025-12-29 (Mon) into week 1 of the NEXT year', () => {
    expect(isoWeek(toDate('2025-12-29')!.getTime())).toEqual({ week: 1, year: 2026 })
  })
  it('reports a 53rd week for a long year (2026 ends on a Thursday)', () => {
    expect(isoWeek(toDate('2026-12-31')!.getTime())).toEqual({ week: 53, year: 2026 })
  })
})

describe('startOfWeek', () => {
  it('snaps back to Monday 00:00', () => {
    const mon = new Date(startOfWeek(toDate('2026-06-04')!)) // Thu → its Monday
    expect(mon.getDay()).toBe(1) // Monday
    expect(mon.getHours()).toBe(0)
    // within the same ISO week as the input
    expect(startOfWeek(toDate('2026-06-04')!)).toBe(startOfWeek(toDate('2026-06-01')!))
  })
})

describe('bucketStart', () => {
  it('day → start of that day', () => {
    expect(bucketStart(toDate('2026-06-04')!, 'day')).toBe(startOfDay(toDate('2026-06-04')!))
  })
  it('week → Monday of that week', () => {
    expect(bucketStart(toDate('2026-06-04')!, 'week')).toBe(startOfWeek(toDate('2026-06-04')!))
  })
  it('month → the 1st at 00:00', () => {
    const first = new Date(bucketStart(toDate('2026-06-15')!, 'month'))
    expect(first.getDate()).toBe(1)
    expect(first.getMonth()).toBe(5)
    expect(first.getHours()).toBe(0)
  })
})

describe('relative labels (clock pinned to 2026-06-10)', () => {
  afterEach(() => vi.useRealTimers())
  const pin = () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 5, 10, 12, 0, 0))
  }

  it('day bucket: Today / Yesterday', () => {
    pin()
    expect(bucketLabel(startOfDay(new Date(2026, 5, 10)), 'day')).toBe('Today')
    expect(bucketLabel(startOfDay(new Date(2026, 5, 9)), 'day')).toBe('Yesterday')
  })
  it('week bucket: This week / Last week', () => {
    pin()
    expect(bucketLabel(startOfWeek(new Date(2026, 5, 10)), 'week')).toBe('This week')
    expect(bucketLabel(startOfWeek(new Date(2026, 5, 3)), 'week')).toBe('Last week')
  })
  it('month bucket: This month / Last month', () => {
    pin()
    expect(bucketLabel(bucketStart(new Date(2026, 5, 10), 'month'), 'month')).toBe('This month')
    expect(bucketLabel(bucketStart(new Date(2026, 4, 10), 'month'), 'month')).toBe('Last month')
  })
})
