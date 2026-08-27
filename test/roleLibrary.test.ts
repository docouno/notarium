import { Buffer } from 'node:buffer'
import { access, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createLocalFsFiles, renameNoReplaceIfAvailable } from '@notarium/engine'
import { SYSTEM_PRINCIPAL } from '../packages/server/src/services/authz'
import {
  createFsRoleLibrary,
  createRolesService,
  inMemoryAbilityPersistence,
  loadBundledAbilityInventory,
  RoleAlreadyExistsError,
  RoleDependencyConflictError,
} from '../packages/server/src/services/roles'
import { itAtomicPublish } from './role-library-contract/atomicPublishGate'
import { packageDirectoryOf } from './role-library-contract/roleLibraryContract'
import { writableLibrary } from './roleLibraryComposition'

let root: string
const location = { scope: 'personal' as const, space: 'personal' }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nt-role-library-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('filesystem role library bounds', () => {
  it('vetoes detach when the package contains a symbolic-link member', async () => {
    const directoryName = 'AbCdefGhij_1'
    const directory = join(root, directoryName)
    const outside = join(root, 'outside.bin')

    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'SKILL.md'),
      '---\nname: linked-skill\ndescription: Linked skill.\n---\n\nInstructions.',
    )
    await writeFile(outside, 'must not be followed')
    await symlink(outside, join(directory, 'asset.bin'))
    const library = writableLibrary(
      createFsRoleLibrary({
        publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
        rootForSpace: () => root,
      }),
    )
    let detached = false

    await expect(
      library.inspectAndRemove(location, directoryName, {
        assertSafe: async (pkg) => {
          const members = [...pkg.files.keys()]
          const unsafe =
            members.length === 1 && members[0] === 'SKILL.md'
              ? undefined
              : members.find((path) => path !== 'SKILL.md')

          if (unsafe) {
            throw new Error(`unsafe package member: ${unsafe}`)
          }
        },
        remove: async (beforeDetach) => {
          await beforeDetach()
          detached = true
        },
      }),
    ).rejects.toThrow('unsafe package member: asset.bin (symbolic link)')
    expect(detached).toBe(false)
    await expect(lstat(join(directory, 'asset.bin'))).resolves.toMatchObject({})
  })

  it('vetoes an auxiliary member added before the fenced detach inspection', async () => {
    const directoryName = 'AbCdefGhij_1'
    const directory = join(root, directoryName)

    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'SKILL.md'),
      '---\nname: changing-skill\ndescription: Changing skill.\n---\n\nInstructions.',
    )
    const library = writableLibrary(
      createFsRoleLibrary({
        publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
        rootForSpace: () => root,
      }),
    )
    let detached = false

    await expect(
      library.inspectAndRemove(location, directoryName, {
        assertSafe: async (pkg) => {
          const members = [...pkg.files.keys()]

          if (members.length !== 1 || members[0] !== 'SKILL.md') {
            throw new Error(`unsafe package member: ${members.find((p) => p !== 'SKILL.md')}`)
          }
        },
        remove: async (beforeDetach) => {
          await mkdir(join(directory, 'references'))
          await writeFile(join(directory, 'references', 'late.md'), '# Late\n')
          await beforeDetach()
          detached = true
        },
      }),
    ).rejects.toThrow('unsafe package member: references/late.md')
    expect(detached).toBe(false)
    await expect(access(join(directory, 'SKILL.md'))).resolves.toBeUndefined()
    await expect(access(join(directory, 'references', 'late.md'))).resolves.toBeUndefined()
  })

  it('vetoes an empty auxiliary directory in the fenced raw-member roster', async () => {
    const directoryName = 'AbCdefGhij_1'
    const directory = join(root, directoryName)

    await mkdir(join(directory, 'references'), { recursive: true })
    await writeFile(
      join(directory, 'SKILL.md'),
      '---\nname: empty-directory\ndescription: Empty directory proof.\n---\n\nInstructions.',
    )
    const library = writableLibrary(
      createFsRoleLibrary({
        publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
        rootForSpace: () => root,
      }),
    )
    let detached = false

    await expect(
      library.inspectAndRemove(location, directoryName, {
        assertSafe: async (_pkg, members = []) => {
          if (members.length !== 1 || members[0] !== 'SKILL.md') {
            throw new Error(`unsafe package member: ${members.find((p) => p !== 'SKILL.md')}`)
          }
        },
        remove: async (beforeDetach) => {
          await beforeDetach()
          detached = true
        },
      }),
    ).rejects.toThrow('unsafe package member: references')
    expect(detached).toBe(false)
    await expect(access(join(directory, 'SKILL.md'))).resolves.toBeUndefined()
    await expect(lstat(join(directory, 'references'))).resolves.toMatchObject({})
  })

  it('vetoes detach when the manifest disappeared before fenced inspection', async () => {
    const directoryName = 'AbCdefGhij_1'
    const directory = join(root, directoryName)

    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'SKILL.md'),
      '---\nname: changing-skill\ndescription: Changing skill.\n---\n\nInstructions.',
    )
    await writeFile(join(directory, 'asset.bin'), 'must survive')
    const library = writableLibrary(
      createFsRoleLibrary({
        publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
        rootForSpace: () => root,
      }),
    )
    let detached = false

    await expect(
      library.inspectAndRemove(location, directoryName, {
        assertSafe: async () => undefined,
        remove: async (beforeDetach) => {
          await rm(join(directory, 'SKILL.md'))
          await beforeDetach()
          detached = true
        },
      }),
    ).rejects.toMatchObject({
      message: 'not found',
      cause: 'ability package changed before delete',
    })
    expect(detached).toBe(false)
    await expect(access(join(directory, 'asset.bin'))).resolves.toBeUndefined()
  })

  it('finds an id-backed package by its manifest name after rename', async () => {
    const directoryName = 'AbCdefGhij_1'

    await mkdir(join(root, directoryName), { recursive: true })
    await writeFile(
      join(root, directoryName, 'SKILL.md'),
      '---\nname: renamed-role\ndescription: Renamed role.\nmetadata:\n  notarium.kind: role\n---\n\nInstructions.',
    )
    const library = writableLibrary(
      createFsRoleLibrary({
        publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
        rootForSpace: () => root,
      }),
    )

    await expect(library.getAbilitiesNamed(location, 'renamed-role')).resolves.toEqual(
      new Map([['role', expect.objectContaining({ directoryName })]]),
    )
    await expect(library.get(location, 'renamed-role')).resolves.toMatchObject({
      directoryName,
    })
    await expect(library.getSkillByDirectory(location, directoryName)).resolves.toMatchObject({
      directoryName,
    })
    await expect(library.getByDirectory(location, directoryName)).resolves.toMatchObject({
      directoryName,
    })
    await expect(library.exists(location, 'renamed-role')).resolves.toBe(true)
  })

  it('indexes same-name external packages independently by ability kind', async () => {
    // Lowercase/uppercase deliberately make default JS sort disagree with the
    // library's established localeCompare winner. This pins both contracts: one
    // winner per kind for runtime, and the legacy global winner for full reads.
    const skillDirectory = 'aBcdefGhij_1'
    const secondSkillDirectory = 'mBcdefGhij_3'
    const roleDirectory = 'BbcdefGhij_2'
    const secondRoleDirectory = 'ZyXwvUtsrq_4'

    await mkdir(join(root, skillDirectory), { recursive: true })
    await writeFile(
      join(root, skillDirectory, 'SKILL.md'),
      '---\nname: shared-name\ndescription: External skill.\n---\n\nSkill instructions.',
    )
    await mkdir(join(root, secondSkillDirectory), { recursive: true })
    await writeFile(
      join(root, secondSkillDirectory, 'SKILL.md'),
      '---\nname: shared-name\ndescription: Second external skill.\n---\n\nSecond skill instructions.',
    )
    await mkdir(join(root, roleDirectory), { recursive: true })
    await writeFile(
      join(root, roleDirectory, 'SKILL.md'),
      '---\nname: shared-name\ndescription: External role.\nmetadata:\n  notarium.kind: role\n---\n\nRole instructions.',
    )
    await mkdir(join(root, secondRoleDirectory), { recursive: true })
    await writeFile(
      join(root, secondRoleDirectory, 'SKILL.md'),
      '---\nname: shared-name\ndescription: Second external role.\nmetadata:\n  notarium.kind: role\n---\n\nSecond role instructions.',
    )
    const library = writableLibrary(
      createFsRoleLibrary({
        publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
        rootForSpace: () => root,
      }),
    )

    await expect(library.getAbilitiesNamed(location, 'shared-name')).resolves.toEqual(
      new Map([
        ['role', expect.objectContaining({ directoryName: roleDirectory })],
        ['skill', expect.objectContaining({ directoryName: skillDirectory })],
      ]),
    )
    await expect(library.get(location, 'shared-name')).resolves.toMatchObject({
      directoryName: skillDirectory,
    })
    const roles = createRolesService({
      catalog: async () => [],
      ...library.deps,
      ...inMemoryAbilityPersistence(),
    })
    const context = { personalSpace: 'personal' }

    await expect(roles.listAbilityResolution(context, SYSTEM_PRINCIPAL)).resolves.toMatchObject({
      candidates: expect.arrayContaining([
        expect.objectContaining({
          kind: 'skill',
          effective: true,
          locator: expect.objectContaining({ packageId: skillDirectory }),
        }),
        expect.objectContaining({
          kind: 'role',
          effective: true,
          locator: expect.objectContaining({ packageId: roleDirectory }),
        }),
      ]),
    })
    await expect(
      roles.loadEffective(context, SYSTEM_PRINCIPAL, 'shared-name', 4_000),
    ).resolves.toMatchObject({
      ok: true,
      loaded: {
        locator: { kind: 'role', packageId: roleDirectory },
        role: { instructions: 'Role instructions.' },
      },
    })
    await expect(
      roles.loadEffectiveSkill(context, SYSTEM_PRINCIPAL, 'shared-name', 4_000),
    ).resolves.toMatchObject({
      ok: true,
      loaded: {
        locator: { kind: 'skill', packageId: skillDirectory },
        skill: { instructions: 'Skill instructions.' },
      },
    })
  })

  it('rejects a composite Skill before it can win exact same-name resolution', async () => {
    const invalidDirectory = 'AbCdefGhij_1'
    const validDirectory = 'ZyXwvUtsrq_4'

    expect(invalidDirectory.localeCompare(validDirectory)).toBeLessThan(0)
    await mkdir(join(root, invalidDirectory), { recursive: true })
    await writeFile(
      join(root, invalidDirectory, 'SKILL.md'),
      '---\nname: shared-skill\ndescription: Invalid composite.\nmetadata:\n  notarium.skills: ""\n---\n\nMust not win.',
    )
    await mkdir(join(root, validDirectory), { recursive: true })
    await writeFile(
      join(root, validDirectory, 'SKILL.md'),
      '---\nname: shared-skill\ndescription: Valid standalone.\n---\n\nValid instructions.',
    )
    const library = writableLibrary(
      createFsRoleLibrary({
        publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
        rootForSpace: () => root,
      }),
    )
    const roles = createRolesService({
      catalog: async () => [],
      ...library.deps,
      ...inMemoryAbilityPersistence(),
    })
    const context = { personalSpace: 'personal' }

    await expect(library.getAbilitiesNamed(location, 'shared-skill')).resolves.toEqual(
      new Map([['skill', expect.objectContaining({ directoryName: validDirectory })]]),
    )
    await expect(roles.listAbilityResolution(context, SYSTEM_PRINCIPAL)).resolves.toMatchObject({
      candidates: [
        expect.objectContaining({
          kind: 'skill',
          effective: true,
          locator: expect.objectContaining({ packageId: validDirectory }),
        }),
      ],
    })
    await expect(
      roles.loadEffectiveSkill(context, SYSTEM_PRINCIPAL, 'shared-skill', 4_000),
    ).resolves.toMatchObject({
      ok: true,
      loaded: {
        locator: { kind: 'skill', packageId: validDirectory },
        skill: { instructions: 'Valid instructions.' },
      },
    })
  })

  it('keeps exact lookup outside the bounded discovery window', async () => {
    await Promise.all(
      Array.from({ length: 300 }, async (_unused, index) => {
        const name = `role-${String(index).padStart(3, '0')}`
        const directoryName = packageDirectoryOf(name)

        await mkdir(join(root, directoryName), { recursive: true })
        await writeFile(
          join(root, directoryName, 'SKILL.md'),
          `---\nnotarium-id: ${directoryName}\nname: ${name}\ndescription: Role ${index}.\nmetadata:\n  notarium.kind: role\n---\n\nInstructions ${index}.`,
        )
      }),
    )
    const library = writableLibrary(
      createFsRoleLibrary({
        publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
        rootForSpace: () => root,
      }),
    )
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      ...inMemoryAbilityPersistence(),
      ...library.deps,
    })

    await expect(library.listManifests(location)).resolves.toMatchObject({ truncated: true })
    await expect(library.getAbilitiesNamed(location, 'role-299')).resolves.toEqual(
      new Map([
        ['role', expect.objectContaining({ directoryName: packageDirectoryOf('role-299') })],
      ]),
    )
    await expect(
      roles.resolveOwnedAt(location, SYSTEM_PRINCIPAL, 'role', packageDirectoryOf('role-299')),
    ).resolves.toMatchObject({
      source: 'owned',
      kind: 'role',
      packageId: packageDirectoryOf('role-299'),
    })
  })

  it('keeps a valid role discoverable beside an oversized package', async () => {
    const wantedDirectory = packageDirectoryOf('wanted')
    const oversizedDirectory = packageDirectoryOf('oversized')

    await mkdir(join(root, wantedDirectory), { recursive: true })
    await writeFile(
      join(root, wantedDirectory, 'SKILL.md'),
      '---\nname: wanted\ndescription: Wanted.\nmetadata:\n  notarium.kind: role\n---\n',
    )
    await mkdir(join(root, oversizedDirectory), { recursive: true })
    await writeFile(
      join(root, oversizedDirectory, 'SKILL.md'),
      '---\nname: oversized\ndescription: Oversized.\nmetadata:\n  notarium.kind: role\n---\n',
    )
    await writeFile(
      join(root, oversizedDirectory, 'resource.bin'),
      Buffer.alloc(8 * 1024 * 1024 + 1),
    )
    const library = writableLibrary(
      createFsRoleLibrary({
        publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
        rootForSpace: () => root,
      }),
    )
    const roles = createRolesService({
      catalog: async () => [],
      ...library.deps,
      ...inMemoryAbilityPersistence(),
    })

    await expect(library.get(location, 'wanted')).resolves.toMatchObject({
      directoryName: wantedDirectory,
    })
    await expect(library.get(location, 'oversized')).rejects.toThrow(/too large/)
    await expect(library.listManifests(location)).resolves.toMatchObject({
      packages: expect.arrayContaining([
        expect.objectContaining({ directoryName: wantedDirectory }),
      ]),
      truncated: false,
    })
    await expect(
      roles.listEffective({ personalSpace: 'personal' }, SYSTEM_PRINCIPAL),
    ).resolves.toMatchObject({
      roles: expect.arrayContaining([expect.objectContaining({ name: 'wanted' })]),
      truncated: false,
    })
  })

  it('reports occupied invalid role and dependency targets as stable Add conflicts', async () => {
    const library = writableLibrary(
      createFsRoleLibrary({
        publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
        rootForSpace: () => root,
      }),
    )
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      ...library.deps,
      ...inMemoryAbilityPersistence(),
    })

    await mkdir(join(root, 'grooming'), { recursive: true })
    await writeFile(
      join(root, 'grooming', 'SKILL.md'),
      '---\nname: grooming\ndescription: Occupied.\nmetadata:\n  notarium.kind: role\n---\n',
    )
    await writeFile(join(root, 'grooming', 'oversized.bin'), Buffer.alloc(8 * 1024 * 1024 + 1))
    await expect(roles.addFromCatalog('grooming', location, null)).rejects.toBeInstanceOf(
      RoleAlreadyExistsError,
    )

    await rm(join(root, 'grooming'), { recursive: true, force: true })
    await mkdir(join(root, 'grooming-evidence'), { recursive: true })
    await writeFile(
      join(root, 'grooming-evidence', 'SKILL.md'),
      '---\nname: grooming-evidence\ndescription: Occupied dependency.\n---\n',
    )
    await writeFile(
      join(root, 'grooming-evidence', 'oversized.bin'),
      Buffer.alloc(8 * 1024 * 1024 + 1),
    )
    await expect(roles.addFromCatalog('grooming', location, null)).rejects.toBeInstanceOf(
      RoleDependencyConflictError,
    )
    await expect(library.exists(location, 'grooming')).resolves.toBe(false)
  })

  it('does not disguise a real dependency I/O failure as a content conflict', async () => {
    const library = writableLibrary(
      createFsRoleLibrary({
        publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
        rootForSpace: () => root,
      }),
    )
    const failure = new Error('storage unavailable')
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      publication: library.deps.publication,
      library: {
        ...library.deps.library,
        exists: async (_where, name) => name === 'grooming-evidence',
        get: async () => {
          throw failure
        },
      },
      ...inMemoryAbilityPersistence(),
    })

    await expect(roles.addFromCatalog('grooming', location, null)).rejects.toBe(failure)
  })

  it('does not walk an oversized sibling directory without a direct SKILL.md', async () => {
    const wantedDirectory = packageDirectoryOf('wanted')

    await mkdir(join(root, wantedDirectory), { recursive: true })
    await writeFile(
      join(root, wantedDirectory, 'SKILL.md'),
      '---\nname: wanted\ndescription: Wanted.\n---\n',
    )
    await mkdir(join(root, 'not-a-package', 'assets'), { recursive: true })
    await writeFile(
      join(root, 'not-a-package', 'assets', 'large.bin'),
      Buffer.alloc(8 * 1024 * 1024 + 1),
    )
    const library = writableLibrary(
      createFsRoleLibrary({
        publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
        rootForSpace: () => root,
      }),
    )

    await expect(library.listManifests(location)).resolves.toEqual({
      packages: [expect.objectContaining({ directoryName: wantedDirectory })],
      truncated: false,
    })
  })

  it('does not advertise a SKILL.md that activation would reject by the shared byte bound', async () => {
    const wantedDirectory = packageDirectoryOf('wanted')
    const longDirectory = packageDirectoryOf('too-long')

    await mkdir(join(root, wantedDirectory), { recursive: true })
    await writeFile(
      join(root, wantedDirectory, 'SKILL.md'),
      '---\nname: wanted\ndescription: Wanted.\nmetadata:\n  notarium.kind: role\n---\n',
    )
    await mkdir(join(root, longDirectory), { recursive: true })
    await writeFile(
      join(root, longDirectory, 'SKILL.md'),
      `---\nname: too-long\ndescription: Too long.\nmetadata:\n  notarium.kind: role\n---\n\n${'x'.repeat(300_000)}`,
    )
    const library = writableLibrary(
      createFsRoleLibrary({
        publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
        rootForSpace: () => root,
      }),
    )
    const roles = createRolesService({
      catalog: async () => [],
      ...library.deps,
      ...inMemoryAbilityPersistence(),
    })

    await expect(
      roles.listEffective({ personalSpace: 'personal' }, SYSTEM_PRINCIPAL),
    ).resolves.toEqual({
      roles: [expect.objectContaining({ name: 'wanted' })],
      truncated: false,
    })
    await expect(
      roles.loadEffective({ personalSpace: 'personal' }, SYSTEM_PRINCIPAL, 'too-long', 4_000),
    ).resolves.toMatchObject({ ok: false, reason: 'not-found' })
  })

  it('rejects traversal paths before writing outside the package directory', async () => {
    const library = writableLibrary(
      createFsRoleLibrary({
        publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
        rootForSpace: () => root,
      }),
    )

    await expect(
      library.putIfAbsent(location, {
        directoryName: 'AbCdefGhij_1',
        files: new Map([
          ['SKILL.md', Buffer.from('---\nname: safe-name\ndescription: Safe.\n---\n')],
          ['../escape', Buffer.from('no')],
        ]),
      }),
    ).rejects.toThrow(/invalid Agent Skill package path/)
  })

  itAtomicPublish(
    'keeps project roots separate from a same-named Personal or Space package',
    async () => {
      const library = writableLibrary(
        createFsRoleLibrary({
          publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
          rootForSpace: () => root,
        }),
      )
      const projectId = 'project-root'
      const project = { scope: 'project' as const, space: 'personal', projectId }
      const packageOf = (name: string) => ({
        directoryName: packageDirectoryOf(name),
        files: new Map([
          ['SKILL.md', Buffer.from(`---\nname: ${name}\ndescription: ${name}.\n---\n`)],
        ]),
      })

      await expect(library.putIfAbsent(location, packageOf(projectId))).resolves.toBe(true)
      await expect(library.putIfAbsent(project, packageOf('project-role'))).resolves.toBe(true)

      await expect(library.get(location, projectId)).resolves.toMatchObject({
        directoryName: packageDirectoryOf(projectId),
      })
      await expect(library.get(project, 'project-role')).resolves.toMatchObject({
        directoryName: packageDirectoryOf('project-role'),
      })
      await expect(library.listManifests(location)).resolves.toEqual({
        packages: [expect.objectContaining({ directoryName: packageDirectoryOf(projectId) })],
        truncated: false,
      })
      await expect(library.listManifests(project)).resolves.toEqual({
        packages: [expect.objectContaining({ directoryName: packageDirectoryOf('project-role') })],
        truncated: false,
      })
      expect((await createLocalFsFiles(root).base.scan()).map((entry) => entry.path)).toContain(
        `_projects/${Buffer.from(projectId).toString('base64url')}/${packageDirectoryOf('project-role')}/SKILL.md`,
      )
    },
  )
})
