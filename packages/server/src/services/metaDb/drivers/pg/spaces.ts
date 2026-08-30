import { spaceOfRow, type SpaceRow } from '../../rows'
import type { SpaceRecord, SpacesPersistence } from '../../types'
import type { PgDriverCtx } from './context'

export const createSpacesFacet = (ctx: PgDriverCtx): SpacesPersistence => ({
  upsert: async (s: SpaceRecord) => {
    await ctx.ensureInit()
    // Keyed by the stable id; notes_dir set once, slug/displayName/
    // aliases refreshed. A slug collision trips the UNIQUE constraint and throws.
    await ctx.required.query(
      `INSERT INTO spaces (id, slug, notes_dir, display_name, aliases, created_at, archived_at, archived_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           slug = EXCLUDED.slug,
           display_name = EXCLUDED.display_name,
           aliases = EXCLUDED.aliases,
           archived_at = EXCLUDED.archived_at,
           archived_by = EXCLUDED.archived_by`,
      [
        s.id,
        s.slug,
        s.notesDir,
        s.displayName,
        s.aliases.length ? JSON.stringify(s.aliases) : null,
        s.createdAt,
        s.archivedAt,
        s.archivedBy,
      ],
    )
  },
  getById: async (id: string) => {
    await ctx.ensureInit()
    const res = await ctx.required.query('SELECT * FROM spaces WHERE id = $1', [id])
    const r = res.rows[0] as SpaceRow | undefined
    return r ? spaceOfRow(r) : null
  },
  getMany: async (ids) => {
    if (ids.length === 0) {
      return []
    }
    await ctx.ensureInit()
    const result = await ctx.required.query(
      'SELECT * FROM spaces WHERE id = ANY($1::text[]) ORDER BY id',
      [[...new Set(ids)]],
    )
    return (result.rows as SpaceRow[]).map(spaceOfRow)
  },
  getBySlug: async (slug: string) => {
    await ctx.ensureInit()
    const res = await ctx.required.query('SELECT * FROM spaces WHERE slug = $1', [slug])
    const r = res.rows[0] as SpaceRow | undefined
    return r ? spaceOfRow(r) : null
  },
  list: async (): Promise<SpaceRecord[]> => {
    await ctx.ensureInit()
    const res = await ctx.required.query('SELECT * FROM spaces ORDER BY created_at, slug')
    return (res.rows as SpaceRow[]).map(spaceOfRow)
  },
})
