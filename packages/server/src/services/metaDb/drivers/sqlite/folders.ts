import { folderIdentityOfRow, parseAliases, type ProjectRow } from '../../rows'
import type { FolderIdentityPersistence, FolderRecord } from '../../types'
import type { SqliteDriverCtx } from './context'

export const createFoldersFacet = (ctx: SqliteDriverCtx): FolderIdentityPersistence => ({
  upsert: async (f: FolderRecord) => {
    await ctx.ensureInit()
    // A plain folder-identity row: type='folder', no handle (slug='',
    // excluded from the partial UNIQUE(space,slug)). Only path/path_aliases/
    // last_seen are mutable; created_at is preserved (lazy-mint moment).
    ctx.required
      .prepare(
        `INSERT INTO folders (id, space, path, type, slug, aliases, path_aliases, display_name, status, last_seen, created_at)
           VALUES (?, ?, ?, 'folder', '', NULL, ?, '', 'active', ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             space = excluded.space,
             path = excluded.path,
             type = 'folder',
             path_aliases = excluded.path_aliases,
             last_seen = excluded.last_seen`,
      )
      .run(
        f.id,
        f.space,
        f.path,
        f.pathAliases.length ? JSON.stringify(f.pathAliases) : null,
        f.lastSeen,
        f.createdAt,
      )
  },
  getById: async (id: string) => {
    await ctx.ensureInit()
    const r = ctx.required
      .prepare(`SELECT * FROM folders WHERE id = ? AND type = 'folder'`)
      .get(id) as ProjectRow | undefined
    return r ? folderIdentityOfRow(r) : null
  },
  byPath: async (space: string, path: string) => {
    await ctx.ensureInit()
    const r = ctx.required
      .prepare(`SELECT * FROM folders WHERE space = ? AND path = ? AND type = 'folder'`)
      .get(space, path) as ProjectRow | undefined
    return r ? folderIdentityOfRow(r) : null
  },
  listForSpace: async (space: string) => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare(`SELECT * FROM folders WHERE space = ? AND type = 'folder' ORDER BY path`)
      .all(space) as ProjectRow[]
    return rows.map(folderIdentityOfRow)
  },
  delete: async (id: string) => {
    await ctx.ensureInit()
    ctx.required.prepare(`DELETE FROM folders WHERE id = ? AND type = 'folder'`).run(id)
  },
  aliasesForSpace: async (space: string) => {
    await ctx.ensureInit()
    // Cross-type: every identified folder (project OR plain) with a path-history.
    const rows = ctx.required
      .prepare(
        `SELECT id, path, path_aliases FROM folders WHERE space = ? AND path_aliases IS NOT NULL ORDER BY path`,
      )
      .all(space) as Array<Pick<ProjectRow, 'id' | 'path' | 'path_aliases'>>
    return rows
      .map((r) => ({ id: r.id, path: r.path, pathAliases: parseAliases(r.path_aliases) }))
      .filter((r) => r.pathAliases.length)
  },
})
