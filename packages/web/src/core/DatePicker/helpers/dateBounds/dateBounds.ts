import { YEARS_PER_PAGE } from '../../consts'
import type { Bounds } from '../../types'
import { fromKey, toKey, yearsStart } from '../calendarGrid'

const boundKey = (v?: string): string | undefined => (v && fromKey(v) ? v : undefined)

export const boundsOf = (min?: string, max?: string): Bounds => {
  const lo = boundKey(min)
  const hi = boundKey(max)
  return lo && hi && lo > hi ? {} : { min: lo, max: hi }
}

export const clampKey = (key: string, bounds: Bounds): string => {
  if (bounds.min && key < bounds.min) {
    return bounds.min
  }
  if (bounds.max && key > bounds.max) {
    return bounds.max
  }

  return key
}

export const dayAllowed = (key: string, bounds: Bounds): boolean =>
  Boolean(fromKey(key)) && !(bounds.min && key < bounds.min) && !(bounds.max && key > bounds.max)

const rangeAllowed = (start: string, end: string, bounds: Bounds): boolean =>
  !(bounds.min && end < bounds.min) && !(bounds.max && start > bounds.max)

export const monthAllowed = (y: number, m: number, bounds: Bounds): boolean =>
  rangeAllowed(toKey(y, m, 1), toKey(y, m, new Date(y, m + 1, 0).getDate()), bounds)

export const yearAllowed = (y: number, bounds: Bounds): boolean =>
  rangeAllowed(toKey(y, 0, 1), toKey(y, 11, 31), bounds)

export const yearPageAllowed = (y: number, bounds: Bounds): boolean => {
  const start = yearsStart(y)
  return rangeAllowed(toKey(start, 0, 1), toKey(start + YEARS_PER_PAGE - 1, 11, 31), bounds)
}

export const canStep = (
  view: { y: number; m: number },
  mode: 'days' | 'months' | 'years',
  dir: number,
  bounds: Bounds,
): boolean => {
  if (mode === 'days') {
    const d = new Date(view.y, view.m + dir, 1)
    return monthAllowed(d.getFullYear(), d.getMonth(), bounds)
  }
  if (mode === 'months') {
    return yearAllowed(view.y + dir, bounds)
  }

  return yearPageAllowed(view.y + dir * YEARS_PER_PAGE, bounds)
}
