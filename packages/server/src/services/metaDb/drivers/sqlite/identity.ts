import type {
  IdentityClaimOutcome,
  IdentityFileClaim,
  IdentityFileSettlement,
  IdentityPersistence,
  IdentityRecord,
} from '@notarium/core'

import type { SqliteDriverCtx } from './context'
import { rekeyReferences } from './identityRefs'
import { rekeyAndQuarantineRevisions } from './revisionQuarantine'

type IdentityRow = {
  id: string
  file_path: string
  space: string
  created_at: string | null
  materialized: number
  deleted_at: string | null
}

const SELECT_COLUMNS = 'id, file_path, space, created_at, materialized, deleted_at'

const recordOfRow = (r: IdentityRow): IdentityRecord => ({
  id: r.id,
  filePath: r.file_path,
  space: r.space,
  createdAt: r.created_at,
  materialized: r.materialized !== 0,
  deletedAt: r.deleted_at,
})

/** Upsert one row WITHOUT ever changing its space. The space guard is the whole
 *  point (#327): before it, a sibling space claiming an existing id simply
 *  overwrote `space`/`file_path` and the note changed owners on a poll order. */
const UPSERT_SQL = `INSERT INTO note_identity (id, file_path, space, created_at, materialized, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       file_path = excluded.file_path,
       created_at = excluded.created_at,
       materialized = excluded.materialized,
       deleted_at = excluded.deleted_at
     WHERE note_identity.space = excluded.space`

export const createIdentityFacet = (ctx: SqliteDriverCtx): IdentityPersistence => ({
  init: () => ctx.ensureInit(),
  loadAll: async (space: string) => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare(`SELECT ${SELECT_COLUMNS} FROM note_identity WHERE space = ?`)
      .all(space) as IdentityRow[]
    return rows.map(recordOfRow)
  },
  findById: async (id: string) => {
    await ctx.ensureInit()
    const r = ctx.required
      .prepare(`SELECT ${SELECT_COLUMNS} FROM note_identity WHERE id = ?`)
      .get(id) as IdentityRow | undefined

    return r ? recordOfRow(r) : null
  },
  claimMany: async (records: readonly IdentityRecord[]) => {
    if (!records.length) {
      return []
    }
    await ctx.ensureInit()
    const db = ctx.required
    const owner = db.prepare(`SELECT ${SELECT_COLUMNS} FROM note_identity WHERE id = ?`)
    const upsert = db.prepare(UPSERT_SQL)
    const outcomes: IdentityClaimOutcome[] = []

    // IMMEDIATE takes the writer reservation before the ownership reads, so a
    // sibling connection cannot commit its own claim between them and the write.
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const r of records) {
        const existing = owner.get(r.id) as IdentityRow | undefined

        if (existing && existing.space !== r.space) {
          outcomes.push({ id: r.id, status: 'foreign-owner', owner: recordOfRow(existing) })
          continue
        }
        upsert.run(r.id, r.filePath, r.space, r.createdAt, r.materialized ? 1 : 0, r.deletedAt)
        outcomes.push({ id: r.id, status: 'claimed' })
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }

    return outcomes
  },
  settleFileClaim: async ({ space, filePath, current, observedId, at }: IdentityFileClaim) => {
    await ctx.ensureInit()
    const db = ctx.required
    const select = db.prepare(`SELECT ${SELECT_COLUMNS} FROM note_identity WHERE id = ?`)
    const upsert = db.prepare(UPSERT_SQL)

    db.exec('BEGIN IMMEDIATE')
    try {
      const ownerRow = select.get(observedId) as IdentityRow | undefined
      const settlement = ((): IdentityFileSettlement => {
        if (ownerRow && ownerRow.space !== space) {
          // The durable owner is authoritative and untouched. The claimant keeps
          // its own id, made durable here so the convergence that rewrites the
          // file's frontmatter can never publish a half-settled identity.
          const record: IdentityRecord = { ...current, space, filePath, deletedAt: null }

          upsert.run(
            record.id,
            record.filePath,
            record.space,
            record.createdAt,
            record.materialized ? 1 : 0,
            record.deletedAt,
          )
          rekeyReferences(db, { space, fromId: observedId, toId: record.id })
          rekeyAndQuarantineRevisions(db, { space, fromId: observedId, toId: record.id })

          return { status: 'foreign-owner', owner: recordOfRow(ownerRow), record }
        }
        // A live note of THIS space holds the id at another path while the
        // claimant is a DIFFERENT identity: a user-copied file, not a rename.
        // Nothing moves — accepting would take the id off the original path.
        // The claimant's own id being the observed one is the opposite case (a
        // genuine move), and it is decided by the branch below.
        if (
          current.id !== observedId &&
          ownerRow &&
          !ownerRow.deleted_at &&
          ownerRow.file_path !== filePath
        ) {
          return {
            status: 'duplicate-path-owner',
            owner: recordOfRow(ownerRow),
            record: { ...current },
          }
        }
        // Free, tombstoned-and-ours, this very path's, or the claimant's own id
        // arriving at a new path: the file's claim is the path's identity.
        const record: IdentityRecord = {
          id: observedId,
          filePath,
          space,
          createdAt: ownerRow?.created_at ?? current.createdAt ?? at,
          materialized: true,
          deletedAt: null,
        }

        upsert.run(
          record.id,
          record.filePath,
          record.space,
          record.createdAt,
          record.materialized ? 1 : 0,
          record.deletedAt,
        )
        if (current.id === observedId) {
          return { status: 'accepted', record }
        }
        // The superseded identity is retired in the SAME transaction: an
        // interrupted settlement must never leave two live rows for one path.
        upsert.run(
          current.id,
          current.filePath,
          space,
          current.createdAt,
          current.materialized ? 1 : 0,
          at,
        )
        rekeyReferences(db, { space, fromId: current.id, toId: record.id })
        rekeyAndQuarantineRevisions(db, { space, fromId: current.id, toId: record.id })

        return { status: 'accepted', record, retiredId: current.id }
      })()

      db.exec('COMMIT')
      return settlement
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  },
  close: () => ctx.close(),
})
