import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, opendir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative as relativePath } from 'node:path'

import { renameNoReplace } from '@notarium/engine'
import { isReclaimableInstallStaging } from './installStaging'
import { MAX_SKILL_FILE_BYTES, MAX_SKILL_MANIFEST_BYTES } from './skillFile'
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
const PACKAGE_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

export type SkillPackage = {
  name: string
  files: Map<string, Uint8Array>
}

/** The target exists, but its package shape exceeds the supported Agent Skills envelope. */
export class InvalidSkillPackageError extends Error {}

export type RoleLibraryListing = { packages: SkillPackage[]; truncated: boolean }

export type RoleLibrary = {
  /** Discovery projection: direct SKILL.md frontmatter only, never package resources
   *  or instruction bodies. Invalid manifests are isolated by the parser; oversized
   *  manifests are skipped without reading their bodies. */
  listManifests(location: RoleLocation): Promise<RoleLibraryListing>
  /** One complete SKILL.md, without resources — activation's progressive load. */
  getSkill(location: RoleLocation, name: string): Promise<SkillPackage | null>
  /** Whether the package target is occupied, including an invalid package. */
  exists(location: RoleLocation, name: string): Promise<boolean>
  /** Complete package bytes — Add/conflict verification only. */
  get(location: RoleLocation, name: string): Promise<SkillPackage | null>
  putIfAbsent(location: RoleLocation, pkg: SkillPackage): Promise<boolean>
}

export type InMemoryRoleLibrary = RoleLibrary & { clear(): void }

export const validateSkillPackage = (pkg: SkillPackage): void => {
  if (
    !PACKAGE_NAME.test(pkg.name) ||
    pkg.name.includes('--') ||
    !pkg.files.has('SKILL.md') ||
    pkg.files.get('SKILL.md')!.byteLength > MAX_SKILL_FILE_BYTES ||
    pkg.files.size > MAX_PACKAGE_FILES
  ) {
    throw new InvalidSkillPackageError(`invalid Agent Skill package: ${pkg.name}`)
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
      throw new InvalidSkillPackageError(`Agent Skill package has too many entries: ${pkg.name}`)
    }
    packageBytes += content.byteLength
    if (packageBytes > MAX_PACKAGE_BYTES) {
      throw new InvalidSkillPackageError(`Agent Skill package is too large: ${pkg.name}`)
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
    if (!entry.isDirectory() || !PACKAGE_NAME.test(entry.name) || entry.name.includes('--')) {
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
    packages.push({ name: entry.name, files })
  }

  return packages.sort((left, right) => left.name.localeCompare(right.name))
}

export const createFsRoleLibrary = ({
  rootForSpace,
}: {
  rootForSpace(space: string): string | null
}): RoleLibrary => {
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
        if (!entry.isDirectory() || !PACKAGE_NAME.test(entry.name) || entry.name.includes('--')) {
          continue
        }
        const packageDirectory = join(root, entry.name)

        try {
          const size = await skillFileSize(packageDirectory)

          if (size === null) {
            continue
          }
          if (manifests.length >= MAX_LIBRARY_PACKAGES) {
            truncated = true
            break
          }
          if (size > MAX_SKILL_FILE_BYTES || bytes + size > MAX_LIBRARY_BYTES) {
            console.warn(`[roles] ignoring invalid package ${entry.name}: SKILL.md is too large`)
            continue
          }
          bytes += size
          manifests.push({
            name: entry.name,
            files: new Map([
              ['SKILL.md', await readManifestPrefix(join(packageDirectory, 'SKILL.md'))],
            ]),
          })
        } catch (err) {
          console.warn(`[roles] ignoring invalid package ${entry.name}:`, (err as Error).message)
        }
      }

      return {
        packages: manifests.sort((left, right) => left.name.localeCompare(right.name)),
        truncated,
      }
    },
    getSkill: async (location, name) => {
      if (!PACKAGE_NAME.test(name) || name.includes('--')) {
        return null
      }
      const path = join(rootOf(location), name, 'SKILL.md')

      try {
        const info = await lstat(path)

        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SKILL_FILE_BYTES) {
          return null
        }

        return {
          name,
          files: new Map([['SKILL.md', await readBoundedFile(path, MAX_SKILL_FILE_BYTES)]]),
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return null
        }
        throw err
      }
    },
    exists: async (location, name) => {
      if (!PACKAGE_NAME.test(name) || name.includes('--')) {
        return false
      }

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
    get: async (location, name) => {
      if (!PACKAGE_NAME.test(name) || name.includes('--')) {
        return null
      }

      const directory = join(rootOf(location), name)

      try {
        const info = await lstat(directory)

        if (!info.isDirectory() || info.isSymbolicLink()) {
          return null
        }
        const files = await readPackageFiles(directory)
        return files.has('SKILL.md') ? { name, files } : null
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return null
        }
        throw err
      }
    },
    putIfAbsent: async (location, pkg) => {
      validateSkillPackage(pkg)
      const { mount, root } = rootsOf(location)
      await prepareRoot(location, mount, root)
      await sweepStaleStaging(mount, root)
      const target = join(root, pkg.name)
      const temp = join(root, `.${pkg.name}.install-${randomUUID()}`)
      await mkdir(temp, { recursive: false })

      try {
        for (const [file, content] of pkg.files) {
          const path = join(temp, ...file.split('/'))
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, content, { flag: 'wx' })
        }

        // The arbiter is the primitive, in one atomic filesystem operation: an
        // occupied pathname of ANY shape is a conflict, never a replacement.
        // Its errors — an unavailable capability included — travel out as they
        // are; there is no fallback to a raceable rename on any branch.
        return await renameNoReplace(temp, target)
      } finally {
        // On the conflict branch the staging really is still there, so this rm
        // does work — and a read-only volume or an EACCES must not turn a
        // defined `false` into a 500.
        await rm(temp, { recursive: true, force: true }).catch((err: Error) => {
          // This process just created a possible orphan after the last sweep.
          // Drop the clean cache so a later install keeps checking it until it
          // ages into the reclaimable window.
          sweeps.delete(root)
          console.warn(`[roles] failed to remove install staging ${temp}:`, err.message)
        })
      }
    },
  }
}

export const createInMemoryRoleLibrary = (): InMemoryRoleLibrary => {
  const packages = new Map<string, SkillPackage>()
  const keyOf = (location: RoleLocation, name: string): string =>
    `${location.space}\0${location.scope === 'project' ? location.projectId : ''}\0${name}`
  const clone = (pkg: SkillPackage): SkillPackage => ({
    name: pkg.name,
    files: new Map([...pkg.files].map(([name, bytes]) => [name, Uint8Array.from(bytes)])),
  })

  return {
    listManifests: async (location) => ({
      packages: [...packages]
        .filter(([key]) =>
          key.startsWith(
            `${location.space}\0${location.scope === 'project' ? location.projectId : ''}\0`,
          ),
        )
        .map(([, pkg]) => ({
          name: pkg.name,
          files: new Map([['SKILL.md', Uint8Array.from(pkg.files.get('SKILL.md')!)]]),
        })),
      truncated: false,
    }),
    getSkill: async (location, name) => {
      const pkg = packages.get(keyOf(location, name))
      const skill = pkg?.files.get('SKILL.md')
      return skill ? { name, files: new Map([['SKILL.md', Uint8Array.from(skill)]]) } : null
    },
    exists: async (location, name) => packages.has(keyOf(location, name)),
    get: async (location, name) => {
      const pkg = packages.get(keyOf(location, name))
      return pkg ? clone(pkg) : null
    },
    putIfAbsent: async (location, pkg) => {
      validateSkillPackage(pkg)
      const key = keyOf(location, pkg.name)

      if (packages.has(key)) {
        return false
      }
      packages.set(key, clone(pkg))
      return true
    },
    clear: () => packages.clear(),
  }
}
