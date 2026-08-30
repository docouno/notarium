import type { DatabaseSync } from 'node:sqlite'

import { canonicalReferenceId, type LiveIdentityRow } from '../../identityRefs'

const IDENTITY_COLUMNS = 'id, space, file_path, deleted_at, settlement_successor_id'
const SQLITE_BATCH_PARAMETERS = 500
const SQLITE_REFERENCE_PAIR_BATCH = 250
const referencePairValues = new Map<number, string>()

const valuesForReferencePairs = (count: number): string => {
  let values = referencePairValues.get(count)

  if (!values) {
    values = Array.from({ length: count }, () => '(?, ?)').join(', ')
    referencePairValues.set(count, values)
  }

  return values
}

const chunksOf = <T>(values: readonly T[], size: number): T[][] => {
  const chunks: T[][] = []

  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size))
  }

  return chunks
}

const readIdentityClosure = (db: DatabaseSync, noteIds: readonly string[]) => {
  const byId = new Map<string, LiveIdentityRow>()
  const queried = new Set<string>()
  let frontier = [...new Set(noteIds)]

  while (frontier.length > 0) {
    const wanted = frontier.filter((id) => !queried.has(id))

    frontier = []
    wanted.forEach((id) => queried.add(id))
    for (const chunk of chunksOf(wanted, SQLITE_BATCH_PARAMETERS)) {
      const rows = db
        .prepare(
          `SELECT ${IDENTITY_COLUMNS} FROM note_identity WHERE id IN (${chunk.map(() => '?').join(', ')})`,
        )
        .all(...chunk) as LiveIdentityRow[]

      for (const row of rows) {
        byId.set(row.id, row)
        if (row.settlement_successor_id && !queried.has(row.settlement_successor_id)) {
          frontier.push(row.settlement_successor_id)
        }
      }
    }
  }

  return byId
}

/** Resolve one bulk reference write from bounded batched reads. The single SQLite
 * writer still makes the whole decision atomic inside the caller's transaction;
 * batching only avoids preparing and executing one statement per item. */
export const enterIdentityTierForReferences = (
  db: DatabaseSync,
  references: Iterable<string | { noteId: string }>,
): { canonical(noteSpace: string, noteId: string): string } => {
  const wanted = new Set<string>()

  for (const reference of references) {
    wanted.add(typeof reference === 'string' ? reference : reference.noteId)
  }
  const byId = readIdentityClosure(db, [...wanted])

  return {
    canonical: (noteSpace, noteId) => {
      const row = byId.get(noteId)

      return canonicalReferenceId(noteSpace, noteId, row, byId)
    },
  }
}

/** Fast exact-reference validation under the caller's SQLite writer fence. Live rows in
 * their stated spaces need no JS identity projection; only foreign/tombstoned rows enter
 * the full explicit-lineage resolver. */
export const canonicalizeReferenceBatchForWrite = (
  db: DatabaseSync,
  references: readonly { space: string; noteId: string }[],
): ReadonlyMap<string, string> | null => {
  const problematic = new Set<string>()

  for (let offset = 0; offset < references.length; offset += SQLITE_REFERENCE_PAIR_BATCH) {
    const count = Math.min(SQLITE_REFERENCE_PAIR_BATCH, references.length - offset)
    const params = new Array<string>(count * 2)

    for (let index = 0; index < count; index += 1) {
      const reference = references[offset + index]

      params[index * 2] = reference.noteId
      params[index * 2 + 1] = reference.space
    }
    const rows = db
      .prepare(
        `WITH requested(id, space) AS (VALUES ${valuesForReferencePairs(count)})
         SELECT identity.id
           FROM note_identity identity
           JOIN requested ON requested.id = identity.id
          WHERE identity.space IS NOT requested.space
             OR identity.deleted_at IS NOT NULL`,
      )
      .all(...params) as Array<{ id: string }>

    rows.forEach((row) => problematic.add(row.id))
  }
  if (problematic.size === 0) {
    return null
  }
  const identity = enterIdentityTierForReferences(db, problematic)
  const canonical = new Map<string, string>()

  for (const reference of references) {
    if (problematic.has(reference.noteId)) {
      canonical.set(reference.noteId, identity.canonical(reference.space, reference.noteId))
    }
  }

  return canonical
}

/** The id a reference must be stored under, read INSIDE the caller's writer
 *  transaction. A route's pre-resolve is an auth check, not a consistency proof:
 *  a settlement can commit between it and this write, and the row that lands
 *  must name a live note or nothing at all (#327). The twin lives in `drivers/pg`. */
export const resolveLiveIdentityForWrite = (
  db: DatabaseSync,
  noteSpace: string,
  noteId: string,
): string => {
  const byId = readIdentityClosure(db, [noteId])

  return canonicalReferenceId(noteSpace, noteId, byId.get(noteId), byId)
}

/** Whether an order entry with NO membership in this scope lost one to a settlement.
 *  The twin's rule, and the reasoning, live in `drivers/pg/liveIdentity.ts`. */
export const isRetiredIdentity = (db: DatabaseSync, noteId: string): boolean => {
  const row = db
    .prepare(
      `SELECT space, file_path, deleted_at, settlement_successor_id FROM note_identity WHERE id = ?`,
    )
    .get(noteId) as LiveIdentityRow | undefined

  return Boolean(row?.deleted_at && row.settlement_successor_id)
}
