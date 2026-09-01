// KnowledgeStore — the domain port every engine implements. The wire maps onto it
// via the host's thin transport mappers (docs/contract.md#mappers).
// canon: docs/architecture.md#p8

import type { FieldFilter, FieldPatch, NoteFields } from '../libs/fields'
import type {
  DocumentRole,
  DocumentState,
  DocumentStateFormat,
  ExactOwnerObservation,
  FrontmatterEntry,
  FrontmatterGeometryReason,
  LogicalNoteState,
  RestoreSafety,
  StorageOwnerProof,
} from '../libs/markdown'
import {
  type BucketGran,
  type DateField,
  type Depth,
  type IfExists,
  type NoteClass,
  type NoteSort,
  type ReadScope,
  type ResolvedVia,
  REVISION_UNAVAILABLE_REASON,
  REVISION_UNAVAILABLE_TITLE,
  type RevisionEntryRole,
  type RevisionKind,
  type RevisionUnavailableReason,
  type ScanPhase,
  type SortDir,
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
  /** What this entry IS in the note's life, decided by the WRITER at append and
   *  never inferred on read. Required, and deliberately not optional: the gap
   *  constructor below builds a Revision literally, so the compiler is what proves a
   *  gap keeps its role, and every direct constructor of a `RevisionInput` has to
   *  name one. The only default lives in SQL, for the mixed-version window (#327).
   *  canon: docs/note-history.md#model */
  entryRole: RevisionEntryRole
  /** Writer attribution id: 'user:<name>', 'pat:<name>:<id>', or 'ui' (mode none); null = external. */
  principal: string | null
  /** Agent-audit attribution captured with the write. Absent on legacy/human revisions so the
   *  existing revision wire shape stays backwards-compatible. */
  agent?: AgentWriteAttribution | null
  /** sha-256 of the stored state blob; null = state honestly unknown (external gap / lost delete state). */
  contentHash: string | null
  /** Versioned semantic identity of the complete state. It includes authored,
   * safety, role/format and provenance-shape semantics while excluding proven
   * runtime owner values and receipt lineage. null marks legacy/gap rows. */
  semanticFingerprint: string | null
  /** `markdown-v1` means the blob is a complete logical note snapshot. null is a
   * legacy compatibility body-only row. This is per revision, not a deployment flag. */
  stateFormat: LogicalNoteState['format'] | DocumentStateFormat | null
  /** Persisted eligibility projection for exact document rows. Legacy/gap rows
   * remain null and are classified from their format/content marker. */
  restoreSafety: RestoreSafety['status'] | null
  title: string
  /** Query projection of the custom display slug at this revision, or null for
   * the implicit slug(title). Current snapshots also contain its raw authored form. */
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
  /** Why this entry is a GAP rather than a state. Present only on a sanitized row: its payload,
   *  edges and attribution are withheld because the note's identity was contaminated by a
   *  cross-space collision, so nothing about it can be attributed honestly (#327). A trusted row
   *  omits the field entirely — the wire shape is additive.
   *  canon: docs/note-history.md#model · docs/core.md#identity */
  unavailableReason?: RevisionUnavailableReason
}

export const REVISION_RESTORE_AVAILABILITY = {
  full: 'full',
  partial: 'partial',
  opaque: 'opaque',
  gap: 'gap',
  blocked: 'blocked',
  unknown: 'unknown',
  /** A blob is stored and this reader cannot open it. Never a projection of a row's
   *  columns — only a surface that already read the blob may answer it.
   *  canon: docs/trash.md#availability */
  unreadable: 'unreadable',
} as const

export type RevisionRestoreAvailability =
  (typeof REVISION_RESTORE_AVAILABILITY)[keyof typeof REVISION_RESTORE_AVAILABILITY]

export type TrashAvailabilityFilter = 'restorable' | 'unavailable'

export const revisionRestoreAvailability = (
  revision: Pick<Revision, 'contentHash' | 'restoreSafety' | 'stateFormat'>,
): RevisionRestoreAvailability => {
  if (revision.contentHash == null) {
    return REVISION_RESTORE_AVAILABILITY.gap
  }
  if (revision.stateFormat === 'opaque-v1') {
    return REVISION_RESTORE_AVAILABILITY.opaque
  }
  if (revision.stateFormat === 'markdown-v2' || revision.stateFormat === 'skill-markdown-v1') {
    return revision.restoreSafety === 'safe'
      ? REVISION_RESTORE_AVAILABILITY.full
      : revision.restoreSafety === 'blocked'
        ? REVISION_RESTORE_AVAILABILITY.blocked
        : REVISION_RESTORE_AVAILABILITY.unknown
  }

  return REVISION_RESTORE_AVAILABILITY.partial
}

export const isRevisionRestorable = (
  revision: Pick<Revision, 'contentHash' | 'restoreSafety' | 'stateFormat'>,
): boolean => {
  const availability = revisionRestoreAvailability(revision)

  return (
    availability === REVISION_RESTORE_AVAILABILITY.full ||
    availability === REVISION_RESTORE_AVAILABILITY.partial
  )
}

export type RevisionDetail = Revision & {
  /** The normalized body projection; null mirrors contentHash. */
  content: string | null
  /** Complete state for new rows. null is the explicit legacy-partial marker. */
  logicalState: LogicalNoteState | null
  /** Exact byte-safe state for current full rows. Kept beside logicalState while markdown-v1
   * remains a readable compatibility format. */
  documentState: DocumentState | null
}

export type RevisionBlob = string | Uint8Array

/** One day of the activity heatmap. `date` is the LOCAL YYYY-MM-DD (shifted east by the query
 *  tz); `created` = a note's first appearance through us, `deleted` = a tombstone, `edited` =
 *  every other counted state, `unavailable` = a journal gap (#327) — real activity whose kind
 *  cannot be classified without reading a payload the row withholds. */
export type ActivityDayCount = {
  date: string
  created: number
  edited: number
  deleted: number
  unavailable: number
}

export type ActivityNoteCount = {
  noteId: string
  count: number
  /** The newest qualifying revision (full ISO). */
  lastAt: string
}

export type ActivityLastEvent = Pick<
  Revision,
  | 'id'
  | 'noteId'
  | 'kind'
  | 'entryRole'
  | 'principal'
  | 'title'
  | 'createdAt'
  | 'charsAdded'
  | 'charsRemoved'
  | 'unavailableReason'
>

export type ActivityNoteGroupCount = {
  noteId: string
  count: string
  charsAdded: string | null
  charsRemoved: string | null
  lastSourceOrdinal: string
  lastEvent: ActivityLastEvent
}

export type ActivityProjectionLease = {
  /** Commit-ordered source cut. Null is reserved for a ready journal with no rows. */
  through: string | null
  activeGeneration: string
  sourceGeneration: string
}

export type ActivityProjectionPreparation =
  { state: 'ready'; lease: ActivityProjectionLease } | { state: 'rebuilding' }

export type ActivityProjectionMaintenance = {
  state: 'ready' | 'rebuilding'
  processed: number
  published: boolean
}

export type ActivityProjectionGcMaintenance = {
  deleted: number
  pending: boolean
}

export type ActivityScopeGate = {
  hasOtherAuthors: boolean
  through: string | null
  activityVersion: string
}

export type ActivityLocation =
  { kind: 'folder'; path: string } | { kind: 'root' } | { kind: 'unavailable' }

export type ActivityCurrentNote = {
  noteId: string
  title: string
  location: Exclude<ActivityLocation, { kind: 'unavailable' }>
}

export type ActivityCurrentProjection = {
  notes: ReadonlyMap<string, ActivityCurrentNote>
  locationThrough: string
}

export type ActivityNoteGroup = ActivityNoteGroupCount & {
  type: 'note'
  title: string
  location: ActivityLocation
}

export type ActivityFolderGroup = {
  type: 'folder'
  location: ActivityLocation
  noteCount: number
  eventCount: string
  charsAdded: string | null
  charsRemoved: string | null
  lastAt: string
  lastSourceOrdinal: string
}

export type ActivityGroupCursor = {
  sourceOrdinal: string
  key: string
}

export type ActivityGroupsResult = {
  itemType: 'note' | 'folder'
  items: ActivityNoteGroup[] | ActivityFolderGroup[]
  total: number
  through: string | null
  activityVersion: string
  scopeGate?: ActivityScopeGate
  locationThrough: string
  nextCursor: ActivityGroupCursor | null
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

export type RevisionInput = Omit<
  Revision,
  'id' | 'restoreSafety' | 'semanticFingerprint' | 'stateFormat'
> & {
  /** Optional on the persistence input so old/fixture writers naturally create
   * explicit legacy rows; every driver normalizes omission to null on output. */
  stateFormat?: Revision['stateFormat']
  semanticFingerprint?: string | null
  restoreSafety?: Revision['restoreSafety']
  /** When present (including null), append is a head CAS. Omission is retained
   * only for legacy/admin writers; production journal paths always provide it. */
  expectedHeadRevisionId?: string | null
  /** Return the existing head instead of appending when fingerprint+lifecycle
   * are equal. Required causal events (restore) deliberately leave this false. */
  allowSemanticNoop?: boolean
}

/** Serve a contaminated row as a GAP. What survives is exactly what stays true
 *  when a note's identity is in doubt: the revision's place in the stream (its
 *  id, note, space, kind and time) — which is what keeps cursors, totals and
 *  session linkage exact. Everything that could attribute or reconstruct the
 *  state is withheld, and nothing is invented in its place: no neutral author,
 *  no reconstructed parent, no alias. canon: docs/core.md#identity */
export const revisionGapOf = (row: Revision): Revision => ({
  id: row.id,
  noteId: row.noteId,
  space: row.space,
  kind: row.kind,
  // The role is structural, like `kind` and `createdAt`: it says where the entry
  // stands, not what the note contained. Quarantine hides payload, not position.
  entryRole: row.entryRole,
  createdAt: row.createdAt,
  baseRevisionId: null,
  theirRevisionId: null,
  sourceRevisionId: null,
  principal: null,
  agent: null,
  contentHash: null,
  semanticFingerprint: null,
  stateFormat: null,
  restoreSafety: null,
  title: REVISION_UNAVAILABLE_TITLE,
  class: null,
  slug: null,
  tags: [],
  charsAdded: null,
  charsRemoved: null,
  unavailableReason: REVISION_UNAVAILABLE_REASON.identityConflict,
})

/** Persistence port of the journal — the meta-DB drivers implement it; core ships an in-memory
 *  twin for hosts without a meta-DB (history for the process lifetime). */
export type RevisionPersistence = {
  init(): Promise<void>
  /** Initialize exactly one space's derived Activity carrier without scanning any sibling space. */
  prepareActivityProjection(space: string): Promise<ActivityProjectionPreparation>
  /** Apply at most one dialect-bounded rebuild unit and publish only under the writer fence. */
  maintainActivityProjection(space: string): Promise<ActivityProjectionMaintenance>
  /** Delete at most one bounded state/head batch from an inert projection generation. */
  maintainActivityProjectionGc(space: string): Promise<ActivityProjectionGcMaintenance>
  /** Append one revision, storing `content` content-addressed by contentHash. Returns it with its id. */
  append(rev: RevisionInput, content: RevisionBlob | null): Promise<Revision>
  /** A note's timeline window, newest first, with the total before slicing. Note-addressed reads
   *  are SPACE-scoped: note ids are globally unique, but the journal is shared across spaces and a
   *  contaminated legacy chain must never be readable through a sibling space (#327). */
  listByNote(
    space: string,
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
  get(space: string, revisionId: string): Promise<Revision | null>
  /** The trash view: notes whose NEWEST revision is a delete-tombstone, newest-deleted first,
   *  windowed. Each item IS the tombstone (createdAt = deletion time, principal = who deleted,
   *  contentHash = the logical-state blob to resurrect). */
  listTrashed(
    space: string,
    opts: { offset: number; limit: number; q?: string; availability?: TrashAvailabilityFilter },
    excludeClasses?: readonly string[],
  ): Promise<{ items: Revision[]; total: number; restorableTotal: number; partialTotal: number }>
  /** Permanently erase this space's notes: drop EVERY revision of each id in it, then GC blobs no
   *  surviving revision references (the CAS is shared). When `expectedLatest` is supplied, the
   *  latest-row compare and purge happen under the driver's append/purge lock; stale candidates
   *  are skipped. Returns the ids actually fenced and erased. */
  purgeNotes(
    space: string,
    noteIds: readonly string[],
    expectedLatest?: ReadonlyMap<string, string>,
  ): Promise<readonly string[]>
  /** Whether the note has ANY journaled row, trusted or quarantined — the existence question the
   *  write path asks before capturing a pre-edit baseline, and the one it stamps `entryRole`
   *  from. A note whose only history is a gap has a history; capturing a fresh "baseline" over it
   *  would invent one, and calling its next edit an `origin` would invent a birth. */
  hasAnyFor(space: string, noteId: string): Promise<boolean>
  /** The newest TRUSTED revision of a note — the dedup/chaining anchor. A gap is never a chain
   *  parent, a tombstone or a restore source: those would all reconstruct state from a row whose
   *  payload is withheld. */
  latestFor(space: string, noteId: string): Promise<Revision | null>
  /** The newest TRUSTED revision for each requested note — {@link latestFor} in bulk, and
   *  withholding a gap for the same reason: newer quarantined rows are skipped, and a note
   *  whose history is gaps only is omitted like an unknown id. A set-oriented read so
   *  provenance lists never issue one persistence query per row. */
  latestForMany(space: string, noteIds: readonly string[]): Promise<Map<string, Revision>>
  /** Day-bucketed activity, aggregated IN the driver (never shipping a year of rows). Rows the
   *  writer marked `entryRole: 'baseline'` are EXCLUDED — counting them would double a
   *  pre-existing note's first edit. `created` is `entryRole: 'origin'`, not "has no parent":
   *  after a quarantine the next real edit has no trusted parent either. */
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
      viewerAuthor?: AuthorFilter
      noteId?: string
      through?: string
      activityLease?: ActivityProjectionLease
      afterId?: string
    },
  ): Promise<{
    items: Revision[]
    total: number
    through: string | null
    nextAfterId: string | null
    activityLease?: ActivityProjectionLease
    hasOtherAuthors?: boolean
  }>
  /** Set-oriented note summaries used by both Note and Folder dashboard modes. */
  activityGroupsByNote(
    space: string,
    opts: {
      from?: string
      to?: string
      excludeClasses?: readonly string[]
      author?: AuthorFilter
      viewerAuthor?: AuthorFilter
      through?: string
      activityLease?: ActivityProjectionLease
    },
  ): Promise<{
    items: ActivityNoteGroupCount[]
    through: string | null
    activityLease: ActivityProjectionLease
    hasOtherAuthors?: boolean
  }>
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
  content(contentHash: string): Promise<RevisionBlob | null>
  close(): Promise<void>
}

/** A row of the identity registry — the id → (space, path) mapping that is NOT derivable from the
 *  files (the meta-DB's first tenant). canon: docs/architecture.md#p7 */
export type IdentityRecord = {
  id: string
  /** Proven pre-Unicode bare name keys that remain addressable for this identity. */
  legacyNameAliases: readonly string[]
  /** DB-owned monotonic revision of the live/tombstoned address binding.
   * Optional on write inputs and normalized by persistent drivers on reads. */
  addressRevision?: number
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
  /** Explicit durable lineage written by an accepted identity settlement. Read projections may
   *  expose it so exact-id access can follow a retired address after restart; ordinary tombstones
   *  omit it and never infer ancestry from path reuse. Persistence writers ignore this field. */
  settlementSuccessorId?: string
}

/** What a batch claim did to ONE record. A row whose id already belongs to a DIFFERENT space is
 *  refused, never stolen — the registry remints and the caller re-keys. */
export type IdentityClaimOutcome =
  | { id: string; status: 'claimed'; legacyNameAliases: readonly string[] }
  | { id: string; status: 'foreign-owner'; owner: IdentityRecord }

export type IdentityLegacyNameAliasMergeOutcome =
  | {
      status: 'merged'
      /** The exact row that received the alias. A superseded id may resolve through durable
       * settlement lineage; ordinary path reuse never creates that lineage. */
      id: string
      legacyNameAliases: readonly string[]
    }
  | { status: 'not-owned' }

/** One file's frontmatter id claim, put to the GLOBAL registry for arbitration. */
export type IdentityFileClaim = {
  space: string
  /** Engine-relative storage path whose claim is being settled. */
  filePath: string
  /** The claimant's live record for `filePath` — the identity this settlement transitions FROM. */
  current: IdentityRecord
  /** The `notarium-id` the file on disk carries. */
  observedId: string
  /** The settlement instant (ISO-8601 UTC) — a tombstone's `deletedAt` and a brand-new row's
   *  birth date. Supplied by the caller so the drivers keep no clock of their own. */
  at: string
}

/** The three outcomes of a file-claim settlement. They are DISTINCT on purpose: collapsing
 *  `duplicate-path-owner` into `accepted` would let a copied file take the original's id.
 *  canon: docs/core.md#identity */
export type IdentityFileSettlement =
  /** The claim is the path's authoritative identity now (the id was free, tombstoned, or already
   *  this very path's). `retiredId` is the superseded identity, tombstoned in the same transaction. */
  | { status: 'accepted'; record: IdentityRecord; retiredId?: string }
  /** The id durably belongs to ANOTHER space. The owner is untouched; the claimant keeps `record`
   *  and its references were re-pointed onto it in the same transaction. */
  | { status: 'foreign-owner'; owner: IdentityRecord; record: IdentityRecord }
  /** A live note of the SAME space already holds the id at another path — a user-copied file.
   *  Nothing moves: owner, claimant and every reference stay exactly as they were. */
  | { status: 'duplicate-path-owner'; owner: IdentityRecord; record: IdentityRecord }

export type IdentityMaterializationInput = {
  /** Engine-relative storage path being converged. */
  filePath: string
  /** The claim the caller last OBSERVED in those bytes (`null` = the file carried none). Anything
   *  else on disk means an external writer got there first, and the caller must re-arbitrate. */
  expectedClaimId: string | null
  /** The id this path must end up carrying. */
  targetId: string
}

/** What one convergence attempt achieved. There is no "probably": `materialized` is claimed only
 *  after a FINAL stable observation of storage still matches the bytes the index was proven
 *  against, so an external edit is either reconciled before publication or belongs to the next
 *  one. canon: docs/core.md#identity */
export type IdentityMaterialization =
  | { status: 'materialized' }
  /** The bytes name something other than the caller expected — re-arbitrate from `observedId`. */
  | { status: 'claim-changed'; observedId: string | null }
  /** The file is gone from this path. Nothing is left to converge and nothing is left to
   *  defend, so this is a terminal SUCCESS for the caller, not a race to retry: a settlement
   *  that has already committed stands, and the next scan removes the note. A racing
   *  replacement is NOT this — that one is re-observed inside the loop. */
  | { status: 'vanished' }
  /** The bytes cannot carry the claim without rewriting entries this channel does not own.
   *  Terminal like `vanished` and for the same reason — re-reading the same file reaches the
   *  same answer — but a failure of the write, not of the path: the file is untouched and the
   *  note keeps whatever id the registry binds to it. */
  | { status: 'unwritable'; reason: FrontmatterGeometryReason }

/** Driven port: identity persistence — the drivers implement it, the read-model's IdentityRegistry
 *  consumes it. Losing it degrades softly. canon: docs/core.md#identity · docs/architecture.md#p2 */
export type IdentityPersistence = {
  init(): Promise<void>
  /** Every record of ONE space — a per-space registry must never ingest a sibling's rows (same
   *  file_path in two spaces is normal; loading both would cross-wire identities). */
  loadAll(space: string): Promise<IdentityRecord[]>
  /** Idempotent batch claim by id. A row is written only while the id is free or already this
   *  space's — an id owned elsewhere comes back as `foreign-owner` instead of changing owners. */
  claimMany(records: readonly IdentityRecord[]): Promise<IdentityClaimOutcome[]>
  /** Atomically add one compatibility name to an existing row owned by `space`, following only
   * durable settlement lineage when `id` was superseded. No other identity field may change,
   * ordinary same-path reuse is unrelated, and a missing/foreign row is never inserted. */
  mergeLegacyNameAlias(input: {
    id: string
    space: string
    alias: string
  }): Promise<IdentityLegacyNameAliasMergeOutcome>
  /** Arbitrate one file's frontmatter claim against the global registry and carry out the whole
   *  transition — identity rows, this space's references and its revision history — in ONE
   *  transaction. The authoritative outcome is what the registry commits to its maps. */
  settleFileClaim(claim: IdentityFileClaim): Promise<IdentityFileSettlement>
  /** Point lookup across ALL spaces — the resolver behind the space-free surfaces. Optional: a
   *  host without it falls back to asking each live store. */
  findById?(id: string): Promise<IdentityRecord | null>
  /** Bounded exact batch lookup for request doors carrying many ids. Unlike `loadAll`, this
   *  never snapshots a space; rows are returned in first-requested-id order. */
  findByIds?(ids: readonly string[]): Promise<IdentityRecord[]>
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
  /** Internal source-addressable import provenance. File truth, omitted by
   * ordinary transport mappers. */
  sourceLocator?: string
  /** The editable display slug — decoupled from title and filename. Present ONLY when custom (else
   *  the default stays implicit; consumers fall back via effectiveSlug).
   *  canon: docs/note-model.md#note-ontology */
  slug?: string
  /** Past human names the resolver still honours so a rename never breaks inbound [[Old Name]].
   *  RAW strings, slugified on lookup; the index view of frontmatter `aliases:`. */
  aliases?: string[]
  /** Registry-owned compatibility aliases inferred from exact historical storage
   * evidence. Internal only; ordinary transport mappers omit them. */
  legacyNameAliases?: readonly string[]
  /** The note's tags, as authored. On the snapshot this is THE tag axis (Feed/graph filter, facet,
   *  histogram), matched via the shared `foldTag`/`matchesTags`. */
  tags?: string[]
  /** Typed primary note kind, projected independently from the bounded custom-fields blob. */
  noteType?: string
  /** Cheap view-reader marker, projected independently from the bounded custom-fields blob.
   * The carrier in the note body remains authoritative; this field is discovery-only. */
  viewType?: string
  /** The note's authored frontmatter beyond the typed fields above — THE field axis
   *  on the snapshot. Absent means "this row did not carry the column", never "the
   *  note has no author keys": a delta poll sends it only for changed rows, and the
   *  read-model carries the previous value forward.
   *  canon: docs/note-model.md#note-ontology */
  fields?: NoteFields
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
  /** Typed projection of reserved `notarium-source`; the raw key is excluded
   * from the public/authored frontmatter projection. */
  sourceLocator?: string
  /** Exact logical Markdown state used internally by CAS/history. Optional only
   * for compatibility with capability-thin third-party/test stores; repository
   * engines always provide it. Ordinary transport mappers do not expose it. */
  logicalState?: LogicalNoteState
  /** Exact physical source plus analyzed authored/provenance state. Repository engines provide it;
   * compatibility adapters may still expose only logicalState during migration. */
  documentState?: DocumentState
  /** Same data as NoteMeta.slug; the editor reads it to prefill the slug field. */
  slug?: string
  /** Same data as NoteMeta.aliases, served so a client can round-trip them. */
  aliases?: string[]
  /** Same internal compatibility axis as NoteMeta. */
  legacyNameAliases?: readonly string[]
  /** Adapter-opaque identity of the exact bytes returned by this read, paired with
   * a fail-closed observation of their storage-owner claim. Internal only. */
  physicalIncarnation?: PhysicalIncarnation
  modifiedAt?: string | null
  /** The resolved creation instant (frontmatter `created:` over file birthtime) — served so the
   *  editor prefills the date field without re-parsing frontmatter. */
  createdAt?: string | null
  versionToken?: string
  /** Trash state: set when read() resolved a DELETED note and served its last journaled state
   *  instead of not-found. `restorable` means historical content is available
   *  for inspection; restoreAvailability is the stricter publication predicate.
   *  Both are absent on a live note. */
  deleted?: boolean
  deletedAt?: string
  deletedByPrincipal?: string | null
  restorable?: boolean
  restoreAvailability?: RevisionRestoreAvailability
}

/** The live note riding a version conflict: the CAS arbiter always knows the id and fresh token. */
export type ConflictNote = NoteContent & { id: string; versionToken: string }

/** The note occupying a refused create's destination, riding `noteAlreadyExists` so the
 *  caller can offer "open that one" instead of making the user hunt for it. Absent when the
 *  collision was caught by an engine's DISK truth — an unindexed file has no note identity
 *  to name (honest degradation, P5). */
export type ExistingNote = { id: string; title: string; filePath: string }

/** One file in a base export: its path and bytes AS THEY LIVE ON DISK — not the parsed read()
 *  view. Markdown-backed stores may return strings; package/resource mounts return raw bytes so
 *  arbitrary auxiliary files stay round-trippable. `path` carries the mount prefix for a hidden
 *  mount included under scope `all`. */
export type ExportEntry = {
  path: string
  content: string | Uint8Array
  /** Package/resource truth must bypass host presentation transforms even when
   * its configured mount prefix is not the canonical default. */
  preserveBytes?: boolean
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
  /** Trusted host hint: the caller already owns the enclosing resource-authority
   *  lease, so a physical read must use admitted observations instead of trying
   *  to acquire that lease recursively. */
  resourceAdmitted?: boolean
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

/** Small body-derived facts used by eager agent context. They are an optional
 *  read-model accelerator: absence costs a normal read but never changes an answer. */
export type NoteFacts = {
  title: string
  summary: string | null
  snippet: string
  muted: boolean
  bodyTokens: number
  /** Optional exact class carried by body-fact accelerators for policy filtering. */
  noteClass?: NoteClass
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
  /** Dedicated view discovery marker; the carrier body remains authoritative. */
  viewType?: string
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
  /** Internal typed frontmatter channel for the derived primary view marker. Undefined
   * preserves, an empty string clears, and a non-empty string sets `view:`. */
  viewType?: string
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
  /** Exact physical source observed by the read-model before an existing-note
   * write. Internal only; engines that receive it must bind publication to it. */
  expectedSource?: PhysicalIncarnation
  /** Identity materialization channel: when set the engine writes it into frontmatter
   *  (`notarium-id`). Engines that can't ignore it. */
  id?: string
  /** Host-internal PLANNED-DESTINATION guard, present only when a caller settled
   *  a destination's identity ahead of the write (a Markdown-tree import).
   *  Semantics apply only while the property is present:
   *
   *  - `null` — the plan expected a FREE path. The write publishes without
   *    replacing anything; an occupant carrying the planned `id` is the same
   *    plan replaying (a retry after a crash) and is allowed to converge.
   *  - a string — the destination must already be owned by exactly that
   *    identity. The body is replaced under a compare-and-swap; the identity is
   *    not.
   *
   *  Any other outcome is a conflict, never a retarget: an import that quietly
   *  wrote its note somewhere else, or over someone else's identity, is the
   *  failure this channel exists to make impossible. Ordinary callers omit it
   *  and keep the engine's existing create/overwrite behaviour.
   *  canon: docs/import.md#importing-a-markdown-tree-302 */
  expectedDestinationId?: string | null
  /** Trusted import provenance. Undefined carries an existing live locator;
   * fresh authored/raw frontmatter cannot mint this claim. */
  sourceLocator?: string
  /** Exact source-less predecessor path the foreign importer proved absent.
   * CachedStore alone re-checks it under the same mutation claim as create. */
  legacyPredecessorPath?: string
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
  /** Frontmatter the note ARRIVES with, host-internal (never on the wire): an imported file's
   *  own keys, carried verbatim as raw entries so an unmodelled one (a nested map, a plugin's
   *  field) survives (#280). Merged UNDER our typed fields — title/tags/created stay ours to
   *  decide — and over nothing on a create. The importer strips the keys it lifts and any
   *  `notarium-id` claim, so this cannot smuggle in an identity.
   *  canon: docs/import.md#drag-and-drop-of-text-files-223 */
  frontmatter?: readonly FrontmatterEntry[]
  /** Point patch over authored frontmatter. Missing keys stay untouched; null
   * removes one key. Host calls resolve byte-shape hints from the space schema. */
  fields?: FieldPatch
  /** Host-proven point intent: title/body/tags/resolver inputs are byte-equivalent
   * to the live note, so body-derived caches and indexes stay valid. */
  derivedContentUnchanged?: true
  /** Host-internal keys whose valid number/checkbox scalars may be emitted bare. */
  fieldsUnquoted?: string[]
  /** Host-internal full-state restore mode. `replace` makes the supplied raw
   * frontmatter the complete authored set instead of merging it into the live
   * file. Ordinary writes/imports omit it and retain merge semantics. */
  frontmatterMode?: 'replace'
  /** Host-internal restore intent: keep the live storage path even when the
   * restored title differs. A deleted note has no live path and ignores it. */
  preservePath?: boolean
  /** Host-internal legacy-restore intent: the historical row never captured
   * authored aliases, so a title rollback must not synthesize over the live
   * raw `aliases:` entry. Complete snapshots use replace semantics instead. */
  preserveAliases?: boolean
  /** Host-internal trash-restore destination. Unlike `directory` + `fileName`,
   * this is the complete space-relative tombstone path, so a deleted imported
   * basename and a prefixed class mount are restored exactly once. */
  restorePath?: string
  /** Journal attribution: 'pat:<user>:<id>' (agent), 'user:<name>' (human), 'ui' (mode none). */
  principal?: string
  /** Host-built agent audit channel. It never crosses the note write wire: the owner
   *  makes unbound writes auditable, while the session snapshot survives session GC. */
  agent?: AgentWriteAttribution
  /** Journal channel for non-plain-save writes: the restore flow records kind 'restore'. */
  journal?: { kind: 'restore'; sourceRevisionId: string }
}

export const AGENT_SESSION_ATTACH = {
  declared: 'declared',
  inferred: 'inferred',
} as const

export type AgentSessionAttach = (typeof AGENT_SESSION_ATTACH)[keyof typeof AGENT_SESSION_ATTACH]

export type AgentSessionAttribution = {
  id: string
  name: string
  attach: AgentSessionAttach
}

export type AgentWriteAttribution = {
  owner: string
  agent: string | null
  /** Transport-neutral identity of the operation that produced this revision. */
  agentCallId?: string
  session?: AgentSessionAttribution
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
  /** Adapter-opaque proof of the exact physical incarnation published by this
   * write. Conditional compensation must match it, not a semantic CAS token. */
  physicalWriteClaim?: PhysicalWriteClaim
  /** Complete internal alias state after the write. */
  legacyNameAliases?: readonly string[]
}

export type PhysicalWriteClaim = { kind: string; value: string }

export type PhysicalIncarnation = {
  claim: PhysicalWriteClaim
  owner: ExactOwnerObservation
}

export type PublishedResourceEvidence = {
  path: string
  source: Uint8Array
  ownerProof: StorageOwnerProof
  identity?: IdentityRecord
  document?: {
    role: DocumentRole
    pathFallbackTitle: string | null
    skillDirectoryName?: string | null
  }
  receipt: {
    id: string
    semanticEventTime: string
    candidateHash: string
    transitions: Array<{
      path: string
      before: { kind: 'present' | 'absent'; value: string }
      after: { kind: 'present' | 'absent'; value: string }
      mtimeMs: number | null
    }>
  }
}

export type MoveResult = {
  id?: string
  filePath?: string
  versionToken?: string
  legacyNameAliases?: readonly string[]
}

export type MoveInput = {
  /** A note-id, or — with isDirectory — the folder's storage path (folders have no identity beyond
   *  their place in the tree). */
  id: string
  destinationPath: string
  isDirectory?: boolean
  /** Internal engine-boundary discriminator for an enveloped note id. */
  identityOnly?: boolean
  /** Exact source bytes and owner observation captured by the caller before a
   * single-note destructive effect. Directory moves do not use it. */
  expectedSource?: PhysicalIncarnation
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
  /** sha-256 of the last state to resurrect; null = an honest gap (shown, not restorable). */
  contentHash: string | null
  restoreAvailability: RevisionRestoreAvailability
  /** Full-state marker copied from the delete tombstone. null = legacy partial. */
  stateFormat: Revision['stateFormat']
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
  /** Receipt-backed owner proof changes full document identity without changing
   * the user projection. Consumers must exact-read this state. */
  requiresExactState?: boolean
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
  /** Omitted keeps the field's historical natural direction. */
  dir?: SortDir
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
  fields?: FieldFilter
  /** Date range: inclusive local-day bounds on the selected axis. `dateField` absent = use the
   *  sort axis (`title` → `modified`); `tz` = minutes east of UTC. */
  from?: string
  to?: string
  tz?: number
  dateField?: DateField
  /** Stable-id membership set (favorites, q): keep only notes whose id is in it. */
  ids?: string[]
  /** Structural callers keep unknown-date rows; Feed's created window does not. */
  includeUndated?: boolean
}
export type BucketsQuery = {
  sort: 'created' | 'modified'
  group: BucketGran
  folder?: string
  depth: Depth
  folders?: string[]
  tags?: string[]
  fields?: FieldFilter
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
  sort?: NoteSort
  dir?: SortDir
}

/** Host-owned derived state that must settle inside a storage mutation's
 *  in-process fence. Engines ignore this; read-model decorators invoke the
 *  hooks immediately before / after their own mutation checkpoint. Hooks must
 *  not re-enter mutation methods on the same store (they already hold its claim). */
export type MutationOptions = {
  prepare?: () => void | Promise<void>
  finalize?: () => void | Promise<void>
  /** Host policy over the exact live note observed inside this mutation's claim.
   * The callback must stay pure: it already runs inside the store's claim and must
   * not re-enter mutation methods. */
  assertCurrent?: (note: NoteContent) => void | Promise<void>
  /** Host-owned bracket entered after the write claim is held and settled in its
   * own `finally`. Used when a caller must acquire a second authority in canonical
   * claim → authority order without releasing it before the physical write. */
  aroundWrite?: (write: () => Promise<WriteResult>) => Promise<WriteResult>
  /** Host-internal checkpoint under physical subtree admission and before its
   * atomic detach. */
  beforeDetach?: (victimNoteIds?: readonly string[]) => void | Promise<void>
  /** Host-internal checkpoint after an atomic subtree detach and before staging
   * bytes are destroyed. */
  afterDetach?: () => void | Promise<void>
  /** Make the write's journal append part of the operation instead of the normal
   * fire-and-forget history path. Reserved for compound host publications. */
  requiredRevision?: boolean
  /** Required-write hook after identity + journal settle and before the read-model
   * publishes the new note. */
  beforePublish?: (result: { id: string; versionToken: string }) => void | Promise<void>
  /** The trusted caller already owns the enclosing resource/package admission. */
  resourceAdmitted?: boolean
  /** Admit a canonical hidden-mount address supplied by trusted host code. */
  internalAddress?: boolean
}

export type RemoveOptions = {
  principal?: string
  agent?: AgentWriteAttribution
  identityOnly?: boolean
  /** Make the delete tombstone a required part of the physical removal. Package
   *  deletion uses this only after it has proved a single victim; multi-note
   *  callers need an atomic batch primitive instead of repeated required appends. */
  requiredRevision?: boolean
  /** Host-internal conditional compensation: remove only this exact state. */
  versionToken?: string
  /** Stronger host-internal ownership proof for compensating a publication. */
  physicalWriteClaim?: PhysicalWriteClaim
  /** Exact source incarnation required for a single-note removal. */
  expectedSource?: PhysicalIncarnation
  /** Same mutation-bound host policy as MutationOptions.assertCurrent. */
  assertCurrent?: MutationOptions['assertCurrent']
}

/** Host-only exact tag delta. Unlike a whole-document save, it reads live metadata
 * inside the note mutation fence and changes only the named tag values. */
export type TagMutationInput = {
  id: string
  add?: readonly string[]
  remove?: readonly string[]
  principal?: string
  agent?: AgentWriteAttribution
}

export type TagMutationResult = { changed: boolean; tags: string[] }

export type KnowledgeStore = {
  /** Hold this replica's file-truth reconciliation on its last committed
   * projection while a host-owned durable publication crosses physical and
   * terminal metadata cuts. The returned release is process-local admission,
   * not durability: the host operation/receipt/outbox own crash recovery. */
  beginCausalPublication?(): Promise<() => void>
  /** Adopt a restart-durable publication into a derived engine with the exact
   * physical receipt and owner proof, rather than rediscovering it as external. */
  adoptPublishedResource?(evidence: PublishedResourceEvidence): Promise<DocumentState>
  /** Host-only bridge for a durable cross-system publication. Metadata commits in
   * the host DB while the physical candidate is still fenced; priming keeps this
   * process's identity cache from inventing a second claimant when bytes appear. */
  primeCommittedIdentity?(record: IdentityRecord): Promise<void>
  confirmCommittedIdentity?(id: string): Promise<void>
  releasePrimedIdentity?(id: string): Promise<void>
  /** Every note's metadata; `opts.scope` applies class-visibility (ReadScope). */
  list(opts?: ListOptions): Promise<NoteMeta[]>
  /** The directory channel: every visible folder path, INCLUDING empty ones the note index can't
   *  see. A SEPARATE channel from list(). Optional (absent ⇒ the tree shows only note-backed folders). */
  listDirs?(): Promise<string[]>
  makeDir?(path: string, opts?: MutationOptions): Promise<void>
  /** Delete a folder subtree. A read-model-equipped store tombstones every child inside the same
   *  prefix mutation fence before removing the on-disk tree. */
  removeDir?(
    path: string,
    opts?: MutationOptions & { principal?: string; agent?: AgentWriteAttribution },
  ): Promise<void>
  /** Feed the engine current→past folder-path pairs so a path-form `[[oldpath/note]]` resolves to a
   *  renamed folder's note. A resolution HINT, not ownership; the bare engine stays alias-blind. */
  setFolderAliases?(aliases: ReadonlyArray<{ current: string; alias: string }>): void
  /** Authoritative stable-id → storage-path hints from an identity-owning decorator.
   *  A bare engine keys graph nodes by path but must still resolve authored `[[id]]`
   *  exactly, including unclaimed external files and copied duplicate claims. */
  setLinkIdentities?(
    identities: ReadonlyArray<{
      id: string
      path: string
      legacyNameAliases?: readonly string[]
    }>,
  ): void
  /** Bring ONE storage path onto `targetId` and PROVE the exact index row describes those very
   *  bytes — the convergence behind the global id arbiter (#327). OPTIONAL: without it a losing
   *  claimant's file keeps naming another space's note until someone saves through us (honest
   *  degradation, P5). canon: docs/core.md#identity */
  materializeIdentityAtPath?(input: IdentityMaterializationInput): Promise<IdentityMaterialization>
  /** Stream every source file for a base export. `opts.scope` reuses the visibility axis (a user
   *  export never sweeps hidden agent state; `all` includes its mounts, but not host/meta state).
   *  Raw on-disk bytes. Optional. */
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
  /** Batch body-derived facts without opening each note through the engine. Optional
   *  accelerator; partial output means callers fall back per missing id. */
  noteFacts?(ids: readonly string[]): Promise<Record<string, NoteFacts>>
  /** A synchronous cache-only peek so a notes window carries previews inline without an engine read.
   *  null = "cold, ask /api/previews". */
  previewPeek(id: string): Preview | null
  search(q: string, opts?: SearchOptions): Promise<SearchResult[]>
  /** The wikilink graph; `opts.scope` excludes agent-memory both as nodes AND as link targets. */
  graph(opts?: ReadSurfaceOptions): Promise<Graph>
  graphHealth?(): Promise<GraphHealth>
  write(input: WriteInput, opts?: MutationOptions): Promise<WriteResult>
  move(input: MoveInput, opts?: MutationOptions): Promise<MoveResult>
  /** `principal` is journal attribution — engines without a journal ignore it. */
  remove(id: string, opts?: RemoveOptions): Promise<void>
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
    viewerAuthor?: AuthorFilter
    noteId?: string
    through?: string
    activityVersion?: string
    afterId?: string
  }): Promise<{
    items: Revision[]
    total: number
    through: string | null
    nextAfterId: string | null
    activityVersion?: string
    scopeGate?: ActivityScopeGate
  }>
  activityGroups?(opts: {
    by: 'note' | 'folder'
    from?: string
    to?: string
    limit: number
    cursor?: ActivityGroupCursor
    through?: string
    activityVersion?: string
    locationThrough?: string
    location?: ActivityLocation
    scope?: ReadScope
    author?: AuthorFilter
    viewerAuthor?: AuthorFilter
  }): Promise<ActivityGroupsResult>
  activityProjection?(opts?: { scope?: ReadScope }): Promise<ActivityCurrentProjection>
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
    availability?: TrashAvailabilityFilter
    scope?: ReadScope
  }): Promise<{ items: TrashEntry[]; total: number; restorableTotal: number; partialTotal: number }>
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
    availability?: TrashAvailabilityFilter
    scope?: ReadScope
  }): Promise<{ purged: number }>
  readonly capabilities: StoreCapabilities
}
