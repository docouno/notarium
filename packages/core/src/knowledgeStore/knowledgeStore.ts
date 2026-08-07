// KnowledgeStore — the domain port every engine implements. The wire maps onto it
// via the host's thin transport mappers (docs/contract.md#mappers).
// canon: docs/architecture.md#p8

import {
  type BucketGran,
  type DateField,
  type Depth,
  type IfExists,
  type NoteClass,
  type NoteSort,
  type ReadScope,
  type ResolvedVia,
  type RevisionKind,
  type ScanPhase,
} from './consts'
export type Revision = {
  /** Journal-assigned, monotonic within a journal (the timeline order). Opaque on the wire. */
  id: string
  /** The note's internal id — survives move/rename. */
  noteId: string
  space: string
  /** The revision this state was built on (the CAS base); null for a note's first state. */
  baseRevisionId: string | null
  /** The other side of a merge (kind 'merge' only). */
  theirRevisionId: string | null
  /** Which revision a restore wrote back (kind 'restore' only). */
  sourceRevisionId: string | null
  kind: RevisionKind
  /** Writer attribution id: 'user:<name>', 'pat:<name>:<id>', or 'ui' (mode none); null = external. */
  principal: string | null
  /** sha-256 of the content blob; null = body honestly unknown (external gap / lost delete state). */
  contentHash: string | null
  title: string
  /** The custom display slug at this revision, or null (the implicit slug(title)). A journal
   *  column because the body blob is frontmatter-stripped — restore reads it back so a
   *  rolled-back note keeps its slug instead of re-ghosting inbound links. */
  slug: string | null
  /** The note's class at append time, so the delta can be class-scoped (a hidden class never
   *  surfaces). Plain string (the journal stores a label); null = unknown. */
  class: string | null
  tags: string[]
  /** When the journal recorded this state (full ISO). For external states = detection time
   *  (granularity = poll cadence). */
  createdAt: string
  /** Char add/remove vs the chain parent (word-segmented), computed at append. null = unknown. */
  charsAdded: number | null
  charsRemoved: number | null
}

export type RevisionDetail = Revision & {
  /** The full body; null mirrors contentHash. */
  content: string | null
}

/** One day of the activity heatmap. `date` is the LOCAL YYYY-MM-DD (shifted east by the query
 *  tz); `created` = a note's first appearance through us, `deleted` = a tombstone, `edited` =
 *  every other counted state. */
export type ActivityDayCount = {
  date: string
  created: number
  edited: number
  deleted: number
}

export type ActivityNoteCount = {
  noteId: string
  count: number
  /** The newest qualifying revision (full ISO). */
  lastAt: string
}

/** A principal-column predicate for author-scoped activity: a revision qualifies when its
 *  `principal` matches one of `exact` or starts with one of `prefixes` (null never matches).
 *  A dumb string match — the journal knows nothing about principal ownership, so the caller
 *  (which owns the `user:`/`pat:<owner>:<id>` scheme) builds the spec, and a deleted PAT's old
 *  revisions still count as the owner's. */
export type AuthorFilter = {
  exact: readonly string[]
  /** LIKE-prefixes — the driver appends `%`. Usernames are `[a-z0-9-]`, so no escaping. */
  prefixes: readonly string[]
}

export type RevisionInput = Omit<Revision, 'id'>

/** Persistence port of the journal — the meta-DB drivers implement it; core ships an in-memory
 *  twin for hosts without a meta-DB (history for the process lifetime). */
export type RevisionPersistence = {
  init(): Promise<void>
  /** Append one revision, storing `content` content-addressed by contentHash. Returns it with its id. */
  append(rev: RevisionInput, content: string | null): Promise<Revision>
  /** A note's timeline window, newest first, with the total before slicing. */
  listByNote(
    noteId: string,
    opts: { offset: number; limit: number },
  ): Promise<{ items: Revision[]; total: number }>
  /** Cursor-based delta: what changed in `space` after `sinceRevId` (null = from the start),
   *  COLLAPSED to one entry per note, newest-first, capped at `limit`. `maxRevId` = the cursor
   *  to advance on acknowledge (null = nothing changed). The cursor is a revision id, not a
   *  timestamp — two states in the same millisecond never confuse it. */
  listBySpaceSince(
    space: string,
    sinceRevId: string | null,
    limit: number,
    /** Classes to EXCLUDE before the collapse (so list/total/maxRevId stay accurate). */
    excludeClasses?: readonly string[],
  ): Promise<{ items: Revision[]; total: number; maxRevId: string | null }>
  get(revisionId: string): Promise<Revision | null>
  /** The trash view: notes whose NEWEST revision is a delete-tombstone, newest-deleted first,
   *  windowed. Each item IS the tombstone (createdAt = deletion time, principal = who deleted,
   *  contentHash = the body to resurrect). */
  listTrashed(
    space: string,
    opts: { offset: number; limit: number; q?: string },
    excludeClasses?: readonly string[],
  ): Promise<{ items: Revision[]; total: number; restorableTotal: number }>
  /** Permanently erase notes: drop EVERY revision of each id, then GC blobs no surviving revision
   *  references (the CAS is shared). */
  purgeNotes(noteIds: readonly string[]): Promise<void>
  /** The newest revision of a note — the dedup/chaining anchor. */
  latestFor(noteId: string): Promise<Revision | null>
  /** The newest revision for each requested note. Missing ids are omitted. A set-oriented
   *  read so provenance lists never issue one persistence query per row. */
  latestForMany(noteIds: readonly string[]): Promise<Map<string, Revision>>
  /** Day-bucketed activity, aggregated IN the driver (never shipping a year of rows). Synthetic
   *  pre-edit baselines (an `external` row that is a note's first entry, baseRevisionId = null)
   *  are EXCLUDED — counting them would double a pre-existing note's first edit. */
  activityByDay(
    space: string,
    opts: {
      from: string
      to: string
      tzOffsetMinutes: number
      excludeClasses?: readonly string[]
      author?: AuthorFilter
    },
  ): Promise<ActivityDayCount[]>
  /** A window over activity EVENTS, newest first — same exclusions as activityByDay. */
  activityEvents(
    space: string,
    opts: {
      from?: string
      to?: string
      offset: number
      limit: number
      excludeClasses?: readonly string[]
      author?: AuthorFilter
    },
  ): Promise<{ items: Revision[]; total: number }>
  /** Per-note activity counts, GROUP BY note_id — same exclusions as activityByDay. */
  activityByNote(
    space: string,
    opts: { from: string; to: string; excludeClasses?: readonly string[] },
  ): Promise<ActivityNoteCount[]>
  /** noteId → its newest revision's createdAt — one bulk query at boot so the read-model serves
   *  precise modifiedAt without per-note round-trips. */
  latestTimestamps(space: string): Promise<Map<string, string>>
  /** noteId → its DISTINCT past titles — seeds alias-history for notes renamed before the alias
   *  channel existed (their former titles live only in the journal). The caller filters out the
   *  current title. */
  historicalNames(space: string): Promise<Map<string, string[]>>
  content(contentHash: string): Promise<string | null>
  close(): Promise<void>
}

/** A row of the identity registry — the id → (space, path) mapping that is NOT derivable from the
 *  files (the meta-DB's first tenant). canon: docs/architecture.md#p7 */
export type IdentityRecord = {
  id: string
  /** Engine-relative storage path (`dir/note.md`) the id currently binds to. */
  filePath: string
  /** The note's space (an immutable slug). Ids are globally unique, so this row is what maps
   *  id → (space, path). Legacy pre-space rows ('') are adopted into the legacy space at boot. */
  space: string
  /** First-seen creation timestamp. The engine recreates its rows on every reindex, so persisting
   *  it here is what makes Feed dates survive a restart. */
  createdAt: string | null
  /** Whether the id is written into the file's frontmatter yet. Until then this row is its only
   *  home (lazy materialization on first save). */
  materialized: boolean
  /** Tombstone. Kept, not deleted: a tombstoned id re-adopting from the new file's frontmatter is
   *  how a materialized note survives an external move (which surfaces as remove+add). */
  deletedAt: string | null
}

/** Driven port: identity persistence — the drivers implement it, the read-model's IdentityRegistry
 *  consumes it. Losing it degrades softly. canon: docs/core.md#identity · docs/architecture.md#p2 */
export type IdentityPersistence = {
  init(): Promise<void>
  /** Every record of ONE space — a per-space registry must never ingest a sibling's rows (same
   *  file_path in two spaces is normal; loading both would cross-wire identities). */
  loadAll(space: string): Promise<IdentityRecord[]>
  /** Idempotent batch upsert by id (last write wins). */
  upsertMany(records: readonly IdentityRecord[]): Promise<void>
  /** Point lookup across ALL spaces — the resolver behind the space-free surfaces. Optional: a
   *  host without it falls back to asking each live store. */
  findById?(id: string): Promise<IdentityRecord | null>
  close(): Promise<void>
}
/** A typed placement: a directory whose notes all take ONE class (enforced). A space is a set of
 *  mounts with DISJOINT roots feeding one index — the notes-mount never descends into a dot-named
 *  sub-mount like `.notarium/memory`. canon: docs/note-model.md#note-classes */
export type MountConfig = {
  class: NoteClass
  /** Storage root for this mount's files (host-resolved absolute path). */
  dir: string
  /** Space-relative namespace this mount's paths carry as `filePath` ('' = the notes-mount at the
   *  space root; e.g. '.notarium/memory' for the agent-mount). Defaults to ''. */
  prefix?: string
}
export type ReadSurfaceOptions = {
  scope?: ReadScope
  /** Project-subtree narrowing: a space-relative FOLDER prefix ('' = the whole space). Runs in the
   *  read-model query next to the ReadScope axis, so a project-scoped list/recall stays correct
   *  under limits/budget. */
  pathPrefix?: string
}

export type ListOptions = ReadSurfaceOptions & {
  /** Candidate narrowing by semantic class. This is an optimization, NOT a visibility bypass:
   *  the read-model still intersects it with `scope`. Engines may push it into their class index. */
  classes?: readonly NoteClass[]
}

/** What the underlying engine can do. Features degrade by capability instead of breaking.
 *  identity/cas/revisions/trash/visibility are read-model concerns: the CachedStore layer owns
 *  enforcement and a bare engine reports false, so in production the invariant always holds.
 *  canon: docs/core.md#read-model · docs/architecture.md#p13 */
export type StoreCapabilities = {
  fts: boolean
  vector: boolean
  hybrid: boolean
  graphExpand: boolean
  /** Assigns internal note-ids (the wire REQUIRES them). Equipped by CachedStore, or by a
   *  self-registering engine like InMemoryStore. */
  identity: boolean
  /** Optimistic writes: write() of an existing note demands a versionToken and fails the CAS
   *  instead of overwriting silently. */
  cas: boolean
  /** Journals revisions (revisions/revision/restore answer; the wire 404s `revisions_unavailable`). */
  revisions: boolean
  /** Surfaces a trash — a VIEW over the journal, riding the same layer as `revisions`. */
  trash: boolean
  /** ENFORCES the class-visibility invariant (see ReadScope). A bare engine returns the full
   *  population and reports false. */
  visibility: boolean
  /** Can push external-change hints via watch(): a latency capability only — the full rescan stays
   *  the truth arbiter, so a missed signal only shifts WHEN the rescan runs. A store with no change
   *  feed reports false and the read-model polls. canon: docs/core.md#cooperative */
  watch: boolean
}

/** Everything an engine knows about a note without opening it. Timestamps are full ISO-8601 UTC;
 *  null = the engine honestly doesn't know. WIRE DIVERGENCE (the canonical statement — other
 *  shapes point here): `id` is required on the wire but optional in the domain, since a bare
 *  engine can't know it cheaply; the identity layer fills it in.
 *  canon: docs/contract.md#wire-v2 · docs/architecture.md#p5 */
export type NoteMeta = {
  id?: string
  title: string
  /** The note's class, materialized from its mount (see ReadScope). Optional only at the
   *  bare-engine level (default `user-doc`). */
  class?: NoteClass
  /** Storage-view location: where the note lives as a file. Never a note reference. */
  filePath: string
  /** The editable display slug — decoupled from title and filename. Present ONLY when custom (else
   *  the default stays implicit; consumers fall back via effectiveSlug).
   *  canon: docs/note-model.md#note-ontology */
  slug?: string
  /** Past human names the resolver still honours so a rename never breaks inbound [[Old Name]].
   *  RAW strings, slugified on lookup; the index view of frontmatter `aliases:`. */
  aliases?: string[]
  /** The note's tags, as authored. On the snapshot this is THE tag axis (Feed/graph filter, facet,
   *  histogram), matched via the shared `foldTag`/`matchesTags`. */
  tags?: string[]
  /** Last content change. An engine that only knows the day reports midnight UTC; the read-model
   *  upgrades it from the journal and its own write/delta stamps. */
  modifiedAt: string | null
  createdAt: string | null
}

/** read()'s domain shape — same wire divergence on `id` as NoteMeta. `versionToken` diverges the
 *  same way: a CAS-capable store always answers it, a bare engine may not. */
export type NoteContent = {
  id?: string
  title?: string
  class?: NoteClass
  filePath?: string
  content: string
  frontmatter: Record<string, unknown>
  /** Same data as NoteMeta.slug; the editor reads it to prefill the slug field. */
  slug?: string
  /** Same data as NoteMeta.aliases, served so a client can round-trip them. */
  aliases?: string[]
  modifiedAt?: string | null
  /** The resolved creation instant (frontmatter `created:` over file birthtime) — served so the
   *  editor prefills the date field without re-parsing frontmatter. */
  createdAt?: string | null
  versionToken?: string
  /** Trash state: set when read() resolved a DELETED note and served its last journaled state
   *  instead of not-found. `restorable` is false for an honest gap. Absent on a live note. */
  deleted?: boolean
  deletedAt?: string
  deletedByPrincipal?: string | null
  restorable?: boolean
}

/** The live note riding a version conflict: the CAS arbiter always knows the id and fresh token. */
export type ConflictNote = NoteContent & { id: string; versionToken: string }

/** The note occupying a refused create's destination, riding `noteAlreadyExists` so the
 *  caller can offer "open that one" instead of making the user hunt for it. Absent when the
 *  collision was caught by an engine's DISK truth — an unindexed file has no note identity
 *  to name (honest degradation, P5). */
export type ExistingNote = { id: string; title: string; filePath: string }

/** One file in a base export: a note's path and its bytes AS THEY LIVE ON DISK (the full
 *  frontmatter+body file, round-trippable) — not the parsed read() view. `path` carries the mount
 *  prefix for a hidden mount included under scope `all`. */
export type ExportEntry = {
  path: string
  content: string
}

export type SearchOptions = {
  pageSize?: number
  scope?: ReadScope
  /** Project-subtree narrowing, narrowed in-query (not after the caller's limit cut). */
  pathPrefix?: string
  /** Force the LEXICAL channel only (FTS prefix match), skipping the hybrid fusion. The Feed
   *  q-filter wants CONTAINMENT, not similarity; the quick-jump leaves this off for ranked hybrid. */
  lexicalOnly?: boolean
}

/** `background: true` marks a bulk/prefetch read a serializing engine may queue behind interactive
 *  traffic (a scheduling hint, same result). `signal` lets the host stop a batch the client walked
 *  away from — engines check it between items. */
export type ReadOptions = {
  background?: boolean
  signal?: AbortSignal
  /** Opt IN to the trash deleted-view: reading a DELETED note returns its last state (flagged
   *  `deleted`) instead of not-found. OFF by default so discovery reads still miss a deleted note. */
  deletedView?: boolean
  /** Internal resolver hint: a reserved identity envelope must stay on the identity
   *  axis even when a legacy file has the same literal storage path. Authored-link
   *  resolution sets this; ordinary storage reads keep listed file paths exact. */
  identityOnly?: boolean
  /** Internal storage-adapter hint: resolve this key as one exact file path, with no
   *  id/title/slug fallback. The read-model uses it when its persisted registry
   *  already names the authoritative owner of a stable id during degraded boot. */
  storageOnly?: boolean
}

/** A note's Feed-card enrichment: snippet, first image, tags, word count, and a model-agnostic
 *  token estimate of the body. */
export type Preview = {
  snippet: string
  image: string | null
  tags: string[]
  words: number
  tokens: number
}

export type SearchResult = {
  /** Same wire divergence as NoteMeta.id: required on the wire (the store drops hits it can't map). */
  id?: string
  title?: string
  filePath?: string
  modifiedAt?: string | null
  createdAt?: string | null
  score?: number
  snippet: string
  /** Decorative note type label — NOT the model class. Defaults to `note`. */
  noteType?: string
  /** Decorative engine-supplied hit kind (legacy back-compat) — NOT the model class or noteType. */
  type?: string
  /** The note's class, carried as a label (user search only returns visible classes). */
  class?: NoteClass
}

/** The domain save shape: the wire's SaveRequest plus host-side channels that never cross the wire
 *  (the materialization id, the writing principal, the restore-flow journal kind). */
export type WriteInput = {
  title: string
  content?: string
  directory?: string
  noteType?: string
  tags?: string[] | string
  /** The user-typed display slug — three-state like tags: `undefined` LEAVES `slug:` untouched, a
   *  string SETS it (kept only when it diverges from slug(title)), `''` CLEARS it. Never touches
   *  the storage filename. canon: docs/note-model.md#note-ontology */
  slug?: string
  /** The note-id being edited in place — triggers move-then-write so a title/folder change renames
   *  rather than duplicating. Absent = create. */
  originalId?: string
  /** Internal engine-boundary discriminator: originalId is a reserved identity
   *  envelope, not a raw opaque id or storage key. */
  identityOnly?: boolean
  /** Create-collision policy, DEFAULT `fail`: an unset policy never clobbers, so a create
   *  channel is safe before anyone remembers to think about it. `uniquify` is resolved above the
   *  engines (they see it as `fail` and the read-model retries onto the next free name).
   *  Ignored on edits — those are id-addressed and CAS-proven.
   *  canon: docs/note-model.md#create-collisions */
  ifExists?: IfExists
  /** The version the editor read. REQUIRED with originalId (CAS). */
  versionToken?: string
  /** Identity materialization channel: when set the engine writes it into frontmatter
   *  (`notarium-id`). Engines that can't ignore it. */
  id?: string
  /** Destination-mount selector, host-internal (never on the create/update wire). The gateway sets
   *  it so remember_about_user writes into the agent-memory mount; the note's class is that mount's,
   *  ENFORCED. Ignored on edits. */
  targetClass?: NoteClass
  /** The agent-memory `summary` frontmatter — a typed channel feeding the derived profile index.
   *  Three-state: `undefined` carries the existing one forward, a string sets/overwrites. */
  summary?: string
  /** The agent-memory `muted` frontmatter — a human opt-OUT that keeps a category out of the eager
   *  profile without deleting it. Three-state like `summary`. */
  muted?: boolean
  /** Explicit storage filename (sans `.md`), host-internal — overrides the default slug(title).
   *  Import sets a deterministic source-id-keyed value so a re-import overwrites the SAME file. On
   *  edits it PINS the basename (the pin/mute path that must not rename-to-slug and collide). Folder
   *  pages always keep `index.md`. */
  fileName?: string
  /** Import provenance, host-internal. The selected root still obeys the normal
   *  destination fence; parser-owned suffixes and the pinned filename retain
   *  their frozen pre-portability spelling so an old POSIX import is not
   *  duplicated on re-import. Never accepted from REST/MCP wire schemas. */
  legacyImportRoot?: string
  /** Authored creation instant — the date-as-data axis. Three-state like tags/slug: `undefined`
   *  LEAVES `created:`, a string SETS/OVERWRITES; omitted = fall back to file birthtime. (No
   *  `modifiedAt` channel by design — `modified` always tracks the real mtime.) */
  createdAt?: string
  /** Journal attribution: 'pat:<user>:<id>' (agent), 'user:<name>' (human), 'ui' (mode none). */
  principal?: string
  /** Journal channel for non-plain-save writes: the restore flow records kind 'restore'. */
  journal?: { kind: 'restore'; sourceRevisionId: string }
}

export type WriteResult = {
  id?: string
  filePath?: string
  /** The title the note was actually stored under. Diverges from the request only when a
   *  `uniquify` create had to step aside, which is exactly when a caller must not assume. */
  title?: string
  /** The class the note was actually written as (from its mount) — the authoritative value the
   *  read-model stamps into the snapshot. */
  class?: NoteClass
  /** Version of the note as just written (chains a follow-up save without a re-read). */
  versionToken?: string
  /** Raw engine response — host-side diagnostics only; never crosses the wire. */
  result?: unknown
}

export type MoveInput = {
  /** A note-id, or — with isDirectory — the folder's storage path (folders have no identity beyond
   *  their place in the tree). */
  id: string
  destinationPath: string
  isDirectory?: boolean
  /** Internal engine-boundary discriminator for an enveloped note id. */
  identityOnly?: boolean
}

/** The restore flow: write the journaled revision's state back through the CAS path (the
 *  versionToken proves what the restorer is overwriting). */
export type RestoreInput = {
  id: string
  revisionId: string
  versionToken: string
  principal?: string
}

/** One trashed note: the delete-tombstone flattened for a host. `filePath` is null when an
 *  identity-capable engine forgot it; `principal` is null for an external (principal-less) delete. */
export type TrashEntry = {
  noteId: string
  title: string
  filePath: string | null
  class?: NoteClass
  deletedAt: string
  principal: string | null
  revisionId: string
  /** sha-256 of the last body to resurrect; null = an honest gap (shown in trash, not restorable). */
  contentHash: string | null
}

/** One per-id failure in a best-effort batch. `reason` mirrors the typed error vocabulary; `error`
 *  is the line a host can surface directly. */
export type BatchFailure = {
  id: string
  error: string
  reason?: string
}

/** One note in a delta feed: fresh metadata plus the live body (and tags) when the engine could
 *  fetch it cheaply — consumers re-derive its graph edges and journal the external state. */
export type NoteChange = {
  meta: NoteMeta
  content?: string
  tags?: string[]
}

/** What `changes(cursor)` reports (the cursor is opaque — pass it back for "since"). `inventory`
 *  is the engine's full current note population: deletions and moves fall out of diffing it,
 *  sidestepping "poll can't see what's gone" without journaling deletes. */
export type StoreDelta = {
  cursor: string
  upserts: NoteChange[]
  inventory: NoteMeta[]
}

// Sync status — domain twin of the wire SyncStatusSchema (identity mapper).
export type SyncStatus = {
  scan: {
    phase: ScanPhase
    startedAt: string | null
    readyAt: string | null
    error: string | null
  }
  delta: {
    cursor: string | null
    lastPollAt: string | null
    lastChangeAt: string | null
    /** The periodic reconcile cadence: with a watcher engaged, the rare correctness backstop;
     *  without one, the responsive polling interval (`watch` says which). */
    intervalMs: number
    /** Whether an external-change watcher is engaged (else polling-only). Absent on a bare engine. */
    watch?: boolean
  }
  engine: {
    indexing: 'unknown' | 'idle' | 'busy'
    indexed?: number
    total?: number
    lastIndexedAt?: string | null
    /** Semantic (vector) index state: the live search `mode` plus embed-backfill progress (done =
     *  total - pending). Present only when the engine has a vector channel. */
    vector?: {
      mode: 'vector' | 'fts'
      pending: number
      total: number
    }
  }
  counts: { notes: number; links: number } | null
}

// Graph — domain shapes; the wire mapper renames filePath → file_path.

export type GraphRealNode = {
  id: string
  title: string
  filePath: string
  folder: string
  ghost: false
  degree: number
  /** Only graph-visible classes reach this surface (agent-memory/derived excluded). */
  class?: NoteClass
  /** The note's tags — the graph's tag facet reads these (no lazy preview sweep). */
  tags?: string[]
  community?: number
  x?: number
  y?: number
}

export type GraphGhostNode = {
  id: string
  title: string
  ghost: true
  folder: ''
  degree: number
  /** The normalised link target (our slug algebra): the key a future note's title must match. */
  target: string
  prefillTitle: string
  /** Raw/current directory the create flow must use to close a path-form link. */
  prefillDirectory?: string
  /** False when the ghost is a missing stable identity, which cannot be recreated. */
  creatable: boolean
  /** The notes pointing at the ghost — the create-from-ghost flow back-links each. `id` is absent
   *  only on a bare engine's graph. */
  sources?: Array<{ id?: string; title: string; folder: string }>
  x?: number
  y?: number
}

export type GraphNode = GraphRealNode | GraphGhostNode
/** Internal provenance carried only between derivation and graph shaping. A target
 *  string alone cannot distinguish a synthetic ghost from a real opaque note id with
 *  the same spelling. Symbols survive in-process object spreads but never reach JSON. */
export const GRAPH_GHOST_TARGET = Symbol('notarium.graph.ghost-target')
export type GraphLink = {
  source: string
  target: string
  type: string
  [GRAPH_GHOST_TARGET]?: true
  /** How the wikilink resolved. Set ONLY on a FRESH derivation; the incremental snapshot omits it
   *  (a cached inbound edge isn't re-resolved when its target is renamed, so it would undercount). */
  resolvedVia?: ResolvedVia
}

export type Graph = { nodes: GraphNode[]; links: GraphLink[] }

/** One wikilink edge resolving through a name OTHER than the target's current one — carries the
 *  human titles so the UI renders "A → B (via a former name)" without a second lookup. */
export type GraphHealthEdge = {
  source: { id: string; title: string }
  target: { id: string; title: string }
  via: Exclude<ResolvedVia, 'current'>
}

/** Read-only health of the wikilink graph, computed on a FRESH derivation: links resolving through
 *  a FORMER name + ghost (broken) links. Visibility + hygiene only — correctness doesn't depend. */
export type GraphHealth = {
  /** Resolved (non-ghost) edges considered — the denominator. */
  totalLinks: number
  /** Edges through a PRIOR name (note-alias + folder-alias). A live custom slug is a current
   *  alternate, counted apart in `via.slug`, not here. */
  staleNamed: number
  via: { slug: number; noteAlias: number; folderAlias: number }
  edges: GraphHealthEdge[]
  ghosts: Array<{
    id: string
    title: string
    target: string
    /** Unique source notes pointing at this ghost (edges are deduped, so priority = notes healed). */
    refCount: number
    sources: Array<{ id?: string; title: string; folder: string }>
  }>
}

// Store events — what subscribe() emits; the SSE surface maps 1:1.

export type StoreEvent =
  | { type: 'status'; status: SyncStatus }
  /** `folders` = the current folders of the upserted notes; a client unions them with the old
   *  folders from its own cache so a move by another client refreshes both endpoints. */
  | { type: 'changed'; upserts: string[]; removed: string[]; folders: string[] }
  | { type: 'graph' }

// List-layer query shapes — neutral names; the wire query params coincide.
export type NotesQuery = {
  sort: NoteSort
  offset: number
  limit?: number
  folder?: string
  depth: Depth
  /** Folder filter set (inclusion): keep notes under ANY listed subtree, OR across the set
   *  (prefix-match), applied after `folder`. */
  folders?: string[]
  /** Tag filter: keep notes carrying ANY listed tag (OR), matched case-insensitively and
   *  hierarchically (`ml` also matches `ml/nlp`). */
  tags?: string[]
  /** Date range: inclusive local-day bounds on the selected axis. `dateField` absent = use the
   *  sort axis (`title` → `modified`); `tz` = minutes east of UTC. */
  from?: string
  to?: string
  tz?: number
  dateField?: DateField
  /** Stable-id membership set (favorites, q): keep only notes whose id is in it. */
  ids?: string[]
}
export type BucketsQuery = {
  sort: 'created' | 'modified'
  group: BucketGran
  folder?: string
  depth: Depth
  folders?: string[]
  tags?: string[]
  from?: string
  to?: string
  dateField?: DateField
  ids?: string[]
  tz: number
}

export type TreeChildrenQuery = {
  path: string
  offset: number
  limit?: number
}

/** Host-owned derived state that must settle inside a storage mutation's
 *  in-process fence. Engines ignore this; read-model decorators invoke the
 *  hooks immediately before / after their own mutation checkpoint. Hooks must
 *  not re-enter mutation methods on the same store (they already hold its claim). */
export type MutationOptions = {
  prepare?: () => void | Promise<void>
  finalize?: () => void | Promise<void>
}

export type KnowledgeStore = {
  /** Every note's metadata; `opts.scope` applies class-visibility (ReadScope). */
  list(opts?: ListOptions): Promise<NoteMeta[]>
  /** The directory channel: every visible folder path, INCLUDING empty ones the note index can't
   *  see. A SEPARATE channel from list(). Optional (absent ⇒ the tree shows only note-backed folders). */
  listDirs?(): Promise<string[]>
  makeDir?(path: string, opts?: MutationOptions): Promise<void>
  /** Delete a folder subtree. A read-model-equipped store tombstones every child inside the same
   *  prefix mutation fence before removing the on-disk tree. */
  removeDir?(path: string, opts?: MutationOptions & { principal?: string }): Promise<void>
  /** Feed the engine current→past folder-path pairs so a path-form `[[oldpath/note]]` resolves to a
   *  renamed folder's note. A resolution HINT, not ownership; the bare engine stays alias-blind. */
  setFolderAliases?(aliases: ReadonlyArray<{ current: string; alias: string }>): void
  /** Authoritative stable-id → storage-path hints from an identity-owning decorator.
   *  A bare engine keys graph nodes by path but must still resolve authored `[[id]]`
   *  exactly, including unclaimed external files and copied duplicate claims. */
  setLinkIdentities?(identities: ReadonlyArray<{ id: string; path: string }>): void
  /** Stream every note file for a base export. `opts.scope` reuses the visibility axis (a user
   *  export never sweeps agent memory; `all` = full backup). Raw on-disk bytes. Optional. */
  exportNotes?(opts?: { scope?: ReadScope }): AsyncIterable<ExportEntry>
  /** `id` is a note-id first; engines also accept their storage keys so wiki-link resolution works. */
  read(id: string, opts?: ReadOptions): Promise<NoteContent>
  /** Resolve an authored human wikilink on the user-graph namespace. A plain
   *  spelling may fall through a dead stable-id tombstone to a live name; a
   *  reserved identity envelope remains exact. Read-models implement the full
   *  visibility-aware contract; hosts may fall back to read() only for legacy stores. */
  resolveWikilink?(ref: string): Promise<NoteContent>
  /** A note's Feed-card preview. A port method so the engine owns serving it efficiently (the
   *  read-model caches with real invalidation); a bare engine derives it via `derivePreview`. */
  preview(id: string, opts?: ReadOptions): Promise<Preview>
  /** Batch previews: sequential, and the abort check between items lets a dead request stop costing
   *  engine time. */
  previews(ids: readonly string[], opts?: ReadOptions): Promise<Record<string, Preview>>
  /** A synchronous cache-only peek so a notes window carries previews inline without an engine read.
   *  null = "cold, ask /api/previews". */
  previewPeek(id: string): Preview | null
  search(q: string, opts?: SearchOptions): Promise<SearchResult[]>
  /** The wikilink graph; `opts.scope` excludes agent-memory both as nodes AND as link targets. */
  graph(opts?: ReadSurfaceOptions): Promise<Graph>
  graphHealth?(): Promise<GraphHealth>
  write(input: WriteInput, opts?: MutationOptions): Promise<WriteResult>
  move(input: MoveInput, opts?: MutationOptions): Promise<void>
  /** `principal` is journal attribution — engines without a journal ignore it. */
  remove(id: string, opts?: { principal?: string; identityOnly?: boolean }): Promise<void>
  /** Changes since `cursor` (null = establish one without history); an engine with no external
   *  change source returns empty upserts and its full inventory. */
  changes(cursor: string | null): Promise<StoreDelta>
  syncStatus(): Promise<SyncStatus>
  /** Subscribe to external-change hints. `onChange` is an INVITATION the read-model answers with a
   *  full reconcile, so a missed signal only shifts WHEN the rescan runs. canon: docs/core.md#cooperative */
  watch?(onChange: () => void): (() => void) | null
  /** Subscribe to background-index progress ticks — a nudge so the read-model pushes a fresh
   *  `status` frame without polling. The read-model owns the throttle. */
  onIndexProgress?(onTick: () => void): (() => void) | null
  revisions?(
    noteId: string,
    opts: { offset: number; limit: number },
  ): Promise<{ items: Revision[]; total: number }>
  /** Newest journal row per requested note. A read-model concern; absent means provenance
   *  decoration degrades to metadata without falling back to an N+1 query loop. */
  latestRevisions?(noteIds: readonly string[]): Promise<Map<string, Revision>>
  /** One revision with its content (null content = an honest external gap). */
  revision?(noteId: string, revisionId: string): Promise<RevisionDetail | null>
  /** Cursor-based delta (see RevisionPersistence.listBySpaceSince). A read-model concern; a bare
   *  engine doesn't answer and the gateway degrades honestly. */
  revisionsSince?(
    sinceRevId: string | null,
    limit: number,
  ): Promise<{ items: Revision[]; total: number; maxRevId: string | null }>
  activity?(opts: {
    from: string
    to: string
    tzOffsetMinutes: number
    scope?: ReadScope
    author?: AuthorFilter
  }): Promise<ActivityDayCount[]>
  activityEvents?(opts: {
    from?: string
    to?: string
    offset: number
    limit: number
    scope?: ReadScope
    author?: AuthorFilter
  }): Promise<{ items: Revision[]; total: number }>
  activityByNote?(opts: {
    from: string
    to: string
    scope?: ReadScope
  }): Promise<ActivityNoteCount[]>
  /** Write a journaled revision's state back through the CAS path. */
  restore?(input: RestoreInput): Promise<WriteResult>
  listTrashed?(opts: {
    offset: number
    limit: number
    q?: string
    scope?: ReadScope
  }): Promise<{ items: TrashEntry[]; total: number; restorableTotal: number }>
  /** Resurrect a trashed note, keeping its id and last folder. `noteAlreadyExists` if a note is
   *  already at the restore path; `noteNotInTrash` if the id isn't trashed. */
  restoreFromTrash?(id: string, opts?: { principal?: string }): Promise<WriteResult>
  /** Best-effort batch restore: one write burst, per-id failures instead of aborting the run. */
  restoreTrash?(opts: {
    ids?: readonly string[]
    all?: boolean
    q?: string
    onlyRestorable?: boolean
    scope?: ReadScope
    principal?: string
  }): Promise<{ restored: WriteResult[]; failed: BatchFailure[] }>
  /** Permanently erase trashed notes (an `ids` set, or `all` in scope matching `q`). Drops journal
   *  rows + GCs orphan blobs; irreversible. */
  purgeTrash?(opts: {
    ids?: readonly string[]
    all?: boolean
    q?: string
    scope?: ReadScope
  }): Promise<{ purged: number }>
  readonly capabilities: StoreCapabilities
}
