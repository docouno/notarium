import { z } from 'zod'
import {
  ACTIVITY_EVENT_KIND,
  ACTIVITY_GROUP_BY,
  ACTIVITY_LOCATION_KIND,
} from '../../consts/activity'
import { enumValues } from '../../libs/enumValues'
import { AuthorSchema, RevisionUnavailableReasonSchema } from '../primitives'

/** GET /api/s/<slug>/activity query: a day-bucketed window for the heatmap.
 *  `from`/`to` are ISO instants (half-open [from, to)); both optional —
 *  headroom for "all time" / custom ranges — defaulting server-side to a
 *  trailing ~53-week window (GitHub-style). `tz` is the client's UTC offset in
 *  minutes east (JS: -getTimezoneOffset()), so a day boundary matches the
 *  user's clock, exactly like the Feed histogram. */
export const ActivityQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  tz: z.coerce.number().int().min(-840).max(840).default(0),
  /** Author scope: omitted = the whole space's activity; `'mine'` = only
   *  the viewer's own events (a GitLab-style "my contributions" lens). The filter
   *  is applied SERVER-side so per-day intensity counts are exact over the whole
   *  window, not just a loaded page. An enum (not a free username) is honest about
   *  today's only filter — a future "author=<username>" facet is an additive widen. */
  author: z.enum(['mine']).optional(),
})

/** One day of the heatmap. `date` is the local YYYY-MM-DD (under the query's
 *  `tz`). `created` = notes that first appeared through us that day; `edited` =
 *  later states (our saves, restores, detected external edits); `deleted` =
 *  delete-tombstones. `total` = created + edited + deleted + unavailable (the
 *  intensity — a gap IS activity, so a day made only of gaps still lights up). Only
 *  days with at least one counted event are present — the client lays out the
 *  full empty grid and fills these in. */
export const ActivityDaySchema = z.object({
  date: z.string(),
  created: z.number().int(),
  edited: z.number().int(),
  deleted: z.number().int(),
  /** Journal gaps (#327): counted activity that cannot be classified as created,
   *  edited or deleted without reading a withheld payload. Part of `total`. */
  unavailable: z.number().int(),
  total: z.number().int(),
})

/** The heatmap aggregate + the resolved window it covers (the client draws the
 *  grid from `from`/`to`, so an empty `days` still renders the right span). */
export const ActivityResponseSchema = z.object({
  days: z.array(ActivityDaySchema),
  from: z.string(),
  to: z.string(),
  /** Does the window hold activity by someone OTHER than the viewer? The honest
   *  gate for the "mine / everyone" toggle: it earns its place only when there's a
   *  distinction to draw. Computed server-side on the unscoped (everyone) request by
   *  comparing the ATTRIBUTED buckets against the viewer's own — a journal gap is
   *  activity that belongs to nobody, so it must not claim someone else was here
   *  (#327). Always `false` on an author-scoped request or a single-principal host
   *  (mode 'none'), where it's moot. */
  hasOtherAuthors: z.boolean(),
})

/** A display kind for an activity event, derived from the journal `kind` + the entry
 *  ROLE the writer stored on the row: `created` (`entry_role = 'origin'` — the note's
 *  first appearance through us; not "a write with no parent", which stopped meaning
 *  that once a quarantine could leave a note parentless, #327), `edited` (a later
 *  write/external edit), `restored` (a rollback),
 *  `deleted` (a tombstone), `unavailable` (a journal gap — the event happened but
 *  its state is withheld, #327). Moves are NOT here — a pure folder move keeps
 *  title/body/tags so the journal dedups it (no revision); the feed is honest
 *  about what the journal records. */
export const ActivityEventKindSchema = z.enum(enumValues(ACTIVITY_EVENT_KIND))

const ActivityVersionSchema = z.string().min(1).max(2048)
const ActivityLocationThroughSchema = z.string().min(1).max(256)
const ActivityCursorSchema = z.string().min(1).max(2048)

/** GET /api/s/<slug>/activity/events query: a window over the space's revision
 *  events, newest first. `from`/`to` (ISO, half-open) bound it — the standing
 *  "what changed" feed omits them (latest N), the heatmap's day-drill passes the
 *  clicked day's [start, end) in the user's tz (converted to UTC client-side).
 *  Windowed from day one (headroom + the day-drill paginates). */
export const ActivityEventsQuerySchema = z
  .object({
    from: z.string().optional(),
    to: z.string().optional(),
    offset: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    /** Author scope — same lens as the heatmap's `author` (see ActivityQuery).
     *  Keeps the feed + day-drill in sync with a "mine"-scoped heatmap: clicking a
     *  "mine" day must not surface someone else's edits. */
    author: z.enum(['mine']).optional(),
    noteId: z.string().min(1).optional(),
    through: z
      .string()
      .regex(/^[1-9]\d*$/)
      .optional(),
    activityVersion: ActivityVersionSchema.optional(),
    locationThrough: ActivityLocationThroughSchema.optional(),
    cursor: ActivityCursorSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.cursor && value.offset !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cursor'],
        message: 'cursor and offset are mutually exclusive',
      })
    }
    const bounded = value.from !== undefined || value.to !== undefined
    const detail = value.noteId !== undefined
    const boundedRaw = bounded && !detail

    if ((value.through === undefined) !== (value.activityVersion === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['activityVersion'],
        message: 'through and activityVersion must be supplied together',
      })
    }
    if (boundedRaw && (value.through || value.locationThrough || value.cursor)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['from'],
        message: 'bounded raw events do not accept grouped snapshot fields',
      })
    }
    if (
      detail &&
      (!value.through || !value.activityVersion || !value.locationThrough || value.offset != null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['noteId'],
        message: 'grouped detail requires through, activityVersion and locationThrough',
      })
    }
    if (!detail && !bounded && value.locationThrough) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['locationThrough'],
        message: 'standing events do not accept locationThrough',
      })
    }
    if (value.cursor && (!value.through || !value.activityVersion)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cursor'],
        message: 'cursor requires through and activityVersion',
      })
    }
  })

/** One "what changed" event: a journal revision resolved for the dashboard.
 *  `noteId` addresses the note (open it / the registry resolves a deleted one in
 *  trash); `author` is the privacy-filtered writer, null for an external
 *  state with no signer. `charsAdded`/`charsRemoved` echo the timeline's "+N −M"
 *  (null = honestly unknown). `path` is the note's CURRENT containing folder
 *  (gitlab-style feed), resolved server-side from the read-model — `''` = the
 *  space root, `null` = not in the live index (a deleted note, or one moved out).
 *  It is the note's location NOW, not at edit time: the journal keeps no historical
 *  filePath and a pure move isn't journaled, so "where it lives" is the only honest
 *  answer (the same location the note's breadcrumb shows). */
export const ActivityEventSchema = z.object({
  revisionId: z.string(),
  noteId: z.string(),
  kind: ActivityEventKindSchema,
  title: z.string(),
  path: z.string().nullable(),
  at: z.string(),
  principal: z.string().nullable(),
  author: AuthorSchema.nullable(),
  charsAdded: z.number().nullable(),
  charsRemoved: z.number().nullable(),
  /** A journal GAP — see `RevisionUnavailableReasonSchema`. */
  unavailableReason: RevisionUnavailableReasonSchema.optional(),
})

export const ActivityScopeGateSchema = z
  .object({
    hasOtherAuthors: z.boolean(),
    through: z
      .string()
      .regex(/^[1-9]\d*$/)
      .nullable(),
    activityVersion: ActivityVersionSchema,
  })
  .superRefine((value, ctx) => {
    if (value.through === null && value.hasOtherAuthors) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hasOtherAuthors'],
        message: 'an empty Activity snapshot cannot contain other authors',
      })
    }
  })

export const ActivityEventsResponseSchema = z
  .object({
    events: z.array(ActivityEventSchema),
    total: z.number(),
    through: z
      .string()
      .regex(/^[1-9]\d*$/)
      .nullable()
      .optional(),
    activityVersion: ActivityVersionSchema.optional(),
    nextCursor: ActivityCursorSchema.nullable().optional(),
    scopeGate: ActivityScopeGateSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const snapshot = value.activityVersion !== undefined

    if (
      snapshot !== (value.through !== undefined) ||
      snapshot !== (value.nextCursor !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['activityVersion'],
        message: 'standing/detail responses require through, activityVersion and nextCursor',
      })
    }
    if (
      value.scopeGate &&
      (value.scopeGate.through !== value.through ||
        value.scopeGate.activityVersion !== value.activityVersion)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scopeGate'],
        message: 'scopeGate must identify the response snapshot',
      })
    }
    if (
      snapshot &&
      value.through === null &&
      (value.events.length !== 0 ||
        value.total !== 0 ||
        value.nextCursor !== null ||
        value.scopeGate?.hasOtherAuthors === true)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['through'],
        message: 'an empty Activity snapshot cannot contain events, cursors or other authors',
      })
    }
  })

export const ActivityLocationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal(ACTIVITY_LOCATION_KIND.folder), path: z.string().min(1) }),
  z.object({ kind: z.literal(ACTIVITY_LOCATION_KIND.root) }),
  z.object({ kind: z.literal(ACTIVITY_LOCATION_KIND.unavailable) }),
])

export const ActivityGroupsQuerySchema = z
  .object({
    by: z.enum(enumValues(ACTIVITY_GROUP_BY)).default(ACTIVITY_GROUP_BY.note),
    from: z.string().optional(),
    to: z.string().optional(),
    author: z.enum(['mine']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(12),
    cursor: z.string().min(1).max(2048).optional(),
    through: z
      .string()
      .regex(/^[1-9]\d*$/)
      .optional(),
    activityVersion: ActivityVersionSchema.optional(),
    locationThrough: ActivityLocationThroughSchema.optional(),
    location: z.enum(enumValues(ACTIVITY_LOCATION_KIND)).optional(),
    path: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.location && value.by !== ACTIVITY_GROUP_BY.folder) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['location'],
        message: 'location is only valid with by=folder',
      })
    }
    if (value.location === ACTIVITY_LOCATION_KIND.folder && !value.path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['path'],
        message: 'path is required for location=folder',
      })
    }
    if (value.location !== ACTIVITY_LOCATION_KIND.folder && value.path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['path'],
        message: 'path is only valid for location=folder',
      })
    }
    if (value.cursor && (!value.through || !value.locationThrough)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cursor'],
        message: 'cursor requires through, activityVersion and locationThrough',
      })
    }
    if ((value.through === undefined) !== (value.activityVersion === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['activityVersion'],
        message: 'through and activityVersion must be supplied together',
      })
    }
    if (value.cursor && !value.activityVersion) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cursor'],
        message: 'cursor requires activityVersion',
      })
    }
    if (value.location && (!value.through || !value.activityVersion || !value.locationThrough)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['location'],
        message: 'location detail requires through, activityVersion and locationThrough',
      })
    }
  })

export const ActivityNoteGroupSchema = z.object({
  type: z.literal(ACTIVITY_GROUP_BY.note),
  noteId: z.string(),
  title: z.string(),
  location: ActivityLocationSchema,
  count: z.string().regex(/^\d+$/),
  charsAdded: z.string().regex(/^\d+$/).nullable(),
  charsRemoved: z.string().regex(/^\d+$/).nullable(),
  lastEvent: ActivityEventSchema,
})

export const ActivityFolderGroupSchema = z.object({
  type: z.literal(ACTIVITY_GROUP_BY.folder),
  location: ActivityLocationSchema,
  noteCount: z.number().int().nonnegative(),
  eventCount: z.string().regex(/^\d+$/),
  charsAdded: z.string().regex(/^\d+$/).nullable(),
  charsRemoved: z.string().regex(/^\d+$/).nullable(),
  lastAt: z.string(),
})

const ActivityGroupsResponseBaseSchema = z.object({
  total: z.number().int().nonnegative(),
  through: z
    .string()
    .regex(/^[1-9]\d*$/)
    .nullable(),
  activityVersion: ActivityVersionSchema,
  scopeGate: ActivityScopeGateSchema.optional(),
  locationThrough: ActivityLocationThroughSchema,
  nextCursor: ActivityCursorSchema.nullable(),
})

export const ActivityGroupsResponseSchema = z
  .discriminatedUnion('itemType', [
    ActivityGroupsResponseBaseSchema.extend({
      itemType: z.literal(ACTIVITY_GROUP_BY.note),
      items: z.array(ActivityNoteGroupSchema),
    }),
    ActivityGroupsResponseBaseSchema.extend({
      itemType: z.literal(ACTIVITY_GROUP_BY.folder),
      items: z.array(ActivityFolderGroupSchema),
    }),
  ])
  .superRefine((value, ctx) => {
    if (
      value.scopeGate &&
      (value.scopeGate.through !== value.through ||
        value.scopeGate.activityVersion !== value.activityVersion)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scopeGate'],
        message: 'scopeGate must identify the response snapshot',
      })
    }
    if (
      value.through === null &&
      (value.items.length !== 0 ||
        value.total !== 0 ||
        value.nextCursor !== null ||
        value.scopeGate?.hasOtherAuthors === true)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['through'],
        message: 'an empty Activity snapshot cannot contain groups, cursors or other authors',
      })
    }
  })

/** GET /api/s/<slug>/activity/projects query: rank the space's projects by recent
 *  activity. `from`/`to` (ISO) bound the window; default server-side to a
 *  trailing ~90 days ("what you've been working on lately"). `limit` caps the
 *  top-N. */
export const ActivityProjectsQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(20).default(6),
})

/** One active project: the project (a marked folder) + how many of its
 *  notes' revisions fell in the window, newest activity first. A note is counted
 *  toward its DEEPEST containing project (disjoint buckets), so a note in a
 *  sub-project doesn't also inflate the root. `lastAt` is the most recent revision
 *  in the project (full ISO). The block is shown only when ≥2 projects have
 *  activity (client gate) — on a single-project space it would be noise. */
export const ActivityProjectSchema = z.object({
  id: z.string(),
  slug: z.string(),
  displayName: z.string(),
  path: z.string(),
  count: z.number().int(),
  lastAt: z.string().nullable(),
})

export const ActivityProjectsResponseSchema = z.object({
  projects: z.array(ActivityProjectSchema),
})

export type ActivityQuery = z.infer<typeof ActivityQuerySchema>

export type ActivityDay = z.infer<typeof ActivityDaySchema>

export type ActivityResponse = z.infer<typeof ActivityResponseSchema>
export type ActivityEventsQuery = z.infer<typeof ActivityEventsQuerySchema>

export type ActivityEvent = z.infer<typeof ActivityEventSchema>

export type ActivityEventsResponse = z.infer<typeof ActivityEventsResponseSchema>

export type ActivityScopeGate = z.infer<typeof ActivityScopeGateSchema>

export type ActivityLocation = z.infer<typeof ActivityLocationSchema>

export type ActivityGroupsQuery = z.infer<typeof ActivityGroupsQuerySchema>

export type ActivityNoteGroup = z.infer<typeof ActivityNoteGroupSchema>

export type ActivityFolderGroup = z.infer<typeof ActivityFolderGroupSchema>

export type ActivityGroupsResponse = z.infer<typeof ActivityGroupsResponseSchema>

export type ActivityProjectsQuery = z.infer<typeof ActivityProjectsQuerySchema>

export type ActivityProject = z.infer<typeof ActivityProjectSchema>

export type ActivityProjectsResponse = z.infer<typeof ActivityProjectsResponseSchema>
