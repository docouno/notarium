import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, opendir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { MAX_SKILL_FILE_BYTES, MAX_SKILL_MANIFEST_BYTES } from './skillFile'
import type { RoleLocation } from './types'

const MAX_PACKAGE_FILES = 256
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024
const MAX_PACKAGE_ENTRIES = 512
const MAX_PACKAGE_DEPTH = 16
const MAX_LIBRARY_ENTRIES = 1_024
const MAX_LIBRARY_PACKAGES = 256
const MAX_LIBRARY_BYTES = 64 * 1024 * 1024
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
  const rootOf = (location: RoleLocation): string => {
    const root = rootForSpace(location.space)

    if (!root) {
      throw new Error('role library is unavailable for this space')
    }
    if (location.scope === 'project' && !location.projectId) {
      throw new Error('project role location requires projectId')
    }

    return packageRoot(root, location)
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
      const root = rootOf(location)
      await mkdir(root, { recursive: true })
      const target = join(root, pkg.name)
      const temp = join(root, `.${pkg.name}.install-${randomUUID()}`)
      await mkdir(temp, { recursive: false })

      try {
        for (const [relative, content] of pkg.files) {
          const parts = relative.split('/')
          const file = join(temp, ...parts)
          await mkdir(dirname(file), { recursive: true })
          await writeFile(file, content, { flag: 'wx' })
        }
        try {
          await rename(temp, target)
          return true
        } catch (err) {
          if (['EEXIST', 'ENOTEMPTY'].includes((err as NodeJS.ErrnoException).code ?? '')) {
            return false
          }
          throw err
        }
      } finally {
        await rm(temp, { recursive: true, force: true })
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
