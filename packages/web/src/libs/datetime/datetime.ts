// Shared timestamp formatting (#158, unified in #179 — the ONE source of truth for
// date labels across the web UI). The wire carries full ISO instants; the UI
// chooses the precision:
//   - `timeAgo`      — hybrid relative/absolute for a past instant ("just now" /
//                      "5 minutes ago" / "yesterday", an absolute date once older
//                      than a week), paired with `exactDateTime` as a hover tooltip.
//   - `exactDateTime`— the precise instant (date + time), for tooltips.
//   - `absoluteDate` — the canonical absolute calendar date (no time); use it where
//                      relative is wrong (a future/expiry instant, build time) or
//                      undesired (feed cards, trash, provenance). Same format as
//                      `timeAgo`'s older-than-a-week tail.
//   - `compactDate`  — a dense absolute date for tight rows (#188, Spotlight).
// Built on the platform Intl.RelativeTimeFormat/DateTimeFormat (no dependency). Note:
// a relative label is a render-time snapshot — it does not self-tick; callers that
// want it fresh re-render (the connections list refetches on mount).

const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/

const parse = (value: string | null | undefined): Date | null => {
  if (!value) {
    return null
  }
  const calendar = CALENDAR_DAY.exec(value)

  if (calendar) {
    const year = Number(calendar[1])
    const month = Number(calendar[2]) - 1
    const day = Number(calendar[3])
    const local = new Date(year, month, day)

    return local.getFullYear() === year && local.getMonth() === month && local.getDate() === day
      ? local
      : null
  }
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

// One formatter for the module — the locale is process-stable, so there is no need
// to re-allocate it on every call.
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

// The one canonical absolute date-only shape ("Jun 25, 2026"), shared by
// `absoluteDate` and `timeAgo`'s older-than-a-week tail so they never drift.
const ABS_DATE_OPTS: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
}

/** The precise instant for a tooltip: "25 Jun 2026, 01:13". '' for empty/invalid. */
export const exactDateTime = (value: string | null | undefined): string => {
  const d = parse(value)
  return d ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''
}

/** The canonical absolute calendar date, no time: "Jun 25, 2026". Use where relative
 *  is wrong (future/expiry, build time) or undesired (feed cards, trash, provenance).
 *  '' for empty/invalid input — the caller renders its own placeholder. */
export const absoluteDate = (value: string | null | undefined): string => {
  const d = parse(value)
  return d ? d.toLocaleDateString(undefined, ABS_DATE_OPTS) : ''
}

/** A custom date field owns its authored calendar day, even when the stored scalar
 * also carries an instant suffix. Display the same YYYY-MM-DD prefix that DatePicker
 * edits instead of shifting it through the viewer's timezone. */
export const fieldDate = (value: string | null | undefined): string =>
  absoluteDate(value?.includes('T') ? value.slice(0, 10) : value)

/** Replace only the calendar-day portion of a day/instant field value. Clearing
 *  stays empty; an instant keeps its authored time/offset suffix byte-for-byte. */
export const replaceCalendarDay = (value: string, day: string): string =>
  day ? `${day}${value.includes('T') ? value.slice(10) : ''}` : ''

/** Compact calendar date for dense UI rows (#188): current-year dates stay short
 *  ("Jun 03"), older ones add the year. '' for empty/invalid. */
export const compactDate = (value: string | null | undefined, now: Date = new Date()): string => {
  const d = parse(value)

  if (!d) {
    return ''
  }

  return d.toLocaleDateString(
    undefined,
    d.getFullYear() === now.getFullYear()
      ? { month: 'short', day: '2-digit' }
      : { month: 'short', day: '2-digit', year: 'numeric' },
  )
}

/** Hybrid "time ago": relative for the recent past (just now → 6 days), an absolute
 *  date once a week old. `now` is injectable for deterministic tests. Returns '' for
 *  empty/invalid input — the caller renders its own placeholder (e.g. "—"). Buckets
 *  floor to whole units, so the label reads "idle at least N" rather than rounding up. */
export const timeAgo = (value: string | null | undefined, now: Date = new Date()): string => {
  const d = parse(value)

  if (!d) {
    return ''
  }
  const sec = Math.floor((now.getTime() - d.getTime()) / 1000)

  // Future (clock skew) or sub-minute reads as the present.
  if (sec < 60) {
    return 'just now'
  }
  const min = Math.floor(sec / 60)

  if (min < 60) {
    return rtf.format(-min, 'minute')
  }
  const hr = Math.floor(min / 60)

  if (hr < 24) {
    return rtf.format(-hr, 'hour')
  }
  const day = Math.floor(hr / 24)

  if (day < 7) {
    return rtf.format(-day, 'day')
  }

  return d.toLocaleDateString(undefined, ABS_DATE_OPTS)
}
