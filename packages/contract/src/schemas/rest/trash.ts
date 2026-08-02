import { z } from 'zod'
import { AuthorSchema, NoteClassSchema } from '../primitives'
import { RestoredNoteSchema } from './note'
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
  /** Whether the last body is recoverable (a blob is in the CAS). False only for
   *  an honest gap — an external delete whose final state never passed through us;
   *  the row still shows (so the deletion is visible) but restore can't resurrect
   *  it. The UI disables the restore action when false. */
  restorable: z.boolean(),
  /** The delete-tombstone revision id — provenance, and a handle to preview the
   *  last state via GET /api/note/revision. */
  revisionId: z.string(),
})

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
})

/** `total` is the trash population BEFORE the offset/limit slice. */
export const TrashResponseSchema = z.object({
  items: z.array(TrashItemSchema),
  total: z.number(),
  /** Of the same filtered trash population, how many rows are actually restorable
   *  (`contentHash != null`). Lets bulk restore show an honest CTA for the
   *  existing "select all N" path when some matching rows are honest gaps. */
  restorableTotal: z.number(),
})

/** POST /api/s/<slug>/trash/restore: resurrect a trashed note from its tombstone
 *  blob, keeping its note-id and last folder. Answers with SaveResponse (a
 *  restore IS a save). A note already living at the restore path is a typed
 *  error (note_already_exists), never a silent overwrite (P3). */
export const TrashRestoreRequestSchema = z.object({
  id: z.string(),
})

/** One failure inside a best-effort batch restore. `reason`, when
 *  present, is a machine-readable per-item cause; `error` is the human line. */
export const BatchFailureSchema = z.object({
  id: z.string(),
  error: z.string(),
  reason: z.string().optional(),
})

/** POST /api/s/<slug>/trash/restore-many: resurrect several trashed notes in one
 *  server round-trip. Two modes, mirroring purge:
 *  - `{ ids: [...] }` — restore exactly these rows (loaded multi-select).
 *  - `{ all: true, q? }` — restore EVERY trashed note matching the current
 *    search, without listing ids client-side (the existing "select all N" path).
 *  Best-effort and NON-transactional: successes restore immediately, failures are
 *  reported per id so the client can keep just those rows selected. `ids` wins
 *  when both are present. */
export const TrashRestoreManyRequestSchema = z
  .object({
    ids: z.array(z.string()).max(5000).optional(),
    all: z.boolean().optional(),
    q: z.string().optional(),
    /** Restore only rows whose body is actually recoverable (`restorable:true`).
     *  UI bulk restore uses this for the select-all-N path so honest-gap rows stay
     *  selected but are not counted in the action CTA or attempted server-side. */
    onlyRestorable: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.ids?.length) || v.all === true, {
    message: 'ids or all=true required',
  })

export const TrashRestoreManyResponseSchema = z.object({
  ok: z.literal(true),
  restored: z.array(RestoredNoteSchema),
  failed: z.array(BatchFailureSchema),
})

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
