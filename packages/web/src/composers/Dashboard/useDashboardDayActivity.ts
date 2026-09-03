import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ActivityEventsResponse, ActivityGroupsResponse } from '@notarium/contract'
import { dayRangeUtc } from '../../libs/activity'
import { api } from '../../services/api'
import { isActivityProjectionRebuilding, requiresActivitySnapshotRecovery } from './activityErrors'
import type { ActivityGroup } from './activityPreferences'
import type { ActivityFeedGate, ActivityOverview } from './useDashboardActivityFeed'
import type { ActivityScope } from './useDashboardData'

// A loaded day carries the retention key it was fetched under, in two parts. The
// HARD part — Space, scope, Group, day, model lease, location cut and the gate
// epoch — is the identity of the data: any difference clears the day. The SOFT
// part is the gate's source cut alone: an ordinary append advances it, and that
// must refetch the day WITHOUT clearing it, or every save blanks an open drill.
// Both parts drive the fetch; only the hard part gates publication.
type DayActivityLoad = {
  slice: string
  through: string | null
  overview: ActivityOverview | null
  error: string | null
  recovery: DayActivityRecovery | null
}

export type DayActivityRecovery = {
  requestSequence: number
  rebuilding: boolean
}

export const activityDaySlice = (
  space: string,
  scope: ActivityScope,
  group: ActivityGroup,
  day: string,
  gate: Pick<ActivityFeedGate, 'activityVersion' | 'locationThrough'>,
  gateEpoch: number,
): string =>
  JSON.stringify([space, scope, group, day, gate.activityVersion, gate.locationThrough, gateEpoch])

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
  const [loaded, setLoaded] = useState<DayActivityLoad | null>(null)
  const [attempt, setAttempt] = useState(0)
  const requestSequence = useRef(0)
  // Bumped whenever the gate goes NULL — a typed rebuild/stale latch, a Space or
  // Group reset, a scope flip — and never on a drill close: the day goes null then,
  // the gate does not, and closing and reopening the same day is a cache hit.
  // Without the epoch a replacement gate that happens to carry the same cuts would
  // republish the pre-recovery day. A ref bumped in a layout effect, not state or a
  // render-phase write: StrictMode renders twice, and one commit must not read two
  // epochs. A ref is also sufficient — every bump sits between a null → non-null
  // gate transition, and the slice below is an effect dependency, so the refetch
  // cannot be missed even when the replacement gate is byte-identical.
  const gateEpoch = useRef(0)

  useLayoutEffect(() => {
    if (gate == null) {
      gateEpoch.current++
    }
  }, [gate])

  const slice =
    day && gate ? activityDaySlice(space, scope, group, day, gate, gateEpoch.current) : null
  const through = gate?.through ?? null

  const retry = useCallback(() => {
    requestSequence.current++
    setLoaded(null)
    setAttempt((current) => current + 1)
  }, [])

  useEffect(() => {
    const sequence = ++requestSequence.current
    let cancelled = false

    if (!day || !slice) {
      return
    }
    // The key is captured here, with the epoch this episode started under: a late
    // response from a request issued before a recovery stamps the OLD epoch and
    // fails retention by construction, not by the sequence guard alone.
    const stamp = { slice, through }
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
          setLoaded({ ...stamp, overview, error: null, recovery: null })
        }
      })
      .catch((error) => {
        if (!cancelled && requestSequence.current === sequence) {
          const recoveryRequired = requiresActivitySnapshotRecovery(error)

          setLoaded({
            ...stamp,
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
  }, [attempt, day, group, onSnapshotRecovery, scope, slice, space, through, tz])

  // Publication. A loaded OVERVIEW is retained across a soft advance: it stays on
  // screen while the refetch is in flight and swaps in place. A failure record is
  // published only under the exact cut it failed on, so a `through` advance returns
  // the lane to its skeleton while the refetch runs — the day has no stale channel,
  // and "keep rows and show an error" is deliberately not a state it can be in.
  const current =
    loaded != null &&
    loaded.slice === slice &&
    (loaded.overview != null || loaded.through === through)
      ? loaded
      : null

  return {
    overview: current?.overview ?? null,
    error: current?.error ?? null,
    recovery: current?.recovery ?? null,
    retry,
  }
}
