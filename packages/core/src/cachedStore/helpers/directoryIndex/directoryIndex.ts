/** The directory index: every user-visible folder the tree may show,
 *  EMPTY ones included (a marked-but-empty project, a "New folder", an emptied
 *  folder — never-prune). Seeded once from inner.listDirs() (a single FS walk,
 *  off the request path) then maintained incrementally, so listDirs() serves
 *  from memory and never awaits the engine per request (the pre-channel per-/tree
 *  FS walk was a cold-boot stall, and a stale note-snapshot beside a fresh disk
 *  walk dup'd a folder on rename/move). Dot-namespaced dirs (agent-mount) are
 *  never tracked.
 *  @see docs/core.md#list-layer */
export class DirectoryIndex {
  private readonly dirs = new Set<string>()

  /** Add a directory path AND its ancestors. Idempotent; dot-namespaced dirs
   *  (the agent-mount) are never tracked (mirror localFs). */
  add(dir: string): void {
    if (!dir || dir.split('/').some((s) => s.startsWith('.'))) {
      return
    }
    let acc = ''

    for (const part of dir.split('/')) {
      acc = acc ? `${acc}/${part}` : part
      this.dirs.add(acc)
    }
  }

  /** Every tracked folder, in insertion order. */
  list(): string[] {
    return [...this.dirs]
  }

  clear(): void {
    this.dirs.clear()
  }

  /** Drop a folder subtree (the folder and its descendants) — the folder is
   *  gone on disk (removeDir). */
  removeSubtree(path: string): void {
    const prefix = `${path}/`

    for (const d of [...this.dirs]) {
      if (d === path || d.startsWith(prefix)) {
        this.dirs.delete(d)
      }
    }
  }

  /** Re-key a folder subtree from `src` to `dest` and register `dest` itself
   *  (folder move) — the src PARENT lingers (never-prune). */
  moveSubtree(src: string, dest: string): void {
    const prefix = `${src}/`

    for (const d of [...this.dirs]) {
      if (d === src || d.startsWith(prefix)) {
        this.dirs.delete(d)
        this.add(dest + d.slice(src.length))
      }
    }
    this.add(dest)
  }
}
