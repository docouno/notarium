// Engine-managed owner of `.notariummeta` markers: writes/reads the sibling
// dotfile outside the note write path, scans the tree on a separate typed
// channel. Per-space, keyed by the notes dir; a space with no local notes dir
// has no marker capability there (honest degradation, P5).
// canon: docs/projects.md#the-notariummeta-marker-schema-parser-pin

import { promises as fs } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

import { createLocalFsFiles } from '@notarium/engine'

import {
  MARKER_FILENAME,
  type MarkerFields,
  markerRelPath,
  parseMarker,
  type SpaceMarkerFacet,
} from './marker'

/** Read + parse a notes dir's root `.notariummeta` directly by path — re-clone
 *  adoption needs the space facet BEFORE the folder has a registry id (so the
 *  id-keyed store can't resolve it). Absent/broken/unreadable ⇒ null (caller
 *  mints a fresh id). */
export const readRootMarker = async (notesDir: string): Promise<MarkerFields | null> => {
  try {
    return parseMarker(await fs.readFile(join(notesDir, MARKER_FILENAME), 'utf8'))
  } catch {
    return null
  }
}

/** A space root found by the re-clone discovery walk. `displayName` is the
 *  marker's — the space's label rides there as the root project's name; the
 *  `space` facet itself carries none. */
export type SpaceFolderHit = { notesDir: string; facet: SpaceMarkerFacet; displayName?: string }

/** Walk SPACES_ROOT's immediate children for space roots carrying a `space`
 *  facet (re-clone discovery). Symlinked children are NOT followed (a readdir
 *  Dirent reports a symlink, not a directory). Deterministic order so a
 *  slug-collision suffix is stable across boots/filesystems. Never throws
 *  (unreadable root/child → simply absent). */
export const discoverSpaceFolders = async (
  spacesRoot: string,
  exclude: (absDir: string) => boolean = () => false,
): Promise<SpaceFolderHit[]> => {
  let entries

  try {
    entries = await fs.readdir(spacesRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const out: SpaceFolderHit[] = []

  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) {
      continue
    }
    const abs = resolve(join(spacesRoot, e.name))

    if (exclude(abs)) {
      continue
    }
    const marker = await readRootMarker(abs)

    if (!marker?.space) {
      continue
    }
    out.push({ notesDir: e.name, facet: marker.space, displayName: marker.displayName })
  }
  out.sort((a, b) => (a.notesDir < b.notesDir ? -1 : a.notesDir > b.notesDir ? 1 : 0))
  return out
}

/** One on-disk marker from a scan. `folderPath` is POSIX, space-relative (`''`
 *  = space root); `raw` is the unparsed bytes (the store is format-agnostic).
 */
export type MarkerHit = { folderPath: string; raw: string }

/** Result of a marker scan. `complete` is false when ANY dir/marker was
 *  unreadable → the hit set is a LOWER BOUND; the reconcile MUST gate
 *  orphan-prune on it (a partial scan must never prune a live row).
 *  canon: docs/projects.md#reconcile-the-row-lifecycle-fork-b-lazy-i3-implemented-cadence-boot-only-2026-06-18 */
export type MarkerScan = { hits: MarkerHit[]; complete: boolean }

export type MarkerStore = {
  available(space: string): boolean
  /** Write-through a marker at `folderPath`. Mount-boundary guard (P8): refuses
   *  ANY dot-segment path, so a marker can never land under `.notarium/*` (the
   *  second line after the host's safeRelPath). */
  write(space: string, folderPath: string, raw: string): Promise<void>
  /** The marker's bytes, or null when ABSENT. A transient error (EACCES/EIO/
   *  lock) THROWS — never mistake it for "unmarked", or a re-mint would
   *  overwrite a live marker. */
  read(space: string, folderPath: string): Promise<string | null>
  /** Remove the marker (unmark); no-op when already gone. The folder stays (it
   *  holds notes) — only the project identity is dropped. */
  remove(space: string, folderPath: string): Promise<void>
  /** Does the folder exist on disk AS A DIRECTORY? A file path answers false
   *  (you cannot mark a file as a project). */
  folderExists(space: string, folderPath: string): Promise<boolean>
  /** Every `.notariummeta` under the space, ordered by folderPath (stable across
   *  filesystems). */
  scan(space: string): Promise<MarkerScan>
}

const hasDotSegment = (folderPath: string): boolean =>
  // Normalise backslashes first (mirror safeRelPath) so this belt is a superset
  // of the host's guard on every filesystem.
  folderPath
    .replaceAll('\\', '/')
    .split('/')
    .some((seg) => seg.startsWith('.'))

const toPosix = (p: string) => p.split(sep).join('/')

export const createMarkerStore = (notesDirFor: (space: string) => string | null): MarkerStore => {
  const rootFor = (space: string) => {
    const dir = notesDirFor(space)
    return dir ? resolve(dir) : null
  }

  /** Map a space-relative path onto disk, refusing escapes (mirror localFs.abs). */
  const absIn = (rootAbs: string, rel: string): string => {
    const full = resolve(rootAbs, rel)

    if (full !== rootAbs && !full.startsWith(rootAbs + sep)) {
      throw new Error(`path escapes the storage root: ${rel}`)
    }

    return full
  }

  return {
    available: (space) => notesDirFor(space) !== null,

    write: async (space, folderPath, raw) => {
      if (hasDotSegment(folderPath)) {
        throw new Error(`refusing to write a marker under a dot namespace: ${folderPath}`)
      }
      const dir = notesDirFor(space)

      if (!dir) {
        throw new Error(`no marker storage for space ${space}`)
      }
      // localFs.write is atomic (tmp+rename) — a crash mid-write can't leave a
      // half-marker.
      await createLocalFsFiles(dir).write(markerRelPath(folderPath), raw)
    },

    read: async (space, folderPath) => {
      const rootAbs = rootFor(space)

      if (!rootAbs) {
        return null
      }
      try {
        return await fs.readFile(absIn(rootAbs, markerRelPath(folderPath)), 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return null
        }
        throw err // EACCES/EIO/lock — never read a transient error as "unmarked"
      }
    },

    remove: async (space, folderPath) => {
      const dir = notesDirFor(space)

      if (!dir) {
        return
      }
      // localFs.remove unlinks + best-effort prunes emptied dirs; a folder that
      // still holds notes stays.
      await createLocalFsFiles(dir).remove(markerRelPath(folderPath))
    },

    folderExists: async (space, folderPath) => {
      if (hasDotSegment(folderPath)) {
        return false
      }
      const rootAbs = rootFor(space)

      if (!rootAbs) {
        return false
      }
      try {
        const s = await fs.stat(absIn(rootAbs, folderPath))
        return s.isDirectory()
      } catch {
        return false
      }
    },

    scan: async (space) => {
      const rootAbs = rootFor(space)

      if (!rootAbs) {
        return { hits: [], complete: false }
      } // no dir = no truth to assert (complete:false → never prune)
      const out: MarkerHit[] = []
      let complete = true

      const walk = async (dirAbs: string): Promise<void> => {
        let entries

        try {
          entries = await fs.readdir(dirAbs, { withFileTypes: true })
        } catch {
          complete = false // dir unreadable/vanished — scan is a lower bound
          return
        }
        for (const e of entries) {
          if (e.name === MARKER_FILENAME && !e.isFile()) {
            // A marker-named dirent that is NOT a regular file (a symlink — the
            // Dirent is lstat-style). Suppress prune: an unclassifiable marker
            // must never read as "absent" and delete a row.
            complete = false
          } else if (e.isFile() && e.name === MARKER_FILENAME) {
            try {
              const raw = await fs.readFile(join(dirAbs, e.name), 'utf8')
              out.push({ folderPath: toPosix(relative(rootAbs, dirAbs)), raw })
            } catch {
              complete = false // gone between readdir and read — race, don't prune
            }
          } else if (e.isDirectory() && !e.name.startsWith('.')) {
            // Skip dot-dirs (incl. `.notarium/`): the walk never descends into a
            // Notarium-managed namespace.
            await walk(join(dirAbs, e.name))
          }
        }
      }
      await walk(rootAbs)
      // Deterministic order (raw readdir order is filesystem-dependent) so a
      // derived-slug collision suffixes identically on every boot/clone.
      out.sort((a, b) => (a.folderPath < b.folderPath ? -1 : a.folderPath > b.folderPath ? 1 : 0))
      return { hits: out, complete }
    },
  }
}
