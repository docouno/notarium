import { z } from 'zod'
import { AuthorSchema, NoteClassSchema } from '../primitives'
import {
  RestoreAvailabilitySchema,
  RestoreConflictReasonSchema,
  RestorePendingPhaseSchema,
  RevisionStateFormatSchema,
} from './history'
import { SpaceSchema } from './spaces'

/** One trashed note: the delete-tombstone, resolved for the UI. */
export const TrashItemSchema = z.object({
  /** The internal note-id (P7) — restore/purge address the note by it. */
  noteId: z.string(),
  title: z.string(),
  /** Last known storage location — where the note lived when deleted. Restore
   *  returns it here (or the space root when that folder is gone). null when the
   *  last path is unknown (an identity-capable engine that forgot it). */
  filePath: z.string().nullable(),
  /** The note's class — a surface may label the row; the window is already
   *  class-filtered server-side. */
  class: NoteClassSchema.optional(),
  /** When the note was deleted: the delete-tombstone's journal timestamp (full
   *  ISO, the honest-timestamps source). */
  deletedAt: z.string(),
  /** Who deleted it, resolved + privacy-filtered; null = an EXTERNAL delete
   *  (removed on disk / out-of-band — no principal to name). */
  deletedBy: AuthorSchema.nullable(),
  /** True when the delete was observed from OUTSIDE Notarium (principal-less):
   *  the UI marks it "deleted outside Notarium". Usually still restorable — the
   *  journal kept the last body (why this is separate from `restorable`). */
  external: z.boolean(),
  /** Backwards-compatible content marker: false only for an honest gap. Restore
   *  eligibility is the richer `restoreAvailability` field below; a present
   *  blob may still be opaque, blocked, unknown or unavailable on this host. */
  restorable: z.boolean(),
  restoreAvailability: RestoreAvailabilitySchema,
  /** Current exact, opaque or compatibility encoding. null means either a
   * legacy body-only snapshot or a gap; `restoreAvailability` distinguishes it. */
  stateFormat: RevisionStateFormatSchema,
  /** The delete-tombstone revision id — provenance, and a handle to preview the
   *  last state via GET /api/note/revision. */
  revisionId: z.string(),
})

export const TrashAvailabilityFilterSchema = z.enum(['restorable', 'unavailable'])

/** GET /api/s/<slug>/trash query: a window over the space's trash, newest-deleted
 *  first. */
export const TrashQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  /** Optional case-insensitive substring filter over the note TITLE — the trash
   *  search. Empty/absent = the whole trash. Applied server-side so it
   *  scopes the window + `total` (scales past one page). Title only: the journal
   *  is path-free (P7) — the last path is an identity-registry join the search
   *  doesn't reach; title is what a user looks a deleted note up by anyway. */
  q: z.string().optional(),
  /** Recovery outcome filter. It is independent from selection: the same rows
   * remain eligible for permanent deletion, while bulk Restore only acts on the
   * recoverable subset. */
  availability: TrashAvailabilityFilterSchema.optional(),
})

/** `total` is the trash population BEFORE the offset/limit slice. */
export const TrashResponseSchema = z.object({
  items: z.array(TrashItemSchema),
  total: z.number(),
  /** Of the same filtered trash population, how many rows the strict durable
   *  bulk capability can restore. Zero when that capability is unavailable. */
  restorableTotal: z.number(),
  /** Restorable legacy rows inside the same filtered population. A client uses
   * this to warn before a bulk operation that includes incomplete copies. */
  partialTotal: z.number(),
  /** Host capability, separate from intrinsic item state. When false, otherwise
   * exact/partial rows are served as capability-unavailable. */
  restoreAvailable: z.boolean(),
})

/** POST /api/s/<slug>/trash/restore: strict idempotent resurrection from one
 *  tombstone, keeping note-id and last folder. The response may be pending while
 *  crash recovery completes; conflicts and non-restorable state are terminal. */
export const TrashRestoreRequestSchema = z.object({
  id: z.string(),
  revisionId: z.string(),
  idempotencyKey: z.string().min(1).max(200),
})

/** One failure inside the legacy best-effort space-restore batch. `reason`, when
 *  present, is a machine-readable per-item cause; `error` is the human line. */
export const BatchFailureSchema = z.object({
  id: z.string(),
  error: z.string(),
  reason: z.string().optional(),
})

/** POST /api/s/<slug>/trash/restore-many: accept or resume one durable ordered
 *  restore roster. Two selection modes, mirroring purge:
 *  - `{ ids: [...] }` — restore exactly these rows (loaded multi-select).
 *  - `{ all: true, q? }` — restore EVERY trashed note matching the current
 *    search, without listing ids client-side (the existing "select all N" path).
 *  Selection is frozen when the parent operation is accepted. Every item then
 *  runs the strict single-note protocol under a deterministic child key. Repeating
 *  the same principal/key/payload resumes the parent; changing the payload for the
 *  same key is a conflict. `ids` wins when both are present. */
export const TrashRestoreManyRequestSchema = z
  .object({
    ids: z.array(z.string()).max(5000).optional(),
    all: z.boolean().optional(),
    q: z.string().optional(),
    /** For all-mode, freeze only rows classified as full/partial by the public
     *  restore predicate. Explicit ids stay explicit and receive per-item terminal
     *  outcomes even when not restorable. */
    onlyRestorable: z.boolean().optional(),
    idempotencyKey: z.string().min(1).max(200),
  })
  .refine((v) => Boolean(v.ids?.length) || v.all === true, {
    message: 'ids or all=true required',
  })

const BulkRestoreItemBaseSchema = z.object({
  id: z.string(),
  revisionId: z.string().nullable(),
})

export const BulkRestoreConflictReasonSchema = z.union([
  RestoreConflictReasonSchema,
  z.literal('note_not_in_trash'),
])

export const BulkRestoreItemSchema = z.discriminatedUnion('status', [
  BulkRestoreItemBaseSchema.extend({ status: z.literal('queued') }),
  BulkRestoreItemBaseSchema.extend({
    revisionId: z.string(),
    status: z.literal('pending'),
    operationId: z.string(),
    phase: RestorePendingPhaseSchema,
  }),
  BulkRestoreItemBaseSchema.extend({
    revisionId: z.string(),
    status: z.literal('succeeded'),
    operationId: z.string(),
    restoredRevisionId: z.string(),
    filePath: z.string(),
    versionToken: z.string(),
  }),
  BulkRestoreItemBaseSchema.extend({
    status: z.literal('conflict'),
    operationId: z.string().optional(),
    reason: BulkRestoreConflictReasonSchema,
  }),
  BulkRestoreItemBaseSchema.extend({
    revisionId: z.string(),
    status: z.literal('not-restorable'),
    operationId: z.string(),
    reason: z.string(),
  }),
])

export const BulkRestoreCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  conflict: z.number().int().nonnegative(),
  notRestorable: z.number().int().nonnegative(),
})

const BulkRestoreProgressSchema = z.object({
  status: z.enum(['running', 'completed']),
  operationId: z.string(),
  items: z.array(BulkRestoreItemSchema),
  counts: BulkRestoreCountsSchema,
})

export const TrashRestoreManyResponseSchema = z.discriminatedUnion('status', [
  BulkRestoreProgressSchema.extend({ status: z.literal('running') }),
  BulkRestoreProgressSchema.extend({ status: z.literal('completed') }),
  z.object({
    status: z.literal('conflict'),
    error: z.string(),
    operationId: z.string(),
    reason: z.literal('idempotency-conflict'),
  }),
  z.object({ status: z.literal('busy'), error: z.string(), reason: z.string() }),
])

/** POST /api/s/<slug>/trash/purge: irreversibly erase trashed notes (journal rows
 *  + GC orphan blobs). Two modes:
 *  - `{ ids: [...] }` — erase exactly these (a multi-select delete / one note).
 *  - `{ all: true, q? }` — erase EVERY trashed note matching the search `q`
 *    (the "Select all N" path), without listing ids client-side (scales past one
 *    page). `ids` wins when both are present. */
export const TrashPurgeRequestSchema = z.object({
  ids: z.array(z.string()).max(5000).optional(),
  all: z.boolean().optional(),
  q: z.string().optional(),
  /** Keeps Select-all-N scoped to the active recovery filter. */
  availability: TrashAvailabilityFilterSchema.optional(),
})

/** `purged` is how many notes were erased. */
export const TrashPurgeResponseSchema = z.object({
  ok: z.literal(true),
  purged: z.number(),
})

/** POST /api/spaces/restore-many: un-archive several spaces in one host-
 *  level request. Best-effort and NON-transactional, matching the trash batch:
 *  each id either returns its restored Space row or a per-item failure. */
export const RestoreSpacesRequestSchema = z.object({
  ids: z.array(z.string()).min(1).max(5000),
})

export const RestoreSpacesResponseSchema = z.object({
  ok: z.literal(true),
  restored: z.array(SpaceSchema),
  failed: z.array(BatchFailureSchema),
})

export type TrashItem = z.infer<typeof TrashItemSchema>

export type TrashAvailabilityFilter = z.infer<typeof TrashAvailabilityFilterSchema>

export type TrashQuery = z.infer<typeof TrashQuerySchema>

export type TrashResponse = z.infer<typeof TrashResponseSchema>

export type TrashRestoreRequest = z.infer<typeof TrashRestoreRequestSchema>

export type BatchFailure = z.infer<typeof BatchFailureSchema>

export type TrashRestoreManyRequest = z.infer<typeof TrashRestoreManyRequestSchema>

export type TrashRestoreManyResponse = z.infer<typeof TrashRestoreManyResponseSchema>

export type TrashPurgeRequest = z.infer<typeof TrashPurgeRequestSchema>

export type TrashPurgeResponse = z.infer<typeof TrashPurgeResponseSchema>

export type RestoreSpacesRequest = z.infer<typeof RestoreSpacesRequestSchema>

export type RestoreSpacesResponse = z.infer<typeof RestoreSpacesResponseSchema>
