import type { IdentityPersistence, IdentityRecord } from '@notarium/core'

import type { PgDriverCtx } from './context'

export const createIdentityFacet = (ctx: PgDriverCtx): IdentityPersistence => ({
  init: () => ctx.ensureInit(),
  loadAll: async (space: string) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      'SELECT id, file_path, space, created_at, materialized, deleted_at FROM note_identity WHERE space = $1',
      [space],
    )
    return (
      res.rows as Array<{
        id: string
        file_path: string
        space: string
        created_at: string | null
        materialized: boolean
        deleted_at: string | null
      }>
    ).map((r) => ({
      id: r.id,
      filePath: r.file_path,
      space: r.space,
      createdAt: r.created_at,
      materialized: r.materialized,
      deletedAt: r.deleted_at,
    }))
  },
  findById: async (id: string) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      'SELECT id, file_path, space, created_at, materialized, deleted_at FROM note_identity WHERE id = $1',
      [id],
    )
    const r = res.rows[0] as
      | {
          id: string
          file_path: string
          space: string
          created_at: string | null
          materialized: boolean
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
      materialized: r.materialized,
      deletedAt: r.deleted_at,
    }
  },
  upsertMany: async (records: readonly IdentityRecord[]) => {
    if (!records.length) {
      return
    }
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      for (const r of records) {
        await client.query(
          `INSERT INTO note_identity (id, file_path, space, created_at, materialized, deleted_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (id) DO UPDATE SET
               file_path = EXCLUDED.file_path,
               space = EXCLUDED.space,
               created_at = EXCLUDED.created_at,
               materialized = EXCLUDED.materialized,
               deleted_at = EXCLUDED.deleted_at`,
          [r.id, r.filePath, r.space, r.createdAt, r.materialized, r.deletedAt],
        )
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  },
  close: () => ctx.close(),
})
