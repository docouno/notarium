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

import { renameNoReplaceIfAvailable } from '@notarium/engine'
import {
  createFsRoleLibrary,
  type PublishDirectoryIfAbsent,
  type RoleLocation,
} from '../../packages/server/src/services/roles'
import { isReclaimableInstallStaging } from '../../packages/server/src/services/roles/installStaging'
import {
  ATOMIC_PUBLISH_GATE,
  atomicPublishAvailable,
  describeAtomicPublish,
} from './atomicPublishGate'
import { describeRoleLibraryContract, packageOf } from './roleLibraryContract'

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
  createFsRoleLibrary({
    publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
    rootForSpace: () => mount,
  })

/** The same library with the capability dictated rather than probed. A separate
 *  entry point on purpose: a default parameter would silently swap `undefined`
 *  — the case under test — back for the host's real answer. */
const libraryPublishingWith = (mount: string, publish: PublishDirectoryIfAbsent | undefined) =>
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
  name = 'wanted',
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

describe('role library staging selection', () => {
  it('reserves the staging grammar only where a library root actually is', () => {
    const staging = `.wanted.install-${randomUUID()}`

    expect(isReclaimableInstallStaging(staging, true)).toBe(true)
    expect(isReclaimableInstallStaging(`_projects/cHJvamVjdC1h/${staging}`, true)).toBe(true)
    // A package resource under that grammar is authored data, kept verbatim by
    // export and by backup.
    expect(isReclaimableInstallStaging(`wanted/assets/${staging}`, true)).toBe(false)
    expect(isReclaimableInstallStaging(`wanted/${staging}`, true)).toBe(false)
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

  it('refuses to publish, touching nothing, when composition carried no capability', async () => {
    const mount = await mkmount()

    mkdirMock.mockClear()
    opendirMock.mockClear()

    await expect(
      libraryPublishingWith(mount, undefined).putIfAbsent(PERSONAL, packageOf('wanted', 'Owned.')),
    ).rejects.toMatchObject({ code: 'ENOTSUP' })
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
      libraryPublishingWith(mount, undefined).putIfAbsent(PERSONAL, packageOf('wanted', 'Owned.')),
    ).rejects.toMatchObject({ code: 'ENOTSUP' })
    await expect(lstat(mount)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the two pure refusals ahead of the capability one', async () => {
    const mount = await mkmount()
    const absent = libraryPublishingWith(mount, undefined)

    // Content and location are decided without consulting the runtime at all, so
    // an unsupported host must not relabel either as "unavailable".
    await expect(absent.putIfAbsent(PERSONAL, packageOf('Bad Name', 'Owned.'))).rejects.toThrow(
      /invalid Agent Skill package/i,
    )
    await expect(
      createFsRoleLibrary({
        publishDirectoryIfAbsent: undefined,
        rootForSpace: () => null,
      }).putIfAbsent(PERSONAL, packageOf('wanted', 'Owned.')),
    ).rejects.toThrow(/role library is unavailable for this space/)
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
    expect(seen[0]![1]).toBe(join(mount, 'wanted'))
    expect(seen[0]![0]).toMatch(/\/\.wanted\.install-/)
    await expect(readFile(join(mount, 'wanted', 'SKILL.md'), 'utf8')).resolves.toContain('Owned.')
    await expect(entriesOf(mount)).resolves.toEqual(['wanted'])
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
      packages: [{ name: 'wanted' }],
    })
    await expect(absent.exists(PERSONAL, 'wanted')).resolves.toBe(true)
    await expect(absent.getSkill(PERSONAL, 'wanted')).resolves.toMatchObject({ name: 'wanted' })
  })

  it('lets an injected failure travel out unchanged, staging cleaned', async () => {
    const mount = await mkmount()
    const failure = Object.assign(new Error('unsupported medium'), { code: 'EXDEV', errno: 18 })

    await expect(
      libraryPublishingWith(mount, async () => {
        throw failure
      }).putIfAbsent(PERSONAL, packageOf('wanted', 'Owned.')),
    ).rejects.toBe(failure)
    await expect(entriesOf(mount)).resolves.toEqual([])
  })
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
    const target = join(mount, 'wanted')

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

      const library = createFsRoleLibrary({
        publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
        rootForSpace: () => ${JSON.stringify(mount)},
      })
      const added = await library.putIfAbsent(
        { scope: 'personal', space: 'personal' },
        {
          name: 'wanted',
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
    await expect(entriesOf(mount)).resolves.toEqual(['wanted'])
  }, 15_000)

  it('leaves no staging of its own behind, after a success and after a conflict', async () => {
    const mount = await mkmount()
    const library = libraryAt(mount)

    await expect(library.putIfAbsent(PERSONAL, packageOf('wanted', 'Owned.'))).resolves.toBe(true)
    await expect(entriesOf(mount)).resolves.toEqual(['wanted'])
    await expect(library.putIfAbsent(PERSONAL, packageOf('wanted', 'Second.'))).resolves.toBe(false)
    await expect(entriesOf(mount)).resolves.toEqual(['wanted'])
  })

  it('keeps a conflict a defined answer when the staging cleanup itself fails', async () => {
    const mount = await mkmount()
    const library = libraryAt(mount)

    await library.putIfAbsent(PERSONAL, packageOf('wanted', 'Occupant.'))
    rmMock.mockRejectedValueOnce(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
    )

    await expect(library.putIfAbsent(PERSONAL, packageOf('wanted', 'Second.'))).resolves.toBe(false)
    await expect(readFile(join(mount, 'wanted', 'SKILL.md'), 'utf8')).resolves.toContain(
      'Occupant.',
    )
    const orphan = (await entriesOf(mount)).find((entry) => entry.startsWith('.wanted.install-'))

    expect(orphan).toBeDefined()
    const stale = new Date(Date.now() - 2 * STALE_MS)

    await utimes(join(mount, orphan!), stale, stale)
    await expect(library.putIfAbsent(PERSONAL, packageOf('second', 'Owned.'))).resolves.toBe(true)
    await expect(lstat(join(mount, orphan!))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports an injected conflict as `false` and sweeps its own staging', async () => {
    const mount = await mkmount()
    const occupant = packageOf('wanted', 'Occupant.')

    await expect(libraryAt(mount).putIfAbsent(PERSONAL, occupant)).resolves.toBe(true)
    const before = await fingerprint(join(mount, 'wanted'))

    await expect(
      libraryPublishingWith(mount, async () => false).putIfAbsent(
        PERSONAL,
        packageOf('wanted', 'Second.'),
      ),
    ).resolves.toBe(false)
    await expect(fingerprint(join(mount, 'wanted'))).resolves.toBe(before)
    await expect(entriesOf(mount)).resolves.toEqual(['wanted'])
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
      readFile(join(projectRoot(realMount), 'wanted', 'SKILL.md'), 'utf8'),
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

      await mkdir(join(root, 'wanted', 'assets'), { recursive: true })
      await writeFile(join(root, 'wanted', 'SKILL.md'), 'published')
      await mkdir(join(root, 'not-a-package'), { recursive: true })
      await mkdir(join(root, '_projects', 'cHJvamVjdC1i'), { recursive: true })
      const twin = await orphanStaging(join(root, 'wanted', 'assets'), 2 * STALE_MS)
      const stagedFile = join(root, `.wanted.install-${randomUUID()}`)
      const stagedLink = join(root, `.other.install-${randomUUID()}`)

      await writeFile(stagedFile, 'authored')
      await symlink(join(root, 'wanted'), stagedLink)
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
      expect(await entriesOf(root)).toEqual([...before.keys(), 'other'].sort())
      await expect(lstat(twin)).resolves.toMatchObject({})
      await expect(readFile(stagedFile, 'utf8')).resolves.toBe('authored')
      await expect(readlink(stagedLink)).resolves.toBe(join(root, 'wanted'))
    })

    it.each([
      ['regular file', async (path: string) => await actualFs.writeFile(path, 'authored')],
      [
        'symlink',
        async (path: string, root: string) => await actualFs.symlink(join(root, 'wanted'), path),
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
