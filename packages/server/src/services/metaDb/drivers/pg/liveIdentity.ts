import type { PoolClient } from 'pg'

import { canonicalReferenceId, referenceIdentityConflict } from '../../identityRefs'
import {
  type IdentityRow,
  lockIdentityRows,
  readIdentityRows,
  readLiveIdentityAtPaths,
} from './lockOrder'

const pathKey = (row: { space: string; file_path: string }): string =>
  `${row.space}\u0000${row.file_path}`

/** What a reference writer may conclude about the ids it is about to store, decided
 *  ENTIRELY from rows this transaction holds. Both answers are pure: the queries ran
 *  at tier-1 entry, so no facet lock can sit between the read and the decision. */
export type ReferenceIdentityScope = {
  /** The id a reference must be stored under. A route's pre-resolve is an auth
   *  check, not a consistency proof (#327). */
  canonical(noteSpace: string, noteId: string): string
  /** Whether an order entry with NO membership in this scope lost one to a
   *  settlement, rather than never having had one. */
  isRetired(noteId: string): boolean
}

/** Enter tier 1 for a reference write: probe the ids this transaction may store,
 *  then lock them TOGETHER WITH the live rows standing at any tombstone's path, in
 *  one pass. The probe exists only to widen that set — a successor discovered after
 *  the entry is a row this transaction does not hold, and an answer derived from it
 *  is a conflict rather than a guess.
 *
 *  One pass, not one per id: resolving in a loop enters tier 1 once per entry, in the
 *  client's order, which is a deadlock against any other writer resolving the same two
 *  ids the other way round. The twin lives in `drivers/sqlite`, where a single writer
 *  makes all of this unnecessary. */
export const enterIdentityTierForReferences = async (
  client: PoolClient,
  noteIds: readonly string[],
): Promise<ReferenceIdentityScope> => {
  const wanted = [...new Set(noteIds)]
  const probed = await readIdentityRows(client, wanted)
  const probedSuccessors = await readLiveIdentityAtPaths(
    client,
    probed
      .filter((row) => row.deleted_at)
      .map((row) => ({ space: row.space, filePath: row.file_path })),
  )
  const { lock, rows } = await lockIdentityRows(client, [
    ...wanted,
    ...probedSuccessors.map((row) => row.id),
  ])
  const declared = new Set(lock.declared)
  const byId = new Map(rows.map((row) => [row.id, row]))
  const retired = rows.filter((row) => row.deleted_at)
  // Re-read UNDER the hold: whatever stands at those paths now is what the decision
  // rests on, and any of it outside `declared` committed after this transaction
  // entered the tier.
  const liveAtPath = new Map<string, IdentityRow[]>()

  for (const live of await readLiveIdentityAtPaths(
    client,
    retired.map((row) => ({ space: row.space, filePath: row.file_path })),
  )) {
    const key = pathKey(live)

    liveAtPath.set(key, [...(liveAtPath.get(key) ?? []), live])
  }
  const successorsOf = (row: IdentityRow | undefined): IdentityRow[] =>
    row?.deleted_at ? (liveAtPath.get(pathKey(row)) ?? []) : []

  return {
    canonical: (noteSpace, noteId) => {
      const row = byId.get(noteId)
      const successors = successorsOf(row)

      for (const successor of successors) {
        if (!declared.has(successor.id)) {
          throw referenceIdentityConflict(noteId)
        }
      }

      return canonicalReferenceId(noteSpace, noteId, row, successors)
    },
    // The state that PROVES a lost membership is a retired identity WITH a live note
    // standing at its path: `accepted` re-keys the pin onto the id that won and
    // tombstones the old one, and that successor is the trace it leaves.
    //
    // A tombstone with nothing at its path is an ordinary deleted note — the same
    // judgement `canonicalReferenceId` makes, and for the same reason: a conflict
    // there could never clear, so the scope would be unreorderable for good.
    //
    // A `foreign-owner` migration leaves no trace at all — the observed id stays live
    // with its durable owner — and it cannot be inferred from the scope's own space
    // either, because a loose pin is cross-space by design. So that half is
    // deliberately NOT detected: a stale reorder loses the migrated pin's rank, and
    // the next one (over a reloaded list) is correct. Guessing instead turned every
    // unpinned cross-space note into a permanent 409 and made the registry answer
    // whether an id exists in a space the caller cannot read.
    isRetired: (noteId) => successorsOf(byId.get(noteId)).length > 0,
  }
}
