import { MONTHS, YEARS_PER_PAGE } from '../../consts'

const pad = (n: number) => String(n).padStart(2, '0')

export const toKey = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`

export const fromKey = (v: string): { y: number; m: number; d: number } | null => {
  const [y, m, d] = v.split('-').map(Number)

  if (!y || !m || !d || Number.isNaN(y + m + d)) {
    return null
  }
  // Range-guard so an out-of-spec key (a future/external caller, not the controlled
  // isoToDateInput) can't make displayLabel read MONTHS[12] === undefined and crash
  // the trigger render. Day is bounded to the real length of that month.
  if (m < 1 || m > 12 || d < 1 || d > new Date(y, m, 0).getDate()) {
    return null
  }

  return { y, m: m - 1, d }
}

export const yearsStart = (y: number) => Math.floor(y / YEARS_PER_PAGE) * YEARS_PER_PAGE
export const daysInMonthOf = (y: number, m: number) => new Date(y, m + 1, 0).getDate()

/** The label the trigger shows: a parsed value as `3 Nov 2024`, else the placeholder. */
export const displayLabel = (value: string): string | null => {
  const p = fromKey(value)

  if (!p) {
    return null
  }

  return `${p.d} ${MONTHS[p.m].slice(0, 3)} ${p.y}`
}

// Monday-based weekday index (the app's week starts Monday — listing buckets too).
export const mondayIndex = (jsDay: number) => (jsDay + 6) % 7

// The 6×7 day grid: lead with the trailing days of the previous month so the 1st sits
// under its real weekday, then fill 42 cells (always 6 rows — no layout jump).
export const dayCells = (view: {
  y: number
  m: number
}): Array<{ y: number; m: number; d: number; inMonth: boolean }> => {
  const firstDow = mondayIndex(new Date(view.y, view.m, 1).getDay())
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate()
  return Array.from({ length: 42 }, (_, i) => {
    const dayNum = i - firstDow + 1
    const date = new Date(view.y, view.m, dayNum)
    return {
      y: date.getFullYear(),
      m: date.getMonth(),
      d: date.getDate(),
      inMonth: dayNum >= 1 && dayNum <= daysInMonth,
    }
  })
}
