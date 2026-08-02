// In-memory FolderIdentityPersistence for the e2e fake (#100 phase 3): the plain
// folder-identity facet (`type='folder'` rows). The real meta-DB shares ONE table
// with projects; the fake keeps a separate Map (our code never mints a folder at a
// project's path — recordFolderRename checks the project facet first — so the
// cross-type UNIQUE(space,path) the real table enforces is never reached here).
// Folder identities are MINTED at runtime via the /move-folder route (no marker in
// the fake → registry-only), not seeded; a reset clears them.

import type { FolderIdentityPersistence, FolderRecord } from '@notarium/server'

import { cmp, type FolderTableView } from './projects'
import type { InMemoryProjects } from './projects'

export class InMemoryFolders implements FolderIdentityPersistence, FolderTableView {
  private rows = new Map<string, FolderRecord>() // id → row

  /** The project facet shares the real table, and `aliasesForSpace` is CROSS-type
   *  (a moved PROJECT folder also has a path-history) — so the fake unions in the
   *  project rows that carry path-aliases to match the driver's whole-table query.
   *  Also registers as the cross-type table view (renamePrefix re-prefixes BOTH
   *  facets; removeById/pathHolder keep the one-table id-flip + UNIQUE(space,path)
   *  invariants the two split Maps would otherwise miss). */
  constructor(private readonly projects: InMemoryProjects) {
    projects.attachFolders(this)
  }

  clear(): void {
    this.rows.clear()
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

  /** Re-prefix the row AT oldPrefix and every descendant — the folder half of the
   *  real table-wide UPDATE (#100 phase 3), invoked from InMemoryProjects.renamePrefix. */
  renamePrefix(space: string, oldPrefix: string, newPrefix: string): void {
    if (oldPrefix === newPrefix) {
      return
    }
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
  }

  async upsert(f: FolderRecord): Promise<void> {
    // The one-table cross-type invariants (#100 phase 3): an id the PROJECT facet holds
    // flips to 'folder' here (move it between Maps); a DIFFERENT id at this path is
    // a global UNIQUE(space,path) violation.
    this.projects.removeById(f.id)
    const projectHolder = this.projects.pathHolder(f.space, f.path)

    if (projectHolder && projectHolder !== f.id) {
      throw new Error(`UNIQUE constraint failed: folders(space, path) = (${f.space}, ${f.path})`)
    }
    const existing = this.rows.get(f.id)
    this.rows.set(f.id, { ...f, createdAt: existing?.createdAt ?? f.createdAt })
  }
  async getById(id: string): Promise<FolderRecord | null> {
    const r = this.rows.get(id)
    return r ? { ...r } : null
  }
  async byPath(space: string, path: string): Promise<FolderRecord | null> {
    for (const r of this.rows.values()) {
      if (r.space === space && r.path === path) {
        return { ...r }
      }
    }

    return null
  }
  async listForSpace(space: string): Promise<FolderRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.space === space)
      .sort((a, b) => cmp(a.path, b.path))
      .map((r) => ({ ...r }))
  }
  async delete(id: string): Promise<void> {
    this.rows.delete(id)
  }
  async aliasesForSpace(
    space: string,
  ): Promise<Array<{ id: string; path: string; pathAliases: string[] }>> {
    const fromFolders = [...this.rows.values()].filter(
      (r) => r.space === space && r.pathAliases.length,
    )
    const fromProjects = (await this.projects.listForSpace(space)).filter(
      (r) => r.pathAliases.length,
    )
    return [...fromFolders, ...fromProjects].map((r) => ({
      id: r.id,
      path: r.path,
      pathAliases: [...r.pathAliases],
    }))
  }
}
