import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, opendir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative as relativePath } from 'node:path'

import { ABILITY_KIND, type AbilityKind } from '@notarium/contract'
import { exactOwnerObservation, isGeneratedNoteId, isSkillName } from '@notarium/core'
import {
  type AdmissionMode,
  type FileClaim,
  FilePackagePublicationUnavailableError,
  type PackagePublicationView,
  type SpaceResourceAuthority,
} from '@notarium/engine'
import { AbilityUnavailableError, RoleInstallUnavailableError } from './errors'
import { isReclaimableInstallStaging } from './installStaging'
import {
  isResolvableAbilityManifest,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_MANIFEST_BYTES,
  packageRevision,
  parseSkillFile,
} from './skillFile'
import type { RoleLocation, RolePublicationTarget } from './types'

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

export type NamedAbilityPackages = ReadonlyMap<AbilityKind, SkillPackage>
export type ProjectedRolePackage = {
  registryNoteId: string
  filePath: string
  versionToken: string
}

export type RolePackageSnapshot = ProjectedRolePackage & {
  kind: AbilityKind
  manifestNoteId: string
  pkg: SkillPackage
}

/** The identity a strict caller captured earlier. `registryNoteId` is the SELECTOR the
 *  exact-note scope is entered by, not a member to compare; `kind` and `manifestNoteId`
 *  are read from the manifest itself, which is where a captured package comes apart. */
export type RolePackageTarget = Pick<
  RolePackageSnapshot,
  'kind' | 'registryNoteId' | 'manifestNoteId'
>

export type RolePackageMoveResult =
  | { status: 'moved'; snapshot: RolePackageSnapshot }
  | { status: 'occupied'; snapshot: RolePackageSnapshot }
  | { status: 'missing' }

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

export type WithProjectedRolePackage = <T>(
  space: string,
  pkg: PublishedRolePackage,
  expectedRegistryNoteId: string | undefined,
  task: (projection: ProjectedRolePackage) => Promise<T>,
) => Promise<T | null>

export type RoleLibrary = {
  /** Discovery projection: direct SKILL.md frontmatter only, never package resources
   *  or instruction bodies. Invalid manifests are isolated by the parser; oversized
   *  manifests are skipped without reading their bodies. */
  listManifests(location: RoleLocation): Promise<RoleLibraryListing>
  /** One stable same-name candidate per ability kind, without resources. External
   *  packages may collide on a manifest name even though product writes cannot. */
  getAbilitiesNamed(location: RoleLocation, name: string): Promise<NamedAbilityPackages>
  /** One exact SKILL.md by its immutable owned package address. */
  getSkillByDirectory(location: RoleLocation, directoryName: string): Promise<SkillPackage | null>
  /** Capture one exact registry/package snapshot under Core exact-note then shared
   * package admission. Both leases are released before the snapshot is returned. */
  captureExactPackage(
    location: RoleLocation,
    directoryName: string,
    expectedRegistryNoteId?: string,
  ): Promise<RolePackageSnapshot | null>
  /** Revalidate a captured dual identity under Core exact-note, exclusive placement
   * and exclusive package admission, then retain all three through the task. */
  withExactPackageMutation<T>(
    location: RoleLocation,
    directoryName: string,
    expected: RolePackageTarget,
    task: (snapshot: RolePackageSnapshot) => Promise<T>,
  ): Promise<T | null>
  /** Whether the package target is occupied, including an invalid package. */
  exists(
    location: RoleLocation,
    name: string,
    options?: { allowDuringClosure?: boolean },
  ): Promise<boolean>
  /** Complete package bytes — Add/conflict verification only. */
  get(location: RoleLocation, name: string): Promise<SkillPackage | null>
  /** Complete package bytes by immutable owned package address. */
  getByDirectory(location: RoleLocation, directoryName: string): Promise<SkillPackage | null>
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
  inspectAndRemove(
    location: RoleLocation,
    directoryName: string,
    options: {
      expected?: {
        kind: AbilityKind
        registryNoteId: string
        manifestNoteId: string
      }
      assertSafe(pkg: SkillPackage, members?: readonly string[]): void | Promise<void>
      remove(beforeDetach: (victimNoteIds?: readonly string[]) => Promise<void>): Promise<void>
    },
  ): Promise<boolean>
  /** Canonical space-relative root manifest path for a package at this placement. */
  manifestPath(location: RoleLocation, directoryName: string): string | null
  withCreateAdmission<T>(
    location: RoleLocation,
    directoryName: string,
    task: () => Promise<T>,
    options?: { allowDuringClosure?: boolean },
  ): Promise<T>
}

/** One placement's writer, already bound to its target. The location is not a
 *  parameter: it was settled during preflight, and a handle that still accepted
 *  one could be handed the wrong placement halfway through a multi-package Add. */
export type RolePackagePublication = {
  putIfAbsent(pkg: SkillPackage): Promise<boolean>
  /** Move one package into THIS placement from another placement of the SAME
   *  space, keeping its address. `false` — the destination pathname or manifest
   *  name was taken and nothing moved. This is an external move as far as the
   *  note read-model is concerned: the id lives in the file's frontmatter, so it
   *  survives the path change ([P7](docs/architecture.md#p7)) — which is the whole
   *  reason a promotion moves the directory instead of republishing its bytes. */
  moveFrom(
    source: RoleLocation,
    directoryName: string,
    expected: RolePackageTarget,
    lifecycle: {
      beforeMove(snapshot: RolePackageSnapshot): Promise<void>
      finalize(snapshot: RolePackageSnapshot): Promise<void>
      rollback(): Promise<void>
    },
  ): Promise<RolePackageMoveResult>
}

/** A finalize failure was followed by a failed physical rollback, so the package is
 * still at the target. The caller must preserve target-owned state such as reach. */
export const rolePackageMoveRollbackError = (cause: unknown): Error =>
  Object.assign(new Error('ability placement finalize and physical rollback both failed'), {
    cause,
    physicalMoveCommitted: true as const,
  })

export const isRolePackageMoveRollbackError = (
  error: unknown,
): error is Error & { cause: unknown; physicalMoveCommitted: true } =>
  (error as { physicalMoveCommitted?: unknown } | null)?.physicalMoveCommitted === true

export type RolePackagePublicationPolicy = {
  /** Pure composition answer: can this deployment publish a package at this
   *  target at all? No space is minted, no authority or store is built, no path
   *  is probed — so a read model may ask it for every target it lists. */
  availableFor(target: RolePublicationTarget): boolean
  /** The writer for one settled placement, or `null` when the prerequisites are
   *  incomplete. Resolving one prepares nothing: no root, no sweep, no staging. */
  publicationFor(location: RoleLocation): Promise<RolePackagePublication | null>
}

/** What a composition root gets: the read side and the write side, separately.
 *  Everything that reads works on a deployment that cannot publish at all. */
export type RoleLibraryComposition = {
  library: RoleLibrary
  publication: RolePackagePublicationPolicy
}

/** Seed-only package augmentation used to materialize recovery edge cases. It is
 * deliberately absent from RolesService and every REST/MCP surface. */
export type SeedableRoleLibraryComposition = RoleLibraryComposition & {
  seedPackageFile(
    location: RoleLocation,
    directoryName: string,
    relativePath: string,
    content: Uint8Array,
  ): Promise<void>
}

/** The same PAIR a filesystem composition returns, plus a reset. Test paths get
 *  no shortcut around the write boundary: a package reaches storage through a
 *  target-bound handle here too, or the tests would prove a seam production does
 *  not have. */
export type InMemoryRoleLibraryComposition = RoleLibraryComposition & {
  library: RoleLibrary & { clear(): void }
}

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

const readPackageFiles = async (
  root: string,
  options: { recordSpecialEntries?: boolean; members?: Set<string> } = {},
): Promise<Map<string, Uint8Array>> => {
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
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = join(directory, entry.name)

      options.members?.add(relative)

      if (entry.isSymbolicLink()) {
        if (options.recordSpecialEntries) {
          files.set(`${relative} (symbolic link)`, new Uint8Array())
        }
        continue
      }

      if (entry.isDirectory()) {
        await walk(absolute, relative, depth + 1)
      } else if (entry.isFile()) {
        if (files.size >= MAX_PACKAGE_FILES) {
          throw new InvalidSkillPackageError(`Agent Skill package has too many files: ${root}`)
        }
        const content = await readBoundedFile(absolute, MAX_PACKAGE_BYTES - bytes)
        bytes += content.byteLength
        files.set(relative, content)
      } else if (options.recordSpecialEntries) {
        files.set(`${relative} (non-regular entry)`, new Uint8Array())
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
  prospectivePersonalRoot = () => false,
  publishDirectoryIfAbsent,
  authorityForSpace,
  resourcePrefixForSpace,
  projectPublishedPackages,
  withProjectedRolePackage,
}: {
  rootForSpace(space: string): string | null
  /** Whether a Personal placement this host has not created yet will have a
   *  library root. Declared by the composition root from the SAME mount policy a
   *  minted space is built with — never by probing a filesystem or by inventing a
   *  root path for a space that does not exist. Absent ⇒ a Personal Add on a
   *  host that has not minted yet is refused rather than guessed at. */
  prospectivePersonalRoot?(): boolean
  /** REQUIRED to pass, allowed to be `undefined`: every composition root has to
   *  state what the runtime it built on can do, and a library that inherited an
   *  absent capability must be indistinguishable — in tests too — from one built
   *  on a host that genuinely lacks it. */
  publishDirectoryIfAbsent: PublishDirectoryIfAbsent | undefined
  authorityForSpace?(space: string): Promise<SpaceResourceAuthority | null>
  resourcePrefixForSpace?(space: string): string | null
  projectPublishedPackages?: ProjectPublishedRolePackages
  /** Production composition seam: the host owns the NoteStore exact-note scope;
   * RoleLibrary receives only bounded projection facts and owns its RA admissions. */
  withProjectedRolePackage?: WithProjectedRolePackage
}): SeedableRoleLibraryComposition => {
  // The two projections answer the SAME question — which note id is readable at a
  // package address — and they are one decision, not two options. With neither, both
  // answer `directoryName` and the library is id-backed end to end. With both, both
  // answer the host's store ids. With exactly one, the bulk listing and every strict
  // path hand out different identities for one package and nothing says so: a listing
  // would show a package under an id no capture can address, or a capture would return
  // a registry id the listing never publishes.
  if (Boolean(projectPublishedPackages) !== Boolean(withProjectedRolePackage)) {
    throw new Error(
      'role library identity is one decision: configure the bulk projection and the exact package composition scope together, or neither',
    )
  }

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

  const projectedPackage = async <T>(
    location: RoleLocation,
    directoryName: string,
    expectedRegistryNoteId: string | undefined,
    task: (projection: ProjectedRolePackage) => Promise<T>,
  ): Promise<T | null> => {
    const packagePath = resourcePackagePath(location, directoryName)

    if (packagePath == null && withProjectedRolePackage) {
      throw new Error('role library has no projected resource path')
    }
    const pkg = {
      directoryName,
      filePath: `${packagePath ?? directoryName}/SKILL.md`,
    }

    if (withProjectedRolePackage) {
      return withProjectedRolePackage(location.space, pkg, expectedRegistryNoteId, task)
    }

    const physical = await skillAtPhysical(location, directoryName)
    const manifest = physical?.files.get('SKILL.md')

    if (!physical || !manifest) {
      return null
    }
    const registryNoteId = expectedRegistryNoteId ?? directoryName

    return task({
      registryNoteId,
      filePath: pkg.filePath,
      versionToken: packageRevision(new Map([['SKILL.md', manifest]])),
    })
  }
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

  const resourcePlacementPath = (location: RoleLocation): string | null => {
    const prefix = resourcePrefixForSpace?.(location.space)

    if (prefix == null) {
      return null
    }
    if (location.scope === 'project' && !location.projectId) {
      throw new Error('project role location requires projectId')
    }
    if (location.scope !== 'project') {
      return prefix
    }
    const relative = `_projects/${projectDirectory(location.projectId!)}`

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
    options?: { allowDuringClosure?: boolean },
  ): Promise<T> => {
    const context = await authorityContext(location, name)

    if (!context) {
      return task(null)
    }
    const lease = await context.authority.admitSkillPlacement(
      `${context.resourcePath}/SKILL.md`,
      'exclusive',
      owner,
      options,
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
    options?: { allowDuringClosure?: boolean },
  ): Promise<T> => {
    const context = await authorityContext(location, name)

    if (!context) {
      return task(null)
    }
    const lease = await context.authority.admitPackage(context.resourcePath, mode, owner, options)

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
    options?: { allowDuringClosure?: boolean },
  ): Promise<{ size: number; content: Uint8Array } | null> => {
    const packageDirectory = join(rootOf(location), directoryName)

    return withPackageAdmission(
      location,
      directoryName,
      'shared',
      owner,
      async (context) => {
        if (context) {
          const observation = await context.authority.observe(`${context.resourcePath}/SKILL.md`, {
            owner: `${owner}-read`,
            packagePath: context.resourcePath,
            maxBytes: MAX_SKILL_FILE_BYTES,
            ...options,
          })

          return observation.kind === 'present'
            ? { size: observation.bytes.byteLength, content: observation.bytes }
            : null
        }
        const size = await skillFileSize(packageDirectory)

        return size == null
          ? null
          : { size, content: await readManifestPrefix(join(packageDirectory, 'SKILL.md')) }
      },
      options,
    )
  }

  type ManifestIndexEntry = {
    /** Legacy name-global winner used by full-package authoring reads. */
    first: string
    /** Runtime identity is (kind, name), so exact activation needs both winners. */
    byKind: Partial<Record<AbilityKind, string>>
  }

  const manifestIndex = async (
    location: RoleLocation,
    options?: { allowDuringClosure?: boolean },
  ): Promise<Map<string, ManifestIndexEntry>> => {
    const index = new Map<string, ManifestIndexEntry>()
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
        const manifest = await manifestAt(location, entry.name, 'role-index-manifest', options)

        if (!manifest || manifest.size > MAX_SKILL_FILE_BYTES) {
          continue
        }
        const parsed = parseSkillFile(Buffer.from(manifest.content).toString('utf8'), entry.name)

        if (!isResolvableAbilityManifest(parsed)) {
          throw new InvalidSkillPackageError(
            `Agent Skill package cannot attach skills: ${entry.name}`,
          )
        }
        const kind = parsed.role ? ABILITY_KIND.role : ABILITY_KIND.skill
        const indexed = index.get(parsed.name)
        const byKind = indexed?.byKind ?? {}
        const current = byKind[kind]

        // Product writes reject duplicate names, but external files can still create
        // them. Identity is (kind, name), so keep one stable package per kind rather
        // than letting the smaller package of the other kind hide it.
        if (!current || entry.name.localeCompare(current) < 0) {
          byKind[kind] = entry.name
        }
        index.set(parsed.name, {
          first:
            !indexed || entry.name.localeCompare(indexed.first) < 0 ? entry.name : indexed.first,
          byKind,
        })
      } catch (err) {
        console.warn(`[roles] ignoring invalid package ${entry.name}:`, (err as Error).message)
      }
    }

    return index
  }

  /** Whether a physically present sibling already claims this manifest NAME — the one
   *  bit the caller needs. A predicate, not a second index: which duplicate would win
   *  a contested name is a resolution rule, and it belongs to `manifestIndex` alone.
   *  Reads siblings without their package leases; the call site owns that decision. */
  const manifestNameOccupiedPhysically = async (
    location: RoleLocation,
    name: string,
  ): Promise<boolean> => {
    let directory

    try {
      directory = await opendir(rootOf(location))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false
      }
      throw error
    }
    let entries = 0
    let occupied = false

    for await (const entry of directory) {
      if (++entries > MAX_LIBRARY_ENTRIES) {
        throw new Error(`role library has too many entries: ${rootOf(location)}`)
      }
      if (!entry.isDirectory() || !isGeneratedNoteId(entry.name)) {
        continue
      }
      const manifest = (await skillAtPhysical(location, entry.name))?.files.get('SKILL.md')

      if (!manifest) {
        continue
      }
      try {
        const parsed = parseSkillFile(Buffer.from(manifest).toString('utf8'), entry.name)

        if (isResolvableAbilityManifest(parsed) && parsed.name === name) {
          occupied = true
          break
        }
      } catch {
        continue
      }
    }

    return occupied
  }

  const skillAtPhysical = async (
    location: RoleLocation,
    directoryName: string,
  ): Promise<SkillPackage | null> => {
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
  }

  type AdmittedSkillPackage = {
    pkg: SkillPackage
    manifestClaim: { adapterId: string; claim: FileClaim & { kind: 'present' } } | null
  }

  const skillAtAdmitted = async (
    location: RoleLocation,
    directoryName: string,
    context: { authority: SpaceResourceAuthority; resourcePath: string } | null,
  ): Promise<AdmittedSkillPackage | null> => {
    if (context) {
      // Directory-bound, not merely strict: a package move carries a whole directory,
      // and a manifest hardlinked into a stranger's directory answers a plain file
      // claim just as truthfully from either side of the swap.
      const observation = await context.authority.observeDirectoryBoundAdmitted(
        `${context.resourcePath}/SKILL.md`,
        MAX_SKILL_FILE_BYTES,
      )

      return observation.kind === 'present'
        ? {
            pkg: {
              directoryName,
              files: new Map([['SKILL.md', observation.bytes]]),
            },
            manifestClaim: { adapterId: observation.adapterId, claim: observation.claim },
          }
        : null
    }

    const pkg = await skillAtPhysical(location, directoryName)

    return pkg ? { pkg, manifestClaim: null } : null
  }

  const snapshotAtAdmitted = async (
    location: RoleLocation,
    directoryName: string,
    projection: ProjectedRolePackage,
    context: { authority: SpaceResourceAuthority; resourcePath: string } | null,
  ): Promise<{
    snapshot: RolePackageSnapshot
    manifestClaim: AdmittedSkillPackage['manifestClaim']
  } | null> => {
    const admitted = await skillAtAdmitted(location, directoryName, context)
    const pkg = admitted?.pkg
    const manifest = pkg?.files.get('SKILL.md')

    if (!admitted || !pkg || !manifest) {
      return null
    }
    let parsed

    try {
      parsed = parseSkillFile(Buffer.from(manifest).toString('utf8'), directoryName)
    } catch {
      return null
    }
    const owner = exactOwnerObservation(manifest)

    return owner.kind === 'claimed'
      ? {
          snapshot: {
            ...projection,
            kind: parsed.role ? ABILITY_KIND.role : ABILITY_KIND.skill,
            manifestNoteId: owner.id,
            pkg,
          },
          manifestClaim: admitted.manifestClaim,
        }
      : null
  }

  const skillAt = async (
    location: RoleLocation,
    directoryName: string,
  ): Promise<SkillPackage | null> =>
    withPackageAdmission(
      location,
      directoryName,
      'shared',
      'role-get-skill',
      async (context) => (await skillAtAdmitted(location, directoryName, context))?.pkg ?? null,
    )

  /** One placement's writer, resolved once and then held. Resolving it prepares
   *  nothing — no root, no sweep, no staging — so a caller may settle every
   *  target of a multi-package Add before the first of them mutates anything.
   *  The FS root, its real-directory/symlink guard, the placement fence and the
   *  stale-staging sweep stay owned here; only the moment they run moves. */
  const publicationAt = async (location: RoleLocation): Promise<RolePackagePublication | null> => {
    if (!publishDirectoryIfAbsent || rootForSpace(location.space) == null) {
      return null
    }
    const { mount, root } = rootsOf(location)
    const publish = publishDirectoryIfAbsent
    const authorityChannelConfigured =
      authorityForSpace !== undefined || resourcePrefixForSpace !== undefined
    let authorityPublication: PackagePublicationView | null = null

    if (authorityChannelConfigured) {
      const authority = await authorityForSpace?.(location.space)
      const placementPath = resourcePlacementPath(location)

      if (!authority || placementPath == null) {
        return null
      }
      authorityPublication = authority.packagePublicationFor(placementPath, 'role-put-placement')
      if (!authorityPublication) {
        return null
      }
    }

    const authorityCommitting = async <T>(commit: () => Promise<T>): Promise<T> => {
      try {
        return await commit()
      } catch (err) {
        // The authority protocol continues after the aggregate rename to prove
        // its result. Only its producer-local typed refusal guarantees that the
        // package did not land; a raw errno here may come from post-commit proof.
        if (err instanceof FilePackagePublicationUnavailableError) {
          throw new RoleInstallUnavailableError(
            'role installation is unavailable for this location',
          )
        }
        throw err
      }
    }

    /** Direct FS has no proof protocol after this callback: it is the primitive
     *  commit itself, so its narrow raw pathname refusal still proves that the
     *  target was not published. */
    const directCommitting = async (commit: () => Promise<boolean>): Promise<boolean> => {
      try {
        return await commit()
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code

        if (
          err instanceof FilePackagePublicationUnavailableError ||
          code === 'ENOTSUP' ||
          code === 'EXDEV'
        ) {
          throw new RoleInstallUnavailableError(
            'role installation is unavailable for this location',
          )
        }
        throw err
      }
    }

    return {
      putIfAbsent: async (pkg: SkillPackage) => {
        validateSkillPackage(pkg)
        if (!isGeneratedNoteId(pkg.directoryName)) {
          throw new InvalidSkillPackageError(
            `invalid owned Agent Skill package address: ${pkg.directoryName}`,
          )
        }
        const manifestName = parseSkillFile(
          Buffer.from(pkg.files.get('SKILL.md')!).toString('utf8'),
          pkg.directoryName,
        ).name

        await prepareRoot(location, mount, root)
        await sweepStaleStaging(mount, root)
        const authorityResourcePath = resourcePackagePath(location, pkg.directoryName)

        if (authorityPublication) {
          if (authorityResourcePath == null) {
            throw new Error('role library has no projected resource path')
          }

          return await authorityCommitting(async () => {
            const published = await authorityPublication.publishIfAbsent({
              rootPath: authorityResourcePath,
              files: [...pkg.files].map(([path, content]) => ({ path, content })),
            })

            return published.status === 'published'
          })
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
                return await directCommitting(() => publish(temp, target))
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

      moveFrom: async (
        origin: RoleLocation,
        directoryName: string,
        expected: RolePackageTarget,
        lifecycle: {
          beforeMove(snapshot: RolePackageSnapshot): Promise<void>
          finalize(snapshot: RolePackageSnapshot): Promise<void>
          rollback(): Promise<void>
        },
      ) => {
        const from = origin
        const to = location

        if (!isGeneratedNoteId(directoryName)) {
          throw new InvalidSkillPackageError(
            `invalid owned Agent Skill package address: ${directoryName}`,
          )
        }
        if (from.space !== to.space) {
          throw new Error('a package move cannot cross spaces')
        }
        const source = join(rootOf(from), directoryName)
        const target = join(root, directoryName)

        if (source === target) {
          throw new Error('a package move needs two different placements')
        }
        await prepareRoot(to, mount, root)

        const result = await projectedPackage(
          from,
          directoryName,
          expected.registryNoteId,
          (projection) =>
            // The destination's placement lease wraps the whole critical section, exactly
            // as publication's does: the name check and the publication that acts on it
            // are one decision, and the packages that could take that name have other ids.
            withPlacementAdmission(to, directoryName, 'role-move-placement', async () => {
              const release = await acquirePlacementFence(root)

              try {
                // Both sides admitted, destination first — the order the destination's
                // own lease already fixes, since the name check and the publication that
                // acts on it are one decision.
                //
                // It is NOT what keeps two mirrored moves of one package off each
                // other's half: taken this way round, A→B holds the lease on B and asks
                // for A while B→A holds A and asks for B, which is the inversion itself.
                // What rules that pair out is one floor up and two facts wide. The
                // source is resolved by `projectedPackage` BEFORE any lease here is
                // taken, and in production that resolution is an exact-note claim on the
                // package's registry note (`projectedRolePackageScope`) — so two moves
                // of ONE package serialize on its note id and the second never reaches
                // this line. Two moves of DIFFERENT packages hold disjoint package
                // leases and cannot wait on each other at all.
                return await withPackageAdmission(
                  to,
                  directoryName,
                  'exclusive',
                  'role-move-target',
                  (targetContext) =>
                    withPackageAdmission(
                      from,
                      directoryName,
                      'exclusive',
                      'role-move-source',
                      async (sourceContext) => {
                        const admitted = await snapshotAtAdmitted(
                          from,
                          directoryName,
                          projection,
                          sourceContext,
                        )
                        const snapshot = admitted?.snapshot

                        // The same two manifest-borne halves `withExactPackageMutation`
                        // revalidates, and for the same reason the registry id is not
                        // one of them: it is the selector this scope was entered by.
                        if (
                          !snapshot ||
                          snapshot.kind !== expected.kind ||
                          snapshot.manifestNoteId !== expected.manifestNoteId
                        ) {
                          throw new AbilityUnavailableError('ability package changed before move')
                        }
                        const currentManifest = snapshot.pkg.files.get('SKILL.md')!
                        const currentSkill = parseSkillFile(
                          Buffer.from(currentManifest).toString('utf8'),
                          directoryName,
                        )
                        // Sibling manifests are read DIRECTLY, the same way the
                        // publication side reads them for the same question
                        // (`assertSkillManifestNameAvailableAdmitted`): the placement
                        // lease this move already holds is what makes a name allocation
                        // exclusive, and a sibling's own lease adds nothing to it. Going
                        // through `manifestIndex` would instead take one nested shared
                        // package lease per sibling while this move holds a
                        // placement-exclusive and two package-exclusive leases — the
                        // move's admission footprint would grow with the size of the
                        // destination library, and each nested lease would queue behind
                        // an unrelated writer of a package this move never touches.
                        const occupied =
                          (await manifestNameOccupiedPhysically(to, currentSkill.name)) ||
                          (await pathOccupied(join(root, currentSkill.name)))

                        if (occupied) {
                          return { status: 'occupied', snapshot } as const
                        }

                        const authorityBacked = sourceContext !== null || targetContext !== null
                        const authorityMove =
                          sourceContext &&
                          targetContext &&
                          sourceContext.authority === targetContext.authority
                            ? sourceContext.authority.conditionalDirectoryMoveFor(
                                sourceContext.resourcePath,
                                targetContext.resourcePath,
                                'SKILL.md',
                              )
                            : null

                        if (
                          authorityBacked &&
                          (!sourceContext ||
                            !targetContext ||
                            !admitted.manifestClaim ||
                            !authorityMove)
                        ) {
                          throw new RoleInstallUnavailableError(
                            'role movement is unavailable for this location',
                          )
                        }

                        await lifecycle.beforeMove(snapshot)
                        let targetProof:
                          | {
                              adapterId: string
                              claim: FileClaim & { kind: 'present' }
                            }
                          | undefined

                        const rollbackCommittedMove = async (cause: unknown): Promise<void> => {
                          let restored = false

                          if (sourceContext && targetContext && targetProof) {
                            const reverse = sourceContext.authority.conditionalDirectoryMoveFor(
                              targetContext.resourcePath,
                              sourceContext.resourcePath,
                              'SKILL.md',
                            )

                            if (!reverse) {
                              throw rolePackageMoveRollbackError(cause)
                            }
                            try {
                              const reversed = await reverse.moveIfClaimed(targetProof)

                              // `committed-error` is directional: this reverse
                              // transition remains committed at its target, which
                              // is the original source placement. Lifecycle must
                              // therefore roll back with it even though proof failed.
                              restored =
                                reversed.status === 'moved' || reversed.status === 'committed-error'
                            } catch {
                              throw rolePackageMoveRollbackError(cause)
                            }
                          } else {
                            try {
                              restored = await directCommitting(() => publish(target, source))
                            } catch {
                              throw rolePackageMoveRollbackError(cause)
                            }
                          }
                          if (!restored) {
                            throw rolePackageMoveRollbackError(cause)
                          }
                          await lifecycle.rollback()
                        }
                        let published: boolean

                        try {
                          if (authorityMove && admitted.manifestClaim) {
                            const moved = await authorityMove.moveIfClaimed(admitted.manifestClaim)

                            if (moved.status === 'committed-error') {
                              throw rolePackageMoveRollbackError(
                                new AbilityUnavailableError(moved.reason),
                              )
                            }
                            if (moved.status === 'conflict') {
                              throw new AbilityUnavailableError(
                                'ability package changed during physical move',
                              )
                            }
                            published = moved.status === 'moved'
                            targetProof = moved.status === 'moved' ? moved.targetProof : undefined
                          } else {
                            published = await directCommitting(() => publish(source, target))
                          }
                        } catch (error) {
                          if (!isRolePackageMoveRollbackError(error)) {
                            await lifecycle.rollback()
                          }
                          throw error
                        }

                        if (!published) {
                          await lifecycle.rollback()
                          return { status: 'occupied', snapshot } as const
                        }
                        try {
                          await lifecycle.finalize(snapshot)
                          return { status: 'moved', snapshot } as const
                        } catch (error) {
                          await rollbackCommittedMove(error)
                          throw error
                        }
                      },
                    ),
                )
              } finally {
                release()
              }
            }),
        )

        return result ?? { status: 'missing' as const }
      },
    }
  }

  const library: RoleLibrary = {
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
    getAbilitiesNamed: async (location, name) => {
      if (!isSkillName(name)) {
        return new Map()
      }

      const indexed = (await manifestIndex(location)).get(name)
      const found = new Map<AbilityKind, SkillPackage>()

      for (const kind of [ABILITY_KIND.role, ABILITY_KIND.skill] as const) {
        const directoryName = indexed?.byKind[kind]
        const pkg = directoryName ? await skillAt(location, directoryName) : null
        const manifest = pkg?.files.get('SKILL.md')

        if (!pkg || !manifest) {
          continue
        }
        try {
          const parsed = parseSkillFile(Buffer.from(manifest).toString('utf8'), pkg.directoryName)

          // The external manifest may change after the index pass. The producer owns
          // the kind-keyed contract, so it must reject that torn read here rather than
          // make every resolver rediscover which identity it actually received.
          if (
            parsed.name === name &&
            parsed.role === (kind === ABILITY_KIND.role) &&
            isResolvableAbilityManifest(parsed)
          ) {
            found.set(kind, pkg)
          }
        } catch (err) {
          console.warn(
            `[roles] ignoring invalid package ${pkg.directoryName}:`,
            (err as Error).message,
          )
        }
      }

      return found
    },
    getSkillByDirectory: async (location, directoryName) =>
      isGeneratedNoteId(directoryName) ? skillAt(location, directoryName) : null,
    captureExactPackage: async (location, directoryName, expectedRegistryNoteId) => {
      if (!isGeneratedNoteId(directoryName)) {
        return null
      }

      return projectedPackage(location, directoryName, expectedRegistryNoteId, (projection) =>
        withPackageAdmission(
          location,
          directoryName,
          'shared',
          'role-exact-authority',
          async (context) =>
            (await snapshotAtAdmitted(location, directoryName, projection, context))?.snapshot ??
            null,
        ),
      )
    },
    withExactPackageMutation: async (location, directoryName, expected, task) => {
      if (!isGeneratedNoteId(directoryName)) {
        return null
      }

      return projectedPackage(
        location,
        directoryName,
        expected.registryNoteId,
        async (projection) => {
          return withPlacementAdmission(
            location,
            directoryName,
            'role-exact-mutation-placement',
            async () => {
              return withPackageAdmission(
                location,
                directoryName,
                'exclusive',
                'role-exact-mutation-package',
                async (context) => {
                  const admitted = await snapshotAtAdmitted(
                    location,
                    directoryName,
                    projection,
                    context,
                  )
                  const snapshot = admitted?.snapshot

                  // Both manifest-borne halves of the captured identity, revalidated
                  // under the very leases the task will hold: they are read out of the
                  // bytes at this address, so they are what a package swapped since the
                  // capture would have changed.
                  //
                  // The registry id is not among them, and the reason is that comparing
                  // it here would prove NOTHING rather than that it would be safe:
                  // `snapshot.registryNoteId` is a copy of the selector this scope was
                  // entered by (`projectedPackage` puts it there), so the comparison is a
                  // value against itself and can refuse nothing at all. What binds that
                  // id to this ADDRESS is one floor up, inside the exact-note claim the
                  // projection opened — `projectedRolePackageScope` refuses when the
                  // note's own path is no longer this package's.
                  return snapshot &&
                    snapshot.kind === expected.kind &&
                    snapshot.manifestNoteId === expected.manifestNoteId
                    ? task(snapshot)
                    : null
                },
              )
            },
          )
        },
      )
    },
    exists: async (location, name, options) => {
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
        options,
      )

      return occupiedDirectly || (await manifestIndex(location, options)).has(name)
    },
    get: async (location, name) => {
      if (!isSkillName(name)) {
        return null
      }

      const directoryName = (await manifestIndex(location)).get(name)?.first

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
    awaitReadableNoteIds: (location, directoryNames) =>
      projectNoteIds(location, directoryNames, true),
    readableNoteIds: (location, directoryNames) => projectNoteIds(location, directoryNames, false),
    inspectAndRemove: async (location, directoryName, options) => {
      let found = false

      await options.remove(async (victimNoteIds) => {
        const directory = join(rootOf(location), directoryName)

        try {
          const info = await lstat(directory)

          if (!info.isDirectory() || info.isSymbolicLink()) {
            throw new AbilityUnavailableError('ability package changed before delete')
          }
          const members = new Set<string>()
          const files = await readPackageFiles(directory, {
            recordSpecialEntries: true,
            members,
          })

          if (!files.has('SKILL.md')) {
            throw new AbilityUnavailableError('ability package changed before delete')
          }
          const pkg = { directoryName, files }

          validateSkillPackage(pkg)
          const parsed = parseSkillFile(
            Buffer.from(files.get('SKILL.md')!).toString('utf8'),
            directoryName,
          )
          const owner = exactOwnerObservation(files.get('SKILL.md')!)

          if (
            options.expected &&
            ((parsed.role ? ABILITY_KIND.role : ABILITY_KIND.skill) !== options.expected.kind ||
              !victimNoteIds?.includes(options.expected.registryNoteId) ||
              owner.kind !== 'claimed' ||
              owner.id !== options.expected.manifestNoteId)
          ) {
            throw new AbilityUnavailableError('ability package changed before delete')
          }
          await options.assertSafe(pkg, [...members])
          found = true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new AbilityUnavailableError('ability package changed before delete')
          }
          throw error
        }
      })

      return found
    },
    manifestPath: (location, directoryName) => {
      const root = resourcePackagePath(location, directoryName)
      return root == null ? null : `${root}/SKILL.md`
    },
    withCreateAdmission: (location, directoryName, task, options) =>
      withPlacementAdmission(
        location,
        directoryName,
        'ability-create-placement',
        () =>
          withPackageAdmission(
            location,
            directoryName,
            'exclusive',
            'ability-create-package',
            task,
            options,
          ),
        options,
      ),
  }

  return {
    library,
    seedPackageFile: async (location, directoryName, relative, content) => {
      const parts = relative.split('/')

      if (
        !isGeneratedNoteId(directoryName) ||
        !relative ||
        relative.includes('\\') ||
        parts.some((part) => !part || part === '.' || part === '..')
      ) {
        throw new InvalidSkillPackageError(`invalid seeded package path: ${relative}`)
      }
      const target = join(rootOf(location), directoryName, ...parts)

      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, { flag: 'wx' })
    },
    publication: {
      // Pure, and deliberately so: a read model asks this for every target it
      // lists, so it may not mint a space, build an authority or touch a disk.
      availableFor: (target) =>
        publishDirectoryIfAbsent !== undefined &&
        (target.kind === 'prospective-personal'
          ? prospectivePersonalRoot()
          : rootForSpace(target.location.space) != null),
      publicationFor: publicationAt,
    },
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
} = {}): InMemoryRoleLibraryComposition => {
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

  const snapshotOf = (
    location: RoleLocation,
    pkg: SkillPackage,
    registryNoteId = pkg.directoryName,
  ): RolePackageSnapshot | null => {
    const manifest = pkg.files.get('SKILL.md')

    if (!manifest) {
      return null
    }
    let parsed

    try {
      parsed = parseSkillFile(Buffer.from(manifest).toString('utf8'), pkg.directoryName)
    } catch {
      return null
    }
    const owner = exactOwnerObservation(manifest)

    return owner.kind === 'claimed'
      ? {
          registryNoteId,
          filePath:
            location.scope === 'project'
              ? `.notarium/skills/_projects/${projectDirectory(location.projectId!)}/${pkg.directoryName}/SKILL.md`
              : `.notarium/skills/${pkg.directoryName}/SKILL.md`,
          versionToken: packageRevision(new Map([['SKILL.md', manifest]])),
          kind: parsed.role ? ABILITY_KIND.role : ABILITY_KIND.skill,
          manifestNoteId: owner.id,
          pkg: clone(pkg),
        }
      : null
  }

  const manifestIdentityOf = (pkg: SkillPackage): { name: string; kind: AbilityKind } | null => {
    const manifest = pkg.files.get('SKILL.md')

    if (!manifest) {
      return null
    }
    try {
      const parsed = parseSkillFile(Buffer.from(manifest).toString('utf8'), pkg.directoryName)

      if (!isResolvableAbilityManifest(parsed)) {
        return null
      }

      return {
        name: parsed.name,
        kind: parsed.role ? ABILITY_KIND.role : ABILITY_KIND.skill,
      }
    } catch {
      return null
    }
  }

  const manifestNameOf = (pkg: SkillPackage): string | null => manifestIdentityOf(pkg)?.name ?? null

  const packageByName = (
    location: RoleLocation,
    name: string,
    kind?: AbilityKind,
  ): SkillPackage | null => {
    const matches = [...packages]
      .filter(([key, pkg]) => {
        const identity = manifestIdentityOf(pkg)

        return (
          key.startsWith(prefixOf(location)) &&
          identity?.name === name &&
          (kind === undefined || identity.kind === kind)
        )
      })
      .sort(([, left], [, right]) => left.directoryName.localeCompare(right.directoryName))

    return matches[0]?.[1] ?? null
  }

  const putIfAbsent = async (location: RoleLocation, pkg: SkillPackage): Promise<boolean> => {
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
  }

  const movePackage = async (
    from: RoleLocation,
    to: RoleLocation,
    directoryName: string,
    expected: RolePackageTarget,
    lifecycle: {
      beforeMove(snapshot: RolePackageSnapshot): Promise<void>
      finalize(snapshot: RolePackageSnapshot): Promise<void>
      rollback(): Promise<void>
    },
  ): Promise<RolePackageMoveResult> => {
    if (from.space !== to.space) {
      throw new Error('a package move cannot cross spaces')
    }
    const pkg = packages.get(keyOf(from, directoryName))

    if (!pkg) {
      return { status: 'missing' }
    }
    const name = manifestNameOf(pkg)
    const snapshot = snapshotOf(from, pkg)

    if (
      !snapshot ||
      snapshot.kind !== expected.kind ||
      snapshot.registryNoteId !== expected.registryNoteId ||
      snapshot.manifestNoteId !== expected.manifestNoteId
    ) {
      throw new AbilityUnavailableError('ability package changed before move')
    }

    if (packages.has(keyOf(to, directoryName)) || (name != null && packageByName(to, name))) {
      return { status: 'occupied', snapshot }
    }
    await lifecycle.beforeMove(snapshot)
    packages.delete(keyOf(from, directoryName))
    packages.set(keyOf(to, directoryName), pkg)
    try {
      await lifecycle.finalize(snapshot)
      return { status: 'moved', snapshot }
    } catch (error) {
      const targetKey = keyOf(to, directoryName)
      const sourceKey = keyOf(from, directoryName)
      const restored = packages.get(targetKey) === pkg && !packages.has(sourceKey)

      if (restored) {
        packages.delete(targetKey)
        packages.set(sourceKey, pkg)
      }

      if (!restored) {
        throw rolePackageMoveRollbackError(error)
      }
      await lifecycle.rollback()
      throw error
    }
  }

  const library = {
    listManifests: async (location) => ({
      packages: [...packages]
        .filter(([key]) => key.startsWith(prefixOf(location)))
        .map(([, pkg]) => ({
          directoryName: pkg.directoryName,
          files: new Map([['SKILL.md', Uint8Array.from(pkg.files.get('SKILL.md')!)]]),
        })),
      truncated: false,
    }),
    getAbilitiesNamed: async (location, name) => {
      const found = new Map<AbilityKind, SkillPackage>()

      for (const kind of [ABILITY_KIND.role, ABILITY_KIND.skill] as const) {
        const pkg = packageByName(location, name, kind)
        const skill = pkg?.files.get('SKILL.md')

        if (pkg && skill) {
          found.set(kind, {
            directoryName: pkg.directoryName,
            files: new Map([['SKILL.md', Uint8Array.from(skill)]]),
          })
        }
      }

      return found
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
    captureExactPackage: async (location, directoryName, expectedRegistryNoteId) => {
      const pkg = packages.get(keyOf(location, directoryName))
      const snapshot = pkg ? snapshotOf(location, pkg) : null

      return snapshot &&
        (expectedRegistryNoteId === undefined || snapshot.registryNoteId === expectedRegistryNoteId)
        ? snapshot
        : null
    },
    withExactPackageMutation: async (location, directoryName, expected, task) => {
      const pkg = packages.get(keyOf(location, directoryName))
      const snapshot = pkg ? snapshotOf(location, pkg) : null

      return snapshot &&
        snapshot.kind === expected.kind &&
        snapshot.registryNoteId === expected.registryNoteId &&
        snapshot.manifestNoteId === expected.manifestNoteId
        ? task(snapshot)
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
    inspectAndRemove: async (location, directoryName, options) => {
      let found = false

      await options.remove(async () => {
        const pkg = packages.get(keyOf(location, directoryName))

        if (!pkg) {
          throw new AbilityUnavailableError('ability package changed before delete')
        }
        const manifest = pkg.files.get('SKILL.md')
        const parsed = manifest
          ? parseSkillFile(Buffer.from(manifest).toString('utf8'), directoryName)
          : null
        const owner = manifest ? exactOwnerObservation(manifest) : { kind: 'unproven' as const }

        if (
          options.expected &&
          (!parsed ||
            (parsed.role ? ABILITY_KIND.role : ABILITY_KIND.skill) !== options.expected.kind ||
            directoryName !== options.expected.registryNoteId ||
            owner.kind !== 'claimed' ||
            owner.id !== options.expected.manifestNoteId)
        ) {
          throw new AbilityUnavailableError('ability package changed before delete')
        }
        await options.assertSafe(clone(pkg), [...pkg.files.keys()])
        found = true
      })

      return found
    },
    manifestPath: (location, directoryName) => {
      const root =
        location.scope === 'project'
          ? `.notarium/skills/_projects/${projectDirectory(location.projectId!)}/${directoryName}`
          : `.notarium/skills/${directoryName}`

      return `${root}/SKILL.md`
    },
    withCreateAdmission: async (_location, _directoryName, task) => task(),
    clear: () => packages.clear(),
  } satisfies RoleLibrary & { clear(): void }

  return {
    library,
    publication: {
      availableFor: () => true,
      publicationFor: async (location) => ({
        putIfAbsent: (pkg) => putIfAbsent(location, pkg),
        moveFrom: (origin, directoryName, expected, lifecycle) =>
          movePackage(origin, location, directoryName, expected, lifecycle),
      }),
    },
  }
}
