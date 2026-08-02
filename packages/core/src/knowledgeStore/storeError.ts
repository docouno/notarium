import { STORE_ERROR_REASON } from './consts'
import type { ConflictNote } from './knowledgeStore'

/**
 * Error vocabulary between engines and hosts. Hosts map the flags to transport
 * codes (HTTP: isToolError → 400, isUnavailable → 503 + `reason`,
 * isNotFound → 404 + `reason`, isConflict → 409 + `current`, else 500).
 * Engines may throw their own subclasses (e.g. the MCP client's error) — hosts
 * read the flags, not the class, so any Error carrying them works.
 */
export class StoreError extends Error {
  /** The caller's fault: bad id, occupied destination, invalid input. */
  isToolError?: boolean
  /** The engine can't be reached at all (down / timing out) — retryable. */
  isUnavailable?: boolean
  /** The reference resolves to no note. First-class on purpose (layer 1):
   *  engines must not improvise — the prior engine used to pass garbage through
   *  and the e2e fake fabricated an empty note, hiding this class of bug. */
  isNotFound?: boolean
  /** The save's version_token went stale: someone wrote between the caller's
   *  read and this write (P3) — nothing was overwritten. */
  isConflict?: boolean
  /** The live note (id + fresh versionToken) riding the conflict to the 409
   *  envelope, so the loser sees the other side instead of losing it. */
  current?: ConflictNote
  /** Machine-readable cause for the wire envelope, e.g. "engine_unreachable". */
  reason?: string
}

/** A note reference that resolves to nothing — every engine throws this same
 *  shape so hosts and the contract spec see one behaviour. */
export const noteNotFound = (id: string): StoreError => {
  const err = new StoreError(`note not found: ${id}`)
  err.isNotFound = true
  err.reason = STORE_ERROR_REASON.noteNotFound
  return err
}

/** A create that must NOT clobber (`ifExists:'fail'`) found a note already
 *  living at its slug(title) destination. The plain create path UPSERTS by path
 *  on purpose (UI re-save, retry-dedup) — but an intent-create from an agent
 *  (`remember_about_project`, a fresh `remember_about_user` category) must be
 *  additive, never silently overwrite a same-titled note. The caller's mistake:
 *  edit the existing note or pick another title. */
export const noteAlreadyExists = (title: string): StoreError => {
  const err = new StoreError(
    `a note titled "${title}" already exists here — edit it instead of creating a duplicate, or use a different title`,
  )
  err.isToolError = true
  err.reason = STORE_ERROR_REASON.noteAlreadyExists
  return err
}

/** An update (original_id) arrived without a version_token. Strict on
 *  purpose — for the UI and for programmatic clients alike: a writer that
 *  can't say what it read must not overwrite. */
export const versionTokenRequired = (id: string): StoreError => {
  const err = new StoreError(`version_token required to update ${id}`)
  err.isToolError = true
  err.reason = STORE_ERROR_REASON.versionTokenRequired
  return err
}

/** The compare-and-swap failed: the note changed after the writer's read.
 *  `current` is the live note with a fresh token — the 409 envelope's payload. */
export const versionConflict = (current: ConflictNote): StoreError => {
  const err = new StoreError(`note changed since read: ${current.id}`)
  err.isConflict = true
  err.reason = STORE_ERROR_REASON.versionConflict
  err.current = current
  return err
}

/** A revision reference that resolves to nothing under the given note —
 *  unknown id, or a revision that belongs to another note. */
export const revisionNotFound = (revisionId: string): StoreError => {
  const err = new StoreError(`revision not found: ${revisionId}`)
  err.isNotFound = true
  err.reason = STORE_ERROR_REASON.revisionNotFound
  return err
}

/** A restore aimed at a revision whose body the journal honestly doesn't have
 *  (an external gap marker) — the caller's mistake, not a server fault. */
export const revisionHasNoContent = (revisionId: string): StoreError => {
  const err = new StoreError(`revision has no content to restore: ${revisionId}`)
  err.isToolError = true
  err.reason = STORE_ERROR_REASON.revisionHasNoContent
  return err
}

/** A restore-from-trash named a note that isn't in the trash — never
 *  deleted, or already restored/purged. The caller's mistake (a stale trash
 *  list), not a server fault. */
export const noteNotInTrash = (id: string): StoreError => {
  const err = new StoreError(`note is not in the trash: ${id}`)
  err.isNotFound = true
  err.reason = STORE_ERROR_REASON.noteNotInTrash
  return err
}

/** The journal surface was asked on a host whose store doesn't journal (a bare
 *  engine without the read-model layer) — honest capability degradation. */
export const revisionsUnavailable = (): StoreError => {
  const err = new StoreError('this host does not journal revisions')
  err.isNotFound = true
  err.reason = STORE_ERROR_REASON.revisionsUnavailable
  return err
}
