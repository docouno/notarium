import { spaceOfRow, type SpaceRow } from '../../rows'
import type { SpaceRecord, SpacesPersistence } from '../../types'
import type { SqliteDriverCtx } from './context'

export const createSpacesFacet = (ctx: SqliteDriverCtx): SpacesPersistence => ({
  upsert: async (s: SpaceRecord) => {
    await ctx.ensureInit()
    // Keyed by the stable id: insert with created_at on first sight,
    // refresh slug/displayName/aliases on later upserts (provision, rename).
    // notes_dir is set once (the physical folder name) and never updated — a
    // rename leaves the folder where it is. A slug collision trips the UNIQUE
    // index and throws (the rename caller maps it to 409).
    ctx.required
      .prepare(
        `INSERT INTO spaces (id, slug, notes_dir, display_name, aliases, created_at, archived_at, archived_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             slug = excluded.slug,
             display_name = excluded.display_name,
             aliases = excluded.aliases,
             archived_at = excluded.archived_at,
             archived_by = excluded.archived_by`,
      )
      .run(
        s.id,
        s.slug,
        s.notesDir,
        s.displayName,
        s.aliases.length ? JSON.stringify(s.aliases) : null,
        s.createdAt,
        s.archivedAt,
        s.archivedBy,
      )
  },
  getById: async (id: string) => {
    await ctx.ensureInit()
    const r = ctx.required.prepare('SELECT * FROM spaces WHERE id = ?').get(id) as
      SpaceRow | undefined
    return r ? spaceOfRow(r) : null
  },
  getMany: async (ids) => {
    if (ids.length === 0) {
      return []
    }
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare('SELECT * FROM spaces WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id')
      .all(JSON.stringify([...new Set(ids)])) as SpaceRow[]
    return rows.map(spaceOfRow)
  },
  getBySlug: async (slug: string) => {
    await ctx.ensureInit()
    const r = ctx.required.prepare('SELECT * FROM spaces WHERE slug = ?').get(slug) as
      SpaceRow | undefined
    return r ? spaceOfRow(r) : null
  },
  list: async (): Promise<SpaceRecord[]> => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare('SELECT * FROM spaces ORDER BY created_at, slug')
      .all() as SpaceRow[]
    return rows.map(spaceOfRow)
  },
})
