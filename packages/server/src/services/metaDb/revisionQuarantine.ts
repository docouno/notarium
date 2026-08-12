// Which journal rows survive a cross-space identity repair with their payload, and
// which are served as gaps from then on — the taint rules and the all-space walk.
// canon: docs/note-history.md#model · docs/core.md#identity

import { REVISION_INTEGRITY } from '@notarium/core'

/** The columns the closure walk needs; the drivers select exactly these. */
export type ChainRow = {
  id: string
  note_id: string
  space: string
  base_rev: string | null
  their_rev: string | null
  source_rev: string | null
  integrity: string
}

export const dependenciesOf = (row: ChainRow): string[] =>
  [row.base_rev, row.their_rev, row.source_rev].filter((id): id is string => id != null)

/** What the settlement must write for one `(space, fromId) → toId` transition. */
export type QuarantinePlan = {
  /** Claimant rows that keep their payload and take the new note id. */
  rekeyTrusted: string[]
  /** Claimant rows that take the new note id AND become gaps. */
  rekeyQuarantined: string[]
  /** Contaminated rows of the OWNER or a third space: integrity only, never re-keyed —
   *  their note id still means what it always meant in their own space. */
  quarantineOnly: string[]
}

/** Decide the plan over an already-closed dependency graph. `closure` must hold
 *  every row reachable from the claimant's chains through parents and children,
 *  in any space — a reference to a row that is no longer stored is simply absent
 *  from it, and contaminates nothing. */
export const planQuarantine = (
  closure: ReadonlyMap<string, ChainRow>,
  { space, fromId }: { space: string; fromId: string },
): QuarantinePlan => {
  const tainted = new Set<string>()

  for (const row of closure.values()) {
    if (row.integrity === REVISION_INTEGRITY.quarantined) {
      tainted.add(row.id)
      continue
    }
    for (const dependency of dependenciesOf(row)) {
      const parent = closure.get(dependency)

      // A dependency that is gone, already a gap, or belongs to another space or
      // another logical note is a seed: THIS row was built on state it cannot
      // account for. The parent itself may still be perfectly readable.
      if (
        !parent ||
        parent.integrity === REVISION_INTEGRITY.quarantined ||
        parent.space !== row.space ||
        parent.note_id !== row.note_id
      ) {
        tainted.add(row.id)
        break
      }
    }
  }
  // Contamination flows downstream only, so iterate to a fixed point. This is
  // O(closure²) in the worst case; the closure is bounded by the note's own chain
  // plus whatever crosses into it, and the walk that built it already dominates.
  for (let grew = true; grew;) {
    grew = false
    for (const row of closure.values()) {
      if (tainted.has(row.id)) {
        continue
      }
      if (dependenciesOf(row).some((dependency) => tainted.has(dependency))) {
        tainted.add(row.id)
        grew = true
      }
    }
  }

  const plan: QuarantinePlan = { rekeyTrusted: [], rekeyQuarantined: [], quarantineOnly: [] }

  for (const row of closure.values()) {
    const claimant = row.space === space && row.note_id === fromId

    if (claimant) {
      ;(tainted.has(row.id) ? plan.rekeyQuarantined : plan.rekeyTrusted).push(row.id)
      continue
    }
    if (tainted.has(row.id) && row.integrity !== REVISION_INTEGRITY.quarantined) {
      plan.quarantineOnly.push(row.id)
    }
  }

  return plan
}
