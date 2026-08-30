import type { PoolClient } from 'pg'

import { canonicalReferenceId, referenceIdentityConflict } from '../../identityRefs'
import { type IdentityRow, lockIdentityRows, readIdentityRows } from './lockOrder'

const readIdentityClosure = async (client: PoolClient, noteIds: readonly string[]) => {
  const byId = new Map<string, IdentityRow>()
  const queried = new Set<string>()
  let frontier = [...new Set(noteIds)]

  while (frontier.length > 0) {
    const wanted = frontier.filter((id) => !queried.has(id))

    frontier = []
    wanted.forEach((id) => queried.add(id))
    for (const row of await readIdentityRows(client, wanted)) {
      byId.set(row.id, row)
      if (row.settlement_successor_id && !queried.has(row.settlement_successor_id)) {
        frontier.push(row.settlement_successor_id)
      }
    }
  }

  return byId
}

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

/** Enter tier 1 for a reference write: probe the explicit settlement-successor
 *  closure, then lock that whole declared id set in one pass. A successor linked after
 *  the probe is absent from the held rows and canonicalization returns a conflict,
 *  never a path-based guess.
 *
 *  One pass, not one per id: resolving in a loop enters tier 1 once per entry, in the
 *  client's order, which is a deadlock against any other writer resolving the same two
 *  ids the other way round. The twin lives in `drivers/sqlite`, where a single writer
 *  makes all of this unnecessary. */
export const enterIdentityTierForReferences = async (
  client: PoolClient,
  references: Iterable<string | { noteId: string }>,
): Promise<ReferenceIdentityScope> => {
  const wantedSet = new Set<string>()

  for (const reference of references) {
    wantedSet.add(typeof reference === 'string' ? reference : reference.noteId)
  }
  const wanted = [...wantedSet]
  const probed = await readIdentityClosure(client, wanted)
  const { rows } = await lockIdentityRows(client, [...wanted, ...probed.keys()])
  const byId = new Map(rows.map((row) => [row.id, row]))

  return {
    canonical: (noteSpace, noteId) => {
      const row = byId.get(noteId)

      return canonicalReferenceId(noteSpace, noteId, row, byId)
    },
    // The state that PROVES a lost membership is a retired identity WITH an explicit
    // settlement successor: `accepted` re-keys the pin onto the id that won,
    // tombstones the old one and records that durable lineage.
    //
    // A tombstone without lineage is an ordinary deleted note — even if another note
    // later reuses the path. Treating path occupancy as lineage moves rank/reference
    // state onto an unrelated note.
    //
    // A `foreign-owner` migration leaves no trace at all — the observed id stays live
    // with its durable owner — and it cannot be inferred from the scope's own space
    // either, because a loose pin is cross-space by design. So that half is
    // deliberately NOT detected: a stale reorder loses the migrated pin's rank, and
    // the next one (over a reloaded list) is correct. Guessing instead turned every
    // unpinned cross-space note into a permanent 409 and made the registry answer
    // whether an id exists in a space the caller cannot read.
    isRetired: (noteId) => {
      const row = byId.get(noteId)

      if (!row?.deleted_at || !row.settlement_successor_id) {
        return false
      }
      if (!byId.has(row.settlement_successor_id)) {
        throw referenceIdentityConflict(noteId)
      }

      return true
    },
  }
}
