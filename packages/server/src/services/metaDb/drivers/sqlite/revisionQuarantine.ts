import type { DatabaseSync } from 'node:sqlite'

import { REVISION_INTEGRITY } from '@notarium/core'

import { laterOrigins, ORIGINS_OF_NOTE_SQL } from '../../revisionProjection'
import { type ChainRow, dependenciesOf, planQuarantine } from '../../revisionQuarantine'

// Cast the BIGINT-ish columns to TEXT so the shared planner compares ids as the
// strings the port speaks, not as a mix of number/bigint per dialect.
const CHAIN_COLUMNS = `CAST(id AS TEXT) AS id, note_id, space,
    CAST(base_rev AS TEXT) AS base_rev, CAST(their_rev AS TEXT) AS their_rev,
    CAST(source_rev AS TEXT) AS source_rev, integrity`

/** Move this space's journal for `fromId` onto `toId` and mark every chain the
 *  collision contaminated — inside the caller's settlement transaction, so the
 *  history can never be half-repaired. The twin lives in `drivers/pg`.
 *  canon: docs/core.md#identity */
export const rekeyAndQuarantineRevisions = (
  db: DatabaseSync,
  { space, fromId, toId }: { space: string; fromId: string; toId: string },
): void => {
  if (fromId === toId) {
    return
  }
  const seed = db
    .prepare(`SELECT ${CHAIN_COLUMNS} FROM note_revisions WHERE space = ? AND note_id = ?`)
    .all(space, fromId) as ChainRow[]

  if (!seed.length) {
    return
  }
  const closure = new Map<string, ChainRow>()
  const byId = db.prepare(`SELECT ${CHAIN_COLUMNS} FROM note_revisions WHERE id = ?`)
  // Three seeks unioned, not one three-way OR: the OR form needs SQLite's
  // MULTI-INDEX OR optimization, which it only reaches while the database has no
  // `sqlite_stat1` — the day anything runs ANALYZE, the same query silently
  // becomes a full journal scan per row, inside the settlement transaction.
  const children = db.prepare(
    `SELECT ${CHAIN_COLUMNS} FROM note_revisions WHERE base_rev = ?
     UNION SELECT ${CHAIN_COLUMNS} FROM note_revisions WHERE their_rev = ?
     UNION SELECT ${CHAIN_COLUMNS} FROM note_revisions WHERE source_rev = ?`,
  )
  // Over parents AND children, across every space: a contaminated ancestor's
  // descendants are just as unreadable wherever they live. Traversal order is free
  // — the taint is resolved to a fixed point once the whole closure is in hand.
  const queue = [...seed]

  while (queue.length) {
    const row = queue.pop()!

    if (closure.has(row.id)) {
      continue
    }
    closure.set(row.id, row)
    for (const dependency of dependenciesOf(row)) {
      const parent = byId.get(Number(dependency)) as ChainRow | undefined

      if (parent && !closure.has(parent.id)) {
        queue.push(parent)
      }
    }
    for (const child of children.all(
      Number(row.id),
      Number(row.id),
      Number(row.id),
    ) as ChainRow[]) {
      if (!closure.has(child.id)) {
        queue.push(child)
      }
    }
  }

  const plan = planQuarantine(closure, { space, fromId })
  const rekey = db.prepare(`UPDATE note_revisions SET note_id = ? WHERE id = ?`)
  const quarantine = db.prepare(`UPDATE note_revisions SET integrity = ? WHERE id = ?`)

  for (const id of plan.rekeyTrusted) {
    rekey.run(toId, Number(id))
  }
  for (const id of plan.rekeyQuarantined) {
    rekey.run(toId, Number(id))
    quarantine.run(REVISION_INTEGRITY.quarantined, Number(id))
  }
  for (const id of plan.quarantineOnly) {
    quarantine.run(REVISION_INTEGRITY.quarantined, Number(id))
  }
  if (plan.rekeyTrusted.length || plan.rekeyQuarantined.length) {
    const origins = db
      .prepare(ORIGINS_OF_NOTE_SQL.replaceAll('%1', '?').replaceAll('%2', '?'))
      .all(space, toId) as Array<{ id: number }>
    const demote = db.prepare(`UPDATE note_revisions SET entry_role = 'change' WHERE id = ?`)

    for (const id of laterOrigins(origins.map((row) => String(row.id)))) {
      demote.run(Number(id))
    }
  }
  const affected = new Map<string, { space: string; noteId: string }>()

  for (const row of closure.values()) {
    affected.set(`${row.space}\u0000${row.note_id}`, { space: row.space, noteId: row.note_id })
  }
  affected.set(`${space}\u0000${toId}`, { space, noteId: toId })
  const dropHead = db.prepare('DELETE FROM revision_heads WHERE space = ? AND note_id = ?')
  const restoreHead = db.prepare(
    `INSERT INTO revision_heads (space, note_id, revision_id, semantic_fingerprint, lifecycle)
     SELECT space, note_id, id, semantic_fingerprint,
            CASE WHEN kind = 'delete' THEN 'deleted' ELSE 'live' END
       FROM note_revisions
      WHERE space = ? AND note_id = ? AND integrity = 'trusted'
      ORDER BY id DESC LIMIT 1`,
  )

  for (const pair of affected.values()) {
    dropHead.run(pair.space, pair.noteId)
    restoreHead.run(pair.space, pair.noteId)
  }
}
