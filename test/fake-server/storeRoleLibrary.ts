import { ABILITY_KIND, type AbilityKind } from '@notarium/contract'
import {
  analyzeDocumentState,
  DOCUMENT_ROLE,
  exactOwnerObservation,
  isSkillName,
  type KnowledgeStore,
  NOTE_CLASS,
  READ_SCOPE,
} from '@notarium/core'
import {
  AbilityUnavailableError,
  InvalidSkillPackageError,
  isResolvableAbilityManifest,
  parseSkillFile,
  type RoleLibrary,
  type RoleLibraryListing,
  type RoleLocation,
  rolePackageMoveRollbackError,
  type RolePackagePublication,
  type RolePackageSnapshot,
  type SeedableRoleLibraryComposition,
  type SkillPackage,
  validateSkillPackage,
} from '@notarium/server'

const projectDirectory = (projectId: string): string =>
  Buffer.from(projectId, 'utf8').toString('base64url')

const placementRoot = (location: RoleLocation): string =>
  location.scope === 'project'
    ? `.notarium/skills/_projects/${projectDirectory(location.projectId!)}`
    : '.notarium/skills'

const packageRoot = (location: RoleLocation, directoryName: string): string =>
  `${placementRoot(location)}/${directoryName}`

const clone = (pkg: SkillPackage): SkillPackage => ({
  directoryName: pkg.directoryName,
  files: new Map([...pkg.files].map(([name, bytes]) => [name, Uint8Array.from(bytes)])),
})

/** The bound the production library puts on ONE placement's listing
 *  (`MAX_LIBRARY_PACKAGES`). Reproduced rather than referenced: the fake owes the
 *  same SHAPE of answer — a bounded page plus an honest `truncated` — and a fixture
 *  may lower the number so a world crosses it without seeding 257 packages. */
const MAX_LIBRARY_PACKAGES = 256

/** The manifest-name grammar the shipped library refuses OUTSIDE, before it looks
 *  anything up — ASKED of the one producer rather than reproduced.
 *
 *  It used to be reproduced, on the argument that a deliberate twin is this file's job.
 *  That argument holds for the wire and not for a domain PREDICATE: the copy here was
 *  missing the length half, so the twin and the real library answered differently about
 *  a 65-character name — and the conformance suite that reconciles them has no case for
 *  length. A twin that disagrees about what a name IS tests the wrong server. */
const nameable = (name: string): boolean => isSkillName(name)

/**
 * Fake-server package adapter over the same store that serves note routes.
 * Production gets this convergence from the filesystem mount; keeping a second
 * in-memory package map would make package mutations invisible to the editor and
 * editor mutations invisible to the Skills inventory.
 */
export const createStoreRoleLibrary = (
  storeForSpace: (space: string) => Promise<KnowledgeStore>,
  maxPackages: () => number | undefined = () => undefined,
  {
    onBarrier,
  }: {
    /** Every crossing of the read-model publication barrier, as it happens. The fake
     *  writes through the store it reads, so the barrier costs it nothing — which is
     *  precisely why both port methods used to be ONE function here, and why a caller
     *  that took the barrier on a READ path looked identical to one that did not. The
     *  cost it hides is real on the host: the barrier blocks mutations across the whole
     *  space while it runs. */
    onBarrier?: (location: RoleLocation, directoryNames: readonly string[]) => void
  } = {},
): SeedableRoleLibraryComposition => {
  /** One claim at a time per placement — the fake's stand-in for the filesystem
   *  library's `acquirePlacementFence`. `putIfAbsent` asks "is this name free?" and
   *  then writes, with awaits in between; unfenced, two concurrent installers of one
   *  name both read "free" and both publish. The port forbids that outright
   *  (`RoleLibrary.putIfAbsent`), and the real library cannot reach it — so a double
   *  that can is a double that hides the state it exists to reproduce. */
  const placementClaims = new Map<string, Promise<unknown>>()

  const claimPlacement = async <T>(location: RoleLocation, run: () => Promise<T>): Promise<T> => {
    const key = `${location.space}\0${placementRoot(location)}`
    const claim = (placementClaims.get(key) ?? Promise.resolve()).then(run)

    // The tail must never be a rejected promise: the next claimant chains onto it, and
    // one failed install would otherwise fail every install behind it.
    placementClaims.set(
      key,
      claim.catch(() => undefined),
    )
    return claim
  }

  /** The package members a NOTE cannot hold. An Agent Skill package may carry
   *  `scripts/`, `assets/` and references in any format; the filesystem library keeps
   *  them as plain files beside SKILL.md and the note read-model simply does not index
   *  them. This fake used to refuse them outright, which put every package with a
   *  non-Markdown resource — a whole legitimate class of packages — beyond the reach
   *  of the browser gates, because this is the only library they run. Kept beside the
   *  store rather than inside it precisely BECAUSE the store is notes: these are the
   *  members the editor could never have shown either way, so nothing diverges by
   *  living here. Keyed by space and full path, the same address the store uses. */
  const resources = new Map<string, Uint8Array>()
  const resourceKey = (space: string, path: string): string => `${space}\0${path}`
  const resourcesUnder = (space: string, root: string): Array<[string, Uint8Array]> =>
    [...resources]
      .filter(([key]) => key.startsWith(resourceKey(space, `${root}/`)))
      .map(([key, bytes]) => [key.slice(resourceKey(space, `${root}/`).length), bytes])

  const packageByDirectory = async (
    location: RoleLocation,
    directoryName: string,
  ): Promise<SkillPackage | null> => {
    const store = await storeForSpace(location.space)
    const root = packageRoot(location, directoryName)
    const notes = await store.list({ scope: READ_SCOPE.all, classes: [NOTE_CLASS.skill] })

    if (!notes.some((note) => note.filePath === `${root}/SKILL.md`)) {
      return null
    }
    const files = new Map<string, Uint8Array>()

    for (const note of notes) {
      if (!note.filePath?.startsWith(`${root}/`)) {
        continue
      }
      const relative = note.filePath.slice(root.length + 1)
      const content = await store.read(note.id ?? note.filePath)
      const source = content.documentState?.source

      if (source) {
        files.set(relative, Uint8Array.from(source))
      }
    }
    // A resource is part of the package but never part of it ALONE: SKILL.md decides
    // whether there is a package here at all, and it is always a note.
    for (const [relative, bytes] of resourcesUnder(location.space, root)) {
      files.set(relative, Uint8Array.from(bytes))
    }

    return files.has('SKILL.md') ? { directoryName, files } : null
  }

  const packagesAt = async (location: RoleLocation): Promise<SkillPackage[]> => {
    const store = await storeForSpace(location.space)
    const prefix = `${placementRoot(location)}/`
    const notes = await store.list({ scope: READ_SCOPE.all, classes: [NOTE_CLASS.skill] })
    const directories = new Set<string>()

    for (const note of notes) {
      if (!note.filePath?.startsWith(prefix)) {
        continue
      }
      const relative = note.filePath.slice(prefix.length)
      const match = /^([^/]+)\/SKILL\.md$/.exec(relative)

      if (match) {
        directories.add(match[1])
      }
    }

    return (
      await Promise.all([...directories].sort().map((name) => packageByDirectory(location, name)))
    ).filter((pkg): pkg is SkillPackage => pkg != null)
  }

  const parsedIdentity = (pkg: SkillPackage): { name: string; kind: AbilityKind } | null => {
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

  const parsedName = (pkg: SkillPackage): string | null => parsedIdentity(pkg)?.name ?? null

  const packageByName = async (
    location: RoleLocation,
    name: string,
    kind?: AbilityKind,
  ): Promise<SkillPackage | null> =>
    (await packagesAt(location)).find((pkg) => {
      const identity = parsedIdentity(pkg)

      return identity?.name === name && (kind === undefined || identity.kind === kind)
    }) ?? null

  /** Package identities off the note projection. The fake writes through the store it
   *  reads, so its publication barrier is already crossed by the time anyone asks;
   *  what is left is exactly the partial answer the real host gives
   *  (`projectPublishedPackages` in `server.ts`): a
   *  package the projection does not hold is absent, never an error.
   *
   *  Absence is reported, not judged. Deciding what it MEANS belongs to
   *  `RolesService`, the layer that turns a missing identity into `published without
   *  a readable note identity` — and a throw here would take that decision away from
   *  the only layer where the fake-server runs the real service. */
  const noteIdsAt = async (
    location: RoleLocation,
    directoryNames: readonly string[],
  ): Promise<ReadonlyMap<string, string>> => {
    const store = await storeForSpace(location.space)
    const notes = await store.list({ scope: READ_SCOPE.all, classes: [NOTE_CLASS.skill] })
    const projected = new Map<string, string>()

    for (const directoryName of new Set(directoryNames)) {
      const filePath = `${packageRoot(location, directoryName)}/SKILL.md`
      const note = notes.find((candidate) => candidate.filePath === filePath)

      if (!note?.id) {
        continue
      }
      projected.set(directoryName, note.id)
    }

    return projected
  }

  const withExactPackageScope = async <T>(
    location: RoleLocation,
    directoryName: string,
    expectedRegistryNoteId: string | undefined,
    task: (snapshot: RolePackageSnapshot) => Promise<T>,
  ): Promise<T | null> => {
    const store = await storeForSpace(location.space)
    const filePath = `${packageRoot(location, directoryName)}/SKILL.md`
    const registryNoteId =
      expectedRegistryNoteId ??
      (await store.list({ scope: READ_SCOPE.all, classes: [NOTE_CLASS.skill] })).find(
        (candidate) => candidate.filePath === filePath,
      )?.id

    if (!registryNoteId) {
      return null
    }
    const project = async (current: Awaited<ReturnType<KnowledgeStore['read']>>) => {
      const manifest = current.documentState?.source

      if (
        !manifest ||
        !current.versionToken ||
        current.id !== registryNoteId ||
        current.filePath !== filePath
      ) {
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
        ? task({
            registryNoteId,
            filePath,
            versionToken: current.versionToken,
            kind: parsed.role ? ABILITY_KIND.role : ABILITY_KIND.skill,
            manifestNoteId: owner.id,
            pkg: {
              directoryName,
              files: new Map([['SKILL.md', Uint8Array.from(manifest)]]),
            },
          })
        : null
    }
    const exactStore = store as KnowledgeStore & {
      withExactNoteClaim?<Result>(
        noteId: string,
        task: (current: Awaited<ReturnType<KnowledgeStore['read']>>) => Promise<Result>,
      ): Promise<Result>
    }

    try {
      return exactStore.withExactNoteClaim
        ? await exactStore.withExactNoteClaim(registryNoteId, project)
        : await project(await store.read(registryNoteId))
    } catch (error) {
      if ((error as { isNotFound?: unknown }).isNotFound === true) {
        return null
      }
      throw error
    }
  }

  const captureExactPackage = (
    location: RoleLocation,
    directoryName: string,
    expectedRegistryNoteId?: string,
  ): Promise<RolePackageSnapshot | null> =>
    withExactPackageScope(
      location,
      directoryName,
      expectedRegistryNoteId,
      async (snapshot) => snapshot,
    )

  const listing = async (location: RoleLocation): Promise<RoleLibraryListing> => {
    const all = await packagesAt(location)
    const limit = Math.max(0, maxPackages() ?? MAX_LIBRARY_PACKAGES)

    return {
      packages: all.slice(0, limit).flatMap((pkg) => {
        const manifest = pkg.files.get('SKILL.md')

        return manifest
          ? [{ directoryName: pkg.directoryName, files: new Map([['SKILL.md', manifest]]) }]
          : []
      }),
      // A bounded scan says so. The listing is what the inventory pages over, so
      // swallowing the bound is how a placement disappears without a word.
      truncated: all.length > limit,
    }
  }

  const putIfAbsent = async (location: RoleLocation, pkg: SkillPackage): Promise<boolean> => {
    // The pure refusal first and OUTSIDE the fence, the order the shipped library
    // keeps: a malformed package is refused without consulting the placement at all.
    validateSkillPackage(pkg)

    return claimPlacement(location, async () => {
      const name = parsedName(pkg)

      if (
        !name ||
        (await packageByDirectory(location, pkg.directoryName)) != null ||
        (await packageByName(location, name)) != null
      ) {
        return false
      }
      const store = await storeForSpace(location.space)
      const root = packageRoot(location, pkg.directoryName)

      try {
        for (const [relative, bytes] of pkg.files) {
          if (!relative.endsWith('.md')) {
            // Not a note, so not the store's — but still the package's.
            resources.set(
              resourceKey(location.space, `${root}/${relative}`),
              Uint8Array.from(bytes),
            )
            continue
          }
          const role =
            relative === 'SKILL.md' ? DOCUMENT_ROLE.skillRoot : DOCUMENT_ROLE.skillAuxiliary
          const state = analyzeDocumentState({
            source: bytes,
            role,
            pathFallbackTitle: relative.split('/').at(-1)!.replace(/\.md$/i, ''),
            ...(role === DOCUMENT_ROLE.skillRoot ? { skillDirectoryName: pkg.directoryName } : {}),
          })
          const projection = state.projection

          if (!projection) {
            throw new InvalidSkillPackageError(`invalid Agent Skill Markdown: ${relative}`)
          }
          await store.write(
            {
              id: relative === 'SKILL.md' ? pkg.directoryName : undefined,
              title:
                role === DOCUMENT_ROLE.skillRoot && projection.titleOrigin.kind === 'hidden-h1'
                  ? projection.titleOrigin.title
                  : projection.title,
              content: projection.body,
              frontmatter: projection.frontmatterEntries,
              frontmatterMode: 'replace',
              targetClass: NOTE_CLASS.skill,
              restorePath: `${root}/${relative}`,
            },
            { internalAddress: true },
          )
        }

        return true
      } catch (error) {
        await store.removeDir?.(root, { internalAddress: true })
        for (const [relative] of resourcesUnder(location.space, root)) {
          resources.delete(resourceKey(location.space, `${root}/${relative}`))
        }
        throw error
      }
    })
  }

  const movePackage = async (
    from: RoleLocation,
    to: RoleLocation,
    directoryName: string,
    expected: Parameters<RolePackagePublication['moveFrom']>[2],
    lifecycle: Parameters<RolePackagePublication['moveFrom']>[3],
  ): ReturnType<RolePackagePublication['moveFrom']> => {
    if (from.space !== to.space) {
      throw new Error('a package move cannot cross spaces')
    }
    const snapshot = await captureExactPackage(from, directoryName, expected.registryNoteId)

    if (!snapshot) {
      return { status: 'missing' }
    }
    if (
      snapshot.kind !== expected.kind ||
      snapshot.registryNoteId !== expected.registryNoteId ||
      snapshot.manifestNoteId !== expected.manifestNoteId
    ) {
      throw new AbilityUnavailableError('ability package changed before move')
    }
    const name = parsedName(snapshot.pkg)

    if (!name) {
      return { status: 'missing' }
    }

    return claimPlacement(to, async () => {
      if (
        (await packageByDirectory(to, directoryName)) != null ||
        (await packageByName(to, name)) != null
      ) {
        return { status: 'occupied', snapshot } as const
      }
      const store = await storeForSpace(from.space)
      const notes = await store.list({ scope: READ_SCOPE.all, classes: [NOTE_CLASS.skill] })
      const sourceRoot = packageRoot(from, directoryName)
      const targetRoot = packageRoot(to, directoryName)
      const members = notes
        .filter(
          (note): note is typeof note & { filePath: string; id: string } =>
            note.filePath?.startsWith(`${sourceRoot}/`) === true && note.id != null,
        )
        .sort((left, right) =>
          left.filePath === `${sourceRoot}/SKILL.md`
            ? -1
            : right.filePath === `${sourceRoot}/SKILL.md`
              ? 1
              : left.filePath.localeCompare(right.filePath),
        )

      if (members[0]?.filePath !== `${sourceRoot}/SKILL.md`) {
        throw new AbilityUnavailableError('ability package changed before move')
      }
      await lifecycle.beforeMove(snapshot)
      let physicalMoveStarted = false

      try {
        // Production moves the directory and lets identity survive the path change on
        // the frontmatter claim. The fake has no filesystem, so it re-addresses each
        // member BY ITS EXISTING ID. The root uses the version and bytes captured under
        // the exact scope above — never a fresh token read after release — so the Store
        // CAS rejects a same-path replacement before lifecycle finalize.
        for (const note of members) {
          const relative = note.filePath.slice(sourceRoot.length + 1)
          const content = await store.read(note.id)
          const capturedManifest =
            relative === 'SKILL.md' ? snapshot.pkg.files.get('SKILL.md') : undefined
          const projection = capturedManifest
            ? analyzeDocumentState({
                source: capturedManifest,
                role: DOCUMENT_ROLE.skillRoot,
                pathFallbackTitle: content.title ?? 'SKILL',
                skillDirectoryName: directoryName,
              }).projection
            : content.documentState?.projection

          if (!projection) {
            throw new Error(`fake role package member is unreadable: ${note.filePath}`)
          }
          await store.write(
            {
              id: note.id,
              originalId: note.id,
              versionToken: relative === 'SKILL.md' ? snapshot.versionToken : content.versionToken,
              title: content.title ?? projection.title,
              content: projection.body,
              frontmatter: projection.frontmatterEntries,
              frontmatterMode: 'replace',
              targetClass: NOTE_CLASS.skill,
              restorePath: `${targetRoot}/${relative}`,
            },
            { internalAddress: true },
          )
          physicalMoveStarted ||= relative === 'SKILL.md'
        }
        // The non-note members move with the directory, exactly as they do on disk.
        for (const [relative, bytes] of resourcesUnder(from.space, sourceRoot)) {
          resources.delete(resourceKey(from.space, `${sourceRoot}/${relative}`))
          resources.set(resourceKey(to.space, `${targetRoot}/${relative}`), bytes)
        }

        await lifecycle.finalize(snapshot)
        return { status: 'moved', snapshot } as const
      } catch (error) {
        if (!physicalMoveStarted) {
          await lifecycle.rollback()
          throw error
        }
        const restored = await movePackage(to, from, directoryName, expected, {
          beforeMove: async () => undefined,
          finalize: async () => undefined,
          rollback: async () => undefined,
        })

        if (restored.status !== 'moved') {
          throw rolePackageMoveRollbackError(error)
        }
        await lifecycle.rollback()
        throw error
      }
    })
  }

  const library: RoleLibrary = {
    listManifests: listing,
    getAbilitiesNamed: async (location, name) => {
      const found = new Map<AbilityKind, SkillPackage>()

      for (const kind of [ABILITY_KIND.role, ABILITY_KIND.skill] as const) {
        const pkg = await packageByName(location, name, kind)
        const manifest = pkg?.files.get('SKILL.md')

        if (pkg && manifest) {
          found.set(kind, {
            directoryName: pkg.directoryName,
            files: new Map([['SKILL.md', manifest]]),
          })
        }
      }

      return found
    },
    getSkillByDirectory: async (location, directoryName) => {
      const pkg = await packageByDirectory(location, directoryName)
      const manifest = pkg?.files.get('SKILL.md')

      return pkg && manifest
        ? { directoryName: pkg.directoryName, files: new Map([['SKILL.md', manifest]]) }
        : null
    },
    captureExactPackage,
    withExactPackageMutation: (location, directoryName, expected, task) =>
      withExactPackageScope(location, directoryName, expected.registryNoteId, async (captured) =>
        captured.kind === expected.kind && captured.manifestNoteId === expected.manifestNoteId
          ? claimPlacement(location, () => task(captured))
          : null,
      ),
    // A name no package may carry occupies nothing. Asked here, ahead of any lookup,
    // exactly where the shipped library asks it: a fake that answered `true` for a
    // malformed name would make an unpublishable name look taken, and the Add that
    // reports "already exists" for a name nothing owns is the state no browser gate
    // could reach while this check was missing.
    exists: async (location, name) =>
      nameable(name) &&
      ((await packageByDirectory(location, name)) != null ||
        (await packageByName(location, name)) != null),
    get: async (location, name) => {
      const pkg = await packageByName(location, name)
      return pkg ? clone(pkg) : null
    },
    getByDirectory: async (location, directoryName) => {
      const pkg = await packageByDirectory(location, directoryName)
      return pkg ? clone(pkg) : null
    },
    // Two bodies, not one alias: `awaitReadableNoteIds` is the WRITE-side question and
    // pays for a barrier, `readableNoteIds` is the same answer without it. Aliased,
    // the fake could not fail a read path that took the barrier — and the browser
    // gates run on nothing else.
    awaitReadableNoteIds: async (location, directoryNames) => {
      onBarrier?.(location, directoryNames)
      return noteIdsAt(location, directoryNames)
    },
    readableNoteIds: async (location, directoryNames) => noteIdsAt(location, directoryNames),
    inspectAndRemove: async (location, directoryName, options) => {
      let found = false
      const root = packageRoot(location, directoryName)
      const captured = await packageByDirectory(location, directoryName)
      const files = captured
        ? new Map<string, Uint8Array>([
            ['SKILL.md', Uint8Array.from(captured.files.get('SKILL.md')!)],
          ])
        : null

      if (files) {
        for (const [relative, bytes] of resourcesUnder(location.space, root)) {
          files.set(relative, Uint8Array.from(bytes))
        }
      }

      await options.remove(async (victimNoteIds) => {
        if (!files) {
          throw new Error('ability package changed before delete')
        }
        if (options.expected) {
          const manifest = files.get('SKILL.md')!
          const parsed = parseSkillFile(Buffer.from(manifest).toString('utf8'), directoryName)
          const owner = exactOwnerObservation(manifest)

          if (
            (parsed.role ? ABILITY_KIND.role : ABILITY_KIND.skill) !== options.expected.kind ||
            !victimNoteIds?.includes(options.expected.registryNoteId) ||
            owner.kind !== 'claimed' ||
            owner.id !== options.expected.manifestNoteId
          ) {
            throw new Error('ability package changed before delete')
          }
        }
        await options.assertSafe({ directoryName, files }, [...files.keys()])
        found = true
      })

      return found
    },
    manifestPath: (location, directoryName) => `${packageRoot(location, directoryName)}/SKILL.md`,
    withCreateAdmission: (location, _directoryName, task) => claimPlacement(location, task),
  }

  return {
    library,
    seedPackageFile: async (location, directoryName, relative, content) => {
      if (
        !relative ||
        relative.includes('\\') ||
        relative.split('/').some((part) => !part || part === '.' || part === '..')
      ) {
        throw new InvalidSkillPackageError(`invalid seeded package path: ${relative}`)
      }
      resources.set(
        resourceKey(location.space, `${packageRoot(location, directoryName)}/${relative}`),
        Uint8Array.from(content),
      )
    },
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
