import { z } from 'zod'
import {
  FIELD_FACET_DEFAULT_LIMIT,
  FIELD_FACET_MAX_VALUES,
  FIELD_SCHEMA_MAX_FIELDS,
  PROJECTED_FIELD_KEYS,
} from '../../consts/fields'
import { BUCKET_GRAN, DATE_FIELD, DEPTH, NOTE_SORT, SORT_DIR } from '../../consts/notes'
import { enumValues } from '../../libs/enumValues'
import {
  DurableScalarSchema,
  IsoTimestampSchema,
  NoteClassSchema,
  prototypeSafeRecord,
} from '../primitives'

export const PreviewSchema = z.object({
  snippet: z.string(),
  image: z.string().nullable(),
  tags: z.array(z.string()),
  words: z.number(),
  /** A model-agnostic token estimate of the note body: server-derived (it
   *  has the body) via the shared estimateTokens heuristic — the client never
   *  estimates, it renders this number. */
  tokens: z.number(),
})

export const ViewSummarySchema = z.object({
  text: z.string(),
  status: z.enum(['ready', 'unavailable']),
})

/** One note as the flat list reports it. `createdAt`/`modifiedAt` are null when
 *  the engine honestly doesn't know (the Feed then falls back created→modified).
 *  `preview` rides along only under `?preview=1` — the warm cached preview or
 *  null; cold ones the client batches via POST /api/previews. */
export const NoteListItemSchema = z.object({
  /** The note-id: the identity every client reference (URLs, caches, graph
   *  nodes, preview batches) keys on. canon: docs/architecture.md#p7 */
  id: z.string(),
  title: z.string(),
  /** Storage-view field: where the note lives as a file. Identity for the Files
   *  browse surface, never a note reference. canon: docs/contract.md#wire-v2 */
  filePath: z.string(),
  /** The editable display slug: the client builds `/n/<id>/<slug>` from it.
   *  Absent when the note has no custom slug. Choosing WHICH note a `[[my-slug]]`
   *  names is the server's — the client sends human references to `noteResolve`. */
  slug: z.string().optional(),
  /** Alias-history returned with note metadata. Human resolution runs server-side
   *  over the whole space, never against this list window. */
  aliases: z.array(z.string()).optional(),
  /** Last content change. Precise for everything that happened on this
   *  server's watch (journal is the source); day precision (midnight UTC)
   *  when only the engine's inventory date is known. */
  modifiedAt: IsoTimestampSchema,
  createdAt: IsoTimestampSchema,
  /** The note's class: a READ-ONLY label a surface reads to tag a row (e.g.
   *  agent-memory), never to filter — hidden classes are already excluded from
   *  this window server-side.
   *  canon: docs/architecture.md#p11 · docs/note-model.md#note-classes */
  class: NoteClassSchema.optional(),
  /** Authored note type projected for compact card metadata. Absent when the
   * default is implicit or the snapshot cannot prove it. */
  noteType: DurableScalarSchema.optional(),
  /** Dedicated discovery marker, independent of the capped authored-field blob. */
  viewType: DurableScalarSchema.optional(),
  /** Primary-view summary requested only for marker-bearing Feed rows. */
  viewSummary: ViewSummarySchema.optional(),
  /** Values requested for card presentation. This compact map deliberately omits
   * the index blob's unreadable/truncation bookkeeping. */
  fields: prototypeSafeRecord(z.union([z.string(), z.array(z.string())])).optional(),
  preview: PreviewSchema.nullable().optional(),
})

/** One note's authored frontmatter as the index carries it — the wire's own reading
 *  of the fields blob. Author keys sit one level down so they can never collide with
 *  the fixed members; empty name lists and zero counters never ride, because the
 *  serialized blob is compared as a STRING to decide whether a row changed.
 *  The nested maps use the prototype-safe record parser: an authored own
 *  `__proto__` stays data instead of mutating a prototype or disappearing.
 *  canon: docs/architecture.md#literals */
export const NoteFieldsWireSchema = z
  .object({
    keys: prototypeSafeRecord(z.union([z.string(), z.array(z.string())])),
    unreadable: z.array(z.string()).min(1).optional(),
    unreadableMore: z.number().int().positive().optional(),
    truncated: z.array(z.string()).min(1).optional(),
    truncatedMore: z.number().int().positive().optional(),
  })
  // Build a response shape on top of this one with `.extend()`: `.merge()` takes the
  // unknown-key policy from its ARGUMENT and hands back a copy that STRIPS unknown
  // members instead of refusing them. test/enumDrift.test.ts derives the note-detail
  // shape the way V06 will and requires the refusal, so this is a gate, not advice.
  .strict()

/** How a notes window is ordered. `created`/`modified` are newest-first and
 *  mirror the Feed's two date signals (`created` hides notes whose createdAt
 *  the engine honestly doesn't know — they only surface under `modified`);
 *  `title` is A→Z for tree/browse listings. */
export const NoteSortSchema = z.enum(enumValues(NOTE_SORT))

/** Direction of a list-layer sort axis. Omitted keeps the field's historical
 *  natural direction: title ascending, date axes descending. */
export const SortDirSchema = z.enum(enumValues(SORT_DIR))

/** A folder filter set on the wire, the folder facet of the app's one
 *  inclusion filter language: nothing selected = all; each entry ADDS its subtree
 *  (prefix-match), OR across the set, composing with `folder`. Arrives as a repeated
 *  query key (`folders=a&folders=b`) — one key parses to a bare string, many to an
 *  array, so the preprocess normalises both. The cap is a DoS/URL guard, not a real
 *  limit. canon: docs/contract.md#filters */
const FolderSet = z.preprocess(
  (v) => (v == null ? undefined : Array.isArray(v) ? v : [v]),
  z.array(z.string()).max(1000).optional(),
)

/** A tag filter set: same wire shape and inclusion model as FolderSet, but each
 *  tag matches case-insensitively AND hierarchically — a query tag `ml` also
 *  matches `ml/nlp` (subtree-prefix, mirroring the folder cascade). */
const TagSet = z.preprocess(
  (v) => (v == null ? undefined : Array.isArray(v) ? v : [v]),
  z.array(z.string()).max(100).optional(),
)

type FieldCondition =
  | { kind: 'eq'; value: string }
  | { kind: 'day'; value: string }
  | { kind: 'present' }
  | { kind: 'unreadable' }

type ParsedFieldAddress = { ns: 'note'; key: string; condition: FieldCondition }
type FieldQueryKind = FieldCondition['kind']

export const FieldConditionV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('eq'), value: DurableScalarSchema }),
  z.object({ kind: z.literal('day'), value: DurableScalarSchema }),
  z.object({ kind: z.literal('present') }),
  z.object({ kind: z.literal('unreadable') }),
])

export const FieldClauseV1Schema = z
  .object({
    op: z.literal('or'),
    ns: z.literal('note'),
    key: DurableScalarSchema,
    values: z.array(FieldConditionV1Schema).min(1).max(128),
  })
  .strict()

export const FieldFilterAstV1Schema = z
  .object({
    op: z.literal('and'),
    nodes: z.array(FieldClauseV1Schema).max(128),
  })
  .strict()

const projectedFieldKeys = new Set<string>(PROJECTED_FIELD_KEYS)

const isLocalDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))

  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

const projectedFieldMessage = (key: string): string => {
  if (key === 'tags') {
    return 'field key "tags" uses the tags query axis (?tags=)'
  }
  if (key === 'created') {
    return 'field key "created" uses the date query axis (?from= and ?to=)'
  }
  if (key === 'notarium-source') {
    return 'field key "notarium-source" is import provenance and is not addressable here'
  }
  if (key === 'notarium-id' || key === 'notarium-created') {
    return `storage-owned field key "${key}" is not addressable here`
  }

  return `field key "${key}" is projected onto note metadata and is not addressable here`
}

const parseFieldAddress = (
  raw: string,
  kind: FieldQueryKind,
): ParsedFieldAddress | { error: string } => {
  const dot = raw.indexOf('.')

  if (dot <= 0) {
    return { error: 'field address requires a namespace, for example note.status' }
  }
  const namespace = raw.slice(0, dot)

  if (namespace === 'file') {
    return { error: 'field namespace "file" is reserved and is not supported in v1' }
  }
  if (namespace !== 'note') {
    return { error: 'unsupported field namespace; only "note" is supported' }
  }
  const address = raw.slice(dot + 1)
  const carriesValue = kind === 'eq' || kind === 'day'
  const colon = carriesValue ? address.indexOf(':') : -1

  if (carriesValue && colon < 0) {
    return {
      error:
        kind === 'day'
          ? 'field day must be <namespace>.<key>:YYYY-MM-DD'
          : 'field equality must be <namespace>.<key>:<value>',
    }
  }
  const key = carriesValue ? address.slice(0, colon) : address

  if (!key) {
    return { error: 'field key must not be empty' }
  }
  if (key === 'view' && kind !== 'eq' && kind !== 'present') {
    return { error: 'note.view supports equality and presence filters only' }
  }
  if (projectedFieldKeys.has(key) && key !== 'view') {
    return { error: projectedFieldMessage(key) }
  }
  if (!carriesValue) {
    return { ns: 'note', key, condition: { kind } }
  }
  const value = address.slice(colon + 1)

  if (kind === 'day' && !isLocalDate(value)) {
    return { error: 'field day requires a valid YYYY-MM-DD calendar date' }
  }

  return { ns: 'note', key, condition: { kind, value } }
}

const fieldSet = (kind: FieldQueryKind) => {
  const item = z.string().superRefine((value, ctx) => {
    const parsed = parseFieldAddress(value, kind)

    if ('error' in parsed) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: parsed.error })
    }
  })

  return z.preprocess(
    (value) => (value == null ? undefined : Array.isArray(value) ? value : [value]),
    z.array(item).max(100).optional(),
  )
}

export const fieldFilterQueryFields = {
  field: fieldSet('eq').describe('repeatable note.<key>:<value> equality filters'),
  fieldDay: fieldSet('day').describe('repeatable declared-date note.<key>:YYYY-MM-DD filters'),
  fieldAny: fieldSet('present').describe('repeatable note.<key> presence filters'),
  fieldBad: fieldSet('unreadable').describe('repeatable note.<key> unreadable-value filters'),
}

type FieldFilterQuery = {
  field?: string[]
  fieldDay?: string[]
  fieldAny?: string[]
  fieldBad?: string[]
}

export const parseFieldFilter = (query: FieldFilterQuery) => {
  const nodes = new Map<string, { op: 'or'; ns: 'note'; key: string; values: FieldCondition[] }>()

  const append = (raw: string, kind: FieldQueryKind) => {
    const parsed = parseFieldAddress(raw, kind)

    if ('error' in parsed) {
      throw new Error(parsed.error)
    }
    const id = `${parsed.ns}\u0000${parsed.key}`
    const clause = nodes.get(id)

    if (clause) {
      const duplicate = clause.values.some((condition) =>
        condition.kind !== parsed.condition.kind
          ? false
          : (condition.kind === 'eq' && parsed.condition.kind === 'eq') ||
              (condition.kind === 'day' && parsed.condition.kind === 'day')
            ? condition.value === parsed.condition.value
            : true,
      )

      if (!duplicate) {
        clause.values.push(parsed.condition)
      }
    } else {
      nodes.set(id, { op: 'or', ns: parsed.ns, key: parsed.key, values: [parsed.condition] })
    }
  }

  for (const raw of query.field ?? []) {
    append(raw, 'eq')
  }
  for (const raw of query.fieldDay ?? []) {
    append(raw, 'day')
  }
  for (const raw of query.fieldAny ?? []) {
    append(raw, 'present')
  }
  for (const raw of query.fieldBad ?? []) {
    append(raw, 'unreadable')
  }

  return nodes.size === 0 ? undefined : { op: 'and' as const, nodes: [...nodes.values()] }
}

/** A local calendar day in URL/query state. It is deliberately NOT an ISO instant:
 *  the client sends the user's visible day (`YYYY-MM-DD`) plus `tz`, and the server
 *  applies inclusive local-day bounds to the active date axis. */
const LocalDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine(isLocalDate, 'invalid calendar date')

/** The date axis a range filter applies to; omitted = follow the `sort` axis. */
export const DateFieldSchema = z.enum(enumValues(DATE_FIELD))

/** GET /api/notes query: the server computes filter+sort+slice from its
 *  read-model snapshot, so a client never needs the whole base client-side.
 *  - `folder` scopes to a directory; '' is the space root; absent = all.
 *  - `depth` picks the folder's whole subtree (Feed facet) or only its direct
 *    children (the lazy tree / folder browse).
 *  - `limit` absent = the full (filtered, sorted) population: folder-scoped
 *    consumers (tree expand, folder delete) genuinely want everything; window
 *    consumers (Feed) always pass offset+limit. */
export const NotesQuerySchema = z.object({
  sort: NoteSortSchema.default(NOTE_SORT.modified),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).optional(),
  folder: z.string().optional(),
  depth: z.enum(enumValues(DEPTH)).default(DEPTH.subtree),
  folders: FolderSet,
  /** Keep notes carrying ANY of these tags — see TagSet. Composes with
   *  `folder`/`folders`; `total`, window and histogram describe the filtered set. */
  tags: TagSet,
  ...fieldFilterQueryFields,
  /** Full-text MEMBERSHIP filter: the engine's lexical FTS answers WHICH
   *  notes contain the words; the list then slices/sorts/windows that subset. It
   *  NARROWS, it does not rank — ordering stays by `sort` (date). Empty/absent = no
   *  text filter. Degrades honestly: a backend without FTS narrows by whatever its
   *  `search` returns (e.g. title+body substring). canon: docs/architecture.md#p5 */
  q: z.string().optional(),
  /** Inclusive local-day date range filter. `from`/`to` are URL-visible
   *  `YYYY-MM-DD` days in the user's timezone; `tz` is minutes east of UTC
   *  (`-getTimezoneOffset()`). The filter is applied BEFORE slice/window, so
   *  `total` stays honest. If `dateField` is omitted, the server filters by the
   *  current sort axis (`created|modified`; `title` falls back to `modified`). A
   *  note with no usable date on that axis is outside an active range. */
  from: LocalDate.optional(),
  to: LocalDate.optional(),
  tz: z.coerce.number().int().min(-840).max(840).default(0),
  dateField: DateFieldSchema.optional(),
  /** Favorite facet: '1' keeps only notes the current principal pinned in
   *  this space. Server-side, so window/`total`/buckets stay in lockstep. */
  favorite: z.literal('1').optional(),
  /** '1' = decorate each note with its warm cached preview (or null). Off by
   *  default — only the Feed wants the extra bytes. */
  preview: z.literal('1').optional(),
  /** '1' = derive bounded primary-view summaries for marker-bearing rows. Feed only. */
  viewSummary: z.literal('1').optional(),
})

/** `total` is the filtered population size BEFORE the offset/limit slice — the
 *  Feed's scrollbar and "jump anywhere" honesty. */
export const NotesResponseSchema = z.object({
  notes: z.array(NoteListItemSchema),
  total: z.number(),
})

/** Grouping granularity (the Feed's grouping minus 'off'). */
export const BucketGranSchema = z.enum(enumValues(BUCKET_GRAN))

/** Same scope params as /api/notes (no window — buckets describe the whole
 *  filtered population), plus the granularity and the client's UTC offset in
 *  minutes east (JS: -getTimezoneOffset()) so day boundaries match the user's
 *  clock, not the server's. `title` sort has no date axis — not accepted. Every
 *  filter facet below mirrors /api/notes exactly, so grouped section sizes sum to
 *  the same query's `total`. */
export const BucketsQuerySchema = z.object({
  sort: DateFieldSchema.default(DATE_FIELD.modified),
  group: BucketGranSchema,
  folder: z.string().optional(),
  depth: z.enum(enumValues(DEPTH)).default(DEPTH.subtree),
  folders: FolderSet,
  tags: TagSet,
  ...fieldFilterQueryFields,
  q: z.string().optional(),
  from: LocalDate.optional(),
  to: LocalDate.optional(),
  dateField: DateFieldSchema.optional(),
  favorite: z.literal('1').optional(),
  tz: z.coerce.number().int().min(-840).max(840).default(0),
})

/** One date bucket, in list order (newest first). `key` is the bucket start as
 *  a local YYYY-MM-DD (day → the day, week → its Monday, month → its 1st);
 *  '' is the trailing "undated" bucket (notes whose active date the engine
 *  honestly doesn't know — only under `modified` sort; `created` excludes
 *  them, mirroring /api/notes). Counts sum to `total`, which equals the same
 *  query's /api/notes total — THE invariant that lets a client lay out grouped
 *  sections (headers, section sizes, scrollbar) without fetching any items. */
export const BucketSchema = z.object({
  key: z.string(),
  count: z.number(),
})

export const BucketsResponseSchema = z.object({
  buckets: z.array(BucketSchema),
  total: z.number(),
})

/** The tag-facet query: like the folder tree, the whole facet rides one call.
 *  `q` prefix-filters the tag list (case-insensitive, matches any segment path
 *  that starts with it); `limit` caps the rows returned, by descending count then
 *  name (top-N). Both are headroom — v1 renders the whole facet. The facet is
 *  computed under the same class-visibility checkpoint as the listing:
 *  agent-memory tags never surface on the default surface.
 *  canon: docs/note-model.md#note-classes */
export const TagsQuerySchema = z.object({
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).optional(),
})

/** One node of the tag facet, shaped like TreeFolder so the client nests it in
 *  one pass. `tag` is the FOLDED full path — lowercased, '/'-separated —
 *  the resolve/match key the filter echoes back (`?tags=<tag>`). `label` is the
 *  display casing of the last segment (tags fold for matching but show with the
 *  author's casing). `count` is the subtree population (notes carrying this tag OR
 *  any descendant `tag/...`, mirroring the folder cascade); `direct` only notes
 *  carrying exactly this tag. Hierarchical `a/b` yields a node `a` (parent, with a
 *  subtree count) and `a/b` (leaf) — the same algebra as the folder skeleton. */
export const TagFacetSchema = z.object({
  tag: z.string(),
  label: z.string(),
  count: z.number(),
  direct: z.number(),
})

export const TagsResponseSchema = z.object({
  tags: z.array(TagFacetSchema),
  /** Distinct facet nodes before any `q`/`limit` cut — the honest "N tags" the UI
   *  shows when it truncates to top-N. */
  total: z.number(),
})

export const FieldsQuerySchema = z.object({
  q: z.string().optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(FIELD_SCHEMA_MAX_FIELDS)
    .default(FIELD_FACET_DEFAULT_LIMIT),
  valuesLimit: z.coerce
    .number()
    .int()
    .min(0)
    .max(FIELD_FACET_MAX_VALUES)
    .default(FIELD_FACET_MAX_VALUES),
})

export const FieldFacetValueSchema = z.object({
  value: z.string(),
  count: z.number().int().nonnegative(),
})

export const FieldFacetSchema = z.object({
  key: z.string(),
  declared: z.boolean(),
  notes: z.number().int().nonnegative(),
  values: z.array(FieldFacetValueSchema),
  total: z.number().int().nonnegative(),
})

export const FieldsResponseSchema = z.object({
  fields: z.array(FieldFacetSchema),
  total: z.number().int().nonnegative(),
  truncated: z.literal(true).optional(),
})

/** The cold half of the preview story: the Feed asks for ONE batch per viewport
 *  (never per card) and aborts on scroll-away — the server stops deriving on
 *  disconnect. The cap bounds a single request's worst-case engine work; bulk
 *  consumers (graph facets) chunk. */
export const PreviewsRequestSchema = z.object({
  ids: z.array(z.string()).min(1).max(100),
})

/** id → preview for everything the request resolved. A requested id may be
 *  absent (unresolvable, or the request was aborted mid-derivation) — absence
 *  is not an error. */
export const PreviewsResponseSchema = z.object({
  previews: z.record(z.string(), PreviewSchema),
})

export type NoteListItem = z.infer<typeof NoteListItemSchema>
export type NotesQuery = z.infer<typeof NotesQuerySchema>

export type FieldFilterAstV1 = z.infer<typeof FieldFilterAstV1Schema>

export type NotesResponse = z.infer<typeof NotesResponseSchema>
export type BucketsQuery = z.infer<typeof BucketsQuerySchema>

export type Bucket = z.infer<typeof BucketSchema>

export type BucketsResponse = z.infer<typeof BucketsResponseSchema>

export type TagsQuery = z.infer<typeof TagsQuerySchema>

export type TagFacet = z.infer<typeof TagFacetSchema>

export type TagsResponse = z.infer<typeof TagsResponseSchema>

export type FieldsQuery = z.infer<typeof FieldsQuerySchema>
export type FieldFacetValue = z.infer<typeof FieldFacetValueSchema>
export type FieldFacet = z.infer<typeof FieldFacetSchema>
export type FieldsResponse = z.infer<typeof FieldsResponseSchema>

export type Preview = z.infer<typeof PreviewSchema>
export type ViewSummary = z.infer<typeof ViewSummarySchema>

export type PreviewsRequest = z.infer<typeof PreviewsRequestSchema>

export type PreviewsResponse = z.infer<typeof PreviewsResponseSchema>
