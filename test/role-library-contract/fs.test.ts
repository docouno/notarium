import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type * as nodeFsPromises from 'node:fs/promises'
import {
  chmod,
  lstat,
  lutimes,
  mkdir,
  mkdtemp,
  opendir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ensureNotariumResourceAuthority,
  FilePackagePublicationUnavailableError,
  NotariumStoreCompositionOwner,
  renameNoReplaceIfAvailable,
  SpaceResourceAuthorityRegistry,
} from '@notarium/engine'
import {
  AbilityUnavailableError,
  createFsRoleLibrary,
  InvalidSkillPackageError,
  isRolePackageMoveRollbackError,
  type PublishDirectoryIfAbsent,
  RoleInstallUnavailableError,
  type RoleLocation,
  type SkillPackage,
  type WithProjectedRolePackage,
} from '../../packages/server/src/services/roles'
import { isReclaimableInstallStaging } from '../../packages/server/src/services/roles/installStaging'
import { writableLibrary } from '../roleLibraryComposition'
import {
  ATOMIC_PUBLISH_GATE,
  atomicPublishAvailable,
  describeAtomicPublish,
  itAtomicPublish,
} from './atomicPublishGate'
import {
  describeRoleLibraryAddressCollisionContract,
  describeRoleLibraryContract,
  packageDirectoryOf,
  packageOf,
} from './roleLibraryContract'

// Two entry points are wrapped, both delegating to the real ones: the suite has
// to fail one specific cleanup and one specific walk. Everything else — the
// library's writes and this file's own fixtures — stays real.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeFsPromises>()

  return {
    ...actual,
    lstat: vi.fn(actual.lstat),
    mkdir: vi.fn(actual.mkdir),
    rm: vi.fn(actual.rm),
    opendir: vi.fn(actual.opendir),
  }
})

const actualFs = await vi.importActual<typeof nodeFsPromises>('node:fs/promises')
const execFileAsync = promisify(execFile)
const lstatMock = vi.mocked(lstat)
const mkdirMock = vi.mocked(mkdir)
const rmMock = vi.mocked(rm)
const opendirMock = vi.mocked(opendir)
const STALE_MS = 60 * 60 * 1_000
const PERSONAL: RoleLocation = { scope: 'personal', space: 'personal' }
const PROJECT: RoleLocation = { scope: 'project', space: 'personal', projectId: 'project-a' }
const projectRoot = (mount: string): string =>
  join(mount, '_projects', Buffer.from(PROJECT.projectId!, 'utf8').toString('base64url'))
const SKILL_PREFIX = '.notarium/skills'

const admittedLibraryAt = (mount: string) => {
  const registry = new SpaceResourceAuthorityRegistry()
  const compositions = new NotariumStoreCompositionOwner()
  const authority = ensureNotariumResourceAuthority({
    spaceId: PERSONAL.space,
    resourceAuthorityRegistry: registry,
    composition: compositions.getOrCreate(PERSONAL.space, [
      { class: 'skill', dir: mount, prefix: SKILL_PREFIX },
    ]),
  })
  const library = writableLibrary(
    createFsRoleLibrary({
      publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
      rootForSpace: () => mount,
      resourcePrefixForSpace: () => SKILL_PREFIX,
      authorityForSpace: async () => authority,
    }),
  )

  return { authority, library }
}

/** Permission-based fixtures are vacuous under a uid that ignores permissions. */
const UNPRIVILEGED_GATE =
  '[gate: unprivileged filesystem permissions (run tests as a non-root user)]'
const unprivileged = process.getuid?.() !== 0
const mounts: string[] = []

const mkmount = async (): Promise<string> => {
  const mount = await mkdtemp(join(tmpdir(), 'nt-role-contract-'))

  mounts.push(mount)
  return mount
}

/** The real-filesystem library, carrying whatever this runtime actually offers. */
const libraryAt = (mount: string) =>
  writableLibrary(
    createFsRoleLibrary({
      publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
      rootForSpace: () => mount,
    }),
  )

/** The same library with the capability dictated rather than probed. A separate
 *  entry point on purpose: a default parameter would silently swap `undefined`
 *  — the case under test — back for the host's real answer. */
const libraryPublishingWith = (mount: string, publish: PublishDirectoryIfAbsent | undefined) =>
  writableLibrary(
    createFsRoleLibrary({ publishDirectoryIfAbsent: publish, rootForSpace: () => mount }),
  )

/** The composition itself, for the cases that are ABOUT its write side existing —
 *  the capability answer is the presence of a handle now, not an error raised by
 *  a method that should never have been reachable. */
const compositionPublishingWith = (mount: string, publish: PublishDirectoryIfAbsent | undefined) =>
  createFsRoleLibrary({ publishDirectoryIfAbsent: publish, rootForSpace: () => mount })

/** Identity AND content of one entry, so a case proves both that an occupant kept
 *  its inode and that not a byte of it moved. */
const fingerprint = async (path: string): Promise<string> => {
  const info = await lstat(path, { bigint: true })
  const identity = `${info.dev}:${info.ino}:${info.mode}`

  if (info.isSymbolicLink()) {
    return `${identity} -> ${await readlink(path)}`
  }
  if (info.isFile()) {
    return `${identity} = ${(await readFile(path)).toString('base64')}`
  }
  const members: string[] = []

  for (const entry of (await readdir(path)).sort()) {
    members.push(`${entry}:${await fingerprint(join(path, entry))}`)
  }

  return `${identity} [${members.join(',')}]`
}

/** Staging left behind by a dead process. Backdating happens AFTER it is filled:
 *  a directory's mtime advances when a new top-level entry appears, so ageing it
 *  first would leave it young again. */
const orphanStaging = async (
  directory: string,
  ageMs: number,
  name = packageDirectoryOf('wanted'),
): Promise<string> => {
  const path = join(directory, `.${name}.install-${randomUUID()}`)

  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'SKILL.md'), 'half-written')
  if (ageMs) {
    const when = new Date(Date.now() - ageMs)

    await utimes(path, when, when)
  }

  return path
}

const entriesOf = async (directory: string): Promise<string[]> => (await readdir(directory)).sort()

afterEach(async () => {
  // An unconsumed one-shot would otherwise leak into the next case — including
  // into this hook's own cleanup.
  rmMock.mockReset().mockImplementation(actualFs.rm)
  lstatMock.mockReset().mockImplementation(actualFs.lstat)
  mkdirMock.mockReset().mockImplementation(actualFs.mkdir)
  opendirMock.mockReset().mockImplementation(actualFs.opendir as typeof opendir)
  vi.restoreAllMocks()
  await Promise.all(
    mounts.splice(0).map(async (mount) => {
      await rm(mount, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }),
  )
})

describeRoleLibraryContract(
  'createFsRoleLibrary',
  async () => ({ library: libraryAt(await mkmount()) }),
  { gate: atomicPublishAvailable ? undefined : ATOMIC_PUBLISH_GATE },
)

describeRoleLibraryAddressCollisionContract(
  'createFsRoleLibrary',
  async () => ({ library: libraryAt(await mkmount()) }),
  { gate: atomicPublishAvailable ? undefined : ATOMIC_PUBLISH_GATE },
)

describe('role library staging selection', () => {
  it('reserves the staging grammar only where a library root actually is', () => {
    const packageDirectory = packageDirectoryOf('wanted')
    const staging = `.${packageDirectory}.install-${randomUUID()}`

    expect(isReclaimableInstallStaging(staging, true)).toBe(true)
    expect(isReclaimableInstallStaging(`_projects/cHJvamVjdC1h/${staging}`, true)).toBe(true)
    // A package resource under that grammar is authored data, kept verbatim by
    // export and by backup.
    expect(isReclaimableInstallStaging(`${packageDirectory}/assets/${staging}`, true)).toBe(false)
    expect(isReclaimableInstallStaging(`${packageDirectory}/${staging}`, true)).toBe(false)
    // So is a regular file or a symlink wearing the name.
    expect(isReclaimableInstallStaging(staging, false)).toBe(false)
    expect(isReclaimableInstallStaging('wanted', true)).toBe(false)
    expect(isReclaimableInstallStaging('_projects', true)).toBe(false)
  })
})

/** Deliberately OUTSIDE the native gate. These cases dictate the capability
 *  instead of probing it, so none of them needs `renameat2` — and the host that
 *  lacks it is precisely the one whose refusal they describe. Gated, they would
 *  skip on the only deployment that depends on them. */
describe('role library publication capability', () => {
  it('closes the publication gate only on a runtime that truly cannot publish', async () => {
    // The gate hides 34 real contract cases when it closes, and closing is a
    // legitimate answer — so a gate stuck shut looks exactly like a machine that
    // cannot. This witness publishes for itself and demands the gate agree.
    const publish = renameNoReplaceIfAvailable()
    let published = false

    if (publish) {
      const root = await mkdtemp(join(tmpdir(), 'nt-publish-gate-witness-'))

      try {
        await mkdir(join(root, 'source'))
        published = await publish(join(root, 'source'), join(root, 'target')).catch(() => false)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }

    expect(atomicPublishAvailable).toBe(published)
  })

  it('makes every composition root state the capability, even as undefined', () => {
    // The whole seam rests on one token: `X | undefined` REQUIRES the key while
    // allowing an absent capability, and `X?:` would let the next composition
    // root forget it and inherit an unavailable library silently. Nothing at
    // runtime can see the difference, so the assertion is a type-level one —
    // `tsc --noEmit` covers `test/`, and the call below is never made.
    // @ts-expect-error omitting publishDirectoryIfAbsent must not compile
    const forgotten = () => createFsRoleLibrary({ rootForSpace: () => null })

    expect(forgotten).toBeTypeOf('function')
  })

  it('hands out no writer at all, touching nothing, when composition carried no capability', async () => {
    const mount = await mkmount()
    const composition = compositionPublishingWith(mount, undefined)

    mkdirMock.mockClear()
    opendirMock.mockClear()

    // The availability answer is pure and comes first; resolving confirms it
    // without a filesystem call of any kind.
    expect(composition.publication.availableFor({ kind: 'location', location: PERSONAL })).toBe(
      false,
    )
    await expect(composition.publication.publicationFor(PERSONAL)).resolves.toBeNull()
    // Residue alone would not prove this: the staging `finally` erases its own
    // tree, so a late refusal leaves an empty mount too. Assert the calls that
    // must never have happened — no root prepared, no stale sweep, no staging.
    expect(mkdirMock).not.toHaveBeenCalled()
    expect(opendirMock).not.toHaveBeenCalled()
    await expect(entriesOf(mount)).resolves.toEqual([])
  })

  it('does not even create the library root when the capability is absent', async () => {
    const mount = await mkmount()

    await rm(mount, { recursive: true, force: true })
    await expect(
      compositionPublishingWith(mount, undefined).publication.publicationFor(PERSONAL),
    ).resolves.toBeNull()
    await expect(lstat(mount)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the two pure refusals inside the writer, and the space answer outside it', async () => {
    const mount = await mkmount()
    const publishing = libraryPublishingWith(mount, async (source, target) => {
      await actualFs.rename(source, target)
      return true
    })

    // Content is decided without consulting the runtime at all, so a supported
    // host must still refuse a malformed package as malformed.
    await expect(publishing.putIfAbsent(PERSONAL, packageOf('Bad Name', 'Owned.'))).rejects.toThrow(
      /invalid Agent Skill (?:package|manifest)/i,
    )
    // A space this host serves no library for has no writer either — the same
    // answer as an absent capability, reached before any package is looked at.
    await expect(
      createFsRoleLibrary({
        publishDirectoryIfAbsent: undefined,
        rootForSpace: () => null,
      }).publication.publicationFor(PERSONAL),
    ).resolves.toBeNull()
  })

  it('hands the injected capability the exact staging and target pathnames', async () => {
    const mount = await mkmount()
    const seen: [string, string][] = []
    const publish = vi.fn(async (source: string, target: string) => {
      seen.push([source, target])
      await actualFs.rename(source, target)
      return true
    })

    await expect(
      libraryPublishingWith(mount, publish).putIfAbsent(PERSONAL, packageOf('wanted', 'Owned.')),
    ).resolves.toBe(true)
    expect(publish).toHaveBeenCalledOnce()
    const directoryName = packageDirectoryOf('wanted')
    expect(seen[0]![1]).toBe(join(mount, directoryName))
    expect(seen[0]![0]).toContain(`/.${directoryName}.install-`)
    await expect(readFile(join(mount, directoryName, 'SKILL.md'), 'utf8')).resolves.toContain(
      'Owned.',
    )
    await expect(entriesOf(mount)).resolves.toEqual([directoryName])
  })

  it('keeps the whole read side working without any capability at all', async () => {
    const mount = await mkmount()

    const publish = async (source: string, target: string) => {
      await actualFs.rename(source, target)
      return true
    }

    await expect(
      libraryPublishingWith(mount, publish).putIfAbsent(PERSONAL, packageOf('wanted', 'Owned.')),
    ).resolves.toBe(true)
    // The same mount through a library that was handed NO capability. This is
    // the ground on which design/02 declined a `RoleLibrary.available`, and it
    // is worth pinning: a guard placed at the library's entrance instead of at
    // publication would be invisible on every supported host, and would take
    // listing and activation down with publishing on the one host that matters.
    const absent = libraryPublishingWith(mount, undefined)

    await expect(absent.listManifests(PERSONAL)).resolves.toMatchObject({
      packages: [{ directoryName: packageDirectoryOf('wanted') }],
    })
    await expect(absent.exists(PERSONAL, 'wanted')).resolves.toBe(true)
    await expect(absent.getAbilitiesNamed(PERSONAL, 'wanted')).resolves.toEqual(
      new Map([
        ['skill', expect.objectContaining({ directoryName: packageDirectoryOf('wanted') })],
      ]),
    )
  })

  it('refuses an incomplete configured authority during pure writer resolution', async () => {
    const mount = await mkmount()
    const directPublish = vi.fn(async () => true)
    const packagePublicationFor = vi.fn(() => null)
    const authorityForSpace = vi.fn(async () => ({ packagePublicationFor }) as never)
    const composition = createFsRoleLibrary({
      publishDirectoryIfAbsent: directPublish,
      rootForSpace: () => mount,
      resourcePrefixForSpace: () => '',
      authorityForSpace,
    })

    mkdirMock.mockClear()
    opendirMock.mockClear()

    await expect(composition.publication.publicationFor(PERSONAL)).resolves.toBeNull()
    expect(authorityForSpace).toHaveBeenCalledOnce()
    expect(packagePublicationFor).toHaveBeenCalledWith('', 'role-put-placement')
    expect(directPublish).not.toHaveBeenCalled()
    expect(mkdirMock).not.toHaveBeenCalled()
    expect(opendirMock).not.toHaveBeenCalled()
    await expect(entriesOf(mount)).resolves.toEqual([])
  })

  it('prebinds the authority placement without preparing the filesystem', async () => {
    const mount = await mkmount()
    const publishIfAbsent = vi.fn(async () => ({ status: 'conflict' as const }))
    const packagePublicationFor = vi.fn(() => ({ publishIfAbsent }))
    const composition = createFsRoleLibrary({
      publishDirectoryIfAbsent: vi.fn(async () => true),
      rootForSpace: () => mount,
      resourcePrefixForSpace: () => '',
      authorityForSpace: async () => ({ packagePublicationFor }) as never,
    })

    mkdirMock.mockClear()
    opendirMock.mockClear()
    const writer = await composition.publication.publicationFor(PERSONAL)

    expect(writer).not.toBeNull()
    expect(packagePublicationFor).toHaveBeenCalledWith('', 'role-put-placement')
    expect(mkdirMock).not.toHaveBeenCalled()
    expect(opendirMock).not.toHaveBeenCalled()

    await expect(writer!.putIfAbsent(packageOf('wanted', 'Owned.'))).resolves.toBe(false)
    expect(packagePublicationFor).toHaveBeenCalledOnce()
    expect(publishIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: packageDirectoryOf('wanted') }),
    )
  })

  it('does not relabel a raw errno from the authority protocol after publication', async () => {
    const mount = await mkmount()
    const candidate = packageOf('wanted', 'Owned.')
    const failure = Object.assign(new Error('proof crossed devices after commit'), {
      code: 'EXDEV',
    })
    const publishIfAbsent = vi.fn(async () => {
      const target = join(mount, candidate.directoryName)

      await actualFs.mkdir(target)
      await actualFs.writeFile(join(target, 'SKILL.md'), candidate.files.get('SKILL.md')!)
      throw failure
    })
    const composition = createFsRoleLibrary({
      publishDirectoryIfAbsent: vi.fn(async () => true),
      rootForSpace: () => mount,
      resourcePrefixForSpace: () => '',
      authorityForSpace: async () =>
        ({ packagePublicationFor: () => ({ publishIfAbsent }) }) as never,
    })
    const writer = await composition.publication.publicationFor(PERSONAL)

    await expect(writer!.putIfAbsent(candidate)).rejects.toBe(failure)
    await expect(readFile(join(mount, candidate.directoryName, 'SKILL.md'))).resolves.toEqual(
      Buffer.from(candidate.files.get('SKILL.md')!),
    )
  })

  it("maps only the authority protocol's typed pre-commit refusal", async () => {
    const mount = await mkmount()
    const composition = createFsRoleLibrary({
      publishDirectoryIfAbsent: vi.fn(async () => true),
      rootForSpace: () => mount,
      resourcePrefixForSpace: () => '',
      authorityForSpace: async () =>
        ({
          packagePublicationFor: () => ({
            publishIfAbsent: async () => {
              throw new FilePackagePublicationUnavailableError('unsupported pathname')
            },
          }),
        }) as never,
    })
    const writer = await composition.publication.publicationFor(PERSONAL)

    await expect(writer!.putIfAbsent(packageOf('wanted', 'Owned.'))).rejects.toBeInstanceOf(
      RoleInstallUnavailableError,
    )
    await expect(entriesOf(mount)).resolves.toEqual([])
  })

  it('names a commit the medium refused as unavailable, staging cleaned', async () => {
    const mount = await mkmount()
    // The one errno class that still means "nothing landed": the commit could not be
    // performed on this pathname. Presence answered for the deployment; this answers
    // for the path, and the caller may retry elsewhere without wondering whether a
    // package is half on disk.
    const failure = Object.assign(new Error('unsupported medium'), { code: 'EXDEV', errno: 18 })

    await expect(
      libraryPublishingWith(mount, async () => {
        throw failure
      }).putIfAbsent(PERSONAL, packageOf('wanted', 'Owned.')),
    ).rejects.toBeInstanceOf(RoleInstallUnavailableError)
    await expect(entriesOf(mount)).resolves.toEqual([])
  })

  it('lets any other injected failure travel out unchanged, staging cleaned', async () => {
    const mount = await mkmount()
    // An I/O error is NOT the capability answer. Relabelled as unavailable it would
    // invite a retry that then conflicts with the package the first attempt may well
    // have published.
    const failure = Object.assign(new Error('disk on fire'), { code: 'EIO', errno: 5 })

    await expect(
      libraryPublishingWith(mount, async () => {
        throw failure
      }).putIfAbsent(PERSONAL, packageOf('wanted', 'Owned.')),
    ).rejects.toBe(failure)
    await expect(entriesOf(mount)).resolves.toEqual([])
  })
})

/** The refusals `movePackage` owes that only a real filesystem can state. The shared
 *  contract asserts the floor every implementation of the port owes — never `true`,
 *  nothing moved — because both doubles answer `false` where this library throws. The
 *  SHAPE lives here, next to the identical shapes `putIfAbsent` already has, so the
 *  production implementation is described by something rather than by nothing: until
 *  this file existed, `movePackage` on disk was executed by no test at all. */
describe('role library promotion refusals', () => {
  it('refuses an address that is not an owned package address, touching nothing', async () => {
    const mount = await mkmount()

    mkdirMock.mockClear()
    opendirMock.mockClear()

    // Same refusal `putIfAbsent` makes about the same string, and for the same reason:
    // a manifest NAME is not an address, and a promotion addressed by one would publish
    // a directory this library never minted.
    await expect(libraryAt(mount).movePackage(PROJECT, PERSONAL, 'wanted')).rejects.toBeInstanceOf(
      InvalidSkillPackageError,
    )
    expect(mkdirMock).not.toHaveBeenCalled()
    expect(opendirMock).not.toHaveBeenCalled()
    await expect(entriesOf(mount)).resolves.toEqual([])
  })

  /** Identity is one decision, and a composition root that answers it half-way is
   *  refused at construction — before it has a library to hand anyone. Both halves
   *  answer "which note id is readable at this package address": the bulk projection
   *  for a listing, the exact scope for every capture and mutation. Configure one and
   *  the two answer differently for the same package, silently. */
  it('refuses a composition that projects package identity only half-way', () => {
    const mount = 'unused-by-this-refusal'
    const bulk = async () => new Map<string, string>()
    const scope: WithProjectedRolePackage = async (_space, pkg, expectedRegistryNoteId, task) =>
      task({
        registryNoteId: expectedRegistryNoteId ?? pkg.directoryName,
        filePath: pkg.filePath,
        versionToken: 'registry-version',
      })

    // The bulk listing would speak the host's note ids; every strict path would speak
    // package addresses.
    expect(() =>
      createFsRoleLibrary({
        publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
        rootForSpace: () => mount,
        projectPublishedPackages: bulk,
      }),
    ).toThrow(/one decision/)
    // The mirror image, and the one nothing refused before: the strict paths would
    // speak the host's note ids while the listing kept answering `directoryName`.
    expect(() =>
      createFsRoleLibrary({
        publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
        rootForSpace: () => mount,
        withProjectedRolePackage: scope,
      }),
    ).toThrow(/one decision/)
    // Both halves, or neither, build.
    expect(() =>
      createFsRoleLibrary({
        publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
        rootForSpace: () => mount,
        projectPublishedPackages: bulk,
        withProjectedRolePackage: scope,
      }),
    ).not.toThrow()
    expect(() =>
      createFsRoleLibrary({
        publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
        rootForSpace: () => mount,
      }),
    ).not.toThrow()
  })

  it('refuses two placements that are one, and a move across two spaces', async () => {
    const mount = await mkmount()
    const directoryName = packageDirectoryOf('wanted')

    // Both are caller errors rather than an occupied destination, so neither is the
    // `false` a caller answers by picking another name. Publishing a directory onto
    // itself is not a move; two spaces are two note stores.
    await expect(libraryAt(mount).movePackage(PROJECT, PROJECT, directoryName)).rejects.toThrow(
      /two different placements/,
    )
    await expect(
      libraryAt(mount).movePackage(PROJECT, { ...PERSONAL, space: 'elsewhere' }, directoryName),
    ).rejects.toThrow(/cross spaces/)
  })

  it('hands out no promotion writer, touching nothing, when composition carried no capability', async () => {
    const mount = await mkmount()

    mkdirMock.mockClear()
    opendirMock.mockClear()

    // A deployment that cannot move a pathname atomically has to say so before it
    // touches anything — a promotion has no raceable fallback either. The
    // destination owns the move, so the destination is the placement with no writer.
    await expect(
      compositionPublishingWith(mount, undefined).publication.publicationFor(PERSONAL),
    ).resolves.toBeNull()
    expect(mkdirMock).not.toHaveBeenCalled()
    expect(opendirMock).not.toHaveBeenCalled()
    await expect(entriesOf(mount)).resolves.toEqual([])
  })

  it('keeps the pure refusals inside the promotion writer', async () => {
    const mount = await mkmount()
    const publishing = libraryAt(mount)

    // Address and placement are decided without consulting the medium at all, so a
    // supported host must still refuse both as caller errors — the mirror of the
    // ordering `putIfAbsent` keeps.
    await expect(publishing.movePackage(PROJECT, PERSONAL, 'wanted')).rejects.toBeInstanceOf(
      InvalidSkillPackageError,
    )
    await expect(
      publishing.movePackage(PROJECT, PROJECT, packageDirectoryOf('wanted')),
    ).rejects.toThrow(/two different placements/)
  })

  itAtomicPublish(
    'waits for the placement lease a publication into the same destination holds',
    async () => {
      const mount = await mkmount()
      const pkg = packageOf('wanted', 'Owned.')
      const { authority, library } = admittedLibraryAt(mount)

      await expect(library.putIfAbsent(PROJECT, pkg)).resolves.toBe(true)

      let release: () => void = () => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const asked: string[] = []
      const admitPlacement = authority.admitSkillPlacement.bind(authority)

      vi.spyOn(authority, 'admitSkillPlacement').mockImplementation(async (...args) => {
        const path = args[0]
        const owner = args[2]

        if (owner === 'role-move-placement') {
          asked.push(path)
          await held
        }

        return admitPlacement(...args)
      })
      const move = library.movePackage(PROJECT, PERSONAL, pkg.directoryName)
      const raced = await Promise.race([
        move.then(() => 'moved'),
        new Promise((resolve) => setTimeout(() => resolve('waiting'), 60)),
      ])

      // Personal and a Space root are ONE directory shared by every package in the
      // placement — which is exactly why `putIfAbsent` serialises the name check and
      // the publication on a PLACEMENT-wide lease rather than a per-package one. A
      // promotion publishes into that same directory and owes the same lease; holding
      // only the per-package ones lets a move and a publication both find the manifest
      // name free and both take it.
      expect(raced).toBe('waiting')
      expect(asked).toEqual([`${SKILL_PREFIX}/${pkg.directoryName}/SKILL.md`])
      release()
      await expect(move).resolves.toBe(true)
    },
  )

  itAtomicPublish(
    'holds source and target package admissions through placement finalize',
    async () => {
      const mount = await mkmount()
      const { library } = admittedLibraryAt(mount)
      const pkg = packageOf('wanted', 'Owned.')

      await expect(library.putIfAbsent(PROJECT, pkg)).resolves.toBe(true)
      let entered!: () => void
      const finalizing = new Promise<void>((resolve) => {
        entered = resolve
      })
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const moving = library.movePackage(PROJECT, PERSONAL, pkg.directoryName, async () => {
        entered()
        await held
      })

      await finalizing
      const sourceRead = library.captureExactPackage(PROJECT, pkg.directoryName)
      const targetRead = library.captureExactPackage(PERSONAL, pkg.directoryName)
      const raced = await Promise.race([
        Promise.all([sourceRead, targetRead]).then(() => 'read'),
        new Promise((resolve) => setTimeout(() => resolve('waiting'), 60)),
      ])

      expect(raced).toBe('waiting')
      release()
      await expect(moving).resolves.toBe(true)
      await expect(sourceRead).resolves.toBeNull()
      await expect(targetRead).resolves.toMatchObject({
        pkg: { directoryName: pkg.directoryName },
        registryNoteId: pkg.directoryName,
      })
    },
  )

  itAtomicPublish(
    'rejects a byte-identical new-inode replacement after source observation',
    async () => {
      const mount = await mkmount()
      const registry = new SpaceResourceAuthorityRegistry()
      const compositions = new NotariumStoreCompositionOwner()
      const authority = ensureNotariumResourceAuthority({
        spaceId: PERSONAL.space,
        resourceAuthorityRegistry: registry,
        composition: compositions.getOrCreate(PERSONAL.space, [
          { class: 'skill', dir: mount, prefix: SKILL_PREFIX },
        ]),
      })
      const original = packageOf('wanted', 'Original body.')
      const source = join(projectRoot(mount), original.directoryName)
      const displaced = join(mount, `.externally-displaced-${original.directoryName}.md`)
      let replaced = false
      const moveFor = authority.conditionalDirectoryMoveFor.bind(authority)

      vi.spyOn(authority, 'conditionalDirectoryMoveFor').mockImplementation(
        (sourcePath, targetPath, proofRelativePath) => {
          const view = moveFor(sourcePath, targetPath, proofRelativePath)

          return view
            ? {
                moveIfClaimed: async (expected) => {
                  if (!replaced && sourcePath.includes(original.directoryName)) {
                    replaced = true
                    const manifest = join(source, 'SKILL.md')
                    const bytes = await actualFs.readFile(manifest)

                    await actualFs.rename(manifest, displaced)
                    await actualFs.writeFile(manifest, bytes)
                  }

                  return view.moveIfClaimed(expected)
                },
              }
            : null
        },
      )
      const composition = createFsRoleLibrary({
        publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
        rootForSpace: () => mount,
        resourcePrefixForSpace: () => SKILL_PREFIX,
        authorityForSpace: async () => authority,
      })
      const library = writableLibrary(composition)

      await expect(library.putIfAbsent(PROJECT, original)).resolves.toBe(true)
      const captured = await library.captureExactPackage(PROJECT, original.directoryName)
      const publisher = await composition.publication.publicationFor(PERSONAL)
      const events: string[] = []

      expect(captured).not.toBeNull()
      expect(publisher).not.toBeNull()
      await expect(
        publisher!.moveFrom(PROJECT, original.directoryName, captured!, {
          beforeMove: async () => {
            events.push('before')
          },
          finalize: async () => {
            events.push('finalize')
          },
          rollback: async () => {
            events.push('rollback')
          },
        }),
      ).rejects.toBeInstanceOf(AbilityUnavailableError)

      expect(replaced).toBe(true)
      expect(events).toEqual(['before', 'rollback'])
      await expect(library.getByDirectory(PERSONAL, original.directoryName)).resolves.toBeNull()
      const restored = await library.getByDirectory(PROJECT, original.directoryName)

      expect(restored!.files.get('SKILL.md')).toEqual(original.files.get('SKILL.md'))
      const [oldManifest, replacementManifest] = await Promise.all([
        actualFs.lstat(displaced, { bigint: true }),
        actualFs.lstat(join(source, 'SKILL.md'), { bigint: true }),
      ])

      expect(replacementManifest.ino).not.toBe(oldManifest.ino)
    },
  )

  /** A host whose adapter cannot bind a directory transition to a claim over the
   *  manifest inside it can still RENAME the directory — which is exactly why this is
   *  a refusal and not a fallback. Every other admission is in place here, so falling
   *  through would publish the package at its new home with nothing proving the bytes
   *  that arrived are the bytes that left, and the lifecycle would commit a reach row
   *  and a placement trail around it. The move is refused before the first of the three
   *  durable effects is written. */
  itAtomicPublish('refuses a move no adapter can prove, before anything is written', async () => {
    const mount = await mkmount()
    const { authority, library } = admittedLibraryAt(mount)
    const composition = createFsRoleLibrary({
      publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
      rootForSpace: () => mount,
      resourcePrefixForSpace: () => SKILL_PREFIX,
      authorityForSpace: async () => authority,
    })
    const original = packageOf('wanted', 'Original body.')

    await expect(library.putIfAbsent(PROJECT, original)).resolves.toBe(true)
    const captured = await library.captureExactPackage(PROJECT, original.directoryName)
    const publisher = await composition.publication.publicationFor(PERSONAL)

    expect(captured).not.toBeNull()
    expect(publisher).not.toBeNull()
    // The capability, and only it: the placement and package admissions this move
    // needs are all still granted, so nothing but the proof is missing.
    vi.spyOn(authority, 'conditionalDirectoryMoveFor').mockReturnValue(null)
    const events: string[] = []

    await expect(
      publisher!.moveFrom(PROJECT, original.directoryName, captured!, {
        beforeMove: async () => {
          events.push('before')
        },
        finalize: async () => {
          events.push('finalize')
        },
        rollback: async () => {
          events.push('rollback')
        },
      }),
    ).rejects.toBeInstanceOf(RoleInstallUnavailableError)

    // Refused, not half-done: the lifecycle was never entered, so there is no reach row
    // and no trail to undo…
    expect(events).toEqual([])
    // …and the bytes are where they were, at the placement the caller asked to leave.
    await expect(library.getByDirectory(PERSONAL, original.directoryName)).resolves.toBeNull()
    await expect(library.getByDirectory(PROJECT, original.directoryName)).resolves.toMatchObject({
      directoryName: original.directoryName,
    })
  })

  /** The mirror of that refusal, on the host that has no projection at all. There the
   *  package address is the only identity there is, so the snapshot has to carry the
   *  path the package actually occupies under the library root — a host with no
   *  resource prefix has no prefix to put in front of it, not "no path". The consumer
   *  is real: an owned save compares this path with the note it is about to write. */
  it('addresses a package by its own directory when the host projects nothing', async () => {
    const mount = await mkmount()
    const library = libraryAt(mount)
    const original = packageOf('wanted', 'Original body.')

    await expect(library.putIfAbsent(PERSONAL, original)).resolves.toBe(true)
    await expect(
      library.captureExactPackage(PERSONAL, original.directoryName),
    ).resolves.toMatchObject({ filePath: `${original.directoryName}/SKILL.md` })
  })

  /** …and the composition that passes THAT check and is still incoherent: both halves of
   *  the projection are wired, but the host names no resource prefix for the space, so
   *  there is no address to project a package at. Answering with the bare directory name
   *  would hand the exact scope a path that names nothing, and it would resolve — for
   *  whatever note happens to sit at that path in the host's own coordinates. */
  it('refuses to project a package the host has no resource address for', async () => {
    const scope: WithProjectedRolePackage = async (_space, pkg, expectedRegistryNoteId, task) =>
      task({
        registryNoteId: expectedRegistryNoteId ?? pkg.directoryName,
        filePath: pkg.filePath,
        versionToken: 'registry-version',
      })
    const asked: string[] = []
    const composition = createFsRoleLibrary({
      publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
      rootForSpace: () => 'unused-by-this-refusal',
      // The pair is complete, so construction is allowed — and the space still has no
      // skill mount to address packages inside.
      resourcePrefixForSpace: () => null,
      projectPublishedPackages: async (_space, packages) => {
        asked.push(...packages.map((pkg) => pkg.filePath))
        return new Map<string, string>()
      },
      withProjectedRolePackage: async (space, pkg, expectedRegistryNoteId, task) => {
        asked.push(pkg.filePath)
        return scope(space, pkg, expectedRegistryNoteId, task)
      },
    })

    await expect(
      composition.library.captureExactPackage(PERSONAL, packageDirectoryOf('wanted')),
    ).rejects.toThrow('role library has no projected resource path')
    // Refused before the projection was asked anything: an address it cannot build is
    // not an address it may guess at.
    expect(asked).toEqual([])
  })

  /** A manifest that declares `notarium.skills` and is not a role cannot be resolved as
   *  an ability at all, so the NAME it carries is not a name anything holds. The
   *  destination check has to agree with `manifestIndex`, which already skips such a
   *  package: disagreeing means a role can never be moved to a placement where some
   *  unresolvable package happens to carry its name, and nothing the owner can do from
   *  the outside would ever release it. */
  itAtomicPublish('moves onto a name only an unresolvable manifest carries', async () => {
    const mount = await mkmount()
    const { authority, library } = admittedLibraryAt(mount)
    const composition = createFsRoleLibrary({
      publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
      rootForSpace: () => mount,
      resourcePrefixForSpace: () => SKILL_PREFIX,
      authorityForSpace: async () => authority,
    })
    const linkedDirectory = packageDirectoryOf('wanted-linked')
    const unresolvable: SkillPackage = {
      directoryName: linkedDirectory,
      files: new Map([
        [
          'SKILL.md',
          Buffer.from(
            `---\nnotarium-id: ${linkedDirectory}\nname: wanted\ndescription: wanted.\nmetadata:\n  notarium.skills: linked\n---\n\nUnresolvable.\n`,
          ),
        ],
      ]),
    }
    const original = packageOf('wanted', 'Original body.')

    await expect(library.putIfAbsent(PERSONAL, unresolvable)).resolves.toBe(true)
    await expect(library.putIfAbsent(PROJECT, original)).resolves.toBe(true)
    const captured = await library.captureExactPackage(PROJECT, original.directoryName)
    const publisher = await composition.publication.publicationFor(PERSONAL)

    expect(captured).not.toBeNull()
    expect(publisher).not.toBeNull()
    await expect(
      publisher!.moveFrom(PROJECT, original.directoryName, captured!, {
        beforeMove: async () => undefined,
        finalize: async () => undefined,
        rollback: async () => undefined,
      }),
    ).resolves.toMatchObject({ status: 'moved' })
    await expect(library.getByDirectory(PERSONAL, original.directoryName)).resolves.toMatchObject({
      directoryName: original.directoryName,
    })
  })

  /** The destination walk is bounded, and the bound is not decoration: it is a full
   *  directory scan that reads one manifest per entry, run inside the move's own
   *  admissions. Unbounded, a placement someone filled with entries turns every move
   *  into an unbounded read under a lease the rest of the space queues behind. */
  itAtomicPublish('refuses to walk a destination past its entry bound', async () => {
    const mount = await mkmount()
    const { authority, library } = admittedLibraryAt(mount)
    const composition = createFsRoleLibrary({
      publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
      rootForSpace: () => mount,
      resourcePrefixForSpace: () => SKILL_PREFIX,
      authorityForSpace: async () => authority,
    })
    const original = packageOf('wanted', 'Original body.')

    await expect(library.putIfAbsent(PROJECT, original)).resolves.toBe(true)
    const captured = await library.captureExactPackage(PROJECT, original.directoryName)
    const publisher = await composition.publication.publicationFor(PERSONAL)

    expect(captured).not.toBeNull()
    expect(publisher).not.toBeNull()
    await Promise.all(
      Array.from({ length: 1_025 }, (_, index) =>
        writeFile(join(mount, `filler-${index}.md`), '# filler\n'),
      ),
    )
    const events: string[] = []

    await expect(
      publisher!.moveFrom(PROJECT, original.directoryName, captured!, {
        beforeMove: async () => {
          events.push('before')
        },
        finalize: async () => {
          events.push('finalize')
        },
        rollback: async () => {
          events.push('rollback')
        },
      }),
    ).rejects.toThrow('role library has too many entries')

    // Refused before the lifecycle was entered, so there is nothing to undo.
    expect(events).toEqual([])
  })

  /** The forward transition's own `committed-error`: the package is AT the destination
   *  and the proof that it is the same package is missing. The lifecycle must not be
   *  rolled back for it — the reach row and the placement trail describe where the
   *  bytes are, and the bytes are at the new home — so the caller is handed the marker
   *  that says exactly that instead of the ordinary "the destination was occupied". */
  itAtomicPublish('keeps the lifecycle when the forward move commits without proof', async () => {
    const mount = await mkmount()
    const { authority, library } = admittedLibraryAt(mount)
    const composition = createFsRoleLibrary({
      publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
      rootForSpace: () => mount,
      resourcePrefixForSpace: () => SKILL_PREFIX,
      authorityForSpace: async () => authority,
    })
    const original = packageOf('wanted', 'Original body.')

    await expect(library.putIfAbsent(PROJECT, original)).resolves.toBe(true)
    const captured = await library.captureExactPackage(PROJECT, original.directoryName)
    const publisher = await composition.publication.publicationFor(PERSONAL)

    expect(captured).not.toBeNull()
    expect(publisher).not.toBeNull()
    vi.spyOn(authority, 'conditionalDirectoryMoveFor').mockReturnValue({
      moveIfClaimed: async () => ({
        status: 'committed-error' as const,
        reason: 'directory moved but its claimed source resource did not reach the target',
      }),
    })
    const events: string[] = []
    const failure = await publisher!
      .moveFrom(PROJECT, original.directoryName, captured!, {
        beforeMove: async () => {
          events.push('before')
        },
        finalize: async () => {
          events.push('finalize')
        },
        rollback: async () => {
          events.push('rollback')
        },
      })
      .then(() => null)
      .catch((error: unknown) => error)

    // Not `occupied` — the destination is not held by someone else, it is held by THIS
    // package — and not a plain throw either: the marker is what tells the layer above
    // that the physical transition stayed at its target.
    expect(isRolePackageMoveRollbackError(failure)).toBe(true)
    expect((failure as { cause?: Error }).cause).toBeInstanceOf(AbilityUnavailableError)
    // The adapter's own words survive as the cause's cause, for the operator log; the
    // class itself says only "not found" on the wire.
    expect((failure as { cause?: { cause?: unknown } }).cause?.cause).toContain(
      'did not reach the target',
    )
    // The lifecycle was entered and NOT unwound: a rollback here would clear the reach
    // row of a package that is standing at the placement that row describes.
    expect(events).toEqual(['before'])
  })

  /** The same undo on a host with no resource authority at all, where there is no claim
   *  to move a directory against and the library publishes the pathname itself. The
   *  rollback has to take THAT route rather than the claim-bound one: reading an
   *  authority off a context this host never built is not a stricter check, it is a
   *  crash in the middle of an undo that was about to succeed. */
  itAtomicPublish('undoes a committed move on a host with no resource authority', async () => {
    const mount = await mkmount()
    const composition = createFsRoleLibrary({
      publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
      rootForSpace: () => mount,
    })
    const library = writableLibrary(composition)
    const original = packageOf('wanted', 'Original body.')

    await expect(library.putIfAbsent(PROJECT, original)).resolves.toBe(true)
    const captured = await library.captureExactPackage(PROJECT, original.directoryName)
    const publisher = await composition.publication.publicationFor(PERSONAL)
    const events: string[] = []
    const finalizeFailure = new Error('the placement trail could not be written')

    expect(captured).not.toBeNull()
    expect(publisher).not.toBeNull()
    await expect(
      publisher!.moveFrom(PROJECT, original.directoryName, captured!, {
        beforeMove: async () => {
          events.push('before')
        },
        finalize: async () => {
          events.push('finalize')
          throw finalizeFailure
        },
        rollback: async () => {
          events.push('rollback')
        },
      }),
    ).rejects.toBe(finalizeFailure)

    expect(events).toEqual(['before', 'finalize', 'rollback'])
    await expect(library.getByDirectory(PERSONAL, original.directoryName)).resolves.toBeNull()
    await expect(library.getByDirectory(PROJECT, original.directoryName)).resolves.toMatchObject({
      directoryName: original.directoryName,
    })
  })

  /** The other half of the same rule, and the half that decides what the caller is
   *  told: a reverse transition that did NOT commit leaves the package at its new home,
   *  so the lifecycle must stay exactly as the forward move left it and the answer must
   *  be the marker rather than the failure that started the undo. Rolled back here, the
   *  reach row and the trail would describe the placement the package no longer
   *  occupies, and the caller would be told the move simply failed. */
  itAtomicPublish('keeps the lifecycle when the reverse move does not commit', async () => {
    const mount = await mkmount()
    const { authority, library } = admittedLibraryAt(mount)
    const composition = createFsRoleLibrary({
      publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
      rootForSpace: () => mount,
      resourcePrefixForSpace: () => SKILL_PREFIX,
      authorityForSpace: async () => authority,
    })
    const original = packageOf('wanted', 'Original body.')
    const moveFor = authority.conditionalDirectoryMoveFor.bind(authority)
    const resolved: Array<[string, string]> = []

    vi.spyOn(authority, 'conditionalDirectoryMoveFor').mockImplementation(
      (sourcePath, targetPath, proofRelativePath) => {
        const view = moveFor(sourcePath, targetPath, proofRelativePath)

        if (!view) {
          return null
        }
        const forward = resolved[0]
        const reverse = forward?.[0] === targetPath && forward[1] === sourcePath

        resolved.push([sourcePath, targetPath])

        return {
          moveIfClaimed: async (expected) =>
            // The source pathname is held by something else now, so the package cannot
            // come home — the one outcome of a reverse move that leaves it where it is.
            reverse ? { status: 'occupied' as const } : view.moveIfClaimed(expected),
        }
      },
    )

    await expect(library.putIfAbsent(PROJECT, original)).resolves.toBe(true)
    const captured = await library.captureExactPackage(PROJECT, original.directoryName)
    const publisher = await composition.publication.publicationFor(PERSONAL)
    const events: string[] = []
    const finalizeFailure = new Error('the placement trail could not be written')

    expect(captured).not.toBeNull()
    expect(publisher).not.toBeNull()
    const failure = await publisher!
      .moveFrom(PROJECT, original.directoryName, captured!, {
        beforeMove: async () => {
          events.push('before')
        },
        finalize: async () => {
          events.push('finalize')
          throw finalizeFailure
        },
        rollback: async () => {
          events.push('rollback')
        },
      })
      .then(() => null)
      .catch((error: unknown) => error)

    expect(isRolePackageMoveRollbackError(failure)).toBe(true)
    expect((failure as { cause?: unknown }).cause).toBe(finalizeFailure)
    expect(events).toEqual(['before', 'finalize'])
    expect(resolved).toHaveLength(2)
    // The package really is at the new home, which is what the marker claims.
    await expect(library.getByDirectory(PERSONAL, original.directoryName)).resolves.toMatchObject({
      directoryName: original.directoryName,
    })
    await expect(library.getByDirectory(PROJECT, original.directoryName)).resolves.toBeNull()
  })

  /** `committed-error` is DIRECTIONAL: it says the transition the call requested is
   *  still at that call's target. Raised by the REVERSE move, that target is the
   *  placement the package came from — so the bytes are home and only the proof of it
   *  failed. Read as "not restored", the rollback is skipped and the lifecycle keeps
   *  describing a home the package no longer occupies, while the marker tells the layer
   *  above that the undo was impossible. The physical fact and the report would then
   *  disagree, which is the one thing this protocol exists to prevent. */
  itAtomicPublish(
    'rolls the lifecycle back when the reverse move lands without proof',
    async () => {
      const mount = await mkmount()
      const registry = new SpaceResourceAuthorityRegistry()
      const compositions = new NotariumStoreCompositionOwner()
      const authority = ensureNotariumResourceAuthority({
        spaceId: PERSONAL.space,
        resourceAuthorityRegistry: registry,
        composition: compositions.getOrCreate(PERSONAL.space, [
          { class: 'skill', dir: mount, prefix: SKILL_PREFIX },
        ]),
      })
      const original = packageOf('wanted', 'Original body.')
      const moveFor = authority.conditionalDirectoryMoveFor.bind(authority)
      const resolved: Array<[string, string]> = []

      vi.spyOn(authority, 'conditionalDirectoryMoveFor').mockImplementation(
        (sourcePath, targetPath, proofRelativePath) => {
          const view = moveFor(sourcePath, targetPath, proofRelativePath)

          if (!view) {
            return null
          }
          // The reverse transition is the one whose ends are the forward move's, swapped
          // — named by its addresses rather than by call order, because what makes the
          // result directional is which placement it commits AT.
          const forward = resolved[0]
          const reverse = forward?.[0] === targetPath && forward[1] === sourcePath

          resolved.push([sourcePath, targetPath])

          return {
            moveIfClaimed: async (expected) => {
              const result = await view.moveIfClaimed(expected)

              // The directory transition really happened; only the claim that proves the
              // carried resource is the same one could not be minted at the target.
              return reverse && result.status === 'moved'
                ? ({
                    status: 'committed-error',
                    reason:
                      'directory moved but its claimed source resource did not reach the target',
                  } as const)
                : result
            },
          }
        },
      )
      const composition = createFsRoleLibrary({
        publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
        rootForSpace: () => mount,
        resourcePrefixForSpace: () => SKILL_PREFIX,
        authorityForSpace: async () => authority,
      })
      const library = writableLibrary(composition)

      await expect(library.putIfAbsent(PROJECT, original)).resolves.toBe(true)
      const captured = await library.captureExactPackage(PROJECT, original.directoryName)
      const publisher = await composition.publication.publicationFor(PERSONAL)
      const events: string[] = []
      const finalizeFailure = new Error('the placement trail could not be written')

      expect(captured).not.toBeNull()
      expect(publisher).not.toBeNull()
      await expect(
        publisher!.moveFrom(PROJECT, original.directoryName, captured!, {
          beforeMove: async () => {
            events.push('before')
          },
          finalize: async () => {
            events.push('finalize')
            throw finalizeFailure
          },
          rollback: async () => {
            events.push('rollback')
          },
        }),
        // The caller gets the failure it actually suffered, not the marker that names an
        // undo which did not happen — the marker is reserved for a package left at the
        // destination, and this one is not.
      ).rejects.toBe(finalizeFailure)

      expect(events).toEqual(['before', 'finalize', 'rollback'])
      expect(resolved).toHaveLength(2)
      // …and the physical fact the answer rests on: the bytes came home.
      await expect(library.getByDirectory(PERSONAL, original.directoryName)).resolves.toBeNull()
      await expect(library.getByDirectory(PROJECT, original.directoryName)).resolves.toMatchObject({
        directoryName: original.directoryName,
      })
    },
  )

  itAtomicPublish('keeps an identity-bound mutation admitted through its callback', async () => {
    const mount = await mkmount()
    const { library } = admittedLibraryAt(mount)
    const pkg = packageOf('wanted', 'Owned.')

    await expect(library.putIfAbsent(PROJECT, pkg)).resolves.toBe(true)
    let entered!: () => void
    const admitted = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const target = await library.captureExactPackage(PROJECT, pkg.directoryName)

    expect(target).not.toBeNull()
    const mutation = library.withExactPackageMutation(
      PROJECT,
      pkg.directoryName,
      target!,
      async (snapshot) => {
        expect(snapshot).toMatchObject({ pkg: { directoryName: pkg.directoryName } })
        entered()
        await held
        return true
      },
    )

    await admitted
    const moving = library.movePackage(PROJECT, PERSONAL, pkg.directoryName)
    const raced = await Promise.race([
      moving.then(() => 'moved'),
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 60)),
    ])

    expect(raced).toBe('waiting')
    release()
    await expect(mutation).resolves.toBe(true)
    await expect(moving).resolves.toBe(true)
  })

  itAtomicPublish(
    'enters the Core projection scope before every exact package admission',
    async () => {
      const mount = await mkmount()
      const registry = new SpaceResourceAuthorityRegistry()
      const compositions = new NotariumStoreCompositionOwner()
      const authority = ensureNotariumResourceAuthority({
        spaceId: PERSONAL.space,
        resourceAuthorityRegistry: registry,
        composition: compositions.getOrCreate(PERSONAL.space, [
          { class: 'skill', dir: mount, prefix: SKILL_PREFIX },
        ]),
      })
      const events: string[] = []

      const withProjectedRolePackage: WithProjectedRolePackage = async (
        _space,
        pkg,
        expectedRegistryNoteId,
        task,
      ) => {
        events.push('core:enter')
        try {
          return await task({
            registryNoteId: expectedRegistryNoteId ?? pkg.directoryName,
            filePath: pkg.filePath,
            versionToken: 'registry-version',
          })
        } finally {
          events.push('core:exit')
        }
      }
      const bulkProjection = vi.fn(
        async (_space, packages: readonly { directoryName: string }[]) =>
          new Map(packages.map((pkg) => [pkg.directoryName, pkg.directoryName])),
      )
      const composition = createFsRoleLibrary({
        publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
        rootForSpace: () => mount,
        resourcePrefixForSpace: () => SKILL_PREFIX,
        authorityForSpace: async () => authority,
        projectPublishedPackages: bulkProjection,
        withProjectedRolePackage,
      })
      const library = writableLibrary(composition)
      const pkg = packageOf('wanted', 'Owned.')

      await library.putIfAbsent(PROJECT, pkg)
      // A sibling already living at the DESTINATION placement. The move has to decide
      // whether its manifest name is free, and this is the package that answer has to
      // look at — so it is also the package a name check done through the ordinary
      // observation path would take a nested shared lease on.
      await library.putIfAbsent(PERSONAL, packageOf('resident', 'Already here.'))
      // Which placement each lease is TAKEN ON, not just in which mode. The move holds
      // one exclusive lease per side and the order between them is what stops two
      // opposite moves of one package from holding each other's half — an order a
      // record of modes alone cannot tell apart from its own reverse.
      const placementOf = (resourcePath: string): string =>
        resourcePath.includes('/_projects/') ? 'project' : 'personal'
      const originalPackageAdmission = authority.admitPackage.bind(authority)
      const admitPackage = vi.spyOn(authority, 'admitPackage')
      admitPackage.mockImplementation(async (...args) => {
        events.push(`package:${placementOf(args[0])}:${args[1]}`)
        return originalPackageAdmission(...args)
      })
      const originalPlacementAdmission = authority.admitSkillPlacement.bind(authority)
      const admitPlacement = vi.spyOn(authority, 'admitSkillPlacement')
      admitPlacement.mockImplementation(async (...args) => {
        events.push(`placement:${placementOf(args[0])}:${args[1]}`)
        return originalPlacementAdmission(...args)
      })

      const captured = await library.captureExactPackage(PROJECT, pkg.directoryName)

      expect(captured).not.toBeNull()
      expect(events).toEqual(['core:enter', 'package:project:shared', 'core:exit'])
      expect(bulkProjection).not.toHaveBeenCalled()

      events.length = 0
      await library.withExactPackageMutation(PROJECT, pkg.directoryName, captured!, async () => {
        events.push('task')
      })
      expect(events).toEqual([
        'core:enter',
        'placement:project:exclusive',
        'package:project:exclusive',
        'task',
        'core:exit',
      ])
      expect(bulkProjection).not.toHaveBeenCalled()

      events.length = 0
      await library.readableNoteIds(PROJECT, [pkg.directoryName])
      expect(events).toEqual([])
      expect(bulkProjection).toHaveBeenCalledOnce()

      events.length = 0
      bulkProjection.mockClear()
      const publication = await composition.publication.publicationFor(PERSONAL)
      const moved = await publication!.moveFrom(PROJECT, pkg.directoryName, captured!, {
        beforeMove: async () => {
          events.push('before-move')
        },
        finalize: async () => {
          events.push('finalize')
        },
        rollback: async () => {
          events.push('rollback')
        },
      })

      expect(moved.status).toBe('moved')
      expect(events).toEqual([
        'core:enter',
        // Destination first, then source — the fixed order, by address.
        'placement:personal:exclusive',
        'package:personal:exclusive',
        'package:project:exclusive',
        'before-move',
        'finalize',
        'core:exit',
      ])
      // …and NOTHING for the resident sibling. The destination name check reads sibling
      // manifests directly under the placement lease, exactly as publication does; a
      // check routed through the ordinary observation path would add one shared package
      // lease per sibling on top of the three exclusives this move already holds.
      expect(events.filter((event) => event.endsWith(':shared'))).toEqual([])
      expect(bulkProjection).not.toHaveBeenCalled()
    },
  )

  itAtomicPublish('rolls a finalize failure back before releasing either package', async () => {
    const mount = await mkmount()
    const { library } = admittedLibraryAt(mount)
    const pkg = packageOf('wanted', 'Owned.')
    const failure = new Error('placement metadata unavailable')
    const rolledBack: string[] = []

    await expect(library.putIfAbsent(PROJECT, pkg)).resolves.toBe(true)
    await expect(
      library.movePackage(
        PROJECT,
        PERSONAL,
        pkg.directoryName,
        async () => {
          throw failure
        },
        async () => {
          // Observed from INSIDE the hook, while both packages are still admitted:
          // the caller's undo has to see the bytes back at the source, or it would be
          // restoring state that describes a placement the package has not returned to.
          // Read through the raw filesystem, not the library — asking the library here
          // would queue behind the very package admissions this move still holds.
          rolledBack.push(
            await actualFs
              .lstat(join(projectRoot(mount), pkg.directoryName, 'SKILL.md'))
              .then(() => 'at-source')
              .catch(() => 'elsewhere'),
          )
        },
      ),
    ).rejects.toBe(failure)
    await expect(library.getByDirectory(PROJECT, pkg.directoryName)).resolves.not.toBeNull()
    await expect(library.getByDirectory(PERSONAL, pkg.directoryName)).resolves.toBeNull()
    // The bytes alone do not close this: the caller wrote reach BEFORE the move and
    // undoes it here. Without the hook the package is at its source with a reach that
    // narrows it to a project it never left.
    expect(rolledBack).toEqual(['at-source'])
  })

  itAtomicPublish(
    'refuses a destination name held by something that is not a package',
    async () => {
      const mount = await mkmount()
      const library = libraryAt(mount)
      const pkg = packageOf('wanted', 'Owned.')

      await expect(library.putIfAbsent(PROJECT, pkg)).resolves.toBe(true)
      // A bare file wearing the manifest name. It has no in-memory representation at all,
      // which is exactly why this case cannot live in the shared contract — and it is the
      // ordinary state of a mount a user also edits by hand.
      const occupant = join(mount, 'wanted')

      await writeFile(occupant, 'not a package')
      const before = await fingerprint(occupant)

      await expect(library.movePackage(PROJECT, PERSONAL, pkg.directoryName)).resolves.toBe(false)
      await expect(fingerprint(occupant)).resolves.toBe(before)
      // Refused, so the version is still the version: still in its project, and no
      // half-published directory at the destination.
      await expect(library.getByDirectory(PROJECT, pkg.directoryName)).resolves.not.toBeNull()
      await expect(entriesOf(mount)).resolves.toEqual(['_projects', 'wanted'])
    },
  )

  /** The OTHER refusal, and a different code path from the one above: the manifest
   *  NAME is free, so the move commits to the transition and only the publication of
   *  the package pathname fails. `beforeMove` has already run by then — the caller has
   *  durable state on the destination — so this branch owes it the same undo a failed
   *  finalize does. */
  itAtomicPublish('rolls back when the destination package address is taken', async () => {
    const mount = await mkmount()
    const library = libraryAt(mount)
    const pkg = packageOf('wanted', 'Owned.')
    const rolledBack: string[] = []

    await expect(library.putIfAbsent(PROJECT, pkg)).resolves.toBe(true)
    // The package ADDRESS, not its manifest name: the name check passes (this
    // directory carries no SKILL.md, so no manifest index sees it) and the atomic
    // publication of the pathname is what refuses.
    await mkdir(join(mount, pkg.directoryName))
    await writeFile(join(mount, pkg.directoryName, 'stranger.md'), 'not ours')

    await expect(
      library.movePackage(PROJECT, PERSONAL, pkg.directoryName, undefined, async () => {
        rolledBack.push('rollback')
      }),
    ).resolves.toBe(false)
    expect(rolledBack).toEqual(['rollback'])
    await expect(library.getByDirectory(PROJECT, pkg.directoryName)).resolves.not.toBeNull()
    await expect(readFile(join(mount, pkg.directoryName, 'stranger.md'), 'utf8')).resolves.toBe(
      'not ours',
    )
  })

  /** The dual identity of a captured package, taken apart one member at a time. The
   *  package stays exactly where the capture found it and keeps its address — what
   *  changes is what its manifest CLAIMS: the note it is, or the ability kind it
   *  declares. Both are ordinary states of a mount a user also edits by hand, and
   *  both are invisible to the registry side: the id a strict caller carries is the
   *  id it selected its note by, so only the manifest read under admission can see
   *  that the two identities came apart. */
  const RECLAIMED: [string, string, Record<string, unknown>][] = [
    [
      'a manifest that now claims another note',
      `notarium-id: ${packageDirectoryOf('other')}\nname: wanted\ndescription: wanted.`,
      { kind: 'skill', manifestNoteId: packageDirectoryOf('other') },
    ],
    [
      'a manifest that now declares another kind',
      `notarium-id: ${packageDirectoryOf('wanted')}\nname: wanted\ndescription: wanted.\nmetadata:\n  notarium.kind: role`,
      { kind: 'role', manifestNoteId: packageDirectoryOf('wanted') },
    ],
  ]

  for (const [label, frontmatter, reclaimed] of RECLAIMED) {
    /** One published package, one target captured before the rewrite, and the state
     *  the rewrite actually produced — asserted, so each case moves exactly ONE
     *  member of the identity and stands on that member alone. */
    const capturedBeforeRewrite = async () => {
      const mount = await mkmount()
      const { library } = admittedLibraryAt(mount)
      const pkg = packageOf('wanted', 'Owned.')

      await expect(library.putIfAbsent(PROJECT, pkg)).resolves.toBe(true)
      const captured = await library.captureExactPackage(PROJECT, pkg.directoryName)

      expect(captured).toMatchObject({
        kind: 'skill',
        registryNoteId: pkg.directoryName,
        manifestNoteId: pkg.directoryName,
      })
      await writeFile(
        join(projectRoot(mount), pkg.directoryName, 'SKILL.md'),
        `---\n${frontmatter}\n---\n\nRewritten outside the port.\n`,
      )
      await expect(library.captureExactPackage(PROJECT, pkg.directoryName)).resolves.toMatchObject({
        registryNoteId: pkg.directoryName,
        ...reclaimed,
      })

      return { captured: captured!, library, pkg }
    }

    itAtomicPublish(`refuses an exact mutation against ${label}`, async () => {
      const { captured, library, pkg } = await capturedBeforeRewrite()
      const task = vi.fn(async () => 'ran')

      // `null`, and the callback never ran: a mutation admitted on a captured
      // identity may not act on a package that is no longer that identity.
      await expect(
        library.withExactPackageMutation(PROJECT, pkg.directoryName, captured, task),
      ).resolves.toBeNull()
      expect(task).not.toHaveBeenCalled()
    })

    itAtomicPublish(`refuses a move against ${label}`, async () => {
      const { captured, library, pkg } = await capturedBeforeRewrite()
      const finalize = vi.fn(async () => undefined)
      const rollback = vi.fn(async () => undefined)

      // The move carries the target its caller captured EARLIER — production writes
      // a reach row and a placement trail in between — so the identity it revalidates
      // is an observation of the past, not of this instant.
      await expect(
        library.movePackage(PROJECT, PERSONAL, pkg.directoryName, finalize, rollback, captured),
      ).rejects.toBeInstanceOf(AbilityUnavailableError)
      // Refused before the transition, so there is nothing to undo and no lifecycle
      // hook may have run: the caller's durable state is still the source's.
      expect(finalize).not.toHaveBeenCalled()
      expect(rollback).not.toHaveBeenCalled()
      await expect(library.getByDirectory(PERSONAL, pkg.directoryName)).resolves.toBeNull()
      await expect(library.getByDirectory(PROJECT, pkg.directoryName)).resolves.not.toBeNull()
    })
  }
})

describeAtomicPublish('filesystem role library publication', () => {
  const OCCUPANTS: [string, (path: string) => Promise<void>][] = [
    ['an empty directory', async (path) => await mkdir(path)],
    [
      'a populated directory',
      async (path) => {
        await mkdir(path)
        await writeFile(join(path, 'SKILL.md'), 'foreign package')
        await writeFile(join(path, 'resource.bin'), Buffer.from([0, 1, 2, 255]))
      },
    ],
    [
      'a directory without SKILL.md',
      async (path) => {
        await mkdir(path)
        await writeFile(join(path, 'notes.md'), 'not a package')
      },
    ],
    ['a regular file', async (path) => await writeFile(path, 'foreign file')],
    [
      'a symlink to a directory',
      async (path) => {
        await mkdir(`${path}-elsewhere`)
        await symlink(`${path}-elsewhere`, path)
      },
    ],
    ['a dangling symlink', async (path) => await symlink(`${path}-nowhere`, path)],
  ]

  it.each(OCCUPANTS)('refuses %s without touching it', async (_label, create) => {
    const mount = await mkmount()
    const target = join(mount, packageDirectoryOf('wanted'))

    await create(target)
    const before = await fingerprint(target)

    await expect(
      libraryAt(mount).putIfAbsent(PERSONAL, packageOf('wanted', 'Owned.')),
    ).resolves.toBe(false)
    await expect(fingerprint(target)).resolves.toBe(before)
  })

  it('lets exactly one of three racing processes claim a free name', async () => {
    const mount = await mkmount()
    const moduleUrl = new URL(
      '../../packages/server/src/services/roles/library.ts',
      import.meta.url,
    ).href
    const membersOf = (marker: string): [string, string][] => [
      ['SKILL.md', `---\nname: wanted\ndescription: wanted.\n---\n\n${marker}`],
      ['references/guide.md', `# wanted\n\n${marker}\n`],
    ]
    const child = (marker: string) => `
      import { renameNoReplaceIfAvailable } from '@notarium/engine'
      import { createFsRoleLibrary } from ${JSON.stringify(moduleUrl)}

      const { publication } = createFsRoleLibrary({
        publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
        rootForSpace: () => ${JSON.stringify(mount)},
      })
      const writer = await publication.publicationFor({ scope: 'personal', space: 'personal' })
      const added = await writer.putIfAbsent(
        {
          directoryName: ${JSON.stringify(packageDirectoryOf('wanted'))},
          files: new Map(
            ${JSON.stringify(membersOf(marker))}.map(([name, content]) => [name, Buffer.from(content)]),
          ),
        },
      )
      process.stdout.write(added ? 'WON' : 'LOST')
    `
    const markers = ['alpha', 'beta', 'gamma']
    const outcomes = await Promise.all(
      markers.map(async (marker) => {
        const { stdout } = await execFileAsync(process.execPath, [
          '--import',
          'tsx',
          '--input-type=module',
          '--eval',
          child(marker),
        ])

        return stdout.trim()
      }),
    )

    expect(outcomes).toHaveLength(3)
    expect(outcomes.filter((outcome) => outcome === 'WON')).toEqual(['WON'])
    const winner = outcomes.indexOf('WON')
    const published = await libraryAt(mount).get(PERSONAL, 'wanted')

    expect(winner).toBeGreaterThanOrEqual(0)
    expect(
      [...published!.files]
        .map(([name, content]) => [name, Buffer.from(content).toString()] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    ).toEqual(membersOf(markers[winner]!).sort(([left], [right]) => left.localeCompare(right)))
    // The losers neither replaced the winner's package nor left staging behind.
    await expect(entriesOf(mount)).resolves.toEqual([packageDirectoryOf('wanted')])
  }, 15_000)

  it('leaves no staging of its own behind, after a success and after a conflict', async () => {
    const mount = await mkmount()
    const library = libraryAt(mount)

    await expect(library.putIfAbsent(PERSONAL, packageOf('wanted', 'Owned.'))).resolves.toBe(true)
    await expect(entriesOf(mount)).resolves.toEqual([packageDirectoryOf('wanted')])
    await expect(library.putIfAbsent(PERSONAL, packageOf('wanted', 'Second.'))).resolves.toBe(false)
    await expect(entriesOf(mount)).resolves.toEqual([packageDirectoryOf('wanted')])
  })

  it('rejects a name conflict before creating publication staging', async () => {
    const mount = await mkmount()
    const library = libraryAt(mount)

    await library.putIfAbsent(PERSONAL, packageOf('wanted', 'Occupant.'))
    rmMock.mockClear()
    rmMock.mockRejectedValueOnce(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
    )

    await expect(library.putIfAbsent(PERSONAL, packageOf('wanted', 'Second.'))).resolves.toBe(false)
    await expect(
      readFile(join(mount, packageDirectoryOf('wanted'), 'SKILL.md'), 'utf8'),
    ).resolves.toContain('Occupant.')
    expect(rmMock).not.toHaveBeenCalled()
    await expect(entriesOf(mount)).resolves.toEqual([packageDirectoryOf('wanted')])
    rmMock.mockReset()
    rmMock.mockImplementation(actualFs.rm)
    await expect(library.putIfAbsent(PERSONAL, packageOf('second', 'Owned.'))).resolves.toBe(true)
  })

  it('reports an injected conflict as `false` and sweeps its own staging', async () => {
    const mount = await mkmount()
    const occupant = packageOf('wanted', 'Occupant.')
    const directoryName = packageDirectoryOf('wanted')

    await expect(libraryAt(mount).putIfAbsent(PERSONAL, occupant)).resolves.toBe(true)
    const before = await fingerprint(join(mount, directoryName))

    await expect(
      libraryPublishingWith(mount, async () => false).putIfAbsent(
        PERSONAL,
        packageOf('wanted', 'Second.'),
      ),
    ).resolves.toBe(false)
    await expect(fingerprint(join(mount, directoryName))).resolves.toBe(before)
    await expect(entriesOf(mount)).resolves.toEqual([directoryName])
  })

  it('publishes into a space whose library root does not exist yet', async () => {
    const mount = await mkmount()

    await rm(mount, { recursive: true, force: true })
    await expect(
      libraryAt(mount).putIfAbsent(PERSONAL, packageOf('wanted', 'Owned.')),
    ).resolves.toBe(true)
  })

  it.each([
    [
      'reserved _projects namespace',
      async (mount: string, outside: string) => {
        await symlink(outside, join(mount, '_projects'))
        const root = projectRoot(outside)

        await mkdir(root, { recursive: true })
        return root
      },
    ],
    [
      'project root',
      async (mount: string, outside: string) => {
        await mkdir(join(mount, '_projects'))
        await symlink(outside, projectRoot(mount))
        return outside
      },
    ],
  ] as const)('fails closed when the library-owned %s is a symlink', async (_label, redirect) => {
    const mount = await mkmount()
    const outside = await mkmount()
    const redirectedRoot = await redirect(mount, outside)

    await orphanStaging(redirectedRoot, 2 * STALE_MS)
    const before = await fingerprint(outside)

    await expect(
      libraryAt(mount).putIfAbsent(PROJECT, packageOf('wanted', 'Owned.')),
    ).rejects.toThrow('role library path must be a real directory')
    await expect(fingerprint(outside)).resolves.toBe(before)
  })

  it.each([
    [
      'reserved _projects namespace',
      async (mount: string) => {
        const path = join(mount, '_projects')

        await writeFile(path, 'foreign')
        return path
      },
    ],
    [
      'project root',
      async (mount: string) => {
        const path = projectRoot(mount)

        await mkdir(join(mount, '_projects'))
        await writeFile(path, 'foreign')
        return path
      },
    ],
  ] as const)(
    'fails closed when the library-owned %s is not a directory',
    async (_label, setup) => {
      const mount = await mkmount()
      const path = await setup(mount)
      const before = await fingerprint(path)

      await expect(
        libraryAt(mount).putIfAbsent(PROJECT, packageOf('wanted', 'Owned.')),
      ).rejects.toThrow('role library path must be a real directory')
      await expect(fingerprint(path)).resolves.toBe(before)
    },
  )

  it('allows the configured mount itself to be a symlink', async () => {
    const realMount = await mkmount()
    const holder = await mkmount()
    const configuredMount = join(holder, 'configured-mount')

    await symlink(realMount, configuredMount)
    await expect(
      libraryAt(configuredMount).putIfAbsent(PROJECT, packageOf('wanted', 'Owned.')),
    ).resolves.toBe(true)
    await expect(
      readFile(join(projectRoot(realMount), packageDirectoryOf('wanted'), 'SKILL.md'), 'utf8'),
    ).resolves.toContain('Owned.')
  })

  it('publishes even when the staging sweep fails outright', async () => {
    const mount = await mkmount()

    opendirMock.mockRejectedValueOnce(Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }))
    await expect(
      libraryAt(mount).putIfAbsent(PERSONAL, packageOf('wanted', 'Owned.')),
    ).resolves.toBe(true)
  })

  describe.each([
    ['personal', PERSONAL, (mount: string) => mount],
    ['project', PROJECT, projectRoot],
  ] as const)('staging reclaim in %s scope', (_scope, location, rootOf) => {
    it('removes an orphan past the threshold and spares a young one', async () => {
      const mount = await mkmount()
      const root = rootOf(mount)

      await mkdir(root, { recursive: true })
      const stale = await orphanStaging(root, 2 * STALE_MS)
      const young = await orphanStaging(root, 0)

      await expect(
        libraryAt(mount).putIfAbsent(location, packageOf('wanted', 'Owned.')),
      ).resolves.toBe(true)
      await expect(lstat(stale)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(lstat(young)).resolves.toMatchObject({})
    })

    it('never reaches published packages, sibling data or a reserved namespace', async () => {
      const mount = await mkmount()
      const root = rootOf(mount)
      const wantedDirectory = packageDirectoryOf('wanted')
      const otherDirectory = packageDirectoryOf('other')

      await mkdir(join(root, wantedDirectory, 'assets'), { recursive: true })
      await writeFile(join(root, wantedDirectory, 'SKILL.md'), 'published')
      await mkdir(join(root, 'not-a-package'), { recursive: true })
      await mkdir(join(root, '_projects', 'cHJvamVjdC1i'), { recursive: true })
      const twin = await orphanStaging(join(root, wantedDirectory, 'assets'), 2 * STALE_MS)
      const stagedFile = join(root, `.${wantedDirectory}.install-${randomUUID()}`)
      const stagedLink = join(root, `.${otherDirectory}.install-${randomUUID()}`)

      await writeFile(stagedFile, 'authored')
      await symlink(join(root, wantedDirectory), stagedLink)
      const stale = new Date(Date.now() - 2 * STALE_MS)

      await utimes(stagedFile, stale, stale)
      await lutimes(stagedLink, stale, stale)
      const before = new Map<string, string>()

      for (const entry of await entriesOf(root)) {
        before.set(entry, await fingerprint(join(root, entry)))
      }

      await expect(
        libraryAt(mount).putIfAbsent(location, packageOf('other', 'Owned.')),
      ).resolves.toBe(true)

      // Everything that was there is still there, byte for byte and inode for
      // inode; the only new entry is the package just published.
      for (const [entry, print] of before) {
        await expect(fingerprint(join(root, entry))).resolves.toBe(print)
      }
      expect(await entriesOf(root)).toEqual([...before.keys(), otherDirectory].sort())
      await expect(lstat(twin)).resolves.toMatchObject({})
      await expect(readFile(stagedFile, 'utf8')).resolves.toBe('authored')
      await expect(readlink(stagedLink)).resolves.toBe(join(root, wantedDirectory))
    })

    it.each([
      ['regular file', async (path: string) => await actualFs.writeFile(path, 'authored')],
      [
        'symlink',
        async (path: string, root: string) =>
          await actualFs.symlink(join(root, packageDirectoryOf('wanted')), path),
      ],
    ] as const)('keeps a %s that replaces a directory after opendir', async (_kind, replace) => {
      const mount = await mkmount()
      const root = rootOf(mount)

      await mkdir(root, { recursive: true })
      const candidate = await orphanStaging(root, 2 * STALE_MS)
      let replacementFingerprint: string | undefined
      let replaced = false

      lstatMock.mockImplementation(async (path) => {
        if (path !== candidate || replaced) {
          return actualFs.lstat(path)
        }
        replaced = true
        await actualFs.rm(candidate, { recursive: true })
        await replace(candidate, root)
        const stale = new Date(Date.now() - 2 * STALE_MS)
        const info = await actualFs.lstat(candidate)

        if (info.isSymbolicLink()) {
          await actualFs.lutimes(candidate, stale, stale)
        } else {
          await actualFs.utimes(candidate, stale, stale)
        }
        replacementFingerprint = await fingerprint(candidate)
        return actualFs.lstat(candidate)
      })

      await expect(
        libraryAt(mount).putIfAbsent(location, packageOf('other', 'Owned.')),
      ).resolves.toBe(true)
      expect(replacementFingerprint).toBeDefined()
      await expect(fingerprint(candidate)).resolves.toBe(replacementFingerprint)
    })
  })

  it('caches a clean root only until newly-created staging could be stale', async () => {
    const mount = await mkmount()
    const library = libraryAt(mount)
    const now = Date.now()

    vi.spyOn(Date, 'now').mockReturnValue(now)

    await expect(library.putIfAbsent(PERSONAL, packageOf('first', 'Owned.'))).resolves.toBe(true)
    const stale = await orphanStaging(mount, 2 * STALE_MS)

    await expect(library.putIfAbsent(PERSONAL, packageOf('second', 'Owned.'))).resolves.toBe(true)
    await expect(lstat(stale)).resolves.toMatchObject({})

    vi.mocked(Date.now).mockReturnValue(now + STALE_MS + 1)
    await expect(library.putIfAbsent(PERSONAL, packageOf('third', 'Owned.'))).resolves.toBe(true)
    await expect(lstat(stale)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('walks again while a young orphan is still lying in the root', async () => {
    const mount = await mkmount()
    const library = libraryAt(mount)
    const young = await orphanStaging(mount, 0)

    await expect(library.putIfAbsent(PERSONAL, packageOf('first', 'Owned.'))).resolves.toBe(true)
    await expect(lstat(young)).resolves.toMatchObject({})

    const aged = new Date(Date.now() - 2 * STALE_MS)

    await utimes(young, aged, aged)
    await expect(library.putIfAbsent(PERSONAL, packageOf('second', 'Owned.'))).resolves.toBe(true)
    await expect(lstat(young)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  const itUnprivileged = unprivileged ? it : it.skip

  itUnprivileged(
    `keeps reclaiming past an entry it cannot remove${unprivileged ? '' : ` ${UNPRIVILEGED_GATE}`}`,
    async () => {
      const mount = await mkmount()
      const stuck = await orphanStaging(mount, 0, 'stuck')

      await mkdir(join(stuck, 'locked'))
      await writeFile(join(stuck, 'locked', 'held'), 'held')
      await chmod(join(stuck, 'locked'), 0o500)
      const stale = new Date(Date.now() - 2 * STALE_MS)

      await utimes(stuck, stale, stale)
      const removable = await orphanStaging(mount, 2 * STALE_MS)
      const directory = await actualFs.opendir(mount)
      const entries = []

      for await (const entry of directory) {
        entries.push(entry)
      }
      const stuckName = stuck.slice(mount.length + 1)
      const removableName = removable.slice(mount.length + 1)
      const ordered = [
        entries.find((entry) => entry.name === stuckName)!,
        entries.find((entry) => entry.name === removableName)!,
      ]

      // Prove the causal branch: an entry fails first, then a later one is still
      // reclaimed. Native directory order cannot establish that sequence.
      opendirMock.mockResolvedValueOnce({
        async *[Symbol.asyncIterator]() {
          yield* ordered
        },
      } as never)

      try {
        await expect(
          libraryAt(mount).putIfAbsent(PERSONAL, packageOf('wanted', 'Owned.')),
        ).resolves.toBe(true)
        await expect(lstat(removable)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(lstat(stuck)).resolves.toMatchObject({})
      } finally {
        await chmod(join(stuck, 'locked'), 0o700)
      }
    },
  )
})
