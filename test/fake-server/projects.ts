// In-memory ProjectsPersistence for the e2e fake (#13): a plain Map behind the
// same facet the SQLite/PG drivers implement, so the production MCP gateway
// (get_my_projects, handle resolution, the hit `project?` label) runs UNCHANGED
// over a world the harness seeds and resets — the executable-spec posture of #18.
//
// Projects are SEEDED from the fixture (not minted via a marker scan): the marker
// subsystem + mark-as-project endpoint are #13 I0c, so the suite declares the
// registry rows directly, exactly as a confirming scan would have left them.

import type { ProjectRecord, ProjectsPersistence } from '@notarium/server'

/** The real `folders` table is ONE table shared by projects + plain folders
 *  (#100 phase 3): a global `UNIQUE(space,path)` over BOTH types, and an upsert by id
 *  that exists as the OTHER type flips it in place (`ON CONFLICT(id)`). The fake
 *  splits it into two Maps, so each facet exposes this view to the other to keep
 *  the cross-type invariants — without it the fake passes where the SQL throws,
 *  or keeps a stale row the real `type` flip removed. */
export type FolderTableView = {
  renamePrefix(space: string, oldPrefix: string, newPrefix: string): void
  /** Drop the row with this id (it is flipping to the other type — the real
   *  `ON CONFLICT(id)` updates one row; the fake moves it between Maps). */
  removeById(id: string): void
  /** The id occupying (space, path), or undefined — the cross-type UNIQUE check. */
  pathHolder(space: string, path: string): string | undefined
}

export class InMemoryProjects implements ProjectsPersistence {
  private rows = new Map<string, ProjectRecord>() // id → row

  private foldersView?: FolderTableView
  attachFolders(view: FolderTableView): void {
    this.foldersView = view
  }
  removeById(id: string): void {
    this.rows.delete(id)
  }
  pathHolder(space: string, path: string): string | undefined {
    for (const r of this.rows.values()) {
      if (r.space === space && r.path === path) {
        return r.id
      }
    }

    return undefined
  }

  clear(): void {
    this.rows.clear()
  }

  /** Replace the whole registry from a fixture (reset re-seeds). */
  seed(records: ProjectRecord[]): void {
    this.rows.clear()
    for (const r of records) {
      this.rows.set(r.id, { ...r })
    }
  }

  async upsert(p: ProjectRecord): Promise<void> {
    // A re-upsert by an id the FOLDER facet holds = the real `ON CONFLICT(id)`
    // flipping that one row's type to 'project' (#100 phase 3 mark-as-project of an
    // identified folder). Move it between Maps so no duplicate row survives.
    this.foldersView?.removeById(p.id)
    // Mirror the real drivers' UNIQUE(space,slug)/(space,path) indexes: a DIFFERENT
    // id claiming the same handle/path is a constraint violation, not a silent
    // overwrite. Without this the fake would pass where sqlite/pg throw — exactly
    // the trap I0c's marker-scan upsert must reckon with (two folders → one slug).
    for (const r of this.rows.values()) {
      if (r.id === p.id) {
        continue
      }
      if (r.space === p.space && r.slug === p.slug) {
        throw new Error(`UNIQUE constraint failed: projects(space, slug) = (${p.space}, ${p.slug})`)
      }
      if (r.space === p.space && r.path === p.path) {
        throw new Error(`UNIQUE constraint failed: projects(space, path) = (${p.space}, ${p.path})`)
      }
    }
    // The path UNIQUE is GLOBAL over both types: a plain folder at this path is a
    // collision too (the real shared-table index).
    const folderHolder = this.foldersView?.pathHolder(p.space, p.path)

    if (folderHolder && folderHolder !== p.id) {
      throw new Error(`UNIQUE constraint failed: folders(space, path) = (${p.space}, ${p.path})`)
    }
    const existing = this.rows.get(p.id)
    // Preserve the original created_at (mint moment) on a re-upsert, like the
    // real drivers (a confirming scan refreshes the derived fields only).
    this.rows.set(p.id, { ...p, createdAt: existing?.createdAt ?? p.createdAt })
  }
  async getById(id: string): Promise<ProjectRecord | null> {
    const r = this.rows.get(id)
    return r ? { ...r } : null
  }
  async getByHandle(space: string, slug: string): Promise<ProjectRecord | null> {
    for (const r of this.rows.values()) {
      if (r.space === space && r.slug === slug) {
        return { ...r }
      }
    }

    return null
  }
  async findBySlug(slug: string, spaces: readonly string[]): Promise<ProjectRecord[]> {
    if (!spaces.length) {
      return []
    }
    const set = new Set(spaces)
    return [...this.rows.values()]
      .filter((r) => r.slug === slug && set.has(r.space))
      .map((r) => ({ ...r }))
  }
  async listForSpaces(spaces: readonly string[]): Promise<ProjectRecord[]> {
    if (!spaces.length) {
      return []
    }
    const set = new Set(spaces)
    return [...this.rows.values()]
      .filter((r) => set.has(r.space))
      .sort((a, b) => cmp(a.space, b.space) || cmp(a.slug, b.slug))
      .map((r) => ({ ...r }))
  }
  async listForSpace(space: string): Promise<ProjectRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.space === space)
      .sort((a, b) => cmp(a.path, b.path))
      .map((r) => ({ ...r }))
  }
  async delete(id: string): Promise<void> {
    this.rows.delete(id)
  }
  async renamePrefix(space: string, oldPrefix: string, newPrefix: string): Promise<void> {
    if (oldPrefix === newPrefix) {
      return
    }
    // Re-prefix the row AT oldPrefix and every descendant (segment-boundary, so
    // `demo` never catches `demofoo`) — the mirror of the real drivers' UPDATE.
    // JS .startsWith/.slice are UTF-16-consistent → astral-safe like the SQL's
    // length()-based cut. No uniqueness re-check (matching a raw SQL UPDATE, which
    // also wouldn't pre-check): the one edge where a real driver WOULD raise
    // UNIQUE(space,path) is moving onto a path already held by an empty marked
    // project (no notes → invisible to the engine's notes-only occupancy gate). The
    // handler calls renamePrefix best-effort (catch+log), so that rare collision
    // logs + self-heals at the next boot reconcile rather than 500-ing the move.
    for (const r of this.rows.values()) {
      if (r.space !== space) {
        continue
      }
      if (r.path === oldPrefix) {
        r.path = newPrefix
      } else if (r.path.startsWith(oldPrefix + '/')) {
        r.path = newPrefix + r.path.slice(oldPrefix.length)
      }
    }
    // Re-prefix the plain-folder rows too (the real table-wide UPDATE).
    this.foldersView?.renamePrefix(space, oldPrefix, newPrefix)
  }
}

/** Binary (codepoint) comparator — matches the SQLite driver's default BINARY
 *  collation and the Postgres driver's `COLLATE "C"`, so the fake's get_my_projects
 *  ordering is the same one the real drivers produce (NOT locale-aware
 *  localeCompare, which would diverge on `-`/`_`/case — #18 parity). */
export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
