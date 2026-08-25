import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useOutletContext } from 'react-router'
import type {
  ActivityEvent,
  ActivityProject,
  ActivityResponse,
  GraphHealth,
} from '@notarium/contract'
import { STORE_EVENT } from '@notarium/contract/events'
import { defaultActivityWindow } from '../../libs/activity'
import { parseAppPath } from '../../libs/routing/routePaths'
import type { GraphView } from '../../libs/wire'
import { api } from '../../services/api'
import { CHANGED_COALESCE_MS, useSync } from '../SyncProvider'

// The dashboard's read-model bundle (#33/#216): every surface (Activity heatmap +
// feed, the Projects list, the Health queue) plus the pill metrics read from ONE
// load, held by the DashboardLayout and shared down through the router Outlet — so
// switching pills (a route change) never refetches or flashes. Data rides the
// read-model (#60) + journal (#12): cheap snapshot reads, all refetched on the
// shared SSE `changed` stream (coalesced) so the dashboard stays live without its
// own poll.

/** East-of-UTC minutes — the viewer's tz, so a day is counted by THEIR clock. */
export const TZ = -new Date().getTimezoneOffset()
const RECENT_LIMIT = 12

export type DashData = {
  activity: ActivityResponse | null
  /** True once the activity endpoint answered (or 404'd) — distinguishes "no
   *  journal on this host" (hide the Activity surface) from "still loading". */
  activityResolved: boolean
  graph: GraphView | null
  /** Grooming health (#100 phase 5): alias-resolution metric + broken links. null when
   *  still loading OR the host can't derive it (404 → Health surface stays empty). */
  health: GraphHealth | null
  recent: ActivityEvent[]
  projects: ActivityProject[]
  /** Distinct tag count (#109) for the reference strip; null until loaded. */
  tags: number | null
  loading: boolean
}

/** What the layout hands every surface through the router Outlet: the loaded
 *  bundle plus the ambient space + the reader opener + the author lens (#218). The
 *  scope lives in the LAYOUT (its toggle sits in the shared reference-strip row, next
 *  to notes·tags·links) so the Activity surface just consumes the effective value —
 *  already forced to 'all' off a solo space where the toggle isn't shown. */
export type DashboardContext = DashData & {
  space: string
  openNote: (id: string) => void
  scope: ActivityScope
}

/** A surface reads its data off the Outlet context the layout supplies. */
export const useDashboardContext = (): DashboardContext => useOutletContext<DashboardContext>()

/** The Activity surface's author lens (#218): whose activity the heatmap + feed show. */
export type ActivityScope = 'all' | 'mine'

/** The heatmap aggregate + standing feed under an author scope (#218). For the
 *  default 'all' it hands back the layout bundle's space-wide data verbatim — ZERO
 *  extra fetches, the common path. For 'mine' it fetches its OWN aggregate + feed
 *  scoped to the viewer (server-side, so per-day intensity is exact over the whole
 *  window), refetched on the same coalesced `changed` SSE the layout uses, so a live
 *  save updates the scoped view too. Stale-while-revalidate: a refetch keeps the prior
 *  scoped data visible (no heatmap flash on every save); a space switch clears it. */
type ScopedActivity = {
  activity: ActivityResponse | null
  recent: ActivityEvent[]
  loading: boolean
}
/** The scoped view while it has no data for the current space yet → the heatmap/feed
 *  skeleton. A module constant so the returned identity is stable (no needless re-render). */
const SCOPED_LOADING: ScopedActivity = { activity: null, recent: [], loading: true }

export const useAuthorScopedActivity = (
  space: string,
  scope: ActivityScope,
  base: ScopedActivity,
): ScopedActivity => {
  const { subscribe } = useSync()
  // The scoped cache is TAGGED with the space it was loaded FOR (like the layout bundle),
  // so a late resolve for a PREVIOUS space can never surface under the new one — the render
  // gate below rejects a mismatched tag → skeleton, never stale cross-space data.
  const [mine, setMine] = useState<{ space: string | null } & ScopedActivity>({
    space: null,
    ...SCOPED_LOADING,
  })
  const reqSeq = useRef(0)

  const load = useCallback(async () => {
    const seq = ++reqSeq.current
    // null = this channel FAILED (transient 5xx / drop); resolved value = its data.
    const [activity, recent] = await Promise.all([
      api.activityGet(space, { tz: TZ, author: 'mine' }).catch(() => null),
      api
        .activityEventsGet(space, { limit: RECENT_LIMIT, author: 'mine' })
        .then((r) => r.events)
        .catch(() => null),
    ])

    if (reqSeq.current !== seq) {
      return
    } // superseded by a newer scoped load (or a space switch)
    setMine((prev) => {
      // Failure handling is COLD-vs-WARM (#218). WARM (we already hold data for
      // THIS space): keep the prior snapshot — stale-but-correct beats fresh-but-wrong (never
      // overwrite a good grid with a false "0 changes" on a transient blip). COLD (no prior
      // data): fall back to an honest EMPTY response rather than null, so a first-load failure
      // never pins the heatmap in a perpetual skeleton (null reads as "still loading"). It
      // recovers on the next coalesced refetch either way.
      const warm = prev.space === space
      const activityOut = activity ??
        (warm ? prev.activity : null) ?? {
          days: [],
          hasOtherAuthors: false,
          ...defaultActivityWindow(Date.now()),
        }
      const recentOut = recent ?? (warm ? prev.recent : [])
      return { space, activity: activityOut, recent: recentOut, loading: false }
    })
  }, [space])

  // A space switch drops any retained scoped data AND invalidates any in-flight load (bump
  // reqSeq), so a slow 'mine' load for the PREVIOUS space can neither write its data into the
  // new space's cache nor flash under it (#218 review: this + the space-tag gate below).
  useEffect(() => {
    reqSeq.current += 1
    setMine({ space: null, ...SCOPED_LOADING })
  }, [space])

  // Fetch (and keep fresh) only while scoped to 'mine' — the 'all' path never pays.
  useEffect(() => {
    if (scope !== 'mine') {
      return
    }
    setMine((d) => ({ ...d, loading: true })) // keep prior data visible; just mark busy
    void load()
  }, [scope, load])
  useEffect(() => {
    if (scope !== 'mine') {
      return
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsub = subscribe((e) => {
      if (e.type !== STORE_EVENT.CHANGED) {
        return
      }
      if (timer) {
        return
      }
      timer = setTimeout(() => {
        timer = null
        void load()
      }, CHANGED_COALESCE_MS)
    })

    return () => {
      unsub()
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [scope, subscribe, load])

  if (scope !== 'mine') {
    return base
  }

  // Only surface the scoped cache when it belongs to the CURRENT space.
  return mine.space === space ? mine : SCOPED_LOADING
}

/** The blank bundle: what a space shows BEFORE its data lands — every surface reads
 *  this as "loading" and renders its skeleton. Also the reset a space switch snaps
 *  back to, so the NEW space never briefly shows the previous one's data. */
const EMPTY_DASH: DashData = {
  activity: null,
  activityResolved: false,
  graph: null,
  health: null,
  recent: [],
  projects: [],
  tags: null,
  loading: true,
}

export const useDashboardData = (space: string): DashData => {
  // The loaded bundle is TAGGED with the space it was loaded FOR. The hook then
  // DERIVES its return: current space's data when they match, else the blank bundle.
  // This is a pure render-time derivation (no reset effect, no setState-in-render) — so
  // the instant `space` changes, the return flips to blank (→ skeleton) and can NEVER
  // show the previous space's data, however the loads race. When the new space resolves,
  // `loaded.space` matches again and its data shows. A same-space refetch keeps
  // `loaded.space === space` throughout, so stale-while-revalidate stays intact.
  const [loaded, setLoaded] = useState<{
    space: string | null
    data: DashData
    /** Internal completion bit for the graph lane; `health: null` is also a valid
     *  settled capability result, so null itself cannot distinguish loading. */
    graphResolved: boolean
  }>({
    space: null,
    data: EMPTY_DASH,
    graphResolved: false,
  })
  const location = useLocation()
  const { subscribe } = useSync()
  // Journal and graph are independent freshness lanes. A shared sequence made a
  // cheap `changed` refresh supersede an already-running graph refresh; under a
  // steady write stream the expensive response was then discarded forever even
  // though no newer graph request existed. Each lane now orders only itself.
  const activityReqSeq = useRef(0)
  const graphReqSeq = useRef(0)

  const loadActivity = useCallback(async () => {
    const seq = ++activityReqSeq.current
    const [activity, recent, projects, tags] = await Promise.all([
      api.activityGet(space, { tz: TZ }).catch(() => null),
      api
        .activityEventsGet(space, { limit: RECENT_LIMIT })
        .then((r) => r.events)
        .catch(() => []),
      api
        .activityProjectsGet(space)
        .then((r) => r.projects)
        .catch(() => []),
      api
        .tagsGet(space)
        .then((r) => r.total)
        .catch(() => null),
    ])

    if (activityReqSeq.current !== seq) {
      return
    }
    setLoaded((prev) => {
      const sameSpace = prev.space === space
      const graphResolved = sameSpace && prev.graphResolved

      return {
        space,
        graphResolved,
        data: {
          activity,
          activityResolved: true,
          graph: sameSpace ? prev.data.graph : null,
          health: sameSpace ? prev.data.health : null,
          recent,
          projects,
          tags,
          loading: !graphResolved,
        },
      }
    })
  }, [space])

  const loadGraph = useCallback(async () => {
    const seq = ++graphReqSeq.current
    // graphHealth 404s on a host without the optional capability; that resolves
    // this lane honestly to an empty Health surface rather than blocking the rest.
    const [graph, health] = await Promise.all([
      api.graphGet(space).catch(() => null),
      api.graphHealthGet(space).catch(() => null),
    ])

    if (graphReqSeq.current !== seq) {
      return
    }
    setLoaded((prev) => {
      const sameSpace = prev.space === space
      const activityResolved = sameSpace && prev.data.activityResolved

      return {
        space,
        graphResolved: true,
        data: {
          activity: sameSpace ? prev.data.activity : null,
          activityResolved,
          graph,
          health,
          recent: sameSpace ? prev.data.recent : [],
          projects: sameSpace ? prev.data.projects : [],
          tags: sameSpace ? prev.data.tags : null,
          loading: !activityResolved,
        },
      }
    })
  }, [space])

  useEffect(() => {
    void loadActivity()
    void loadGraph()
  }, [loadActivity, loadGraph])

  // Freshness, coalesced (a burst of saves costs one refresh a second). Two triggers with
  // DIFFERENT reach: `changed` means notes moved, which is an Activity fact; `graph` means
  // the server finished re-enriching the map, which is the only thing that makes the graph
  // half worth re-reading. A window that saw both refetches both.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let wantActivity = false
    let wantGraph = false
    const unsub = subscribe((e) => {
      if (e.type !== STORE_EVENT.CHANGED && e.type !== STORE_EVENT.GRAPH) {
        return
      }
      if (e.type === STORE_EVENT.CHANGED) {
        wantActivity = true
      }
      if (e.type === STORE_EVENT.GRAPH) {
        wantGraph = true
      }
      if (timer) {
        return
      }
      timer = setTimeout(() => {
        timer = null
        const activity = wantActivity
        const graph = wantGraph

        wantActivity = false
        wantGraph = false
        if (activity) {
          void loadActivity()
        }
        if (graph) {
          void loadGraph()
        }
      }, CHANGED_COALESCE_MS)
    })

    return () => {
      unsub()
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [subscribe, loadActivity, loadGraph])

  // Show the loaded bundle ONLY for the space it belongs to; any other space is still
  // loading → the blank bundle (skeleton), never another space's data.
  //
  // AND only when the ambient `space` already matches the URL. On a space switch the URL
  // flips instantly but SpaceProvider's `active` (→ `space`) trails it by one post-paint
  // effect; in that single lag frame `space` is still the OLD slug and `loaded` still
  // holds the old data — without this guard the heatmap would flash the previous space's
  // grid for ~1 frame (skeleton → OLD-real → skeleton → new-real) before settling. The
  // dashboard is always at `/s/<space>`, so the URL always names the intended space; a
  // mismatch means we're mid-switch → hold the skeleton. Once `active` catches up they
  // agree again (and stay agreed in steady state, so this never adds a spurious skeleton).
  const parsed = parseAppPath(location.pathname)
  const urlSpace = 'space' in parsed ? parsed.space : null
  const inSync = urlSpace == null || urlSpace === space
  return loaded.space === space && inSync ? loaded.data : EMPTY_DASH
}
