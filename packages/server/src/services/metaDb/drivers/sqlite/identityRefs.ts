import type { DatabaseSync } from 'node:sqlite'

import {
  earlierFavorite,
  earliestOf,
  rekeyContextSetItems,
  rekeyOrderEntries,
} from '../../identityRefs'
import type { ContextOrderRow } from '../../rows'

type FavoriteRow = { owner: string; entity_id: string; created_at: string; rank: number | null }
type PinRow = {
  target_kind: string
  target_id: string
  target_space: string
  note_id: string
  created_at: string
}

/** Re-point this space's structurally-qualified references from `fromId` to `toId`.
 *  Runs INSIDE the caller's settlement transaction — identity and references have
 *  to move together or not at all (#327). The twin lives in `drivers/pg`. */
export const rekeyReferences = (
  db: DatabaseSync,
  { space, fromId, toId }: { space: string; fromId: string; toId: string },
): void => {
  if (fromId === toId) {
    return
  }
  rekeyFavorites(db, space, fromId, toId)
  rekeyContextSets(db, space, fromId, toId)
  rekeyPinsAndOrder(db, space, fromId, toId)
}

const rekeyFavorites = (db: DatabaseSync, space: string, fromId: string, toId: string): void => {
  const rows = db
    .prepare(
      `SELECT owner, entity_id, created_at, rank FROM favorites
        WHERE space = ? AND kind = 'note' AND entity_id IN (?, ?)`,
    )
    .all(space, fromId, toId) as FavoriteRow[]
  const remove = db.prepare(
    `DELETE FROM favorites WHERE owner = ? AND space = ? AND kind = 'note' AND entity_id = ?`,
  )
  const put = db.prepare(
    `INSERT INTO favorites (owner, space, kind, entity_id, created_at, rank)
       VALUES (?, ?, 'note', ?, ?, ?)
       ON CONFLICT(owner, space, kind, entity_id)
       DO UPDATE SET created_at = excluded.created_at, rank = excluded.rank`,
  )

  for (const owner of new Set(rows.map((r) => r.owner))) {
    const mine = rows.filter((r) => r.owner === owner)
    const from = mine.find((r) => r.entity_id === fromId)

    if (!from) {
      continue
    }
    const to = mine.find((r) => r.entity_id === toId)
    const survivor = to ? earlierFavorite(to, from) : from

    remove.run(owner, space, fromId)
    put.run(owner, space, toId, survivor.created_at, survivor.rank)
  }
}

const rekeyContextSets = (db: DatabaseSync, space: string, fromId: string, toId: string): void => {
  // A LIKE prefilter keeps the strict parse (which REFUSES a malformed payload)
  // off every set in the base — only candidates that actually mention the id.
  const candidates = db
    .prepare(`SELECT id, items FROM context_sets WHERE items LIKE ? ESCAPE '\\'`)
    .all(`%${fromId.replace(/[\\%_]/g, (c) => '\\' + c)}%`) as Array<{
    id: string
    items: string | null
  }>
  const update = db.prepare(`UPDATE context_sets SET items = ? WHERE id = ?`)

  for (const set of candidates) {
    const next = rekeyContextSetItems(set.items, set.id, space, fromId, toId)

    if (next !== null) {
      update.run(next, set.id)
    }
  }
}

const rekeyPinsAndOrder = (db: DatabaseSync, space: string, fromId: string, toId: string): void => {
  const pins = db
    .prepare(
      `SELECT target_kind, target_id, target_space, note_id, created_at FROM context_scope_pins
        WHERE note_space = ? AND note_id = ?`,
    )
    .all(space, fromId) as PinRow[]

  if (!pins.length) {
    return
  }
  const existing = db.prepare(
    `SELECT target_kind, target_id, target_space, note_id, created_at FROM context_scope_pins
      WHERE target_kind = ? AND target_id = ? AND note_id = ?`,
  )
  const removePin = db.prepare(
    `DELETE FROM context_scope_pins WHERE target_kind = ? AND target_id = ? AND note_id = ?`,
  )
  const putPin = db.prepare(
    `INSERT INTO context_scope_pins (target_kind, target_id, target_space, note_space, note_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(target_kind, target_id, note_id)
       DO UPDATE SET target_space = excluded.target_space, note_space = excluded.note_space, created_at = excluded.created_at`,
  )
  const orderOf = db.prepare(
    `SELECT target_kind, target_id, target_space, entry_kind, entry_ref, rank FROM context_order
      WHERE target_kind = ? AND target_id = ? ORDER BY rank ASC`,
  )
  const dropOrder = db.prepare(`DELETE FROM context_order WHERE target_kind = ? AND target_id = ?`)
  const putOrder = db.prepare(
    `INSERT INTO context_order (target_kind, target_id, target_space, entry_kind, entry_ref, rank)
       VALUES (?, ?, ?, ?, ?, ?)`,
  )

  for (const pin of pins) {
    const target = existing.get(pin.target_kind, pin.target_id, toId) as PinRow | undefined
    const survivor = target ? earliestOf(target, pin) : pin

    removePin.run(pin.target_kind, pin.target_id, fromId)
    putPin.run(pin.target_kind, pin.target_id, pin.target_space, space, toId, survivor.created_at)
    // The order overlay follows only a membership that ACTUALLY moved: the
    // writer's noteSpace comes from the locked pin row, never from targetSpace
    // (a scope's space says nothing about where a pinned note lives).
    const entries = orderOf.all(pin.target_kind, pin.target_id) as ContextOrderRow[]
    const next = rekeyOrderEntries(entries, fromId, toId)

    if (!next) {
      continue
    }
    dropOrder.run(pin.target_kind, pin.target_id)
    for (const entry of next) {
      putOrder.run(
        entry.target_kind,
        entry.target_id,
        entry.target_space,
        entry.entry_kind,
        entry.entry_ref,
        entry.rank,
      )
    }
  }
}
