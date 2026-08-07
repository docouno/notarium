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
    return before.length !== after.length || after.some((dir, index) => dir !== before[index])
  }
}
