import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActivityEventsResponse, ActivityGroupsResponse } from '@notarium/contract'
import { STORE_EVENT } from '@notarium/contract/events'
import { api } from '../../services/api'
import { CHANGED_COALESCE_MS, useSync } from '../SyncProvider'
import { isActivityProjectionRebuilding, requiresActivitySnapshotRecovery } from './activityErrors'
import type { ActivityGroup } from './activityPreferences'
import type { ActivityScope } from './useDashboardData'

const OVERVIEW_LIMIT = 12

export type ActivityOverview =
  | { kind: 'events'; response: ActivityEventsResponse }
  | { kind: 'groups'; response: ActivityGroupsResponse }

export type ActivityFeedGate = {
  through: string | null
  activityVersion: string
  locationThrough: string | null
}

type FeedState = {
  space: string | null
  group: ActivityGroup
  scope: ActivityScope
  overview: ActivityOverview | null
  gate: ActivityFeedGate | null
  gateResolved: boolean
  canScope: boolean
  loading: boolean
  invalidated: boolean
  rebuilding: boolean
  stale: boolean
  error: string | null
}

export type DashboardActivityFeed = Omit<FeedState, 'space'> & {
  recover: (rebuilding: boolean) => void
  retry: () => void
}

const EMPTY: FeedState = {
  space: null,
  group: 'note',
  scope: 'all',
  overview: null,
  gate: null,
  gateResolved: false,
  canScope: false,
  loading: true,
  invalidated: false,
  rebuilding: false,
  stale: false,
  error: null,
}

const errorText = (error: unknown): string =>
  isActivityProjectionRebuilding(error)
    ? 'Rebuilding activity summary…'
    : error instanceof Error
      ? error.message
      : 'Activity could not be loaded'

const loadOverview = async (
  space: string,
  group: ActivityGroup,
  scope: ActivityScope,
  snapshot?: { through: string; activityVersion: string; locationThrough?: string },
): Promise<ActivityOverview> => {
  if (group === 'none') {
    return {
      kind: 'events',
      response: await api.activityEventsGet(space, {
        limit: OVERVIEW_LIMIT,
        author: scope === 'mine' ? 'mine' : undefined,
        ...snapshot,
      }),
    }
  }

  return {
    kind: 'groups',
    response: await api.activityGroupsGet(space, {
      by: group,
      limit: OVERVIEW_LIMIT,
      author: scope === 'mine' ? 'mine' : undefined,
      ...snapshot,
    }),
  }
}

const snapshotOf = (overview: ActivityOverview): ActivityFeedGate | null => {
  const { through, activityVersion } = overview.response

  return through === undefined || activityVersion === undefined
    ? null
    : {
        through,
        activityVersion,
        locationThrough: overview.kind === 'groups' ? overview.response.locationThrough : null,
      }
}

const overviewMatchesGate = (overview: ActivityOverview, gate: ActivityFeedGate): boolean => {
  const snapshot = snapshotOf(overview)

  return (
    snapshot != null &&
    snapshot.through === gate.through &&
    snapshot.activityVersion === gate.activityVersion &&
    snapshot.locationThrough === gate.locationThrough
  )
}

type OverviewResult = { ok: true; overview: ActivityOverview } | { ok: false; error: unknown }

export const useDashboardActivityFeed = (
  space: string,
  group: ActivityGroup,
  preferredScope: ActivityScope,
): DashboardActivityFeed => {
  const { subscribe } = useSync()
  const sequence = useRef(0)
  const [state, setState] = useState<FeedState>(EMPTY)

  const load = useCallback(async () => {
    const seq = ++sequence.current

    setState((current) => {
      const rebuilding = current.space === space && current.rebuilding
      const invalidated = current.space === space && current.invalidated

      return {
        ...(current.space === space && current.group === group
          ? current
          : { ...EMPTY, group, space, invalidated, rebuilding }),
        loading: true,
        error: null,
      }
    })
    const allPromise = loadOverview(space, group, 'all')
    const minePromise: Promise<OverviewResult> | null =
      preferredScope === 'mine'
        ? loadOverview(space, group, 'mine').then(
            (overview): OverviewResult => ({ ok: true, overview }),
            (error): OverviewResult => ({ ok: false, error }),
          )
        : null
    let all: ActivityOverview

    try {
      all = await allPromise
    } catch (error) {
      if (sequence.current !== seq) {
        return
      }
      setState((current) => {
        if (requiresActivitySnapshotRecovery(error)) {
          const rebuilding = isActivityProjectionRebuilding(error)

          return {
            ...EMPTY,
            space,
            group,
            loading: true,
            invalidated: true,
            rebuilding,
            error: errorText(error),
          }
        }
        const invalidated = current.space === space && current.invalidated
        const warm =
          !invalidated &&
          current.space === space &&
          current.group === group &&
          current.overview != null
        const rebuilding = current.space === space && current.rebuilding

        return warm
          ? { ...current, loading: false, stale: true, error: errorText(error) }
          : {
              ...EMPTY,
              space,
              group,
              loading: invalidated,
              invalidated,
              rebuilding,
              error: errorText(error),
            }
      })
      return
    }
    if (sequence.current !== seq) {
      return
    }
    const gate = all.response.scopeGate

    if (!gate) {
      setState((current) => {
        return {
          ...EMPTY,
          space,
          group,
          loading: true,
          invalidated: true,
          rebuilding: current.space === space && current.rebuilding,
          error: 'Activity scope snapshot was not returned',
        }
      })
      return
    }
    const canScope = gate.hasOtherAuthors
    const effectiveScope: ActivityScope = canScope ? preferredScope : 'all'
    const settledGate: ActivityFeedGate = {
      through: gate.through,
      activityVersion: gate.activityVersion,
      locationThrough: all.kind === 'groups' ? all.response.locationThrough : null,
    }
    let overview: ActivityOverview | null = all
    let error: string | null = null
    let invalidated = false
    let rebuilding = false

    if (effectiveScope === 'mine') {
      const mine = await minePromise

      if (sequence.current !== seq) {
        return
      }
      if (!mine?.ok) {
        invalidated = requiresActivitySnapshotRecovery(mine?.error)
        rebuilding = isActivityProjectionRebuilding(mine?.error)
        error = errorText(mine?.error)
        overview = null
      } else {
        if (!overviewMatchesGate(mine.overview, settledGate)) {
          try {
            const refetched = await loadOverview(
              space,
              group,
              'mine',
              gate.through == null
                ? undefined
                : {
                    through: gate.through,
                    activityVersion: gate.activityVersion,
                    ...(settledGate.locationThrough
                      ? { locationThrough: settledGate.locationThrough }
                      : {}),
                  },
            )

            if (sequence.current !== seq) {
              return
            }

            if (!overviewMatchesGate(refetched, settledGate)) {
              throw new Error('Activity scope changed while aligning Mine')
            }
            overview = refetched
          } catch (mineError) {
            if (sequence.current !== seq) {
              return
            }
            invalidated = requiresActivitySnapshotRecovery(mineError)
            rebuilding = isActivityProjectionRebuilding(mineError)
            error = errorText(mineError)
            overview = null
          }
        } else {
          overview = mine.overview
        }
      }
    }
    if (sequence.current !== seq) {
      return
    }
    if (invalidated) {
      setState({
        ...EMPTY,
        space,
        group,
        loading: true,
        invalidated: true,
        rebuilding,
        error,
      })
      return
    }
    setState((current) => {
      const warmMine =
        effectiveScope === 'mine' &&
        current.space === space &&
        current.group === group &&
        current.scope === 'mine' &&
        current.overview != null &&
        overviewMatchesGate(current.overview, settledGate)
      const finalOverview = overview ?? (warmMine ? current.overview : null)
      const recoveryPending =
        current.space === space && current.invalidated && finalOverview == null

      return {
        space,
        group,
        scope: effectiveScope,
        overview: finalOverview,
        gate: settledGate,
        gateResolved: true,
        canScope,
        loading: recoveryPending,
        invalidated: recoveryPending,
        rebuilding: false,
        stale: error != null && finalOverview != null,
        error,
      }
    })
  }, [group, preferredScope, space])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = subscribe((event) => {
      if (event.type !== STORE_EVENT.CHANGED || timer) {
        return
      }
      timer = setTimeout(() => {
        timer = null
        void load()
      }, CHANGED_COALESCE_MS)
    })

    return () => {
      unsubscribe()
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [load, subscribe])

  const current =
    state.space === space && state.group === group
      ? state
      : {
          ...EMPTY,
          group,
          invalidated: state.space === space && state.invalidated,
          rebuilding: state.space === space && state.rebuilding,
        }

  const retry = useCallback(() => void load(), [load])
  const recover = useCallback(
    (rebuilding: boolean) => {
      setState({
        ...EMPTY,
        space,
        group,
        loading: true,
        invalidated: true,
        rebuilding,
        error: rebuilding ? 'Rebuilding activity summary…' : null,
      })
      void load()
    },
    [group, load, space],
  )

  return { ...current, recover, retry }
}
