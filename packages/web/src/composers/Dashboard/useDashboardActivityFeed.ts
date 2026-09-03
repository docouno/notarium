import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActivityEventsResponse, ActivityGroupsResponse } from '@notarium/contract'
import { STORE_EVENT } from '@notarium/contract/events'
import { api } from '../../services/api'
import { CHANGED_COALESCE_MS, useSync } from '../SyncProvider'
import { isActivityProjectionRebuilding, requiresActivitySnapshotRecovery } from './activityErrors'
import type { ActivityGroup } from './activityPreferences'
import type { ActivityScope } from './useDashboardData'

const OVERVIEW_LIMIT = 12
/** How long a rebuild episode may pass as an ordinary load before the surface
 *  explains it. Owner decision: a short rebuild is just a skeleton. */
export const REBUILD_NOTICE_DELAY_MS = 5_000

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
  /** The scope the published data belongs to — `canScope ? preferredScope : 'all'`. */
  scope: ActivityScope
  /** The scope the slice was built FOR. Part of the slice key (with space and
   *  group), and deliberately not `scope`: a solo Space with a stored Mine publishes
   *  `scope: 'all'` forever, so an effective key would never match and the feed
   *  would skeleton for good. */
  preferredScope: ActivityScope
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

export type DashboardActivityFeed = Omit<FeedState, 'space' | 'preferredScope'> & {
  /** The current rebuild episode has outlasted `REBUILD_NOTICE_DELAY_MS`: the
   *  surface explains the skeleton with one calm status line. */
  rebuildingProlonged: boolean
  recover: (rebuilding: boolean) => void
  retry: () => void
}

const EMPTY: FeedState = {
  space: null,
  group: 'note',
  scope: 'all',
  preferredScope: 'all',
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

// The slice key. A state built for another Space, Group OR preferred scope is
// reset as a whole (invalidation and rebuild latches carry over within a Space).
// Keying the scope here is what makes a scope click honest end to end: the
// previous scope's rows can neither render under the new label nor be retained by
// the warm-failure path, and every derived gate — day, branches, heatmap — closes
// until the new slice publishes. The chrome cannot flicker in that window: an
// unresolved gate keeps the previous chrome by identity.
const sameSlice = (
  state: FeedState,
  space: string,
  group: ActivityGroup,
  preferredScope: ActivityScope,
): boolean =>
  state.space === space && state.group === group && state.preferredScope === preferredScope

// A typed rebuild is a STATE, not a failure: it never becomes error text. The
// `rebuilding` bit carries it, and the projection's own `changed` frame — emitted
// on publication and already reloading this hook — clears it. No polling: a poll
// during a rebuild would block on the projection's busy timeout and answer 500.
const failureText = (error: unknown): string | null =>
  isActivityProjectionRebuilding(error)
    ? null
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
        ...(sameSlice(current, space, group, preferredScope)
          ? current
          : { ...EMPTY, group, space, preferredScope, invalidated, rebuilding }),
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
            preferredScope,
            loading: true,
            invalidated: true,
            rebuilding,
            error: failureText(error),
          }
        }
        const invalidated = current.space === space && current.invalidated
        const warm =
          !invalidated &&
          sameSlice(current, space, group, preferredScope) &&
          current.overview != null
        const rebuilding = current.space === space && current.rebuilding

        return warm
          ? { ...current, loading: false, stale: true, error: failureText(error) }
          : {
              ...EMPTY,
              space,
              group,
              preferredScope,
              loading: invalidated,
              invalidated,
              rebuilding,
              error: failureText(error),
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
          preferredScope,
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
        error = failureText(mine?.error)
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
            error = failureText(mineError)
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
        preferredScope,
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
        sameSlice(current, space, group, preferredScope) &&
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
        preferredScope,
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

  const current = sameSlice(state, space, group, preferredScope)
    ? state
    : {
        ...EMPTY,
        group,
        preferredScope,
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
        preferredScope,
        loading: true,
        invalidated: true,
        rebuilding,
        error: null,
      })
      void load()
    },
    [group, load, preferredScope, space],
  )

  // The rebuild threshold belongs to the EPISODE, not to a request. The bit stays
  // true across coalesced `changed` reloads and Group changes within a Space (the
  // slice resets carry it) and clears only when a slice publishes, so the timer is
  // armed once per false → true edge and never re-armed by a reload. It lives here
  // rather than in the surface because this hook is owned by the layout and
  // survives every pill switch, while the Activity surface unmounts on each one.
  const { rebuilding } = current
  const [prolonged, setProlonged] = useState(false)

  useEffect(() => {
    if (!rebuilding) {
      setProlonged(false)
      return
    }
    const timer = setTimeout(() => setProlonged(true), REBUILD_NOTICE_DELAY_MS)

    return () => clearTimeout(timer)
  }, [rebuilding])

  return {
    ...current,
    // Derived from the bit, not merely latched by the timer, so the episode ends in
    // the very commit that publishes rows instead of one passive-effect frame later.
    // Whether the line is SHOWN is the surface's call, not this hook's: the rebuild
    // latch survives an ordinary failure of the next reload, and only the surface
    // knows whether that failure has a notice of its own in the lane the reader is
    // looking at.
    rebuildingProlonged: rebuilding && prolonged,
    recover,
    retry,
  }
}
