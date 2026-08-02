import { useEffect, useRef, useState } from 'react'
import type { ActivityEvent } from '@notarium/contract'
import { EmptyState } from '../../core/EmptyState'
import { IconClock } from '../../core/Icons'
import { dayRangeUtc } from '../../libs/activity'
import { api } from '../../services/api'
import { ActivityFeed } from './ActivityFeed'
import { ActivityHeatmap } from './ActivityHeatmap'
import { TZ, useAuthorScopedActivity, useDashboardContext } from './useDashboardData'
import styles from './Dashboard.module.scss'

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
  const { space, activity, activityResolved, recent, loading, scope, openNote } =
    useDashboardContext()

  // The heatmap + standing feed under the active scope: 'all' reuses the layout
  // bundle (no extra fetch); 'mine' fetches its own server-scoped aggregate + feed.
  const scoped = useAuthorScopedActivity(space, scope, { activity, recent, loading })

  // The grid the heatmap draws is ALWAYS the current view's own data — null whenever
  // that view is still loading (cold start, a space switch, or the first 'mine' fetch),
  // so the heatmap shows its SKELETON, never another view's stale values. Because the
  // skeleton is dimensionally identical (same window), the swap to real data is a pure
  // colour settle — a brief shimmer is honest, showing the wrong numbers is not.
  const heatmapData = scoped.activity

  // The day-drill (#33): a clicked heatmap cell shows THAT day's events instead of
  // the standing latest-N feed. Its own fetch (the day's [start,end) in the user's
  // tz → UTC), carrying the SAME author scope so a "mine" day never surfaces someone
  // else's edits.
  const [day, setDay] = useState<string | null>(null)
  const [dayEvents, setDayEvents] = useState<ActivityEvent[] | null>(null)
  const dayReq = useRef(0)
  useEffect(() => {
    if (!day) {
      setDayEvents(null)
      return
    }
    const seq = ++dayReq.current
    setDayEvents(null)
    const { from, to } = dayRangeUtc(day, TZ)
    void api
      .activityEventsGet(space, {
        from,
        to,
        limit: 100,
        author: scope === 'mine' ? 'mine' : undefined,
      })
      .then((r) => {
        if (dayReq.current === seq) {
          setDayEvents(r.events)
        }
      })
      .catch(() => {
        if (dayReq.current === seq) {
          setDayEvents([])
        }
      })
  }, [day, space, scope])
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
          <ActivityFeed
            space={space}
            recent={scoped.recent}
            loading={scoped.loading}
            day={day}
            dayEvents={dayEvents}
            onClearDay={() => setDay(null)}
            onOpen={openNote}
          />
        </>
      )}
    </div>
  )
}
