import type { ActivityGroupBy } from '@notarium/contract'
import { STORAGE_KEYS } from '../../libs/storageKeys'
import type { ActivityScope } from './useDashboardData'

export type ActivityGroup = ActivityGroupBy | 'none'

export type ActivityScopeChrome = {
  space: string
  committed: boolean
  canScope: boolean
  scope: ActivityScope
}

const GROUPS = new Set<ActivityGroup>(['note', 'folder', 'none'])
const SCOPES = new Set<ActivityScope>(['all', 'mine'])

const read = <T extends string>(key: string, values: ReadonlySet<T>, fallback: T): T => {
  try {
    const value = localStorage.getItem(key)
    return value != null && values.has(value as T) ? (value as T) : fallback
  } catch {
    return fallback
  }
}

const write = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Browser privacy settings may refuse persistence; the live choice still works.
  }
}

export const readActivityGroup = (): ActivityGroup =>
  read(STORAGE_KEYS.dashboardActivityGroup, GROUPS, 'note')

export const readActivityScope = (): ActivityScope =>
  read(STORAGE_KEYS.dashboardActivityScope, SCOPES, 'all')

export const writeActivityGroup = (group: ActivityGroup): void =>
  write(STORAGE_KEYS.dashboardActivityGroup, group)

export const writeActivityScope = (scope: ActivityScope): void =>
  write(STORAGE_KEYS.dashboardActivityScope, scope)

/** Keep only the resolved toggle chrome while another Group establishes its own
 * standing gate. This never resolves data or a day request: those still use the
 * new feed's `gateResolved`. A Space boundary returns an unresolved sentinel;
 * callers retain every return so an A → B → A sequence cannot revive A's cache. */
export const activityScopeChrome = (
  space: string,
  gate: { resolved: boolean; canScope: boolean; scope: ActivityScope },
  previous: ActivityScopeChrome | null,
): ActivityScopeChrome =>
  gate.resolved
    ? { space, committed: true, canScope: gate.canScope, scope: gate.scope }
    : previous?.space === space
      ? previous
      : { space, committed: false, canScope: false, scope: 'all' }

/** Everyone never needs the scoped standing gate to choose its heatmap lane. In
 * particular, a Mine snapshot retained while the projection rebuilds must not
 * remain the effective view after the user explicitly chooses Everyone. */
export const effectiveActivityScope = (
  preferred: ActivityScope,
  chrome: ActivityScopeChrome,
): ActivityScope => (preferred === 'all' ? 'all' : chrome.scope)
