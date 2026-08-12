// Domain constants for the KnowledgeStore port.

/** The default space handle a store serves when the host wires none — the
 *  single-space fallback (the composition root normally passes a real space).
 *  One source so the read-model and the identity registry can't drift. */
export const DEFAULT_SPACE = 'main'

/** A note's CLASS: the policy-bearing kind of a note — the class
 *  registry (v1). Class is mount-derived and enforced there, never a per-file
 *  choice; the policy matrix that hangs off each class lives in the visibility
 *  module (visibility/policy.ts). Reserved-but-not-v1: `chat`,
 *  `encrypted-note` (per-note, security milestone).
 *  canon: docs/note-model.md#note-classes */
export const NOTE_CLASS = {
  userDoc: 'user-doc',
  attachment: 'attachment',
  derived: 'derived',
  agentMemory: 'agent-memory',
  profile: 'profile',
  skill: 'skill',
} as const

/** Machine-readable error reasons the store's engines put on `StoreError.reason`
 *  for the wire envelope. Hosts still map the boolean flags to transport
 *  codes; this vocabulary only names the machine-readable cause. The contract
 *  package carries no matching const source (only an inline
 *  `z.literal('version_conflict')`), so there is no cross-package drift gate. */
export const STORE_ERROR_REASON = {
  noteNotFound: 'note_not_found',
  noteAlreadyExists: 'note_already_exists',
  versionTokenRequired: 'version_token_required',
  versionConflict: 'version_conflict',
  revisionNotFound: 'revision_not_found',
  revisionHasNoContent: 'revision_has_no_content',
  noteNotInTrash: 'note_not_in_trash',
  revisionsUnavailable: 'revisions_unavailable',
  memoryConvergenceExhausted: 'memory_convergence_exhausted',
  /** A reference write lost a race with an identity settlement — retryable (#327). */
  referenceIdentityConflict: 'reference_identity_conflict',
} as const

/** What a CREATE does when a note already occupies its destination path.
 *  `fail` is the DEFAULT — an unset policy never clobbers; only `overwrite`
 *  permits replacing another note's bytes, and it stays host-internal (the wire
 *  offers `fail`/`uniquify` only).
 *  canon: docs/note-model.md#create-collisions */
export const IF_EXISTS = {
  /** Refuse with `noteAlreadyExists`. */
  fail: 'fail',
  /** Land beside it under the next free name (`Plans` → `Plans 2`). */
  uniquify: 'uniquify',
  /** Upsert onto the occupied path — idempotent re-import only. */
  overwrite: 'overwrite',
} as const

/** The visibility SCOPE a discovery surface reads under. `user` is the
 *  default (user-visible classes only); callers opt INTO hidden classes explicitly
 *  with `agentRecall` (adds agent-memory, the recall path) or `all` (the
 *  unfiltered population).
 *  canon: docs/note-model.md#note-classes */
export const READ_SCOPE = {
  user: 'user',
  agentRecall: 'agentRecall',
  all: 'all',
} as const

/** The delta-sync SCAN phase. */
export const SCAN_PHASE = {
  cold: 'cold',
  notes: 'notes',
  graph: 'graph',
  ready: 'ready',
  error: 'error',
} as const

/** How a wikilink RESOLVED to its target. */
export const RESOLVED_VIA = {
  current: 'current',
  slug: 'slug',
  noteAlias: 'note-alias',
  folderAlias: 'folder-alias',
} as const

/** The list-layer SORT axis. */
export const NOTE_SORT = {
  created: 'created',
  modified: 'modified',
  title: 'title',
} as const

/** The DATE axis a range filter runs on. */
export const DATE_FIELD = {
  created: 'created',
  modified: 'modified',
} as const

/** The histogram BUCKET granularity. */
export const BUCKET_GRAN = {
  day: 'day',
  week: 'week',
  month: 'month',
} as const

/** The KIND of state a journaled revision records.
 *  canon: docs/note-history.md#model */
export const REVISION_KIND = {
  /** A save through us (the CAS write path). */
  write: 'write',
  /** A state the delta sync observed arriving from outside (or the pre-edit
   *  baseline captured by the first journaled write of a note). A null
   *  contentHash marks an honest gap: we saw the change but couldn't read the
   *  body. */
  external: 'external',
  /** A journaled revision written back over the live note (rollback). */
  restore: 'restore',
  /** A merge of two concurrent sides — reserved for the P3/P6 ladder; the schema
   *  keeps both parents (baseRevisionId + theirRevisionId) and the merging
   *  principal so that flow lands without a migration. */
  merge: 'merge',
  /** The note disappeared (deleted through us or externally). Carries the last
   *  known content hash so an undelete flow can resurrect from the journal. */
  delete: 'delete',
} as const

/** Whether a journaled row can still be believed. `quarantined` is set when a
 *  cross-space id collision contaminated the note's chain (#327): the row keeps
 *  its structural place — id, note, space, kind, time — and nothing else is
 *  served from it. canon: docs/note-history.md#model · docs/core.md#identity */
export const REVISION_INTEGRITY = { trusted: 'trusted', quarantined: 'quarantined' } as const

/** What a journal entry IS in the life of its note, decided by the writer at append
 *  and stored on the row. No consumer infers it: the approximation everyone used to
 *  share (`kind='external' AND base_rev IS NULL`) stopped meaning "first entry" the
 *  moment quarantine arrived — after it, a note has no trusted parent either (#327).
 *  canon: docs/note-history.md#model */
export const REVISION_ENTRY_ROLE = {
  /** The note appeared through us — its first journaled state, written by us. */
  origin: 'origin',
  /** A synthetic pre-edit state, or the first sighting of a note that already
   *  existed outside. Real history, but not activity: counting it would double a
   *  pre-existing note's first edit. */
  baseline: 'baseline',
  /** Every later state of a note that already has journal entries. */
  change: 'change',
} as const

/** Why a journal entry is served as a GAP. One value today; the field exists so a
 *  future reason is an additive wire change rather than a new shape. */
export const REVISION_UNAVAILABLE_REASON = { identityConflict: 'identity-conflict' } as const

/** The one label a gap carries. Not the note's title — that is withheld — and not
 *  an empty string either, which every surface would render as "Untitled". */
export const REVISION_UNAVAILABLE_TITLE = 'Unavailable revision'

/** Folder-scope depth. */
export const DEPTH = { subtree: 'subtree', direct: 'direct' } as const

export type Depth = (typeof DEPTH)[keyof typeof DEPTH]
export type IfExists = (typeof IF_EXISTS)[keyof typeof IF_EXISTS]
export type RevisionKind = (typeof REVISION_KIND)[keyof typeof REVISION_KIND]
export type RevisionEntryRole = (typeof REVISION_ENTRY_ROLE)[keyof typeof REVISION_ENTRY_ROLE]
export type RevisionUnavailableReason =
  (typeof REVISION_UNAVAILABLE_REASON)[keyof typeof REVISION_UNAVAILABLE_REASON]
export type NoteClass = (typeof NOTE_CLASS)[keyof typeof NOTE_CLASS]
export type ReadScope = (typeof READ_SCOPE)[keyof typeof READ_SCOPE]
export type ScanPhase = (typeof SCAN_PHASE)[keyof typeof SCAN_PHASE]
export type ResolvedVia = (typeof RESOLVED_VIA)[keyof typeof RESOLVED_VIA]
export type NoteSort = (typeof NOTE_SORT)[keyof typeof NOTE_SORT]
export type DateField = (typeof DATE_FIELD)[keyof typeof DATE_FIELD]
export type BucketGran = (typeof BUCKET_GRAN)[keyof typeof BUCKET_GRAN]
