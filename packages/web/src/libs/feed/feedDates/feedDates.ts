// Date parsing and calendar BUCKETING for the Feed page (#32).
//
// Extracted from FeedPage.jsx so the spec-critical bits are unit-testable (#18,
// Layer 2): ISO parsing, ISO-week numbering, and Monday-based week starts. The
// relative labels (Today / This week / …) read the current date, so tests pin
// "now" with fake timers.
//
// This module owns ONLY the feed's calendar grouping (day/week/month headings) —
// a concept distinct from a plain timestamp label. Generic date-label formatting
// (relative "time ago", absolute date, tooltips) lives in the one source of truth,
// `libs/datetime` (#179); the day/month headings keep their own inline shapes on
// purpose, they are bucket headings, not row timestamps.

import { BUCKET_GRAN } from '@notarium/contract/enums'

/** Bucketing granularity (the Feed's grouping minus 'off'). */
export type BucketGran = 'day' | 'week' | 'month'

// Parse an ISO instant (contract v2, #54: createdAt/modifiedAt are full ISO)
// into a Date. Returns null for empty/invalid input.
export const toDate = (value: string | null | undefined): Date | null => {
  if (!value) {
    return null
  }
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export const startOfDay = (d: Date | number): number => {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x.getTime()
}

// Keep-style day heading: Today / Yesterday / weekday (within the week) / date.
export const dayLabel = (ts: number): string => {
  const today = startOfDay(new Date())
  const diff = Math.round((today - ts) / 86400000)

  if (diff <= 0) {
    return 'Today'
  }
  if (diff === 1) {
    return 'Yesterday'
  }
  if (diff < 7) {
    return new Date(ts).toLocaleDateString(undefined, { weekday: 'long' })
  }

  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

// Monday-based start of the week containing `d`.
export const startOfWeek = (d: Date | number): number => {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7))
  return x.getTime()
}

// ISO-8601 week number (weeks start Monday; week 1 holds the year's first Thursday).
export const isoWeek = (ts: number): { week: number; year: number } => {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7)) // shift to this week's Thursday
  const week1 = new Date(d.getFullYear(), 0, 4)
  return {
    week:
      1 +
      Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7),
    year: d.getFullYear(),
  }
}

export const weekLabel = (ts: number): string => {
  const thisWeek = startOfWeek(new Date())
  const diff = Math.round((thisWeek - ts) / (7 * 86400000))

  if (diff === 0) {
    return 'This week'
  }
  if (diff === 1) {
    return 'Last week'
  }
  const { week, year } = isoWeek(ts)
  return `Week ${week}, ${year}`
}

export const monthLabel = (ts: number): string => {
  const now = new Date()
  const d = new Date(ts)
  const months = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth())

  if (months === 0) {
    return 'This month'
  }
  if (months === 1) {
    return 'Last month'
  }

  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

// Bucket a date into the start-of-period timestamp + heading for the granularity.
export const bucketStart = (date: Date | number, gran: BucketGran): number => {
  if (gran === BUCKET_GRAN.week) {
    return startOfWeek(date)
  }
  if (gran === BUCKET_GRAN.month) {
    const x = new Date(date)
    x.setHours(0, 0, 0, 0)
    x.setDate(1)
    return x.getTime()
  }

  return startOfDay(date)
}

export const bucketLabel = (ts: number, gran: BucketGran): string => {
  if (gran === BUCKET_GRAN.week) {
    return weekLabel(ts)
  }
  if (gran === BUCKET_GRAN.month) {
    return monthLabel(ts)
  }

  return dayLabel(ts)
}

// A server bucket's heading. The bucket key IS the bucket start (a local
// YYYY-MM-DD: the day / the week's Monday / the month's 1st), so labelling is
// a parse + the shared relative-label rules; '' (or an unparseable key) is the
// undated tail.
export const labelOfBucket = (key: string, gran: BucketGran): string => {
  const d = key ? toDate(key) : null
  return d ? bucketLabel(d.getTime(), gran) : 'Undated'
}
