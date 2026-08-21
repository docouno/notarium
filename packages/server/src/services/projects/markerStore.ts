// Engine-managed owner of `.notariummeta` markers: writes/reads the sibling
// dotfile outside the note write path, scans the tree on a separate typed
// channel. Per-space, keyed by the notes dir. Reading and scanning are portable;
// WRITING additionally needs the directory-inode anchor this module probes for,
// and a host missing EITHER of the two says so up front instead of failing
// mid-operation (honest degradation, P5).
// canon: docs/projects.md#the-notariummeta-marker-schema-parser-pin

import {
  closeSync,
  promises as fs,
  constants as fsConstants,
  fstatSync,
  openSync,
  statSync,
} from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

import { createLocalFsFiles } from '@notarium/engine'

import {
  MARKER_FILENAME,
  type MarkerFields,
  markerRelPath,
  parseMarker,
  type SpaceMarkerFacet,
} from './marker'

/** The one namespace both halves of this capability speak: the probe proves the
 *  anchor here, and every marker write addresses its open directory through it.
 *  Named because the two must not drift — a write re-anchored somewhere else
 *  would leave the probe vouching for a namespace it no longer uses, and TS
 *  checks neither string. */
const PROC_SELF_FD = '/proc/self/fd'
const fdPath = (fd: number): string => `${PROC_SELF_FD}/${fd}`

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
  /** WRITE-oriented: true only where this store can both reach a notes dir AND
   *  publish a marker into an existing folder through its open directory inode.
   *  A caller gating a marker-backed MUTATION asks this; the read side (`read`,
   *  `scan`, `folderExists`) is portable and asks nothing. */
  available(space: string): boolean
  /** Write-through a marker at an EXISTING `folderPath`; marker metadata never
   *  provisions a user-visible directory. Mount-boundary guard (P8): refuses
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

/** What an anchored marker write needs from the host it was composed on. */
export type AnchoredMarkerRuntime = {
  platform: string
  /** `/proc/self/fd/<fd>` really re-enters the fd it names, proven on a live fd. */
  procSelfFdAnchor: boolean
}

/** The runtime matrix as a pure table, so the negative branches are provable on
 *  any platform. Deliberately NOT derived from the directory no-replace fact:
 *  a marker rides file CAS through a proc-fd anchor, not `renameat2` on a dir. */
export const anchoredMarkerWritesForRuntime = (facts: AnchoredMarkerRuntime): boolean =>
  facts.platform === 'linux' && facts.procSelfFdAnchor

/** Open a directory and demand that `/proc/self/fd/<fd>` names that very inode.
 *  The existence of `/proc/self/fd` proves nothing on its own — a container can
 *  carry the directory without the dynamic per-fd entries the write depends on,
 *  and that host would advertise a capability it cannot perform. Fail closed on
 *  any error, mismatch or missing entry. */
const procSelfFdAnchors = (): boolean => {
  let fd: number | undefined

  try {
    fd = openSync(PROC_SELF_FD, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0))
    const opened = fstatSync(fd, { bigint: true })
    const throughProc = statSync(fdPath(fd), { bigint: true })

    return opened.dev === throughProc.dev && opened.ino === throughProc.ino
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // The probe's verdict is already settled; a close failure cannot change it.
      }
    }
  }
}

export const anchoredMarkerWritesAvailable = (): boolean =>
  anchoredMarkerWritesForRuntime({
    platform: process.platform,
    procSelfFdAnchor: procSelfFdAnchors(),
  })

/** What a marker write needs of storage, and nothing else: the current bytes, and
 *  a compare-and-set over them. Directory moves, package publication and entry
 *  identity are not its dependencies — a host that cannot do any of them can
 *  still identify a folder. */
export type MarkerAnchoredFileView = {
  read(path: string): Promise<string | null>
  mutation: {
    writeIfAbsent(path: string, content: string): Promise<boolean>
    replaceIfAbsent(
      from: string,
      to: string,
      expectedSource: string,
      content: string,
    ): Promise<boolean>
    removeIfUnchanged(path: string, expectedContent: string): Promise<boolean>
  }
}

/** Built PER WRITE, on the `/proc/self/fd/<fd>` pathname of a directory this
 *  process has already opened. A prebuilt bundle cannot exist: the root only
 *  comes into being once the fd does, and that is the entire point — every
 *  relative operation then resolves through the captured inode, so a folder
 *  renamed or recreated mid-write cannot receive the bytes. */
export type MarkerAnchoredFilesFactory = (anchorRoot: string) => MarkerAnchoredFileView

export type MarkerStoreOptions = {
  /** Pin the runtime fact instead of probing for it. `false` must survive: the
   *  option is read by presence, never by truthiness, or the one case worth
   *  testing would silently fall back to the host's real answer. */
  anchoredWritesAvailable?: boolean
  /** The storage half of the capability. REQUIRED to pass, allowed to be
   *  `undefined`: a composition root that cannot offer conditional file mutation
   *  says so here, and `available` answers false for the same reason it answers
   *  false without the host anchor — one capability, two prerequisites. */
  anchoredFilesForRoot?: MarkerAnchoredFilesFactory | undefined
}

/** The production factory: one LocalFS assembly on the opened directory, narrowed
 *  to the two things a marker write reaches for. Absent when the adapter declares
 *  no conditional mutation at all. */
export const localFsAnchoredFiles = (): MarkerAnchoredFilesFactory | undefined =>
  createLocalFsFiles(PROC_SELF_FD).capabilities.conditionalFileMutation
    ? (anchorRoot) => {
        const anchored = createLocalFsFiles(anchorRoot)

        return {
          read: (path) => anchored.base.read(path),
          mutation: anchored.capabilities.conditionalFileMutation!,
        }
      }
    : undefined

export const createMarkerStore = (
  notesDirFor: (space: string) => string | null,
  options: MarkerStoreOptions = {},
): MarkerStore => {
  // Settled once per store. A `/proc` that vanishes afterwards is an operation
  // error, fail closed — this was never a hot-plug promise.
  const anchoredWrites = options.anchoredWritesAvailable ?? anchoredMarkerWritesAvailable()
  const anchoredFilesForRoot = options.anchoredFilesForRoot
  const unavailable = (): Error =>
    Object.assign(new Error('directory-anchored marker writes are unavailable'), {
      code: 'ENOTSUP',
    })

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

  /** Atomic marker visibility without mkdir. The containing folder is the
   *  subject being marked/identified and therefore a precondition, never an
   *  output of this metadata write. */
  const writeInExistingFolder = async (
    rootAbs: string,
    folderPath: string,
    raw: string,
    anchoredFiles: MarkerAnchoredFilesFactory,
  ): Promise<void> => {
    const folderAbs = absIn(rootAbs, folderPath)
    let folderHandle

    try {
      folderHandle = await fs.open(
        folderAbs,
        fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
      )
      const captured = await folderHandle.stat({ bigint: true })

      if (!captured.isDirectory()) {
        throw Object.assign(new Error('marker parent is not a directory'), { code: 'ENOTDIR' })
      }

      // `/proc/self/fd/N` resolves every relative operation through the opened
      // directory inode. If the public folder is renamed/recreated midway, a
      // temp or journal path can never be rebound into the replacement folder.
      // The exact `/proc/self/fd/<fd>` of the directory just opened — never the
      // public pathname it was reached by.
      const anchored = anchoredFiles(fdPath(folderHandle.fd))
      const mutation = anchored.mutation
      const before = await anchored.read(MARKER_FILENAME)
      let written: boolean

      if (before == null) {
        written = await mutation.writeIfAbsent(MARKER_FILENAME, raw)
      } else {
        written = await mutation.replaceIfAbsent(MARKER_FILENAME, MARKER_FILENAME, before, raw)
      }

      if (!written) {
        throw Object.assign(new Error('marker changed concurrently'), { code: 'ESTALE' })
      }

      const current = await fs.lstat(folderAbs, { bigint: true }).catch(() => null)
      const parentUnchanged =
        current?.isDirectory() && current.dev === captured.dev && current.ino === captured.ino

      if (parentUnchanged) {
        return
      }

      // The anchored update landed in the captured directory, never in its
      // replacement. Roll it back with the same content-CAS before reporting a
      // stale parent; a second writer wins rather than being overwritten.
      const rolledBack =
        before == null
          ? await mutation.removeIfUnchanged(MARKER_FILENAME, raw)
          : await mutation.replaceIfAbsent(MARKER_FILENAME, MARKER_FILENAME, raw, before)

      if (!rolledBack) {
        throw Object.assign(new Error('marker parent changed; rollback was not safe'), {
          code: 'ESTALE',
        })
      }
      throw Object.assign(new Error('marker parent changed concurrently'), { code: 'ESTALE' })
    } finally {
      await folderHandle?.close().catch(() => {})
    }
  }

  return {
    // One capability, three prerequisites, all settled without touching a disk:
    // the host anchor, the storage half composition handed over, and a notes dir
    // to anchor inside. A `true` that skipped any of them would be discovered
    // mid-write, which is what this method exists to prevent.
    available: (space) =>
      anchoredWrites && anchoredFilesForRoot !== undefined && notesDirFor(space) !== null,

    write: async (space, folderPath, raw) => {
      // The mount-boundary refusal stays first: it is a pure string verdict that
      // touches no filesystem, and it must read the same on every host.
      if (hasDotSegment(folderPath)) {
        throw new Error(`refusing to write a marker under a dot namespace: ${folderPath}`)
      }
      // Then the runtime, still before `rootFor`, the directory open and any
      // temp/CAS byte: an unsupported host starts no marker mutation at all.
      if (!anchoredWrites || !anchoredFilesForRoot) {
        throw unavailable()
      }
      const rootAbs = rootFor(space)

      if (!rootAbs) {
        throw new Error(`no marker storage for space ${space}`)
      }
      await writeInExistingFolder(rootAbs, folderPath, raw, anchoredFilesForRoot)
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
      await createLocalFsFiles(dir).base.remove(markerRelPath(folderPath))
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
