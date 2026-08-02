import { projectOfRow, type ProjectRow } from '../../rows'
import type { ProjectRecord, ProjectsPersistence } from '../../types'
import type { SqliteDriverCtx } from './context'

export const createProjectsFacet = (ctx: SqliteDriverCtx): ProjectsPersistence => ({
  upsert: async (p: ProjectRecord) => {
    await ctx.ensureInit()
    // created_at is preserved on conflict (mint moment); only derived fields refresh.
    ctx.required
      .prepare(
        `INSERT INTO folders (id, space, path, type, slug, aliases, path_aliases, display_name, status, last_seen, created_at)
           VALUES (?, ?, ?, 'project', ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             space = excluded.space,
             path = excluded.path,
             type = 'project',
             slug = excluded.slug,
             aliases = excluded.aliases,
             path_aliases = excluded.path_aliases,
             display_name = excluded.display_name,
             status = excluded.status,
             last_seen = excluded.last_seen`,
      )
      .run(
        p.id,
        p.space,
        p.path,
        p.slug,
        // canon: docs/projects.md#addressing
        p.aliases.length ? JSON.stringify(p.aliases) : null,
        p.pathAliases.length ? JSON.stringify(p.pathAliases) : null,
        p.displayName,
        p.status,
        p.lastSeen,
        p.createdAt,
      )
  },
  getById: async (id: string) => {
    await ctx.ensureInit()
    const r = ctx.required
      .prepare(`SELECT * FROM folders WHERE id = ? AND type = 'project'`)
      .get(id) as ProjectRow | undefined
    return r ? projectOfRow(r) : null
  },
  getByHandle: async (space: string, slug: string) => {
    await ctx.ensureInit()
    const r = ctx.required
      .prepare(`SELECT * FROM folders WHERE space = ? AND slug = ? AND type = 'project'`)
      .get(space, slug) as ProjectRow | undefined
    return r ? projectOfRow(r) : null
  },
  findBySlug: async (slug: string, spaces: readonly string[]) => {
    if (!spaces.length) {
      return []
    }
    await ctx.ensureInit()
    const placeholders = spaces.map(() => '?').join(',')
    const rows = ctx.required
      .prepare(
        `SELECT * FROM folders WHERE slug = ? AND type = 'project' AND space IN (${placeholders})`,
      )
      .all(slug, ...spaces) as ProjectRow[]
    return rows.map(projectOfRow)
  },
  listForSpaces: async (spaces: readonly string[]) => {
    if (!spaces.length) {
      return []
    }
    await ctx.ensureInit()
    const placeholders = spaces.map(() => '?').join(',')
    const rows = ctx.required
      .prepare(
        `SELECT * FROM folders WHERE type = 'project' AND space IN (${placeholders}) ORDER BY space, slug`,
      )
      .all(...spaces) as ProjectRow[]
    return rows.map(projectOfRow)
  },
  listForSpace: async (space: string) => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare(`SELECT * FROM folders WHERE space = ? AND type = 'project' ORDER BY path`)
      .all(space) as ProjectRow[]
    return rows.map(projectOfRow)
  },
  delete: async (id: string) => {
    await ctx.ensureInit()
    ctx.required.prepare(`DELETE FROM folders WHERE id = ? AND type = 'project'`).run(id)
  },
  renamePrefix: async (space: string, oldPrefix: string, newPrefix: string) => {
    if (oldPrefix === newPrefix) {
      return
    }
    await ctx.ensureInit()
    // Table-wide prefix-UPDATE: re-prefixes BOTH project and plain-folder rows under
    // oldPrefix. Offset is SQL `length()` (char count), NOT JS `.length` (UTF-16) —
    // astral-safe. Boundary check (oldPrefix + '/') keeps `demo` from catching `demofoo`.
    ctx.required
      .prepare(
        `UPDATE folders SET path = ? || substr(path, length(?) + 1)
           WHERE space = ? AND (path = ? OR substr(path, 1, length(?) + 1) = ?)`,
      )
      .run(newPrefix, oldPrefix, space, oldPrefix, oldPrefix, oldPrefix + '/')
  },
})
