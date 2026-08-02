// localfs adapter of the storage seam — the only place in the engine that
// touches node:fs (P9: Node-isms live in edge adapters). Owns the safety
// rails: every relative path is resolved against the root and must stay under
// it (second rampart behind the host's relPath normalisation, same belt-and-
// suspenders the bare driver had), writes are tmp+rename atomic.
//
// Directories are DURABLE (#97): they are never auto-pruned when emptied — a
// folder is a first-class organising primitive (file-first, Obsidian-style), so
// moving the last note out of a folder leaves the folder standing. The directory
// channel (`listDirs`) surfaces them into the tree; an explicit `removeDir` is
// the only thing that deletes one. (Pre-#97 the engine rmdir'd emptied dirs so
// the note-derived tree matched the index; the directory
// channel replaces that — the tree shows real on-disk folders now.)

import { randomUUID } from 'node:crypto'
import { promises as fs, watch as fsWatch } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

import type { FileStat, FileStore } from './types'

/** Directory entries the scan never descends into: dotfiles hide editor/state
 *  dirs (.obsidian, .git — and our own tmp files are dot-named, so a mid-write
 *  rescan can't index a half file). */
const hidden = (name: string) => name.startsWith('.')

/** A change event under a hidden path (a dot-segment anywhere in its relative
 *  path) is noise the watcher ignores (#146): the tmp half of our atomic write is
 *  dot-named (`.<uuid>.tmp`), and .git/.obsidian churn never affects the note
 *  index (scan/listDirs skip dot-dirs too). NB the rename TARGET of our own write
 *  is a real `note.md` — non-hidden — so a write-through still self-fires a watch
 *  event; that's harmless (the read-model already patched its snapshot and
 *  coalesces the redundant reconcile via its trailing debounce). A dot-namespaced
 *  sub-mount (.notarium/memory) is watched by its OWN FileStore — rooted there,
 *  its paths carry no leading dot, so this filter on the root watcher doesn't
 *  blind the agent-mount. */
const hiddenPath = (rel: string | null): boolean =>
  rel != null && rel.split('/').some((seg) => seg.startsWith('.'))

const toPosix = (p: string) => p.split(sep).join('/')

const TEMP_WRITE_ATTEMPTS = 8
const nsToMs = (ns: bigint): number => Number(ns / 1_000_000n) + Number(ns % 1_000_000n) / 1_000_000

const errnoCode = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null ? (err as NodeJS.ErrnoException).code : undefined

/** Publishable bytes in a temp file claimed by THIS operation. The random name
 *  makes a collision vanishingly unlikely; `wx` is the correctness boundary —
 *  the filesystem, not probability, proves that no concurrent writer owns it.
 *  An EEXIST file belongs to somebody else and must never be cleaned up here. */
const writeTemp = async (dir: string, content: string): Promise<string> => {
  let collision: unknown

  for (let attempt = 0; attempt < TEMP_WRITE_ATTEMPTS; attempt++) {
    const tmp = join(dir, `.${randomUUID()}.tmp`)
    let handle

    try {
      handle = await fs.open(tmp, 'wx')
    } catch (err) {
      if (errnoCode(err) === 'EEXIST') {
        collision = err
        continue
      }
      throw err
    }

    // Only a successful exclusive open transfers ownership of this pathname to
    // the operation. From here on cleanup is safe; before it, even an existing
    // same-name file is somebody else's and must not be unlinked.
    let failure: { error: unknown } | undefined

    try {
      await handle.writeFile(content, 'utf8')
    } catch (err) {
      failure = { error: err }
    }

    try {
      await handle.close()
    } catch (err) {
      failure ??= { error: err }
    }

    if (failure) {
      // Cleanup is best-effort: the write/close error is the operation's truth
      // and must never be masked by unlink.
      await fs.unlink(tmp).catch(() => {})
      throw failure.error
    }

    return tmp
  }

  throw collision ?? new Error('failed to claim a temporary file')
}

export const createLocalFsFiles = (root: string): FileStore => {
  const rootAbs = resolve(root)

  /** Map a storage-relative path onto the disk, refusing escapes. */
  const abs = (rel: string): string => {
    const full = resolve(rootAbs, rel)

    if (full !== rootAbs && !full.startsWith(rootAbs + sep)) {
      throw new Error(`path escapes the storage root: ${rel}`)
    }

    return full
  }

  const statOf = async (rel: string): Promise<FileStat | null> => {
    try {
      const s = await fs.stat(abs(rel), { bigint: true })

      if (!s.isFile()) {
        return null
      }

      return {
        path: rel,
        mtimeMs: nsToMs(s.mtimeNs),
        size: Number(s.size),
        // An opaque, zero-extra-I/O prefilter. ctime catches in-place rewrites
        // whose mtime was restored; inode catches atomic replacement. Neither is
        // trusted forever — the engine's source hash sweep remains the arbiter.
        changeToken: `${s.dev}:${s.ino}:${s.ctimeNs}`,
        // Filesystems without creation time report 0 (or the epoch) — that is
        // "unknown", never a real date.
        birthtimeMs: s.birthtimeNs > 0n ? nsToMs(s.birthtimeNs) : null,
      }
    } catch {
      return null
    }
  }

  return {
    scan: async () => {
      const out: FileStat[] = []

      const walk = async (dirAbs: string): Promise<void> => {
        let entries

        try {
          entries = await fs.readdir(dirAbs, { withFileTypes: true })
        } catch {
          return // the dir vanished mid-scan — the next rescan reconverges
        }
        for (const e of entries) {
          if (hidden(e.name)) {
            continue
          }
          const full = join(dirAbs, e.name)

          if (e.isDirectory()) {
            await walk(full)
          } else if (e.isFile() && e.name.endsWith('.md')) {
            const s = await statOf(toPosix(relative(rootAbs, full)))

            if (s) {
              out.push(s)
            }
          }
        }
      }
      await walk(rootAbs)
      return out
    },

    listDirs: async () => {
      // The directory channel (#97): every non-dot directory under the root, on
      // its OWN typed walk — never mixed into scan()'s FileStat[] (the index =
      // notes-only invariant #78). Dot-dirs are skipped (.git/.obsidian and the
      // .notarium agent-mount), so only user-visible folders surface into the
      // tree. The root itself ('') is not a folder node — it is excluded.
      const out: string[] = []

      const walk = async (dirAbs: string): Promise<void> => {
        let entries

        try {
          entries = await fs.readdir(dirAbs, { withFileTypes: true })
        } catch {
          return // vanished mid-walk — the next listing reconverges
        }
        for (const e of entries) {
          if (!e.isDirectory() || hidden(e.name)) {
            continue
          }
          const full = join(dirAbs, e.name)
          out.push(toPosix(relative(rootAbs, full)))
          await walk(full)
        }
      }
      await walk(rootAbs)
      return out
    },

    stat: statOf,

    read: async (rel) => {
      try {
        return await fs.readFile(abs(rel), 'utf8')
      } catch {
        return null
      }
    },

    write: async (rel, content) => {
      const target = abs(rel)
      const dir = dirname(target)
      await fs.mkdir(dir, { recursive: true })
      const tmp = await writeTemp(dir, content)

      try {
        await fs.rename(tmp, target)
      } catch (err) {
        // A failed publish leaves no owned temp behind when cleanup is possible;
        // cleanup failure never replaces the actionable rename error.
        await fs.unlink(tmp).catch(() => {})
        throw err
      }
    },

    rename: async (from, to) => {
      const target = abs(to)
      await fs.mkdir(dirname(target), { recursive: true })
      await fs.rename(abs(from), target)
      // #97: no prune — the emptied source folder is durable (the directory
      // channel surfaces it; an explicit removeDir is the only delete).
    },

    renameDir: async (from, to) => {
      const target = abs(to)
      await fs.mkdir(dirname(target), { recursive: true })
      await fs.rename(abs(from), target)
    },

    remove: async (rel) => {
      try {
        await fs.unlink(abs(rel))
      } catch (err) {
        if (errnoCode(err) === 'ENOENT') {
          return // already gone — removing a missing file is a no-op
        }
        throw err
      }
    },

    makeDir: async (rel) => {
      // Anchor a brand-new empty folder on disk (#97 "New folder"). recursive so
      // intermediate ancestors materialise; idempotent (an existing dir is fine).
      await fs.mkdir(abs(rel), { recursive: true })
    },

    removeDir: async (rel) => {
      // Delete a folder subtree wholesale (#97 folder delete): notes, any sibling
      // markers (.notariummeta) and nested empty dirs go with it. force so a
      // missing dir is a no-op (idempotent, mirrors remove()).
      await fs.rm(abs(rel), { recursive: true, force: true })
    },

    exists: async (rel) => {
      try {
        await fs.access(abs(rel))
        return true
      } catch {
        return false
      }
    },

    dirExists: async (rel) => {
      if (!rel) {
        return true
      } // the storage root always exists as a directory
      try {
        return (await fs.stat(abs(rel))).isDirectory()
      } catch {
        return false
      }
    },

    watch: (onChange) => {
      // The fast path (#146): a recursive fs.watch turns an external edit into an
      // early reconcile instead of waiting out the poll interval. It is ONLY a
      // hint (P3) — the caller still reconciles by a full scan(), so we don't
      // need per-event accuracy, just a wake-up; a dropped event is caught by the
      // periodic backstop. fs.watch can throw synchronously where recursive watch
      // is unavailable (some platforms) or inotify is exhausted (ENOSPC/EMFILE);
      // we return null so the caller degrades to polling (honest P5), never crash.
      let watcher: ReturnType<typeof fsWatch>

      try {
        watcher = fsWatch(rootAbs, { recursive: true }, (_event, filename) => {
          // filename is root-relative (a Buffer becomes a string with the default
          // encoding); on the rare null we can't tell where it fired, so treat it
          // as a real change rather than dropping it.
          const rel = filename == null ? null : toPosix(filename.toString())

          if (hiddenPath(rel)) {
            return
          } // own tmp writes, .git/.obsidian — index-irrelevant
          onChange(rel)
        })
      } catch (err) {
        console.warn(
          '[notarium] fs watch unavailable — falling back to polling:',
          (err as Error).message,
        )
        return null
      }
      // An async watcher error (the inotify queue overflowed, the root was
      // removed) must not throw into the event loop — log and let the periodic
      // backstop carry correctness from here (the watcher is dead, polling lives).
      watcher.on('error', (err) =>
        console.warn(
          '[notarium] fs watch error — polling backstop continues:',
          (err as Error).message,
        ),
      )
      return () => watcher.close()
    },
  }
}
