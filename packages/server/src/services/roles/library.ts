import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, opendir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative as relativePath } from 'node:path'

import { isGeneratedNoteId, isSkillName } from '@notarium/core'
import type { AdmissionMode, SpaceResourceAuthority } from '@notarium/engine'
import { isReclaimableInstallStaging } from './installStaging'
import { MAX_SKILL_FILE_BYTES, MAX_SKILL_MANIFEST_BYTES, parseSkillFile } from './skillFile'
import type { RoleLocation } from './types'

const MAX_PACKAGE_FILES = 256
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024
const MAX_PACKAGE_ENTRIES = 512
const MAX_PACKAGE_DEPTH = 16
const MAX_LIBRARY_ENTRIES = 1_024
const MAX_LIBRARY_PACKAGES = 256
const MAX_LIBRARY_BYTES = 64 * 1024 * 1024
// The same window the two age-only sweeps of this repo use, and a stricter bound
// than theirs: they sweep a file whose mtime advances on every write, while a
// staging DIRECTORY's mtime freezes at its last top-level entry — so this bounds
// an install's whole wall-clock time, not its idle time.
const STALE_INSTALL_MS = 60 * 60 * 1_000

const pathOccupied = async (path: string): Promise<boolean> => {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

export type SkillPackage = {
  /** Physical package address below one placement root. */
  directoryName: string
  files: Map<string, Uint8Array>
}

/** The target exists, but its package shape exceeds the supported Agent Skills envelope. */
export class InvalidSkillPackageError extends Error {}

export type RoleLibraryListing = { packages: SkillPackage[]; truncated: boolean }

export type PublishedRolePackage = {
  directoryName: string
  /** Space-relative path served by the ordinary note projection. */
  filePath: string
}

export type ProjectPublishedRolePackages = (
  space: string,
  packages: readonly PublishedRolePackage[],
  /** `settle` forces the host to reconcile file truth before answering. It is the
   *  publication barrier, and it belongs to publication only — a read pays for it
   *  with a global mutation block over the whole space. */
  options?: { settle?: boolean },
) => Promise<ReadonlyMap<string, string>>

export type RoleLibrary = {
  /** Discovery projection: direct SKILL.md frontmatter only, never package resources
   *  or instruction bodies. Invalid manifests are isolated by the parser; oversized
   *  manifests are skipped without reading their bodies. */
  listManifests(location: RoleLocation): Promise<RoleLibraryListing>
  /** One complete SKILL.md, without resources — activation's progressive load. */
  getSkill(location: RoleLocation, name: string): Promise<SkillPackage | null>
  /** One exact SKILL.md by its immutable owned package address. */
  getSkillByDirectory(location: RoleLocation, directoryName: string): Promise<SkillPackage | null>
  /** Whether the package target is occupied, including an invalid package. */
  exists(location: RoleLocation, name: string): Promise<boolean>
  /** Complete package bytes — Add/conflict verification only. */
  get(location: RoleLocation, name: string): Promise<SkillPackage | null>
  /** Complete package bytes by immutable owned package address. */
  getByDirectory(location: RoleLocation, directoryName: string): Promise<SkillPackage | null>
  putIfAbsent(location: RoleLocation, pkg: SkillPackage): Promise<boolean>
  /** Move one package between two placements of the SAME space, keeping its
   *  address. `false` — the destination pathname or manifest name was taken and
   *  nothing moved. This is an external move as far as the note read-model is
   *  concerned: the id lives in the file's frontmatter, so it survives the path
   *  change ([P7](docs/architecture.md#p7)) — which is the whole reason a
   *  promotion moves the directory instead of republishing its bytes. */
  movePackage(from: RoleLocation, to: RoleLocation, directoryName: string): Promise<boolean>
  /** Cross the host's read-model publication barrier and return the actual note
   *  identity for every package address (the two differ after claim arbitration).
   *  For WRITES only: the barrier reconciles file truth and blocks mutations across
   *  the space while it runs. */
  awaitReadableNoteIds(
    location: RoleLocation,
    directoryNames: readonly string[],
  ): Promise<ReadonlyMap<string, string>>
  /** The same identities off the current projection, without the barrier. A package
   *  the projection has not caught up with is simply absent — which every reader
   *  already treats as "not listable yet", the same answer it would get from a
   *  package published one millisecond later. */
  readableNoteIds(
    location: RoleLocation,
    directoryNames: readonly string[],
  ): Promise<ReadonlyMap<string, string>>
}

export type InMemoryRoleLibrary = RoleLibrary & { clear(): void }

export const validateSkillPackage = (pkg: SkillPackage): void => {
  if (
    (!isGeneratedNoteId(pkg.directoryName) && !isSkillName(pkg.directoryName)) ||
    !pkg.files.has('SKILL.md') ||
    pkg.files.get('SKILL.md')!.byteLength > MAX_SKILL_FILE_BYTES ||
    pkg.files.size > MAX_PACKAGE_FILES
  ) {
    throw new InvalidSkillPackageError(`invalid Agent Skill package: ${pkg.directoryName}`)
  }
  let packageBytes = 0
  const entries = new Set<string>()

  for (const [relative, content] of pkg.files) {
    const parts = relative.split('/')

    if (
      !relative ||
      relative.includes('\\') ||
      parts.length > MAX_PACKAGE_DEPTH + 1 ||
      parts.some((part) => !part || part === '.' || part === '..')
    ) {
      throw new InvalidSkillPackageError(`invalid Agent Skill package path: ${relative}`)
    }
    for (let index = 1; index <= parts.length; index++) {
      entries.add(parts.slice(0, index).join('/'))
    }
    if (entries.size > MAX_PACKAGE_ENTRIES) {
      throw new InvalidSkillPackageError(
        `Agent Skill package has too many entries: ${pkg.directoryName}`,
      )
    }
    packageBytes += content.byteLength
    if (packageBytes > MAX_PACKAGE_BYTES) {
      throw new InvalidSkillPackageError(`Agent Skill package is too large: ${pkg.directoryName}`)
    }
  }
}

const projectDirectory = (projectId: string): string =>
  Buffer.from(projectId, 'utf8').toString('base64url')

// Personal/Space package names own the mount root. Projects live below one
// reserved, non-package namespace so a role named like a project id can never
// swallow (or be swallowed by) that project's library. Leading `_` is outside
// the package-name grammar but remains visible to the Markdown index walk.
const packageRoot = (libraryRoot: string, location: RoleLocation): string =>
  location.scope === 'project'
    ? join(libraryRoot, '_projects', projectDirectory(location.projectId!))
    : libraryRoot

const assertRealDirectory = async (path: string, missingAllowed: boolean): Promise<void> => {
  try {
    const info = await lstat(path)

    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`role library path must be a real directory: ${path}`)
    }
  } catch (err) {
    if (missingAllowed && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw err
  }
}

const readBoundedFile = async (path: string, remaining: number): Promise<Uint8Array> => {
  const handle = await open(path, 'r')

  try {
    const info = await handle.stat()

    if (info.size > remaining) {
      throw new InvalidSkillPackageError(`Agent Skill package is too large: ${path}`)
    }
    const chunks: Buffer[] = []
    let total = 0

    for (;;) {
      const capacity = Math.min(64 * 1024, remaining - total + 1)
      const chunk = Buffer.allocUnsafe(capacity)
      const { bytesRead } = await handle.read(chunk, 0, capacity)

      if (!bytesRead) {
        return Buffer.concat(chunks, total)
      }
      total += bytesRead
      if (total > remaining) {
        throw new InvalidSkillPackageError(`Agent Skill package is too large: ${path}`)
      }
      chunks.push(chunk.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }
}

const readManifestPrefix = async (path: string): Promise<Uint8Array> => {
  const handle = await open(path, 'r')

  try {
    const buffer = Buffer.allocUnsafe(MAX_SKILL_MANIFEST_BYTES)
    let total = 0

    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total)

      if (!bytesRead) {
        break
      }
      total += bytesRead
    }
    const prefix = buffer.subarray(0, total)
    const raw = prefix.toString('utf8')
    const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(raw)

    // Returning a bounded invalid prefix lets the role parser reject just this
    // package without discovery ever reading the remainder of a hostile file.
    return Buffer.from(frontmatter?.[0] ?? prefix)
  } finally {
    await handle.close()
  }
}

const readPackageFiles = async (root: string): Promise<Map<string, Uint8Array>> => {
  const files = new Map<string, Uint8Array>()
  let bytes = 0
  let entries = 0

  const walk = async (directory: string, prefix = '', depth = 0): Promise<void> => {
    if (depth > MAX_PACKAGE_DEPTH) {
      throw new InvalidSkillPackageError(`Agent Skill package is nested too deeply: ${root}`)
    }
    for await (const entry of await opendir(directory)) {
      entries++
      if (entries > MAX_PACKAGE_ENTRIES) {
        throw new InvalidSkillPackageError(`Agent Skill package has too many entries: ${root}`)
      }
      if (entry.isSymbolicLink()) {
        continue
      }
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = join(directory, entry.name)

      if (entry.isDirectory()) {
        await walk(absolute, relative, depth + 1)
      } else if (entry.isFile()) {
        if (files.size >= MAX_PACKAGE_FILES) {
          throw new InvalidSkillPackageError(`Agent Skill package has too many files: ${root}`)
        }
        const content = await readBoundedFile(absolute, MAX_PACKAGE_BYTES - bytes)
        bytes += content.byteLength
        files.set(relative, content)
      }
    }
  }

  await walk(root)
  return files
}

const skillFileSize = async (root: string): Promise<number | null> => {
  try {
    const info = await lstat(join(root, 'SKILL.md'))
    return info.isFile() && !info.isSymbolicLink() ? info.size : null
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw err
  }
}

export const readPackagesFromDirectory = async (root: string): Promise<SkillPackage[]> => {
  let directory

  try {
    directory = await opendir(root)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw err
  }
  const packages: SkillPackage[] = []
  let entries = 0
  let bytes = 0

  for await (const entry of directory) {
    entries++
    if (entries > MAX_LIBRARY_ENTRIES) {
      throw new Error(`role library has too many entries: ${root}`)
    }
    if (!entry.isDirectory() || !isSkillName(entry.name)) {
      continue
    }
    const packageDirectory = join(root, entry.name)

    // A valid package is anchored by its direct SKILL.md. Check that cheap,
    // bounded discriminator before walking arbitrary sibling/project folders.
    if ((await skillFileSize(packageDirectory)) === null) {
      continue
    }
    if (packages.length >= MAX_LIBRARY_PACKAGES) {
      throw new Error(`role library has too many packages: ${root}`)
    }
    const files = await readPackageFiles(packageDirectory)
    bytes += [...files.values()].reduce((total, file) => total + file.byteLength, 0)
    if (bytes > MAX_LIBRARY_BYTES) {
      throw new Error(`role library is too large: ${root}`)
    }
    packages.push({ directoryName: entry.name, files })
  }

  return packages.sort((left, right) => left.directoryName.localeCompare(right.directoryName))
}

/** The engine's atomic directory no-replace, as this composition root found it.
 *  `undefined` is a real answer, not an omission — see the constructor. */
export type PublishDirectoryIfAbsent = (source: string, target: string) => Promise<boolean>

export const createFsRoleLibrary = ({
  rootForSpace,
  publishDirectoryIfAbsent,
  authorityForSpace,
  resourcePrefixForSpace,
  projectPublishedPackages,
}: {
  rootForSpace(space: string): string | null
  /** REQUIRED to pass, allowed to be `undefined`: every composition root has to
   *  state what the runtime it built on can do, and a library that inherited an
   *  absent capability must be indistinguishable — in tests too — from one built
   *  on a host that genuinely lacks it. */
  publishDirectoryIfAbsent: PublishDirectoryIfAbsent | undefined
  authorityForSpace?(space: string): Promise<SpaceResourceAuthority | null>
  resourcePrefixForSpace?(space: string): string | null
  projectPublishedPackages?: ProjectPublishedRolePackages
}): RoleLibrary => {
  const projectNoteIds = async (
    location: RoleLocation,
    directoryNames: readonly string[],
    settle: boolean,
  ): Promise<ReadonlyMap<string, string>> => {
    const unique = [...new Set(directoryNames)]

    // Nothing to project is not a reason to reconcile a whole space.
    if (!unique.length) {
      return new Map()
    }
    if (!projectPublishedPackages) {
      return new Map(unique.map((directoryName) => [directoryName, directoryName]))
    }
    const packages = unique.map((directoryName): PublishedRolePackage => {
      const packagePath = resourcePackagePath(location, directoryName)

      if (packagePath == null) {
        throw new Error('role library has no projected resource path')
      }

      return { directoryName, filePath: `${packagePath}/SKILL.md` }
    })

    return projectPublishedPackages(location.space, packages, { settle })
  }

  const rootsOf = (location: RoleLocation): { mount: string; root: string } => {
    const mount = rootForSpace(location.space)

    if (!mount) {
      throw new Error('role library is unavailable for this space')
    }
    if (location.scope === 'project' && !location.projectId) {
      throw new Error('project role location requires projectId')
    }

    return { mount, root: packageRoot(mount, location) }
  }
  const rootOf = (location: RoleLocation): string => rootsOf(location).root
  type SweepState = { running?: Promise<void>; cleanUntil: number }
  const sweeps = new Map<string, SweepState>()
  const placementFences = new Map<string, Promise<void>>()

  const acquirePlacementFence = async (root: string): Promise<() => void> => {
    const previous = placementFences.get(root) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.catch(() => undefined).then(() => gate)

    placementFences.set(root, tail)
    await previous.catch(() => undefined)

    return () => {
      release()
      if (placementFences.get(root) === tail) {
        placementFences.delete(root)
      }
    }
  }

  const prepareRoot = async (
    location: RoleLocation,
    mount: string,
    root: string,
  ): Promise<void> => {
    if (location.scope !== 'project') {
      await mkdir(root, { recursive: true })
      return
    }

    // The configured mount itself may intentionally be a symlink, but the two
    // namespaces owned by the library must not redirect sweeping or publication.
    const projectsRoot = join(mount, '_projects')

    await assertRealDirectory(projectsRoot, true)
    await assertRealDirectory(root, true)
    await mkdir(root, { recursive: true })
    await assertRealDirectory(projectsRoot, false)
    await assertRealDirectory(root, false)
  }

  /** One non-recursive pass over a library root, removing staging directories no
   *  live install can still own. Returns whether anything was spared for being
   *  young. A failure on one entry never stops the rest: an undeletable leftover
   *  (EACCES after a restore under a foreign uid, EBUSY on a mounted path) would
   *  otherwise block the reclaim of every other one forever. */
  const reclaimStaleStaging = async (mount: string, root: string): Promise<boolean> => {
    let entries = 0
    let spared = false

    for await (const entry of await opendir(root)) {
      entries++
      if (entries > MAX_LIBRARY_ENTRIES) {
        break
      }
      const path = join(root, entry.name)

      try {
        // Dirent is only a snapshot from when the root was opened. A restore or
        // sync can replace that pathname before cleanup reaches it, so the
        // destructive type decision must use the object that is current now.
        const info = await lstat(path)

        if (!isReclaimableInstallStaging(relativePath(mount, path), info.isDirectory())) {
          continue
        }
        if (Date.now() - info.mtimeMs < STALE_INSTALL_MS) {
          spared = true
          continue
        }
        await rm(path, { recursive: true, force: true })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          continue // a concurrent install finished with its own staging
        }
        console.warn(
          `[roles] ignoring unreclaimable staging ${entry.name}:`,
          (err as Error).message,
        )
      }
    }

    return spared
  }

  /** Reclaim orphaned staging lazily without walking once per dependency. An
   *  in-flight promise deduplicates concurrent installs. A clean result is cached
   *  only for the stale window: staging may appear later after another process
   *  dies or this process fails to clean its own temp, and by the time that new
   *  entry can be reclaimable the cache must have expired. A young entry clears
   *  the cache immediately so the next install can observe it crossing the age
   *  threshold. A failed pass is throttled for one window rather than retried on
   *  every package publication forever. */
  const sweepStaleStaging = (mount: string, root: string): Promise<void> => {
    const state = sweeps.get(root) ?? { cleanUntil: 0 }

    if (state.running) {
      return state.running
    }
    if (state.cleanUntil > Date.now()) {
      return Promise.resolve()
    }
    const sweep = reclaimStaleStaging(mount, root)
      .then((spared) => {
        state.cleanUntil = spared ? 0 : Date.now() + STALE_INSTALL_MS
      })
      .catch((err: Error) => {
        state.cleanUntil = Date.now() + STALE_INSTALL_MS
        console.warn(`[roles] failed to sweep install staging in ${root}:`, err.message)
      })
      .finally(() => {
        state.running = undefined
      })

    state.running = sweep
    sweeps.set(root, state)
    return sweep
  }

  const resourcePackagePath = (location: RoleLocation, name: string): string | null => {
    const prefix = resourcePrefixForSpace?.(location.space)

    if (prefix == null) {
      return null
    }
    if (location.scope === 'project' && !location.projectId) {
      throw new Error('project role location requires projectId')
    }
    const relative =
      location.scope === 'project'
        ? `_projects/${projectDirectory(location.projectId!)}/${name}`
        : name

    return prefix ? `${prefix}/${relative}` : relative
  }

  const authorityContext = async (
    location: RoleLocation,
    name: string,
  ): Promise<{ authority: SpaceResourceAuthority; resourcePath: string } | null> => {
    const authority = await authorityForSpace?.(location.space)
    const resourcePath = resourcePackagePath(location, name)

    return authority && resourcePath ? { authority, resourcePath } : null
  }

  /** The PLACEMENT-wide lease. Personal and a Space root are one directory shared by
   *  every package in the placement, so "is this manifest name free" and "publish it"
   *  have to be one critical section ACROSS package ids — a per-package lease cannot
   *  express that. Both writers into a placement take it: publication had it inline,
   *  promotion had only the per-package leases and the in-process fence, so the two
   *  serialised against different mutexes and could both find one name free. */
  const withPlacementAdmission = async <T>(
    location: RoleLocation,
    name: string,
    owner: string,
    task: (
      context: { authority: SpaceResourceAuthority; resourcePath: string } | null,
    ) => Promise<T>,
  ): Promise<T> => {
    const context = await authorityContext(location, name)

    if (!context) {
      return task(null)
    }
    const lease = await context.authority.admitSkillPlacement(
      `${context.resourcePath}/SKILL.md`,
      'exclusive',
      owner,
    )

    try {
      return await task(context)
    } finally {
      lease.settle()
    }
  }

  const withPackageAdmission = async <T>(
    location: RoleLocation,
    name: string,
    mode: AdmissionMode,
    owner: string,
    task: (
      context: { authority: SpaceResourceAuthority; resourcePath: string } | null,
    ) => Promise<T>,
  ): Promise<T> => {
    const context = await authorityContext(location, name)

    if (!context) {
      return task(null)
    }
    const lease = await context.authority.admitPackage(context.resourcePath, mode, owner)

    try {
      return await task(context)
    } finally {
      lease.settle()
    }
  }

  const manifestAt = async (
    location: RoleLocation,
    directoryName: string,
    owner: string,
  ): Promise<{ size: number; content: Uint8Array } | null> => {
    const packageDirectory = join(rootOf(location), directoryName)

    return withPackageAdmission(location, directoryName, 'shared', owner, async (context) => {
      if (context) {
        const observation = await context.authority.observe(`${context.resourcePath}/SKILL.md`, {
          owner: `${owner}-read`,
          packagePath: context.resourcePath,
          maxBytes: MAX_SKILL_FILE_BYTES,
        })

        return observation.kind === 'present'
          ? { size: observation.bytes.byteLength, content: observation.bytes }
          : null
      }
      const size = await skillFileSize(packageDirectory)

      return size == null
        ? null
        : { size, content: await readManifestPrefix(join(packageDirectory, 'SKILL.md')) }
    })
  }

  const manifestIndex = async (location: RoleLocation): Promise<Map<string, string>> => {
    const index = new Map<string, string>()
    let directory

    try {
      directory = await opendir(rootOf(location))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return index
      }
      throw err
    }
    let entries = 0

    for await (const entry of directory) {
      entries++
      if (entries > MAX_LIBRARY_ENTRIES) {
        throw new Error(`role library has too many entries: ${rootOf(location)}`)
      }
      if (!entry.isDirectory() || !isGeneratedNoteId(entry.name)) {
        continue
      }

      try {
        const manifest = await manifestAt(location, entry.name, 'role-index-manifest')

        if (!manifest || manifest.size > MAX_SKILL_FILE_BYTES) {
          continue
        }
        const name = parseSkillFile(Buffer.from(manifest.content).toString('utf8'), entry.name).name
        const current = index.get(name)

        // Invalid duplicate names cannot arise through the product channel, but
        // external files are normal. Pick a stable winner until CRUD can report
        // and repair the collision explicitly.
        if (!current || entry.name.localeCompare(current) < 0) {
          index.set(name, entry.name)
        }
      } catch (err) {
        console.warn(`[roles] ignoring invalid package ${entry.name}:`, (err as Error).message)
      }
    }

    return index
  }

  const skillAt = async (
    location: RoleLocation,
    directoryName: string,
  ): Promise<SkillPackage | null> =>
    withPackageAdmission(location, directoryName, 'shared', 'role-get-skill', async (context) => {
      if (context) {
        const observation = await context.authority.observe(`${context.resourcePath}/SKILL.md`, {
          owner: 'role-get-skill-read',
          packagePath: context.resourcePath,
          maxBytes: MAX_SKILL_FILE_BYTES,
        })

        return observation.kind === 'present'
          ? {
              directoryName,
              files: new Map([['SKILL.md', observation.bytes]]),
            }
          : null
      }
      const path = join(rootOf(location), directoryName, 'SKILL.md')

      try {
        const info = await lstat(path)

        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SKILL_FILE_BYTES) {
          return null
        }

        return {
          directoryName,
          files: new Map([['SKILL.md', await readBoundedFile(path, MAX_SKILL_FILE_BYTES)]]),
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return null
        }
        throw err
      }
    })

  return {
    listManifests: async (location) => {
      const root = rootOf(location)
      let directory

      try {
        directory = await opendir(root)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return { packages: [], truncated: false }
        }
        throw err
      }
      const manifests: SkillPackage[] = []
      let entries = 0
      let bytes = 0
      let truncated = false

      for await (const entry of directory) {
        entries++
        if (entries > MAX_LIBRARY_ENTRIES) {
          truncated = true
          break
        }
        if (!entry.isDirectory() || !isGeneratedNoteId(entry.name)) {
          continue
        }
        try {
          const manifest = await manifestAt(location, entry.name, 'role-list-manifest')

          if (!manifest) {
            continue
          }
          if (manifests.length >= MAX_LIBRARY_PACKAGES) {
            truncated = true
            break
          }
          if (manifest.size > MAX_SKILL_FILE_BYTES || bytes + manifest.size > MAX_LIBRARY_BYTES) {
            console.warn(`[roles] ignoring invalid package ${entry.name}: SKILL.md is too large`)
            continue
          }
          bytes += manifest.size
          manifests.push({
            directoryName: entry.name,
            files: new Map([['SKILL.md', manifest.content]]),
          })
        } catch (err) {
          console.warn(`[roles] ignoring invalid package ${entry.name}:`, (err as Error).message)
        }
      }

      return {
        packages: manifests.sort((left, right) =>
          left.directoryName.localeCompare(right.directoryName),
        ),
        truncated,
      }
    },
    getSkill: async (location, name) => {
      if (!isSkillName(name)) {
        return null
      }

      const directoryName = (await manifestIndex(location)).get(name)

      return directoryName ? skillAt(location, directoryName) : null
    },
    getSkillByDirectory: async (location, directoryName) =>
      isGeneratedNoteId(directoryName) ? skillAt(location, directoryName) : null,
    exists: async (location, name) => {
      if (!isSkillName(name)) {
        return false
      }

      const occupiedDirectly = await withPackageAdmission(
        location,
        name,
        'shared',
        'role-exists',
        async () => {
          try {
            await lstat(join(rootOf(location), name))
            return true
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              return false
            }
            throw err
          }
        },
      )

      return occupiedDirectly || (await manifestIndex(location)).has(name)
    },
    get: async (location, name) => {
      if (!isSkillName(name)) {
        return null
      }

      const directoryName = (await manifestIndex(location)).get(name)

      if (!directoryName) {
        return null
      }

      return withPackageAdmission(
        location,
        directoryName,
        'shared',
        'role-get-package',
        async () => {
          const directory = join(rootOf(location), directoryName)

          try {
            const info = await lstat(directory)

            if (!info.isDirectory() || info.isSymbolicLink()) {
              return null
            }
            const files = await readPackageFiles(directory)
            return files.has('SKILL.md') ? { directoryName, files } : null
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              return null
            }
            throw err
          }
        },
      )
    },
    getByDirectory: async (location, directoryName) => {
      if (!isGeneratedNoteId(directoryName)) {
        return null
      }

      return withPackageAdmission(
        location,
        directoryName,
        'shared',
        'role-get-package-id',
        async () => {
          const directory = join(rootOf(location), directoryName)

          try {
            const info = await lstat(directory)

            if (!info.isDirectory() || info.isSymbolicLink()) {
              return null
            }
            const files = await readPackageFiles(directory)
            return files.has('SKILL.md') ? { directoryName, files } : null
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              return null
            }
            throw err
          }
        },
      )
    },
    putIfAbsent: async (location, pkg) => {
      validateSkillPackage(pkg)
      if (!isGeneratedNoteId(pkg.directoryName)) {
        throw new InvalidSkillPackageError(
          `invalid owned Agent Skill package address: ${pkg.directoryName}`,
        )
      }
      const { mount, root } = rootsOf(location)
      const manifestName = parseSkillFile(
        Buffer.from(pkg.files.get('SKILL.md')!).toString('utf8'),
        pkg.directoryName,
      ).name

      // After the two pure refusals and before the first byte touches disk. A
      // deployment that cannot publish atomically must leave no library root, no
      // stale sweep and no staging tree behind to be found later.
      if (!publishDirectoryIfAbsent) {
        throw Object.assign(new Error('atomic role package publication is unavailable'), {
          code: 'ENOTSUP',
        })
      }
      await prepareRoot(location, mount, root)
      await sweepStaleStaging(mount, root)
      const context = await authorityContext(location, pkg.directoryName)

      if (context) {
        const lease = await context.authority.admitSkillPlacement(
          `${context.resourcePath}/SKILL.md`,
          'exclusive',
          'role-put-placement',
        )

        try {
          const observed = await context.authority.observeStrictAdmitted(context.resourcePath)

          if (observed.kind !== 'absent') {
            return false
          }
          await context.authority.assertSkillManifestNameAvailableAdmitted(
            `${context.resourcePath}/SKILL.md`,
            pkg.files.get('SKILL.md')!,
          )
          const published = await context.authority.publishPackageIfAbsentAdmitted({
            rootPath: context.resourcePath,
            files: [...pkg.files].map(([path, content]) => ({ path, content })),
            expectedRoot: observed.claim,
          })

          return published.status === 'published'
        } finally {
          lease.settle()
        }
      }
      const release = await acquirePlacementFence(root)

      try {
        if (
          (await manifestIndex(location)).has(manifestName) ||
          (await pathOccupied(join(root, manifestName)))
        ) {
          return false
        }

        return await withPackageAdmission(
          location,
          pkg.directoryName,
          'exclusive',
          'role-put-package',
          async () => {
            const target = join(root, pkg.directoryName)
            const temp = join(root, `.${pkg.directoryName}.install-${randomUUID()}`)
            await mkdir(temp, { recursive: false })

            try {
              for (const [file, content] of pkg.files) {
                const path = join(temp, ...file.split('/'))
                await mkdir(dirname(path), { recursive: true })
                await writeFile(path, content, { flag: 'wx' })
              }

              // One atomic pathname publication: any occupied target is a
              // conflict, and an unsupported medium fails without a raceable
              // fallback.
              return await publishDirectoryIfAbsent(temp, target)
            } finally {
              await rm(temp, { recursive: true, force: true }).catch((err: Error) => {
                // This process created a possible orphan after the last sweep.
                // Make the next install keep checking until it can reclaim it.
                sweeps.delete(root)
                console.warn(`[roles] failed to remove install staging ${temp}:`, err.message)
              })
            }
          },
        )
      } finally {
        release()
      }
    },
    movePackage: async (from, to, directoryName) => {
      if (!isGeneratedNoteId(directoryName)) {
        throw new InvalidSkillPackageError(
          `invalid owned Agent Skill package address: ${directoryName}`,
        )
      }
      if (from.space !== to.space) {
        throw new Error('a package move cannot cross spaces')
      }
      const source = join(rootOf(from), directoryName)
      const { mount, root } = rootsOf(to)
      const target = join(root, directoryName)

      if (source === target) {
        throw new Error('a package move needs two different placements')
      }
      // Same refusal as `putIfAbsent`, and for the same reason: a deployment that
      // cannot move a pathname atomically must say so before it touches anything.
      if (!publishDirectoryIfAbsent) {
        throw Object.assign(new Error('atomic role package publication is unavailable'), {
          code: 'ENOTSUP',
        })
      }
      const manifest = await skillAt(from, directoryName)

      if (!manifest) {
        return false
      }
      const manifestName = parseSkillFile(
        Buffer.from(manifest.files.get('SKILL.md')!).toString('utf8'),
        directoryName,
      ).name

      await prepareRoot(to, mount, root)

      // The destination's placement lease wraps the whole critical section, exactly as
      // publication's does: the name check and the publication that acts on it are one
      // decision, and the packages that could take that name have other ids.
      return await withPlacementAdmission(to, directoryName, 'role-move-placement', async () => {
        const release = await acquirePlacementFence(root)

        try {
          if (
            (await manifestIndex(to)).has(manifestName) ||
            (await pathOccupied(join(root, manifestName)))
          ) {
            return false
          }

          // Both sides admitted, destination first. The order is fixed so two moves can
          // never hold each other's half.
          return await withPackageAdmission(
            to,
            directoryName,
            'exclusive',
            'role-move-target',
            () =>
              withPackageAdmission(from, directoryName, 'exclusive', 'role-move-source', () =>
                publishDirectoryIfAbsent(source, target),
              ),
          )
        } finally {
          release()
        }
      })
    },
    awaitReadableNoteIds: (location, directoryNames) =>
      projectNoteIds(location, directoryNames, true),
    readableNoteIds: (location, directoryNames) => projectNoteIds(location, directoryNames, false),
  }
}

export const createInMemoryRoleLibrary = ({
  onBarrier,
}: {
  /** Every crossing of the read-model publication barrier, as it happens. The twin
   *  holds no file truth to reconcile, so the barrier costs it nothing and both port
   *  methods would otherwise be ONE function — and a double that cannot express the
   *  difference cannot fail when a caller takes the wrong one. The difference is not
   *  cosmetic: the barrier blocks mutations across the whole space while it runs, so
   *  a READ that crosses it serialises every write in the space behind an inventory
   *  listing. Recorded rather than simulated, because the twin has no honest way to
   *  lag: its packages ARE its projection. */
  onBarrier?: (location: RoleLocation, directoryNames: readonly string[]) => void
} = {}): InMemoryRoleLibrary => {
  const nameableManifest = (name: string): boolean => isSkillName(name)
  const packages = new Map<string, SkillPackage>()
  const prefixOf = (location: RoleLocation): string =>
    `${location.space}\0${location.scope === 'project' ? location.projectId : ''}\0`
  const keyOf = (location: RoleLocation, directoryName: string): string =>
    `${prefixOf(location)}${directoryName}`
  const noteIdsAt = (
    location: RoleLocation,
    directoryNames: readonly string[],
  ): ReadonlyMap<string, string> =>
    new Map(
      [...new Set(directoryNames)]
        .filter((directoryName) => packages.has(keyOf(location, directoryName)))
        // An Owned package is ID-backed: its directory name IS its note id.
        .map((directoryName) => [directoryName, directoryName]),
    )
  const clone = (pkg: SkillPackage): SkillPackage => ({
    directoryName: pkg.directoryName,
    files: new Map([...pkg.files].map(([name, bytes]) => [name, Uint8Array.from(bytes)])),
  })

  const manifestNameOf = (pkg: SkillPackage): string | null => {
    const manifest = pkg.files.get('SKILL.md')

    if (!manifest) {
      return null
    }
    try {
      return parseSkillFile(Buffer.from(manifest).toString('utf8'), pkg.directoryName).name
    } catch {
      return null
    }
  }

  const packageByName = (location: RoleLocation, name: string): SkillPackage | null => {
    const matches = [...packages]
      .filter(([key, pkg]) => key.startsWith(prefixOf(location)) && manifestNameOf(pkg) === name)
      .sort(([, left], [, right]) => left.directoryName.localeCompare(right.directoryName))

    return matches[0]?.[1] ?? null
  }

  return {
    listManifests: async (location) => ({
      packages: [...packages]
        .filter(([key]) => key.startsWith(prefixOf(location)))
        .map(([, pkg]) => ({
          directoryName: pkg.directoryName,
          files: new Map([['SKILL.md', Uint8Array.from(pkg.files.get('SKILL.md')!)]]),
        })),
      truncated: false,
    }),
    getSkill: async (location, name) => {
      const pkg = packageByName(location, name)

      if (!pkg) {
        return null
      }
      const skill = pkg.files.get('SKILL.md')

      return skill
        ? {
            directoryName: pkg.directoryName,
            files: new Map([['SKILL.md', Uint8Array.from(skill)]]),
          }
        : null
    },
    getSkillByDirectory: async (location, directoryName) => {
      const pkg = packages.get(keyOf(location, directoryName))
      const skill = pkg?.files.get('SKILL.md')

      return pkg && skill
        ? {
            directoryName: pkg.directoryName,
            files: new Map([['SKILL.md', Uint8Array.from(skill)]]),
          }
        : null
    },
    // `exists` answers about a manifest NAME, and asks the grammar first exactly
    // where the shipped library asks it. Without that question an owned package
    // ADDRESS reads as an occupied name here and as a free one on disk — and the two
    // callers of this method (Add, promotion) refuse on nothing else.
    exists: async (location, name) =>
      nameableManifest(name) &&
      (packages.has(keyOf(location, name)) || packageByName(location, name) != null),
    get: async (location, name) => {
      const pkg = packageByName(location, name)
      return pkg ? clone(pkg) : null
    },
    getByDirectory: async (location, directoryName) => {
      const pkg = packages.get(keyOf(location, directoryName))
      return pkg ? clone(pkg) : null
    },
    putIfAbsent: async (location, pkg) => {
      validateSkillPackage(pkg)
      if (!isGeneratedNoteId(pkg.directoryName)) {
        throw new InvalidSkillPackageError(
          `invalid owned Agent Skill package address: ${pkg.directoryName}`,
        )
      }
      const key = keyOf(location, pkg.directoryName)
      const name = manifestNameOf(pkg)

      if (packages.has(key) || (name != null && packageByName(location, name) != null)) {
        return false
      }
      packages.set(key, clone(pkg))
      return true
    },
    movePackage: async (from, to, directoryName) => {
      if (from.space !== to.space) {
        throw new Error('a package move cannot cross spaces')
      }
      const pkg = packages.get(keyOf(from, directoryName))

      if (!pkg) {
        return false
      }
      const name = manifestNameOf(pkg)

      if (packages.has(keyOf(to, directoryName)) || (name != null && packageByName(to, name))) {
        return false
      }
      packages.delete(keyOf(from, directoryName))
      packages.set(keyOf(to, directoryName), pkg)
      return true
    },
    // Identity is projected from a PATH, so it exists only where the package does.
    // A twin that answered for every location would let a caller read the identity
    // of a package it had already moved away, and say nothing about it.
    readableNoteIds: async (location, directoryNames) => noteIdsAt(location, directoryNames),
    awaitReadableNoteIds: async (location, directoryNames) => {
      // The one thing this method does that the other does not. Written as a separate
      // body on purpose: sharing `noteIdsAt` between the two is exactly how the port's
      // deliberate distinction became invisible to every test that uses this twin.
      onBarrier?.(location, directoryNames)
      return noteIdsAt(location, directoryNames)
    },
    clear: () => packages.clear(),
  }
}
