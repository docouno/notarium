import type { DatabaseSync } from 'node:sqlite'

import { canonicalReferenceId, type LiveIdentityRow } from '../../identityRefs'

const IDENTITY_COLUMNS = 'id, space, file_path, deleted_at'

/** The id a reference must be stored under, read INSIDE the caller's writer
 *  transaction. A route's pre-resolve is an auth check, not a consistency proof:
 *  a settlement can commit between it and this write, and the row that lands
 *  must name a live note or nothing at all (#327). The twin lives in `drivers/pg`. */
export const resolveLiveIdentityForWrite = (
  db: DatabaseSync,
  noteSpace: string,
  noteId: string,
): string => {
  const row = db
    .prepare(`SELECT ${IDENTITY_COLUMNS} FROM note_identity WHERE id = ?`)
    .get(noteId) as LiveIdentityRow | undefined
  const liveAtPath =
    row && row.deleted_at
      ? (db
          .prepare(
            `SELECT ${IDENTITY_COLUMNS} FROM note_identity
              WHERE space = ? AND file_path = ? AND deleted_at IS NULL`,
          )
          .all(row.space, row.file_path) as LiveIdentityRow[])
      : []

  return canonicalReferenceId(noteSpace, noteId, row, liveAtPath)
}

/** Whether an order entry with NO membership in this scope lost one to a settlement.
 *  The twin's rule, and the reasoning, live in `drivers/pg/liveIdentity.ts`. */
export const isRetiredIdentity = (db: DatabaseSync, noteId: string): boolean => {
  const row = db
    .prepare(`SELECT space, file_path, deleted_at FROM note_identity WHERE id = ?`)
    .get(noteId) as LiveIdentityRow | undefined

  if (!row?.deleted_at) {
    return false
  }

  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM note_identity WHERE space = ? AND file_path = ? AND deleted_at IS NULL`,
      )
      .get(row.space, row.file_path),
  )
}
