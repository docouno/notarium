import type { PoolClient } from 'pg'

import {
  earlierFavorite,
  earliestOf,
  rekeyContextSetItems,
  rekeyOrderEntries,
} from '../../identityRefs'
import type { ContextOrderRow, ScopePinRow } from '../../rows'
import {
  lockContextOrderRows,
  lockContextOrderScopes,
  lockContextSetsMentioning,
  lockFavoriteNoteRows,
  lockScopePinsForNotes,
} from './lockOrder'

/** Re-point this space's structurally-qualified references from `fromId` to `toId`,
 *  inside the caller's settlement transaction. Each facet is one level of the lock
 *  hierarchy, taken in order and entered once, AFTER the identity rows — so a
 *  concurrent reference writer queues behind the settlement instead of deadlocking
 *  with it. See `lockOrder`. Twin of `drivers/sqlite`. */
export const rekeyReferences = async (
  client: PoolClient,
  { space, fromId, toId }: { space: string; fromId: string; toId: string },
): Promise<void> => {
  if (fromId === toId) {
    return
  }
  await rekeyFavorites(client, space, fromId, toId)
  await rekeyContextSets(client, space, fromId, toId)
  await rekeyPinsAndOrder(client, space, fromId, toId)
}

const rekeyFavorites = async (
  client: PoolClient,
  space: string,
  fromId: string,
  toId: string,
): Promise<void> => {
  const { rows } = await lockFavoriteNoteRows(client, space, [fromId, toId])

  for (const owner of new Set(rows.map((r) => r.owner))) {
    const mine = rows.filter((r) => r.owner === owner)
    const from = mine.find((r) => r.entity_id === fromId)

    if (!from) {
      continue
    }
    const to = mine.find((r) => r.entity_id === toId)
    const survivor = to ? earlierFavorite(to, from) : from

    await client.query(
      `DELETE FROM favorites WHERE owner = $1 AND space = $2 AND kind = 'note' AND entity_id = $3`,
      [owner, space, fromId],
    )
    await client.query(
      `INSERT INTO favorites (owner, space, kind, entity_id, created_at, rank)
         VALUES ($1, $2, 'note', $3, $4, $5)
         ON CONFLICT (owner, space, kind, entity_id)
         DO UPDATE SET created_at = EXCLUDED.created_at, rank = EXCLUDED.rank`,
      [owner, space, toId, survivor.created_at, survivor.rank],
    )
  }
}

const rekeyContextSets = async (
  client: PoolClient,
  space: string,
  fromId: string,
  toId: string,
): Promise<void> => {
  const { rows } = await lockContextSetsMentioning(client, fromId)

  for (const set of rows) {
    const next = rekeyContextSetItems(set.items, set.id, space, fromId, toId)

    if (next !== null) {
      await client.query(`UPDATE context_sets SET items = $1 WHERE id = $2`, [next, set.id])
    }
  }
}

const scopeKeyOf = (row: { target_kind: string; target_id: string }): string =>
  `${row.target_kind}:${row.target_id}`

/** Pins and their order overlay, one LEVEL at a time: every pin row of both ids
 *  (2d), then the pin writes, then the per-scope advisory (2e), then the overlay
 *  (2f). Interleaving them per scope walks 2d → 2e → 2d, which is the sub-order
 *  inversion the settlement itself used to commit. */
const rekeyPinsAndOrder = async (
  client: PoolClient,
  space: string,
  fromId: string,
  toId: string,
): Promise<void> => {
  const { rows: pinRows } = await lockScopePinsForNotes(client, [fromId, toId])
  // `note_space` selects what MOVES; it deliberately does not select what is LOCKED.
  // The target id's row is a merge partner, and a row filtered out of the lock is a
  // row the INSERT below then collides with unheld.
  const moving = pinRows.filter((pin) => pin.note_id === fromId && pin.note_space === space)

  if (!moving.length) {
    return
  }
  const targets = new Map<string, ScopePinRow>(
    pinRows.filter((pin) => pin.note_id === toId).map((pin) => [scopeKeyOf(pin), pin]),
  )

  for (const pin of moving) {
    const target = targets.get(scopeKeyOf(pin))
    const survivor = target ? earliestOf(target, pin) : pin

    await client.query(
      `DELETE FROM context_scope_pins WHERE target_kind = $1 AND target_id = $2 AND note_id = $3`,
      [pin.target_kind, pin.target_id, fromId],
    )
    await client.query(
      `INSERT INTO context_scope_pins (target_kind, target_id, target_space, note_space, note_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (target_kind, target_id, note_id)
         DO UPDATE SET target_space = EXCLUDED.target_space, note_space = EXCLUDED.note_space, created_at = EXCLUDED.created_at`,
      [pin.target_kind, pin.target_id, pin.target_space, space, toId, survivor.created_at],
    )
  }
  // The order overlay follows only a membership that ACTUALLY moved: a settlement
  // rewrites the same DELETE-then-INSERT overlay `setOrder` does, so it takes part in
  // that scope protocol rather than around it.
  const scopes = moving.map((pin) => ({ targetKind: pin.target_kind, targetId: pin.target_id }))

  await lockContextOrderScopes(client, scopes)
  const { rows: ordered } = await lockContextOrderRows(client, scopes)
  const byScope = new Map<string, ContextOrderRow[]>()

  for (const row of ordered) {
    byScope.set(scopeKeyOf(row), [...(byScope.get(scopeKeyOf(row)) ?? []), row])
  }
  for (const pin of moving) {
    const next = rekeyOrderEntries(byScope.get(scopeKeyOf(pin)) ?? [], fromId, toId)

    if (!next) {
      continue
    }
    await client.query(`DELETE FROM context_order WHERE target_kind = $1 AND target_id = $2`, [
      pin.target_kind,
      pin.target_id,
    ])
    for (const entry of next) {
      await client.query(
        `INSERT INTO context_order (target_kind, target_id, target_space, entry_kind, entry_ref, rank)
           VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          entry.target_kind,
          entry.target_id,
          entry.target_space,
          entry.entry_kind,
          entry.entry_ref,
          entry.rank,
        ],
      )
    }
  }
}
