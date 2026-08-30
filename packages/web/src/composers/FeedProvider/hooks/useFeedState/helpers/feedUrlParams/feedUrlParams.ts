import { FEED_URL_PARAMS } from '../../../../../../libs/routing/routePaths'
import { isLocalDate } from '../../../../helpers/isLocalDate'
import type { FeedSort } from '../../../../types'

// Pure `URLSearchParams → URLSearchParams` transforms for the Feed's URL-borne
// filters (sort/tags/q/date-range/favorite). Each is fed to `setSearchParams`'s
// functional updater in useFeedState; the reactive binding (useCallback + deps)
// stays with the hook, the string surgery lives here. A transform that rejects
// its input returns the ORIGINAL `prev` (identity ⇒ react-router skips the nav).

export const setSortParam = (prev: URLSearchParams, next: FeedSort): URLSearchParams => {
  const sp = new URLSearchParams(prev)
  sp.set(FEED_URL_PARAMS.sort, next)
  return sp
}

export const toggleTagParam = (prev: URLSearchParams, tag: string): URLSearchParams => {
  const sp = new URLSearchParams(prev)
  const cur = sp.getAll(FEED_URL_PARAMS.tag)
  sp.delete(FEED_URL_PARAMS.tag)
  const next = cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag]

  for (const t of next) {
    sp.append(FEED_URL_PARAMS.tag, t)
  }

  return sp
}

export const clearTagsParam = (prev: URLSearchParams): URLSearchParams => {
  const sp = new URLSearchParams(prev)
  sp.delete(FEED_URL_PARAMS.tag)
  return sp
}

export const fieldEqParam = (key: string, value: string): string => `note.${key}:${value}`
export const fieldDayParam = (key: string, day: string): string => `note.${key}:${day}`

export const toggleFieldParam = (
  prev: URLSearchParams,
  key: string,
  value: string,
): URLSearchParams => {
  const sp = new URLSearchParams(prev)
  const expression = fieldEqParam(key, value)
  const current = sp.getAll(FEED_URL_PARAMS.field)
  sp.delete(FEED_URL_PARAMS.field)
  const next = current.includes(expression)
    ? current.filter((candidate) => candidate !== expression)
    : [...current, expression]

  for (const candidate of next) {
    sp.append(FEED_URL_PARAMS.field, candidate)
  }

  return sp
}

export const toggleFieldDayParam = (
  prev: URLSearchParams,
  key: string,
  day: string,
): URLSearchParams => {
  const sp = new URLSearchParams(prev)
  const expression = fieldDayParam(key, day)
  const current = sp.getAll(FEED_URL_PARAMS.fieldDay)

  sp.delete(FEED_URL_PARAMS.fieldDay)
  for (const candidate of current.includes(expression)
    ? current.filter((value) => value !== expression)
    : [...current, expression]) {
    sp.append(FEED_URL_PARAMS.fieldDay, candidate)
  }

  return sp
}

export const clearFieldParam = (prev: URLSearchParams, key: string): URLSearchParams => {
  const sp = new URLSearchParams(prev)
  const address = `note.${key}`

  const keep = (param: string, predicate: (value: string) => boolean) => {
    const values = sp.getAll(param).filter(predicate)
    sp.delete(param)
    for (const value of values) {
      sp.append(param, value)
    }
  }

  keep(FEED_URL_PARAMS.field, (value) => !value.startsWith(`${address}:`))
  keep(FEED_URL_PARAMS.fieldDay, (value) => !value.startsWith(`${address}:`))
  keep(FEED_URL_PARAMS.fieldAny, (value) => value !== address)
  keep(FEED_URL_PARAMS.fieldBad, (value) => value !== address)
  return sp
}

export const setQParam = (prev: URLSearchParams, next: string): URLSearchParams => {
  const sp = new URLSearchParams(prev)
  const t = next.trim()

  if (t) {
    sp.set(FEED_URL_PARAMS.q, t)
  } else {
    sp.delete(FEED_URL_PARAMS.q)
  }

  return sp
}

export const setDateFromParam = (
  prev: URLSearchParams,
  next: string,
  dateTo: string,
  sort: FeedSort,
): URLSearchParams => {
  const sp = new URLSearchParams(prev)
  const rawTo = sp.get(FEED_URL_PARAMS.to)

  if (next) {
    if (!isLocalDate(next)) {
      return prev
    }
    if (dateTo && next > dateTo) {
      return prev
    }
    sp.set(FEED_URL_PARAMS.sort, sort)
    sp.set(FEED_URL_PARAMS.from, next)
    if (rawTo && (!isLocalDate(rawTo) || rawTo < next)) {
      sp.delete(FEED_URL_PARAMS.to)
    }
  } else {
    sp.delete(FEED_URL_PARAMS.from)
  }

  return sp
}

export const setDateToParam = (
  prev: URLSearchParams,
  next: string,
  sort: FeedSort,
): URLSearchParams => {
  const sp = new URLSearchParams(prev)
  const from = sp.get(FEED_URL_PARAMS.from)

  if (next) {
    if (!isLocalDate(next)) {
      return prev
    }
    if (from && isLocalDate(from) && next < from) {
      return prev
    }
    sp.set(FEED_URL_PARAMS.sort, sort)
    sp.set(FEED_URL_PARAMS.to, next)
  } else {
    sp.delete(FEED_URL_PARAMS.to)
  }

  return sp
}

export const clearDateRangeParam = (prev: URLSearchParams): URLSearchParams => {
  const sp = new URLSearchParams(prev)
  sp.delete(FEED_URL_PARAMS.from)
  sp.delete(FEED_URL_PARAMS.to)
  return sp
}

export const clearFiltersParam = (prev: URLSearchParams): URLSearchParams => {
  const sp = new URLSearchParams(prev)
  sp.delete(FEED_URL_PARAMS.tag)
  sp.delete(FEED_URL_PARAMS.field)
  sp.delete(FEED_URL_PARAMS.fieldDay)
  sp.delete(FEED_URL_PARAMS.fieldAny)
  sp.delete(FEED_URL_PARAMS.fieldBad)
  sp.delete(FEED_URL_PARAMS.q)
  sp.delete(FEED_URL_PARAMS.from)
  sp.delete(FEED_URL_PARAMS.to)
  sp.delete(FEED_URL_PARAMS.favorite)
  return sp
}

export const setFavoriteParam = (prev: URLSearchParams, next: boolean): URLSearchParams => {
  const sp = new URLSearchParams(prev)

  if (next) {
    sp.set(FEED_URL_PARAMS.favorite, '1')
  } else {
    sp.delete(FEED_URL_PARAMS.favorite)
  }

  return sp
}
