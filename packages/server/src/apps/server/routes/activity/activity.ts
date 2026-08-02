import type { FastifyInstance } from 'fastify'

import {
  ActivityEventsQuerySchema,
  ActivityEventsResponseSchema,
  ActivityProjectsQuerySchema,
  ActivityProjectsResponseSchema,
  ActivityQuerySchema,
  ActivityResponseSchema,
  PROJECT_STATUS,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { ACTIVITY_WEEKS, DAY_MS } from '@notarium/contract/time'
import { revisionsUnavailable } from '@notarium/core'

import { minePrincipalFilter, withAuthors } from '../../../../libs/authors'
import { type ApiRouteCtx, authz, folderOf, s } from '../_shared'
import { activityEventToWire } from '../wire'

export const activityRoutes = async (app: FastifyInstance, ctx: ApiRouteCtx) => {
  const { spaceStoreFor, projects, auth } = ctx

  // GET /activity — day-bucketed heatmap aggregate over the revision journal,
  // computed server-side. Class-scoped: agent-memory never counts. `from`/`to`
  // are half-open ISO; `tz` is minutes east (aligns day boundaries to the
  // viewer's clock). No journal (bare engine) → honest 404.
  // canon: docs/dashboard.md#activity-source-the-revision-journal-12 · docs/dashboard.md#server-side-aggregates
  app.get(s('/activity'), { config: authz('space:read', 'space') }, async (req, reply) => {
    const q = ActivityQuerySchema.safeParse(req.query)

    if (!q.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: q.error.issues[0]?.message || 'bad query' })
    }
    const store = await spaceStoreFor(req)

    if (!store.activity) {
      throw revisionsUnavailable()
    }
    const to = q.data.to ?? new Date().toISOString()
    const from = q.data.from ?? new Date(Date.parse(to) - ACTIVITY_WEEKS * 7 * DAY_MS).toISOString()
    const viewer = req.principal.username
    const author = q.data.author === 'mine' ? minePrincipalFilter(viewer) : undefined
    // On the unscoped load, also count the viewer's OWN events in the same window
    // so the client can tell whether anyone ELSE has activity (hasOtherAuthors) —
    // the gate for the mine/all toggle. Skipped when scoped, or no viewer.
    const wantsOthersSignal = !author && !!viewer
    const [days, mineDays] = await Promise.all([
      store.activity({ from, to, tzOffsetMinutes: q.data.tz, author }),
      wantsOthersSignal
        ? store.activity({
            from,
            to,
            tzOffsetMinutes: q.data.tz,
            author: minePrincipalFilter(viewer),
          })
        : Promise.resolve(null),
    ])
    const totalOf = (ds: typeof days) =>
      ds.reduce((acc, d) => acc + d.created + d.edited + d.deleted, 0)
    const hasOtherAuthors = mineDays != null && totalOf(days) > totalOf(mineDays)
    return ActivityResponseSchema.parse({
      days: days.map((d) => ({ ...d, total: d.created + d.edited + d.deleted })),
      from,
      to,
      hasOtherAuthors,
    })
  })

  // GET /activity/events — the "what changed" feed + heatmap day-drill: a window
  // over activity events, newest first, authors resolved + privacy-filtered.
  // Day-drill passes the clicked day's half-open [from,to); the standing feed
  // omits bounds (latest N).
  // canon: docs/feed-page.md#data-flow
  app.get(s('/activity/events'), { config: authz('space:read', 'space') }, async (req, reply) => {
    const q = ActivityEventsQuerySchema.safeParse(req.query)

    if (!q.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: q.error.issues[0]?.message || 'bad query' })
    }
    const store = await spaceStoreFor(req)

    if (!store.activityEvents) {
      throw revisionsUnavailable()
    }
    const author =
      q.data.author === 'mine' ? minePrincipalFilter(req.principal.username) : undefined
    const [{ items, total }, notes] = await Promise.all([
      store.activityEvents({
        from: q.data.from,
        to: q.data.to,
        offset: q.data.offset,
        limit: q.data.limit,
        author,
      }),
      store.list(),
    ])
    // Resolve each event's folder from the read-model: the journal row has no
    // filePath, so we join on the note's CURRENT folder. null when the note left
    // the live index (deleted / moved out).
    const pathByNote = new Map<string, string>()

    for (const n of notes) {
      if (n.id) {
        pathByNote.set(n.id, folderOf(n.filePath))
      }
    }
    const events = await withAuthors(
      items.map((r) => ({
        ...activityEventToWire(r),
        path: pathByNote.get(r.noteId) ?? null,
      })),
      req.principal.username,
      auth.describeAuthor,
    )
    return ActivityEventsResponseSchema.parse({ events, total })
  })

  // GET /activity/projects — rank the space's projects by recent activity
  // (per-note revision counts × each note's current folder × the project registry).
  // A note counts toward its DEEPEST containing project (disjoint buckets: a
  // sub-project note doesn't inflate the root). The ≥2 gate lives client-side;
  // the server returns the honest ranking.
  app.get(s('/activity/projects'), { config: authz('space:read', 'space') }, async (req, reply) => {
    const q = ActivityProjectsQuerySchema.safeParse(req.query)

    if (!q.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: q.error.issues[0]?.message || 'bad query' })
    }
    const store = await spaceStoreFor(req)

    if (!store.activityByNote) {
      throw revisionsUnavailable()
    }
    const space = req.spaceId
    const to = q.data.to ?? new Date().toISOString()
    const from = q.data.from ?? new Date(Date.parse(to) - 90 * DAY_MS).toISOString()
    const [perNote, notes, projRows] = await Promise.all([
      store.activityByNote({ from, to }),
      store.list(),
      projects ? projects.listForSpace(space) : Promise.resolve([]),
    ])
    const noteFolder = new Map<string, string>()

    for (const n of notes) {
      if (n.id) {
        noteFolder.set(n.id, folderOf(n.filePath))
      }
    }
    // Sorted longest-path-first, so find-first below = the deepest containing project.
    const active = projRows
      .filter((p) => p.status === PROJECT_STATUS.active)
      .sort((a, b) => b.path.length - a.path.length)
    const projectOf = (folder: string) =>
      active.find((p) => p.path === '' || folder === p.path || folder.startsWith(p.path + '/')) ??
      null
    const agg = new Map<string, { p: (typeof active)[number]; count: number; lastAt: string }>()

    for (const e of perNote) {
      const folder = noteFolder.get(e.noteId)

      if (folder == null) {
        continue
      } // not in the live index (deleted / moved out) — skip
      const proj = projectOf(folder)

      if (!proj) {
        continue
      }
      const cur = agg.get(proj.id)

      if (!cur) {
        agg.set(proj.id, { p: proj, count: e.count, lastAt: e.lastAt })
      } else {
        cur.count += e.count
        if (e.lastAt > cur.lastAt) {
          cur.lastAt = e.lastAt
        }
      }
    }
    const ranked = [...agg.values()]
      .sort((a, b) => b.count - a.count || (a.lastAt < b.lastAt ? 1 : -1))
      .slice(0, q.data.limit)
      .map((x) => ({
        id: x.p.id,
        slug: x.p.slug,
        displayName: x.p.displayName,
        path: x.p.path,
        count: x.count,
        lastAt: x.lastAt,
      }))
    return ActivityProjectsResponseSchema.parse({ projects: ranked })
  })
}
