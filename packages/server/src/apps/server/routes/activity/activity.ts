import type { FastifyInstance } from 'fastify'

import {
  ACTIVITY_GROUP_BY,
  ACTIVITY_LOCATION_KIND,
  ActivityEventsQuerySchema,
  ActivityEventsResponseSchema,
  ActivityGroupsQuerySchema,
  ActivityGroupsResponseSchema,
  ActivityProjectsQuerySchema,
  ActivityProjectsResponseSchema,
  ActivityQuerySchema,
  ActivityResponseSchema,
  PROJECT_STATUS,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { ACTIVITY_WEEKS, DAY_MS } from '@notarium/contract/time'
import { activityLocationStale, revisionsUnavailable } from '@notarium/core'
import type {
  ActivityCurrentProjection,
  ActivityFolderGroup as CoreActivityFolderGroup,
  ActivityLocation as CoreActivityLocation,
  ActivityNoteGroup as CoreActivityNoteGroup,
} from '@notarium/core'

import { minePrincipalFilter, withAuthors } from '../../../../libs/authors'
import { type ApiRouteCtx, authz, folderOf, s } from '../_shared'
import { activityEventToWire, unattributedIfGap } from '../wire'
import {
  activityCursorScope,
  decodeEventCursor,
  decodeGroupCursor,
  encodeEventCursor,
  encodeGroupCursor,
} from './helpers/cursors'

const activityPath = (location: CoreActivityLocation): string | null =>
  location.kind === ACTIVITY_LOCATION_KIND.folder
    ? location.path
    : location.kind === ACTIVITY_LOCATION_KIND.root
      ? ''
      : null

const projectionFromNotes = async (
  store: Awaited<ReturnType<ApiRouteCtx['spaceStoreFor']>>,
): Promise<ActivityCurrentProjection> => {
  if (store.activityProjection) {
    return store.activityProjection()
  }
  const notes = await store.list()
  const projected = new Map<
    string,
    {
      noteId: string
      title: string
      location: { kind: 'folder'; path: string } | { kind: 'root' }
    }
  >()

  for (const note of notes) {
    if (!note.id) {
      continue
    }
    const path = folderOf(note.filePath)
    projected.set(note.id, {
      noteId: note.id,
      title: note.title,
      location: path ? { kind: 'folder', path } : { kind: 'root' },
    })
  }

  return { notes: projected, locationThrough: 'legacy' }
}

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
    const viewer = req.principal.userId
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
    // Gaps count as activity (they ARE activity) but never as anyone's: they
    // carry no principal, so the mine/everyone comparison uses the attributed
    // buckets only — a gap alone must not claim "someone else was here".
    const attributedOf = (ds: typeof days) =>
      ds.reduce((acc, d) => acc + d.created + d.edited + d.deleted, 0)
    const hasOtherAuthors = mineDays != null && attributedOf(days) > attributedOf(mineDays)
    return ActivityResponseSchema.parse({
      days: days.map((d) => ({
        ...d,
        total: d.created + d.edited + d.deleted + d.unavailable,
      })),
      from,
      to,
      hasOtherAuthors,
    })
  })

  app.get(s('/activity/groups'), { config: authz('space:read', 'space') }, async (req, reply) => {
    const q = ActivityGroupsQuerySchema.safeParse(req.query)

    if (!q.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: q.error.issues[0]?.message || 'bad query' })
    }
    const store = await spaceStoreFor(req)

    if (!store.activityGroups) {
      throw revisionsUnavailable()
    }
    const viewer = req.principal.userId
    const author = q.data.author === 'mine' ? minePrincipalFilter(viewer) : undefined
    const viewerAuthor =
      !author && !q.data.from && !q.data.to ? minePrincipalFilter(viewer) : undefined
    const scope = activityCursorScope({
      by: q.data.by,
      from: q.data.from,
      to: q.data.to,
      author: q.data.author,
      location: q.data.location,
      path: q.data.path,
    })
    let cursor

    try {
      cursor = q.data.cursor
        ? decodeGroupCursor(q.data.cursor, {
            through: q.data.through!,
            activityVersion: q.data.activityVersion!,
            locationThrough: q.data.locationThrough!,
            scope,
          })
        : undefined
    } catch (error) {
      return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: (error as Error).message })
    }
    const location: CoreActivityLocation | undefined =
      q.data.location === ACTIVITY_LOCATION_KIND.folder
        ? { kind: 'folder', path: q.data.path! }
        : q.data.location === ACTIVITY_LOCATION_KIND.root
          ? { kind: 'root' }
          : q.data.location === ACTIVITY_LOCATION_KIND.unavailable
            ? { kind: 'unavailable' }
            : undefined
    const result = await store.activityGroups({
      by: q.data.by,
      from: q.data.from,
      to: q.data.to,
      limit: q.data.limit,
      cursor,
      through: q.data.through,
      activityVersion: q.data.activityVersion,
      locationThrough: q.data.locationThrough,
      location,
      author,
      viewerAuthor,
    })
    const nextCursor =
      result.nextCursor && result.through
        ? encodeGroupCursor(
            result.nextCursor,
            result.through,
            result.activityVersion,
            result.locationThrough,
            scope,
          )
        : null
    const common = {
      total: result.total,
      through: result.through,
      activityVersion: result.activityVersion,
      ...(result.scopeGate ? { scopeGate: result.scopeGate } : {}),
      locationThrough: result.locationThrough,
      nextCursor,
    }

    if (result.itemType === ACTIVITY_GROUP_BY.folder) {
      const items = (result.items as CoreActivityFolderGroup[]).map((group) => ({
        type: group.type,
        location: group.location,
        noteCount: group.noteCount,
        eventCount: group.eventCount,
        charsAdded: group.charsAdded,
        charsRemoved: group.charsRemoved,
        lastAt: group.lastAt,
      }))
      return ActivityGroupsResponseSchema.parse({
        itemType: ACTIVITY_GROUP_BY.folder,
        items,
        ...common,
      })
    }
    const notes = result.items as CoreActivityNoteGroup[]
    const events = await withAuthors(
      notes.map((note) => ({
        ...activityEventToWire(note.lastEvent),
        path: activityPath(note.location),
      })),
      viewer,
      auth.describeAuthor,
    )
    const items = notes.map((note, index) => ({
      type: ACTIVITY_GROUP_BY.note,
      noteId: note.noteId,
      title: note.title,
      location: note.location,
      count: note.count,
      charsAdded: note.charsAdded,
      charsRemoved: note.charsRemoved,
      lastEvent: unattributedIfGap(events[index]!),
    }))

    return ActivityGroupsResponseSchema.parse({
      itemType: ACTIVITY_GROUP_BY.note,
      items,
      ...common,
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
    const author = q.data.author === 'mine' ? minePrincipalFilter(req.principal.userId) : undefined
    const scope = activityCursorScope({
      from: q.data.from,
      to: q.data.to,
      author: q.data.author,
      noteId: q.data.noteId,
    })
    let afterId: string | undefined
    let through = q.data.through
    let activityVersion = q.data.activityVersion

    try {
      if (q.data.cursor) {
        const decoded = decodeEventCursor(q.data.cursor, {
          through,
          activityVersion,
          scope,
          locationThrough: q.data.locationThrough,
        })
        afterId = decoded.afterId
        through = decoded.through
        activityVersion = decoded.activityVersion
      }
    } catch (error) {
      return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: (error as Error).message })
    }
    const viewerAuthor =
      !author && !q.data.from && !q.data.to && !q.data.noteId
        ? minePrincipalFilter(req.principal.userId)
        : undefined
    const projection = await projectionFromNotes(store)

    if (q.data.locationThrough != null && q.data.locationThrough !== projection.locationThrough) {
      throw activityLocationStale()
    }
    const result = await store.activityEvents({
      from: q.data.from,
      to: q.data.to,
      offset: q.data.offset ?? 0,
      limit: q.data.limit,
      author,
      viewerAuthor,
      noteId: q.data.noteId,
      through,
      activityVersion,
      afterId,
    })

    if (q.data.locationThrough != null) {
      const settled = await projectionFromNotes(store)

      if (settled.locationThrough !== projection.locationThrough) {
        throw activityLocationStale()
      }
    }
    // Resolve each event's folder from the read-model: the journal row has no
    // filePath, so we join on the note's CURRENT folder. null when the note left
    // the live index (deleted / moved out).
    const pathByNote = new Map<string, string>()

    for (const note of projection.notes.values()) {
      pathByNote.set(note.noteId, activityPath(note.location) ?? '')
    }
    const events = (
      await withAuthors(
        result.items.map((r) => ({
          ...activityEventToWire(r),
          path: r.unavailableReason ? null : (pathByNote.get(r.noteId) ?? null),
        })),
        req.principal.userId,
        auth.describeAuthor,
      )
    ).map(unattributedIfGap)
    const snapshot =
      result.activityVersion === undefined
        ? {}
        : {
            through: result.through,
            activityVersion: result.activityVersion,
            nextCursor:
              result.nextAfterId && result.through
                ? encodeEventCursor(
                    result.nextAfterId,
                    result.through,
                    result.activityVersion,
                    scope,
                    q.data.locationThrough,
                  )
                : null,
            ...(result.scopeGate ? { scopeGate: result.scopeGate } : {}),
          }

    return ActivityEventsResponseSchema.parse({
      events,
      total: result.total,
      ...snapshot,
    })
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
