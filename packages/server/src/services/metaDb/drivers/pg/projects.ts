import { projectOfRow, type ProjectRow } from '../../rows'
import type { ProjectRecord, ProjectsPersistence } from '../../types'
import type { PgDriverCtx } from './context'

// PostgreSQL projects-registry persistence (folders table).
// canon: docs/projects.md#model
export const createProjectsFacet = (ctx: PgDriverCtx): ProjectsPersistence => ({
  upsert: async (p: ProjectRecord) => {
    await ctx.ensureInit()
    // created_at is set on first insert and deliberately NOT in the ON CONFLICT
    // UPDATE set — the original mint moment is immutable.
    await ctx.required.query(
      `INSERT INTO folders (id, space, path, type, slug, aliases, path_aliases, display_name, status, last_seen, created_at)
         VALUES ($1, $2, $3, 'project', $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           space = EXCLUDED.space,
           path = EXCLUDED.path,
           type = 'project',
           slug = EXCLUDED.slug,
           aliases = EXCLUDED.aliases,
           path_aliases = EXCLUDED.path_aliases,
           display_name = EXCLUDED.display_name,
           status = EXCLUDED.status,
           last_seen = EXCLUDED.last_seen`,
      [
        p.id,
        p.space,
        p.path,
        p.slug,
        p.aliases.length ? JSON.stringify(p.aliases) : null,
        p.pathAliases.length ? JSON.stringify(p.pathAliases) : null,
        p.displayName,
        p.status,
        p.lastSeen,
        p.createdAt,
      ],
    )
  },
  getById: async (id: string) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      `SELECT * FROM folders WHERE id = $1 AND type = 'project'`,
      [id],
    )
    return res.rows[0] ? projectOfRow(res.rows[0] as ProjectRow) : null
  },
  getByHandle: async (space: string, slug: string) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      `SELECT * FROM folders WHERE space = $1 AND slug = $2 AND type = 'project'`,
      [space, slug],
    )
    return res.rows[0] ? projectOfRow(res.rows[0] as ProjectRow) : null
  },
  findBySlug: async (slug: string, spaces: readonly string[]) => {
    if (!spaces.length) {
      return []
    }
    await ctx.ensureInit()
    const placeholders = spaces.map((_, i) => `$${i + 2}`).join(',')
    const res = await ctx.required.query(
      `SELECT * FROM folders WHERE slug = $1 AND type = 'project' AND space IN (${placeholders})`,
      [slug, ...spaces],
    )
    return (res.rows as ProjectRow[]).map(projectOfRow)
  },
  listForSpaces: async (spaces: readonly string[]) => {
    if (!spaces.length) {
      return []
    }
    await ctx.ensureInit()
    const placeholders = spaces.map((_, i) => `$${i + 1}`).join(',')
    // COLLATE "C" = codepoint order, matching the SQLite driver's BINARY
    // collation so project ordering is identical across drivers.
    const res = await ctx.required.query(
      `SELECT * FROM folders WHERE type = 'project' AND space IN (${placeholders}) ORDER BY space COLLATE "C", slug COLLATE "C"`,
      [...spaces],
    )
    return (res.rows as ProjectRow[]).map(projectOfRow)
  },
  listForSpace: async (space: string) => {
    await ctx.ensureInit()
    const res = await ctx.required.query(
      `SELECT * FROM folders WHERE space = $1 AND type = 'project' ORDER BY path COLLATE "C"`,
      [space],
    )
    return (res.rows as ProjectRow[]).map(projectOfRow)
  },
  delete: async (id: string) => {
    await ctx.ensureInit()
    await ctx.required.query(`DELETE FROM folders WHERE id = $1 AND type = 'project'`, [id])
  },
  renamePrefix: async (space: string, oldPrefix: string, newPrefix: string) => {
    if (oldPrefix === newPrefix) {
      return
    }
    await ctx.ensureInit()
    // Table-wide UPDATE — hits project AND plain-folder rows (no type filter).
    // Cut offset is SQL `length()` (chars), NOT JS `.length` (UTF-16 units),
    // else astral/emoji folder names leave descendants stale. The `/` in the
    // boundary check stops `demo` from also matching `demofoo`.
    await ctx.required.query(
      `UPDATE folders SET path = $1 || substr(path, length($2) + 1)
         WHERE space = $3 AND (path = $4 OR substr(path, 1, length($5) + 1) = $6)`,
      [newPrefix, oldPrefix, space, oldPrefix, oldPrefix, oldPrefix + '/'],
    )
  },
})
