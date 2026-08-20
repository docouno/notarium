import type { AgentPackageLibraryQueryInput } from '@notarium/contract'
import {
  ABILITY_SOURCE,
  AGENT_PACKAGE_LIBRARY_QUERY_MAX,
  ROLE_SCOPE,
} from '@notarium/contract/enums'
import { AGENT_PACKAGE_LIBRARY_URL_PARAMS } from '../../libs/routing/routePaths'

// The URL's filter vocabulary IS the query's — derived from the request the filters
// build, so a value the server stopped accepting cannot survive here as a third copy.
export type PackageLibrarySource = NonNullable<AgentPackageLibraryQueryInput['source']>
export type PackageLibraryHome = NonNullable<AgentPackageLibraryQueryInput['home']>
export type PackageLibraryAvailability = NonNullable<AgentPackageLibraryQueryInput['availability']>

// Exported in the order the aside offers them, so the control renders the dictionary
// rather than restating it: a filter value the URL accepts and the control does not
// offer (or the other way round) is not expressible.
export const PACKAGE_LIBRARY_SOURCES: readonly PackageLibrarySource[] = [
  ABILITY_SOURCE.owned,
  ABILITY_SOURCE.system,
  ABILITY_SOURCE.catalog,
]
export const PACKAGE_LIBRARY_HOMES: readonly PackageLibraryHome[] = [
  ROLE_SCOPE.personal,
  ROLE_SCOPE.space,
]
// "All projects" vs "a chosen set", the filter's own words for the reach — the
// listing asks about a MODE, not about the availability value itself.
export const PACKAGE_LIBRARY_AVAILABILITIES: readonly PackageLibraryAvailability[] = [
  'all',
  'selected',
]

export type PackageLibraryState = {
  q: string | null
  source: PackageLibrarySource | null
  home: PackageLibraryHome | null
  availability: PackageLibraryAvailability | null
  project: string | null
}

export type PackageLibraryPatch = Partial<PackageLibraryState>

const readEnum = <T extends string>(value: string | null, allowed: readonly T[]): T | null =>
  value && allowed.includes(value as T) ? (value as T) : null

export const readPackageLibraryState = (params: URLSearchParams): PackageLibraryState => ({
  // Bounded where the URL becomes state, not at the wire: past the limit the request
  // is not a narrower search, it is a 400 that empties a listing the URL still claims
  // to describe.
  q:
    params
      .get(AGENT_PACKAGE_LIBRARY_URL_PARAMS.q)
      ?.trim()
      .slice(0, AGENT_PACKAGE_LIBRARY_QUERY_MAX) || null,
  source: readEnum(params.get(AGENT_PACKAGE_LIBRARY_URL_PARAMS.source), PACKAGE_LIBRARY_SOURCES),
  home: readEnum(params.get(AGENT_PACKAGE_LIBRARY_URL_PARAMS.home), PACKAGE_LIBRARY_HOMES),
  availability: readEnum(
    params.get(AGENT_PACKAGE_LIBRARY_URL_PARAMS.availability),
    PACKAGE_LIBRARY_AVAILABILITIES,
  ),
  project: params.get(AGENT_PACKAGE_LIBRARY_URL_PARAMS.project)?.trim() || null,
})

/** One aside interaction produces one URL mutation and leaves neighboring state alone. */
export const patchPackageLibraryState = (
  current: URLSearchParams,
  patch: PackageLibraryPatch,
): URLSearchParams => {
  const next = new URLSearchParams(current)

  for (const [key, value] of Object.entries(patch)) {
    const param = AGENT_PACKAGE_LIBRARY_URL_PARAMS[key as keyof PackageLibraryState]
    const normalized = value?.trim()

    if (normalized) {
      next.set(param, normalized)
    } else {
      next.delete(param)
    }
  }

  return canonicalPackageLibraryParams(next)
}

/** Normalize hand-authored URLs without consuming params owned by another surface. */
export const canonicalPackageLibraryParams = (current: URLSearchParams): URLSearchParams => {
  const next = new URLSearchParams(current)
  const state = readPackageLibraryState(next)

  for (const key of Object.keys(AGENT_PACKAGE_LIBRARY_URL_PARAMS) as Array<
    keyof PackageLibraryState
  >) {
    const param = AGENT_PACKAGE_LIBRARY_URL_PARAMS[key]
    const value = state[key]

    if (value) {
      next.set(param, value)
    } else {
      next.delete(param)
    }
  }

  return next
}

export const packageLibraryQuery = (
  state: PackageLibraryState,
  cursor?: string,
): AgentPackageLibraryQueryInput => ({
  ...(state.q ? { q: state.q } : {}),
  ...(state.source ? { source: state.source } : {}),
  ...(state.home ? { home: state.home } : {}),
  ...(state.availability ? { availability: state.availability } : {}),
  ...(state.project ? { project: state.project } : {}),
  limit: 24,
  ...(cursor ? { cursor } : {}),
})

export const hasPackageLibraryFilters = (state: PackageLibraryState): boolean =>
  Object.values(state).some(Boolean)
