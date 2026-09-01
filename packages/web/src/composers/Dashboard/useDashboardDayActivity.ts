import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActivityEventsResponse, ActivityGroupsResponse } from '@notarium/contract'
import { dayRangeUtc } from '../../libs/activity'
import { api } from '../../services/api'
import { isActivityProjectionRebuilding, requiresActivitySnapshotRecovery } from './activityErrors'
import type { ActivityGroup } from './activityPreferences'
import type { ActivityFeedGate, ActivityOverview } from './useDashboardActivityFeed'
import type { ActivityScope } from './useDashboardData'

type DayActivityLoad = {
  identity: string
  overview: ActivityOverview | null
  error: string | null
  recovery: DayActivityRecovery | null
}

export type DayActivityRecovery = {
  requestSequence: number
  rebuilding: boolean
}

export const activityDayIdentity = (
  space: string,
  scope: ActivityScope,
  group: ActivityGroup,
  day: string,
  gate: ActivityFeedGate,
): string =>
  JSON.stringify([
    space,
    scope,
    group,
    day,
    gate.through,
    gate.activityVersion,
    gate.locationThrough,
  ])

export const useDashboardDayActivity = ({
  space,
  scope,
  group,
  day,
  gate,
  tz,
  onSnapshotRecovery,
}: {
  space: string
  scope: ActivityScope
  group: ActivityGroup
  day: string | null
  gate: ActivityFeedGate | null
  tz: number
  onSnapshotRecovery: (rebuilding: boolean) => void
}): {
  overview: ActivityOverview | null
  error: string | null
  recovery: DayActivityRecovery | null
  retry: () => void
} => {
  const identity = day && gate ? activityDayIdentity(space, scope, group, day, gate) : null
  const [loaded, setLoaded] = useState<DayActivityLoad | null>(null)
  const [attempt, setAttempt] = useState(0)
  const requestSequence = useRef(0)

  const retry = useCallback(() => {
    requestSequence.current++
    setLoaded(null)
    setAttempt((current) => current + 1)
  }, [])

  useEffect(() => {
    const sequence = ++requestSequence.current
    let cancelled = false

    if (!day || !identity) {
      return
    }
    const { from, to } = dayRangeUtc(day, tz)
    const request: Promise<ActivityOverview> =
      group === 'none'
        ? api
            .activityEventsGet(space, {
              from,
              to,
              limit: 100,
              author: scope === 'mine' ? 'mine' : undefined,
            })
            .then((response: ActivityEventsResponse) => ({ kind: 'events', response }))
        : api
            .activityGroupsGet(space, {
              by: group,
              from,
              to,
              limit: 100,
              author: scope === 'mine' ? 'mine' : undefined,
            })
            .then((response: ActivityGroupsResponse) => ({ kind: 'groups', response }))

    void request
      .then((overview) => {
        if (!cancelled && requestSequence.current === sequence) {
          setLoaded({ identity, overview, error: null, recovery: null })
        }
      })
      .catch((error) => {
        if (!cancelled && requestSequence.current === sequence) {
          const recoveryRequired = requiresActivitySnapshotRecovery(error)

          setLoaded({
            identity,
            overview: null,
            error:
              error instanceof Error ? error.message : 'Activity for this day could not be loaded',
            recovery: recoveryRequired
              ? {
                  requestSequence: sequence,
                  rebuilding: isActivityProjectionRebuilding(error),
                }
              : null,
          })
          if (recoveryRequired) {
            onSnapshotRecovery(isActivityProjectionRebuilding(error))
          }
        }
      })

    return () => {
      cancelled = true
    }
  }, [attempt, day, group, identity, onSnapshotRecovery, scope, space, tz])

  const current = loaded?.identity === identity ? loaded : null

  return {
    overview: current?.overview ?? null,
    error: current?.error ?? null,
    recovery: current?.recovery ?? null,
    retry,
  }
}
