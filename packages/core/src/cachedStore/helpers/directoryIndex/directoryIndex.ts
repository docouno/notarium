import { namePathKey } from '../../../libs/slug'

/** The directory index: every user-visible folder the tree may show,
 *  EMPTY ones included (a marked-but-empty project, a "New folder", an emptied
 *  folder — never-prune). Seeded and authoritatively refreshed from
 *  inner.listDirs() off the request path, then maintained incrementally between
 *  reconciles, so listDirs() serves from memory without making every /tree request
 *  await an FS walk. Dot-namespaced dirs (agent-mount) are never tracked.
 *  @see docs/core.md#list-layer */
export class DirectoryIndex {
  private readonly dirs = new Set<string>()
  /** Bumped by every mutation that really moves the folder SET. Derived state
   *  keyed on that set (the wikilink resolve table) memoizes against it instead
   *  of rebuilding, so a change this counter misses is not a slow read but a
   *  silently wrong one. */
  private revision = 0

  /** How many times this index changed. Only equality matters. */
  get version(): number {
    return this.revision
  }

  /** Add a directory path AND its ancestors. Idempotent; dot-namespaced dirs
   *  (the agent-mount) are never tracked (mirror localFs). */
  add(dir: string): boolean {
    if (!dir || dir.split('/').some((s) => s.startsWith('.'))) {
      return false
    }
    const before = this.dirs.size
    let acc = ''

    for (const part of dir.split('/')) {
      acc = acc ? `${acc}/${part}` : part
      this.dirs.add(acc)
    }
    if (this.dirs.size !== before) {
      this.revision++
    }

    return this.dirs.size !== before
  }

  /** Every tracked folder, in insertion order. */
  list(): string[] {
    return [...this.dirs]
  }

  has(path: string): boolean {
    return this.dirs.has(path)
  }

  /** Whether any real RAW folder shares this human-name key. Used only as a
   *  fail-closed spelling fence; the raw path remains the storage identity. */
  hasEquivalent(path: string): boolean {
    const key = namePathKey(path)
    return !!key && [...this.dirs].some((dir) => namePathKey(dir) === key)
  }

  clear(): void {
    this.revision++
    this.dirs.clear()
  }

  /** Drop a folder subtree (the folder and its descendants) — the folder is
   *  gone on disk (removeDir). */
  removeSubtree(path: string): boolean {
    const before = this.dirs.size
    const prefix = `${path}/`

    for (const d of [...this.dirs]) {
      if (d === path || d.startsWith(prefix)) {
        this.dirs.delete(d)
      }
    }
    if (this.dirs.size !== before) {
      this.revision++
    }

    return this.dirs.size !== before
  }

  /** Re-key a folder subtree from `src` to `dest` and register `dest` itself
   *  (folder move) — the src PARENT lingers (never-prune). */
  moveSubtree(src: string, dest: string): boolean {
    const before = this.list()
    const prefix = `${src}/`

    for (const d of [...this.dirs]) {
      if (d === src || d.startsWith(prefix)) {
        this.dirs.delete(d)
        this.add(dest + d.slice(src.length))
      }
    }
    this.add(dest)
    const after = this.list()
    const changed =
      before.length !== after.length || after.some((dir, index) => dir !== before[index])

    // The deletes above bypass versioning, and `add()` measures growth against a
    // size the delete already reduced. Re-keying onto a path the set ALREADY
    // tracks therefore shrinks the set while adding nothing new — the one shape
    // that leaves `add()` with nothing to report. This comparison is the exact
    // signal, so version off it rather than off the parts.
    if (changed) {
      this.revision++
    }

    return changed
  }
}
