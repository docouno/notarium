import { STORE_ERROR_REASON } from './consts'
import type { ConflictNote, ExistingNote } from './knowledgeStore'

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
  /** The note already sitting at a refused create's destination — same idea as
   *  `current`, for `noteAlreadyExists`. */
  existing?: ExistingNote
  /** The title an `ifExists:'uniquify'` retry would land on — a preview for the
   *  caller's "save as …" offer, not a reservation: a racing writer can take it, and
   *  the save then answers the name it actually got. Absent BESIDE a known `existing`
   *  means the whole series is taken and retrying cannot help. */
  suggestedTitle?: string
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

/** A create found a note already living at its slug(title) destination and
 *  refused rather than replace its bytes — the default for every create channel.
 *  The caller's move: edit that note, pick another title, or ask for
 *  `ifExists:'uniquify'`. `details` are what only the read-model can supply — the
 *  occupant's identity and the name a uniquify retry would take — so a refusal from
 *  an engine's disk truth simply carries neither. */
export const noteAlreadyExists = (
  title: string,
  details?: { existing?: ExistingNote; suggestedTitle?: string },
): StoreError => {
  const err = new StoreError(
    `a note titled "${title}" already exists here — edit it instead of creating a duplicate, or use a different title`,
  )
  err.isToolError = true
  err.reason = STORE_ERROR_REASON.noteAlreadyExists
  if (details?.existing) {
    err.existing = details.existing
  }
  if (details?.suggestedTitle) {
    err.suggestedTitle = details.suggestedTitle
  }

  return err
}

/** Two immutable package ids cannot publish the same Agent Skill name inside
 * one placement. The manifest name is the user's lookup/display key, so this is
 * a typed conflict rather than a generic malformed-write error. */
export const skillNameConflict = (name: string): StoreError => {
  const err = new StoreError(`skill name "${name}" already exists in this placement`)
  err.isConflict = true
  err.reason = STORE_ERROR_REASON.skillNameConflict

  return err
}

/** A write that named the identity it EXPECTED to find at its destination found
 *  another one — or found the path taken when it planned on a free one. The
 *  refusal exists because the alternative is silent: an ordinary overwrite would
 *  replace that note's bytes AND its identity, and every link pointing at it
 *  would resolve to a note nobody meant to write.
 *  canon: docs/import.md#importing-a-markdown-tree-302 */
export const destinationOwnerConflict = (path: string, detail: string): StoreError => {
  const err = new StoreError(`planned destination ${path} ${detail}`)

  err.isToolError = true
  err.reason = STORE_ERROR_REASON.destinationOwnerConflict

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

/** A bounded category append did not converge; `current` is one coherent live snapshot.
 *  @see docs/note-model.md#agent-memory */
export const memoryConvergenceExhausted = (
  category: string,
  foreignCommits: number,
  current: ConflictNote,
): StoreError => {
  const err = new StoreError(
    `memory category "${category}" is being rewritten concurrently — nothing was recorded after ${foreignCommits} intervening commit(s)`,
  )
  err.isConflict = true
  err.reason = STORE_ERROR_REASON.memoryConvergenceExhausted
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

/** A revision whose body WAS captured and which this reader cannot project. The caller's
 *  copy is not lost and not absent; this server just cannot open it, and no retry changes
 *  that. A tool error rather than a fault for the same reason as the gap above: nothing on
 *  this server is broken, and the answer will not differ next time. */
export const revisionContentUnreadable = (revisionId: string): StoreError => {
  const err = new StoreError(`revision content cannot be read by this server: ${revisionId}`)
  err.isToolError = true
  err.reason = STORE_ERROR_REASON.revisionContentUnreadable
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

export const activityCutInvalid = (cut: string): StoreError => {
  const err = new StoreError(`activity source cut is invalid: ${cut}`)
  err.isToolError = true
  err.reason = STORE_ERROR_REASON.activityCutInvalid
  return err
}

export const activityLocationStale = (): StoreError => {
  const err = new StoreError('activity location cut is stale; reload the grouped overview')
  err.isConflict = true
  err.reason = STORE_ERROR_REASON.activityLocationStale
  return err
}

export const activityProjectionInvalid = (): StoreError => {
  const err = new StoreError('activity projection snapshot is invalid')
  err.isToolError = true
  err.reason = STORE_ERROR_REASON.activityProjectionInvalid
  return err
}

export const activityProjectionStale = (): StoreError => {
  const err = new StoreError('activity projection changed; reload the Activity overview')
  err.isConflict = true
  err.reason = STORE_ERROR_REASON.activityProjectionStale
  return err
}

export const activityProjectionRebuilding = (): StoreError => {
  const err = new StoreError('activity summary is rebuilding')
  err.isUnavailable = true
  err.reason = STORE_ERROR_REASON.activityProjectionRebuilding
  return err
}
