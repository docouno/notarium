import { folderIdentityOfRow, parseAliases, type ProjectRow } from '../../rows'
import type { FolderIdentityPersistence, FolderRecord } from '../../types'
import type { PgDriverCtx } from './context'

export const createFoldersFacet = (ctx: PgDriverCtx): FolderIdentityPersistence => ({
  upsert: async (f: FolderRecord) => {
    await ctx.ensureInit()
    // A plain folder-identity row: type='folder', no handle (slug='',
    // excluded from the partial UNIQUE(space,slug)). created_at preserved.
    await ctx.required.query(
      `INSERT INTO folders (id, space, path, type, slug, aliases, path_aliases, display_name, status, last_seen, created_at)
         VALUES ($1, $2, $3, 'folder', '', NULL, $4, '', 'active', $5, $6)
         ON CONFLICT (id) DO UPDATE SET
           space = EXCLUDED.space,
           path = EXCLUDED.path,
           type = 'folder',
           path_aliases = EXCLUDED.path_aliases,
           last_seen = EXCLUDED.last_seen`,
      [
        f.id,
        f.space,
        f.path,
        f.pathAliases.length ? JSON.stringify(f.pathAliases) : null,
        f.lastSeen,
        f.createdAt,
      ],
    )
  },
  getById: async (id: string) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      `SELECT * FROM folders WHERE id = $1 AND type = 'folder'`,
      [id],
    )
    return res.rows[0] ? folderIdentityOfRow(res.rows[0] as ProjectRow) : null
  },
  byPath: async (space: string, path: string) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      `SELECT * FROM folders WHERE space = $1 AND path = $2 AND type = 'folder'`,
      [space, path],
    )
    return res.rows[0] ? folderIdentityOfRow(res.rows[0] as ProjectRow) : null
  },
  listForSpace: async (space: string) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      `SELECT * FROM folders WHERE space = $1 AND type = 'folder' ORDER BY path COLLATE "C"`,
      [space],
    )
    return (res.rows as ProjectRow[]).map(folderIdentityOfRow)
  },
  delete: async (id: string) => {
    await ctx.ensureInit()
    await ctx.required.query(`DELETE FROM folders WHERE id = $1 AND type = 'folder'`, [id])
  },
  aliasesForSpace: async (space: string) => {
    await ctx.ensureInit()
    // Cross-type: every identified folder (project OR plain) with a path-history.
    const res = await ctx.required.query(
      `SELECT id, path, path_aliases FROM folders WHERE space = $1 AND path_aliases IS NOT NULL ORDER BY path COLLATE "C"`,
      [space],
    )
    return (res.rows as Array<Pick<ProjectRow, 'id' | 'path' | 'path_aliases'>>)
      .map((r) => ({ id: r.id, path: r.path, pathAliases: parseAliases(r.path_aliases) }))
      .filter((r) => r.pathAliases.length)
  },
})
