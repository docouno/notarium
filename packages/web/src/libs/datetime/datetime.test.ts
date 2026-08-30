// timeAgo / exactDateTime (#158): the hybrid relative-then-absolute label and its
// tooltip companion. The bucketing (floor to whole units, the just-now / minute /
// hour / day / absolute thresholds) is OURS and pinned here; the rendered phrasing
// is the platform's Intl, so the expected relative strings are computed through the
// SAME Intl call — the test verifies which unit/number we pick, locale-independent.

import { describe, expect, it } from 'vitest'

import {
  absoluteDate,
  compactDate,
  exactDateTime,
  fieldDate,
  replaceCalendarDay,
  timeAgo,
} from './datetime'

const NOW = new Date('2026-06-25T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const S = 1000
const MIN = 60 * S
const HR = 60 * MIN
const DAY = 24 * HR
const rel = (n: number, unit: Intl.RelativeTimeFormatUnit) =>
  new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(n, unit)

describe('timeAgo (#158 — hybrid relative/absolute)', () => {
  it('sub-minute and any future timestamp (clock skew) read as "just now"', () => {
    expect(timeAgo(ago(30 * S), NOW)).toBe('just now')
    expect(timeAgo(ago(0), NOW)).toBe('just now')
    expect(timeAgo(new Date(NOW.getTime() + MIN).toISOString(), NOW)).toBe('just now')
    expect(timeAgo(new Date(NOW.getTime() + 5 * HR).toISOString(), NOW)).toBe('just now') // far future, not "in 5 hours"
  })

  it('minutes / hours / days are floored to whole units', () => {
    expect(timeAgo(ago(5 * MIN), NOW)).toBe(rel(-5, 'minute'))
    expect(timeAgo(ago(90 * MIN), NOW)).toBe(rel(-1, 'hour')) // 1h30 → "1 hour ago"
    expect(timeAgo(ago(25 * HR), NOW)).toBe(rel(-1, 'day')) // → "yesterday"
    expect(timeAgo(ago(3 * DAY), NOW)).toBe(rel(-3, 'day'))
    expect(timeAgo(ago(6 * DAY + 23 * HR), NOW)).toBe(rel(-6, 'day')) // still < 7d
  })

  it('the 7-day boundary is the relative→absolute flip', () => {
    const abs = (iso: string) =>
      new Date(iso).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    expect(timeAgo(ago(7 * DAY - 1), NOW)).toBe(rel(-6, 'day')) // just under 7d → still relative
    expect(timeAgo(ago(7 * DAY), NOW)).toBe(abs(ago(7 * DAY))) // exactly 7d → first absolute date
    expect(timeAgo(ago(10 * DAY), NOW)).toBe(abs(ago(10 * DAY)))
  })

  it('empty / invalid input → "" (caller renders its own placeholder)', () => {
    expect(timeAgo(null, NOW)).toBe('')
    expect(timeAgo(undefined, NOW)).toBe('')
    expect(timeAgo('not-a-date', NOW)).toBe('')
  })
})

describe('exactDateTime (#158 — tooltip companion)', () => {
  it('renders date + time for a valid instant', () => {
    const iso = '2026-06-25T01:13:00.000Z'
    expect(exactDateTime(iso)).toBe(
      new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    )
  })

  it('empty / invalid input → ""', () => {
    expect(exactDateTime(null)).toBe('')
    expect(exactDateTime('nope')).toBe('')
  })
})

describe('absoluteDate (#179 — canonical absolute date-only)', () => {
  it('renders month/day/year and matches timeAgo’s older-than-a-week tail', () => {
    const iso = '2020-01-15T00:00:00.000Z'
    const expected = new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
    expect(absoluteDate(iso)).toBe(expected)
    // The relative→absolute flip (≥7d) reuses the SAME shape — one source of truth.
    expect(timeAgo(ago(10 * DAY), NOW)).toBe(absoluteDate(ago(10 * DAY)))
  })

  it('empty / invalid input → ""', () => {
    expect(absoluteDate(null)).toBe('')
    expect(absoluteDate(undefined)).toBe('')
    expect(absoluteDate('nope')).toBe('')
  })

  it('keeps a date-only value on its authored local calendar day', () => {
    const previous = process.env.TZ

    process.env.TZ = 'America/Los_Angeles'
    try {
      expect(absoluteDate('2026-09-01')).toBe(
        new Date(2026, 8, 1).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }),
      )
    } finally {
      if (previous === undefined) {
        delete process.env.TZ
      } else {
        process.env.TZ = previous
      }
    }
  })
})

describe('compactDate (#188 — dense absolute date)', () => {
  it('keeps current-year dates short and pads the day', () => {
    const iso = '2026-06-03T01:13:00.000Z'
    expect(compactDate(iso, NOW)).toBe(
      new Date(iso).toLocaleDateString(undefined, { month: 'short', day: '2-digit' }),
    )
  })

  it('adds the year for dates outside the current year', () => {
    const iso = '2020-01-15T00:00:00.000Z'
    expect(compactDate(iso, NOW)).toBe(
      new Date(iso).toLocaleDateString(undefined, {
        month: 'short',
        day: '2-digit',
        year: 'numeric',
      }),
    )
  })

  it('empty / invalid input → ""', () => {
    expect(compactDate(undefined, NOW)).toBe('')
    expect(compactDate('nope', NOW)).toBe('')
  })
})

describe('replaceCalendarDay', () => {
  it('keeps an instant suffix and handles day-only and clear values', () => {
    expect(replaceCalendarDay('2026-09-01T10:00:00Z', '2026-09-02')).toBe('2026-09-02T10:00:00Z')
    expect(replaceCalendarDay('2026-09-01', '2026-09-02')).toBe('2026-09-02')
    expect(replaceCalendarDay('2026-09-01T10:00:00Z', '')).toBe('')
  })
})

describe('fieldDate', () => {
  it('formats the authored calendar prefix without timezone-shifting an instant', () => {
    expect(fieldDate('2026-09-01T23:30:00-11:00')).toBe(absoluteDate('2026-09-01'))
  })
})
