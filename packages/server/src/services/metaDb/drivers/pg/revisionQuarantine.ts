import type { PoolClient } from 'pg'
import { REVISION_INTEGRITY } from '@notarium/core'

import { laterOrigins, ORIGINS_OF_NOTE_SQL } from '../../revisionProjection'
import { type ChainRow, dependenciesOf, planQuarantine } from '../../revisionQuarantine'
import {
  REVISION_CHAIN_COLUMNS as CHAIN_COLUMNS,
  lockRevisionChainRows,
  lockRevisionChainRowsOfNote,
  lockRevisionWideScan,
} from './lockOrder'
import { lockRevisionKeys } from './revisionLocks'

/** Walk the contamination closure over parents AND children across every space —
 *  a contaminated ancestor's descendants are just as unreadable wherever they live.
 *  Breadth-first by LEVEL, one round trip per level rather than two per row: this
 *  runs inside the settlement transaction, so every avoidable query is a lock the
 *  whole meta-DB waits on. The traversal order is otherwise free — the taint is
 *  resolved to a fixed point afterwards. */
const walkClosure = async (
  client: PoolClient,
  seed: readonly ChainRow[],
): Promise<Map<string, ChainRow>> => {
  const closure = new Map<string, ChainRow>()
  let frontier = [...seed]

  while (frontier.length) {
    const fresh = frontier.filter((row) => !closure.has(row.id))

    for (const row of fresh) {
      closure.set(row.id, row)
    }
    if (!fresh.length) {
      break
    }
    const next = await client.query(
      `SELECT ${CHAIN_COLUMNS} FROM note_revisions
        WHERE id = ANY($1::bigint[])
           OR base_rev = ANY($2::bigint[])
           OR their_rev = ANY($2::bigint[])
           OR source_rev = ANY($2::bigint[])`,
      [fresh.flatMap(dependenciesOf), fresh.map((row) => row.id)],
    )

    frontier = (next.rows as ChainRow[]).filter((row) => !closure.has(row.id))
  }

  return closure
}

/** Move this space's journal for `fromId` onto `toId` and mark every chain the
 *  collision contaminated — inside the caller's settlement transaction, so the
 *  history can never be half-repaired.
 *
 *  Locking is a protocol, not an afterthought. Locking rows AS THEY ARE WALKED
 *  gives two settlements whose closures intersect two different orders and a
 *  deadlock, and `FOR UPDATE` on existing rows does not stop an append from
 *  INSERTING a trusted child of a row this transaction is about to quarantine.
 *  So: discover the closure unlocked, take the append protocol's own
 *  `space → note` advisory locks, then re-read the whole closure `FOR UPDATE` in
 *  one sorted set — re-expanding while new rows keep appearing, which they can
 *  only do a bounded number of times once the appends are locked out.
 *  canon: docs/core.md#identity · docs/note-history.md */
export const rekeyAndQuarantineRevisions = async (
  client: PoolClient,
  { space, fromId, toId }: { space: string; fromId: string; toId: string },
): Promise<void> => {
  if (fromId === toId) {
    return
  }
  // The closure is discovered as it is walked, so its keys can never be taken in one
  // sorted pass — the wide-scan mutex is what stands in for that order.
  await lockRevisionWideScan(client)
  const seeded = await client.query(
    `SELECT ${CHAIN_COLUMNS} FROM note_revisions WHERE space = $1 AND note_id = $2 ORDER BY id`,
    [space, fromId],
  )
  const seed = seeded.rows as ChainRow[]

  if (!seed.length) {
    return
  }
  let closure = await walkClosure(client, seed)

  // Each round locks everything discovered so far and re-walks from the rows it
  // now holds; the loop settles when the round adds nothing new — see the exit
  // condition below for what "nothing new" has to mean.
  for (;;) {
    const spaces = new Set<string>()
    const notes = new Set<string>()

    for (const row of closure.values()) {
      spaces.add(row.space)
      notes.add(row.note_id)
    }
    await lockRevisionKeys(client, 'space', [...spaces], 'shared')
    await lockRevisionKeys(client, 'note', [...notes])

    const ids = [...closure.keys()].sort()
    const { rows: held } = await lockRevisionChainRows(client, ids)

    closure = await walkClosure(client, held)
    // Equal SIZE is not the same set: a row can leave the closure (purged under
    // us) while another joins it, and the two cancel out. Settle only when every
    // locked id is still in it, or the round after would quarantine rows nothing
    // holds.
    if (ids.every((id) => closure.has(id))) {
      break
    }
  }

  const plan = planQuarantine(closure, { space, fromId })

  if (plan.rekeyTrusted.length || plan.rekeyQuarantined.length) {
    await client.query('UPDATE note_revisions SET note_id = $1 WHERE id = ANY($2::bigint[])', [
      toId,
      [...plan.rekeyTrusted, ...plan.rekeyQuarantined],
    ])
  }
  const gaps = [...plan.rekeyQuarantined, ...plan.quarantineOnly]

  if (gaps.length) {
    await client.query('UPDATE note_revisions SET integrity = $1 WHERE id = ANY($2::bigint[])', [
      REVISION_INTEGRITY.quarantined,
      gaps,
    ])
  }
  if (plan.rekeyTrusted.length || plan.rekeyQuarantined.length) {
    // The target note's OWN earlier rows are not in the closure, so they are locked
    // here before anything demotes them: writing a row this transaction does not hold
    // is exactly what the order exists to prevent, and the gate says so out loud the
    // moment the UPDATE names a note instead of the ids it holds.
    await lockRevisionChainRowsOfNote(client, space, toId)
    const origins = await client.query(
      ORIGINS_OF_NOTE_SQL.replaceAll('%1', '$1').replaceAll('%2', '$2'),
      [space, toId],
    )
    const demoted = laterOrigins(
      (origins.rows as Array<{ id: string }>).map((row) => String(row.id)),
    )

    if (demoted.length) {
      await client.query(
        `UPDATE note_revisions SET entry_role = 'change' WHERE id = ANY($1::bigint[])`,
        [demoted],
      )
    }
  }
}
