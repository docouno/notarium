// WHAT a durable reference re-key writes, once — the SQL is per-dialect, the
// decisions are not. It moves THIS space's structurally-qualified references onto the
// claimant, inside the settlement transaction; the owner's own references and every
// unscoped authored payload stay exactly as they were.
// canon: docs/core.md#identity

import { STORE_ERROR_REASON } from '@notarium/core'

import type { ContextSetItemRef } from './types'

/** A payload we refuse to interpret. Malformed JSON rolls the whole settlement
 *  back rather than being normalised: silently dropping an entry we cannot parse
 *  would lose a user's curated membership behind an identity repair. */
const malformedReference = (subject: string): Error =>
  Object.assign(new Error(`refusing to re-key a malformed ${subject} payload`), {
    name: 'MalformedReferenceError',
  })

const parseItemsStrict = (raw: string | null, setId: string): ContextSetItemRef[] => {
  let value: unknown

  try {
    value = JSON.parse(raw ?? '[]')
  } catch {
    throw malformedReference(`context set ${setId} items`)
  }
  if (!Array.isArray(value)) {
    throw malformedReference(`context set ${setId} items`)
  }

  return value.map((entry) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof (entry as ContextSetItemRef).space !== 'string' ||
      typeof (entry as ContextSetItemRef).noteId !== 'string'
    ) {
      throw malformedReference(`context set ${setId} items`)
    }

    return {
      space: (entry as ContextSetItemRef).space,
      noteId: (entry as ContextSetItemRef).noteId,
    }
  })
}

/** The set's items with this space's `fromId` re-pointed at `toId`, positions kept
 *  and a post-rewrite duplicate collapsed onto its FIRST occurrence (the same
 *  idempotent-by-noteId rule `addItem` enforces). `null` = nothing to write. */
export const rekeyContextSetItems = (
  raw: string | null,
  setId: string,
  space: string,
  fromId: string,
  toId: string,
): string | null => {
  const items = parseItemsStrict(raw, setId)
  const rewritten = items.map((item) =>
    item.space === space && item.noteId === fromId ? { ...item, noteId: toId } : item,
  )

  if (rewritten.every((item, index) => item.noteId === items[index].noteId)) {
    return null
  }
  const seen = new Set<string>()
  const deduped = rewritten.filter((item) =>
    seen.has(item.noteId) ? false : (seen.add(item.noteId), true),
  )

  return JSON.stringify(deduped)
}

/** Which of two pin rows survives a merge. Pins are listed `created_at ASC`, so the
 *  oldest row IS the earliest position. */
export const earliestOf = <T extends { created_at: string }>(left: T, right: T): T =>
  right.created_at < left.created_at ? right : left

/** Which of two favourite rows survives a merge — by POSITION, which for favourites
 *  is not the same thing as by age. The list is `rank IS NULL, rank ASC,
 *  created_at DESC`: a ranked row always precedes an unranked one, and among
 *  unranked rows the NEWER one shows first. Merging on `created_at ASC` here would
 *  demote a favourite the user had dragged to the top down to its neighbour's slot. */
export const earlierFavorite = <T extends { created_at: string; rank: number | null }>(
  left: T,
  right: T,
): T => {
  if (left.rank == null || right.rank == null) {
    if (left.rank != null) {
      return left
    }
    if (right.rank != null) {
      return right
    }

    return right.created_at > left.created_at ? right : left
  }

  return right.rank < left.rank ? right : left
}

/** Re-point one scope's pin order at `toId` and hand back a DENSE sequence. An
 *  entry for `toId` that was already ranked wins its slot (first occurrence), so a
 *  merge of two memberships keeps the earlier position rather than the later. */
export const rekeyOrderEntries = <T extends { entry_kind: string; entry_ref: string }>(
  entries: readonly T[],
  fromId: string,
  toId: string,
): Array<T & { rank: number }> | null => {
  if (!entries.some((entry) => entry.entry_kind === 'pin' && entry.entry_ref === fromId)) {
    return null
  }
  const seen = new Set<string>()
  const kept: T[] = []

  for (const entry of entries) {
    const ref = entry.entry_kind === 'pin' && entry.entry_ref === fromId ? toId : entry.entry_ref
    const key = `${entry.entry_kind}:${ref}`

    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    kept.push({ ...entry, entry_ref: ref })
  }

  return kept.map((entry, rank) => ({ ...entry, rank }))
}

/** A reference write that raced an identity settlement and can no longer name a
 *  live note without guessing. `isConflict` is what makes the promise real: the
 *  caller gets a 409 it can retry against the settled world, not the 500 that would
 *  read as "the server is broken". */
export const referenceIdentityConflict = (noteId: string): Error =>
  Object.assign(
    new Error(`note ${noteId} changed identity while its reference was being written`),
    {
      name: 'ReferenceIdentityConflictError',
      isConflict: true,
      reason: STORE_ERROR_REASON.referenceIdentityConflict,
    },
  )

/** One identity row as a reference writer sees it. */
export type LiveIdentityRow = { id: string; space: string; file_path: string; deleted_at: unknown }

/** The id a reference must be stored under, decided from rows the caller has
 *  ALREADY locked (identity first, facets after). A live same-space id passes
 *  through; a retired one canonicalizes onto the single live row of the same
 *  `(space, file_path)`; a foreign owner or an ambiguous path is a conflict —
 *  never a guess.
 *
 *  An id this registry has never seen passes through UNCHANGED: it has no
 *  settlement to race with, and an engine that owns identity itself (the
 *  in-memory one) legitimately never writes a `note_identity` row. Refusing it
 *  would take favourites, sets and pins away from those hosts entirely.
 *
 *  `noteSpace` is the note's HOME space, which for a pin is not the scope's space:
 *  the only structural source of it is the locked membership row, so a membership a
 *  settlement moved out from under the request is a conflict, never a guessed rank.
 *  canon: docs/core.md#identity */
export const canonicalReferenceId = (
  noteSpace: string,
  noteId: string,
  row: LiveIdentityRow | undefined,
  liveAtPath: readonly LiveIdentityRow[],
): string => {
  if (!row) {
    return noteId
  }
  if (row.space !== noteSpace) {
    throw referenceIdentityConflict(noteId)
  }
  if (!row.deleted_at) {
    return noteId
  }
  // A tombstone with NOTHING live at its path is an ordinary deleted note, not a
  // re-key: a reference to it is stale exactly the way a reference to an id this
  // registry never knew is stale. A conflict here could never clear — a deleted
  // note does not return to its path on its own — and the caller is told to
  // retry, so it would take the scope out of service permanently.
  if (!liveAtPath.length) {
    return noteId
  }
  // Two live notes at one path is a real ambiguity: which one inherited the
  // reference is not knowable, and guessing moves it onto the wrong note.
  if (liveAtPath.length > 1) {
    throw referenceIdentityConflict(noteId)
  }

  return liveAtPath[0].id
}
