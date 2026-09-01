import type {
  ActivityEventsResponse,
  ActivityGroupBy,
  ActivityGroupsResponse,
  ActivityLocationKind,
  ActivityProjectsResponse,
  ActivityResponse,
  GraphHealth,
  GraphResponse as WireGraph,
} from '@notarium/contract'
import { QUERY_KEY } from '@notarium/contract/query'
import { graphView } from '../../libs/wire'
import { req, sp } from './client'

export const graphApi = {
  graphGet: (space: string) => req<WireGraph>(`${sp(space)}/graph`).then(graphView),
  /** Grooming health (#100 phase 5): the count of wikilink edges resolving through a
   *  former name + the broken (ghost) links. Wire == domain (camelCase), no mapper —
   *  same as the activity aggregate. 404 on a host that can't derive it. */
  graphHealthGet: (space: string) => req<GraphHealth>(`${sp(space)}/graph/health`),
  /** The dashboard Activity heatmap aggregate (#33): day-bucketed revision counts
   *  over a window (defaults server-side to a trailing ~53 weeks). `tz` defaults
   *  to the browser's offset (minutes east) so day boundaries match the clock —
   *  same convention as the Feed histogram. Wire == domain (camelCase), no mapper. */
  activityGet: (
    space: string,
    params: { from?: string; to?: string; tz?: number; author?: 'mine' } = {},
  ) => {
    const q = new URLSearchParams()

    if (params.from) {
      q.set(QUERY_KEY.from, params.from)
    }
    if (params.to) {
      q.set(QUERY_KEY.to, params.to)
    }
    q.set(QUERY_KEY.tz, String(params.tz ?? -new Date().getTimezoneOffset()))
    // Author scope (#218): omit = whole space, 'mine' = only the viewer's events.
    if (params.author) {
      q.set(QUERY_KEY.author, params.author)
    }

    return req<ActivityResponse>(`${sp(space)}/activity?${q.toString()}`)
  },
  /** The "what changed" feed + heatmap day-drill (#33): a window over the space's
   *  activity events, newest first. `from`/`to` (ISO, half-open) bound the day-drill;
   *  the standing feed omits them (latest N). */
  activityEventsGet: (
    space: string,
    params: {
      from?: string
      to?: string
      offset?: number
      limit?: number
      author?: 'mine'
      noteId?: string
      through?: string
      activityVersion?: string
      locationThrough?: string
      cursor?: string
    } = {},
  ) => {
    const q = new URLSearchParams()

    if (params.from) {
      q.set(QUERY_KEY.from, params.from)
    }
    if (params.to) {
      q.set(QUERY_KEY.to, params.to)
    }
    if (params.offset !== undefined) {
      q.set(QUERY_KEY.offset, String(params.offset))
    }
    if (params.limit !== undefined) {
      q.set(QUERY_KEY.limit, String(params.limit))
    }
    // Author scope (#218): keeps the feed + day-drill in sync with a 'mine' heatmap.
    if (params.author) {
      q.set(QUERY_KEY.author, params.author)
    }
    if (params.noteId) {
      q.set(QUERY_KEY.noteId, params.noteId)
    }
    if (params.through) {
      q.set(QUERY_KEY.through, params.through)
    }
    if (params.activityVersion) {
      q.set(QUERY_KEY.activityVersion, params.activityVersion)
    }
    if (params.locationThrough) {
      q.set(QUERY_KEY.locationThrough, params.locationThrough)
    }
    if (params.cursor) {
      q.set(QUERY_KEY.cursor, params.cursor)
    }
    const s = q.toString()
    return req<ActivityEventsResponse>(`${sp(space)}/activity/events${s ? `?${s}` : ''}`)
  },
  activityGroupsGet: (
    space: string,
    params: {
      by: ActivityGroupBy
      from?: string
      to?: string
      author?: 'mine'
      limit?: number
      cursor?: string
      through?: string
      activityVersion?: string
      locationThrough?: string
      location?: ActivityLocationKind
      path?: string
    },
  ) => {
    const q = new URLSearchParams([[QUERY_KEY.by, params.by]])

    if (params.from) {
      q.set(QUERY_KEY.from, params.from)
    }
    if (params.to) {
      q.set(QUERY_KEY.to, params.to)
    }
    if (params.author) {
      q.set(QUERY_KEY.author, params.author)
    }
    if (params.limit !== undefined) {
      q.set(QUERY_KEY.limit, String(params.limit))
    }
    if (params.cursor) {
      q.set(QUERY_KEY.cursor, params.cursor)
    }
    if (params.through) {
      q.set(QUERY_KEY.through, params.through)
    }
    if (params.activityVersion) {
      q.set(QUERY_KEY.activityVersion, params.activityVersion)
    }
    if (params.locationThrough) {
      q.set(QUERY_KEY.locationThrough, params.locationThrough)
    }
    if (params.location) {
      q.set(QUERY_KEY.location, params.location)
    }
    if (params.path) {
      q.set(QUERY_KEY.path, params.path)
    }

    return req<ActivityGroupsResponse>(`${sp(space)}/activity/groups?${q.toString()}`)
  },
  /** Projects ranked by recent activity (#33) — the dashboard shows the block only
   *  when ≥2 come back (gate). Server defaults the window to ~90 days. */
  activityProjectsGet: (space: string, params: { limit?: number } = {}) => {
    const q = new URLSearchParams()

    if (params.limit !== undefined) {
      q.set(QUERY_KEY.limit, String(params.limit))
    }
    const s = q.toString()
    return req<ActivityProjectsResponse>(`${sp(space)}/activity/projects${s ? `?${s}` : ''}`)
  },
}
