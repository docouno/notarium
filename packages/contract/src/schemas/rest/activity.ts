import { z } from 'zod'
import { ACTIVITY_EVENT_KIND } from '../../consts/activity'
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

/** GET /api/s/<slug>/activity/events query: a window over the space's revision
 *  events, newest first. `from`/`to` (ISO, half-open) bound it — the standing
 *  "what changed" feed omits them (latest N), the heatmap's day-drill passes the
 *  clicked day's [start, end) in the user's tz (converted to UTC client-side).
 *  Windowed from day one (headroom + the day-drill paginates). */
export const ActivityEventsQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Author scope — same lens as the heatmap's `author` (see ActivityQuery).
   *  Keeps the feed + day-drill in sync with a "mine"-scoped heatmap: clicking a
   *  "mine" day must not surface someone else's edits. */
  author: z.enum(['mine']).optional(),
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

export const ActivityEventsResponseSchema = z.object({
  events: z.array(ActivityEventSchema),
  total: z.number(),
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

export type ActivityProjectsQuery = z.infer<typeof ActivityProjectsQuerySchema>

export type ActivityProject = z.infer<typeof ActivityProjectSchema>

export type ActivityProjectsResponse = z.infer<typeof ActivityProjectsResponseSchema>
