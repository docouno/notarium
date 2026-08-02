import type { IdentityPersistence, IdentityRecord } from '@notarium/core'

import type { SqliteDriverCtx } from './context'

export const createIdentityFacet = (ctx: SqliteDriverCtx): IdentityPersistence => ({
  init: () => ctx.ensureInit(),
  loadAll: async (space: string) => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare(
        'SELECT id, file_path, space, created_at, materialized, deleted_at FROM note_identity WHERE space = ?',
      )
      .all(space) as Array<{
      id: string
      file_path: string
      space: string
      created_at: string | null
      materialized: number
      deleted_at: string | null
    }>
    return rows.map((r) => ({
      id: r.id,
      filePath: r.file_path,
      space: r.space,
      createdAt: r.created_at,
      materialized: r.materialized !== 0,
      deletedAt: r.deleted_at,
    }))
  },
  findById: async (id: string) => {
    await ctx.ensureInit()
    const r = ctx.required
      .prepare(
        'SELECT id, file_path, space, created_at, materialized, deleted_at FROM note_identity WHERE id = ?',
      )
      .get(id) as
      | {
          id: string
          file_path: string
          space: string
          created_at: string | null
          materialized: number
          deleted_at: string | null
        }
      | undefined

    if (!r) {
      return null
    }

    return {
      id: r.id,
      filePath: r.file_path,
      space: r.space,
      createdAt: r.created_at,
      materialized: r.materialized !== 0,
      deletedAt: r.deleted_at,
    }
  },
  upsertMany: async (records: readonly IdentityRecord[]) => {
    if (!records.length) {
      return
    }
    await ctx.ensureInit()
    const db = ctx.required
    const stmt = db.prepare(
      `INSERT INTO note_identity (id, file_path, space, created_at, materialized, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           file_path = excluded.file_path,
           space = excluded.space,
           created_at = excluded.created_at,
           materialized = excluded.materialized,
           deleted_at = excluded.deleted_at`,
    )
    db.exec('BEGIN')
    try {
      for (const r of records) {
        stmt.run(r.id, r.filePath, r.space, r.createdAt, r.materialized ? 1 : 0, r.deletedAt)
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  },
  close: () => ctx.close(),
})
