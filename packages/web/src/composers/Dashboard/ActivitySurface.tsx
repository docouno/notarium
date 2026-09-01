import { lazy, Suspense, useEffect, useState } from 'react'
import type { ActivityResponse } from '@notarium/contract'
import { EmptyState } from '../../core/EmptyState'
import { IconClock } from '../../core/Icons'
import { ActivityHeatmap } from './ActivityHeatmap'
import { TZ, useAuthorScopedActivity, useDashboardContext } from './useDashboardData'
import { useDashboardDayActivity } from './useDashboardDayActivity'
import styles from './Dashboard.module.scss'

const ActivityFeed = lazy(() =>
  import('./ActivityFeed').then((module) => ({ default: module.ActivityFeed })),
)

export const activityHeatmapSnapshot = (
  scopedActivity: ActivityResponse | null,
  allActivity: ActivityResponse | null,
  preferredScope: 'all' | 'mine',
  effectiveScope: 'all' | 'mine',
  scopeCommitted: boolean,
  canScope: boolean,
  invalidated: boolean,
): ActivityResponse | null =>
  preferredScope === 'all' ||
  (!invalidated && scopeCommitted && (!canScope || effectiveScope === preferredScope))
    ? preferredScope === 'all'
      ? allActivity
      : scopedActivity
    : null

// The default dashboard surface (#216) = the space home (`/s/<space>`): the
// activity heatmap (a journal #12 contribution graph over the trailing year) plus
// the "what changed" timeline. This is the standing landing — deliberately the
// same content #33 shipped, now framed by the pill bar. Capability-honest: a host
// without the revision journal 404s /activity, and this surface hides the heatmap
// and feed (the reference stats stay).
//
// #218 lands the author lens: a "mine / everyone" toggle (owned by the LAYOUT, in the
// reference-strip row) scopes the WHOLE surface — heatmap + standing feed + day-drill
// all follow one question, "whose activity am I looking at". The filter is server-side
// (per-day intensity exact over the full window), and the toggle only shows in a SHARED
// space; this surface just consumes the effective `scope` from context (already 'all' in
// a solo space).

export const ActivitySurface = () => {
  const {
    space,
    activity,
    activityResolved,
    loading,
    scope,
    activityScopeCommitted,
    activityCanScope,
    preferredScope,
    openNote,
    group,
    setGroup,
    feed,
  } = useDashboardContext()

  // The heatmap + standing feed under the active scope: 'all' reuses the layout
  // bundle (no extra fetch); 'mine' fetches its own server-scoped aggregate + feed.
  const scoped = useAuthorScopedActivity(space, scope, { activity, recent: [], loading })

  // The day-drill (#33): a clicked heatmap cell shows THAT day's events instead of
  // the standing latest-N feed. Its own fetch (the day's [start,end) in the user's
  // tz → UTC), carrying the SAME author scope so a "mine" day never surfaces someone
  // else's edits.
  const [day, setDay] = useState<string | null>(null)
  const dayActivity = useDashboardDayActivity({
    space,
    scope,
    group,
    day,
    gate: feed.gateResolved ? feed.gate : null,
    tz: TZ,
    onSnapshotRecovery: feed.recover,
  })

  // The grid the heatmap draws is ALWAYS the current view's own data — null whenever
  // that view is still loading or its standing/day projection lease was invalidated,
  // so the heatmap shows its SKELETON, never another view's stale values. Because the
  // skeleton is dimensionally identical (same window), the swap to real data is a pure
  // colour settle — a brief shimmer is honest, showing the wrong numbers is not.
  const heatmapData = activityHeatmapSnapshot(
    scoped.activity,
    activity,
    preferredScope,
    scope,
    activityScopeCommitted,
    activityCanScope,
    feed.invalidated || dayActivity.recovery != null,
  )
  // A space switch drops any open drill (the layout survives the switch).
  useEffect(() => setDay(null), [space])

  // Capability honesty (#12): a host WITHOUT the journal answers 404 → `activity` is
  // null AFTER it resolved. That's the only case we hide the heatmap/feed (for a real
  // empty state). While still resolving (cold start) we render them in their skeleton
  // state instead of a blank — so the surface never flashes empty → full.
  const unavailable = activityResolved && !activity

  return (
    <div className={styles.surface} data-testid="dash-surface-activity">
      {unavailable ? (
        <EmptyState
          icon={<IconClock size={22} />}
          title="Activity history isn't available on this workspace"
          hint="The revision journal records edits as they happen — start editing and your activity will appear here."
        />
      ) : (
        <>
          <ActivityHeatmap
            activity={heatmapData}
            tz={TZ}
            selected={day}
            onSelectDay={(d) => setDay((cur) => (cur === d ? null : d))}
          />
          <Suspense fallback={<div className={styles.feedEmpty} aria-hidden />}>
            <ActivityFeed
              space={space}
              overview={feed.overview}
              loading={feed.loading || !feed.gateResolved}
              error={feed.error}
              stale={feed.stale}
              onRetry={feed.retry}
              onSnapshotRecovery={feed.recover}
              group={group}
              onGroupChange={setGroup}
              scope={scope}
              day={day}
              dayOverview={dayActivity.overview}
              dayError={dayActivity.error}
              onDayRetry={dayActivity.retry}
              onClearDay={() => setDay(null)}
              onOpen={openNote}
            />
          </Suspense>
        </>
      )}
    </div>
  )
}
