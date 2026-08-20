import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

let root: string
const location = { scope: 'personal' as const, space: 'personal' }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nt-role-library-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('filesystem role library bounds', () => {
  it('finds an id-backed package by its manifest name after rename', async () => {
    const directoryName = 'AbCdefGhij_1'

    await mkdir(join(root, directoryName), { recursive: true })
    await writeFile(
      join(root, directoryName, 'SKILL.md'),
      '---\nname: renamed-role\ndescription: Renamed role.\nmetadata:\n  notarium.kind: role\n---\n\nInstructions.',
    )
    const library = createFsRoleLibrary({
      publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
      rootForSpace: () => root,
    })

    await expect(library.getSkill(location, 'renamed-role')).resolves.toMatchObject({
      directoryName,
    })
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

  it('keeps exact lookup outside the bounded discovery window', async () => {
    await Promise.all(
      Array.from({ length: 300 }, async (_unused, index) => {
        const name = `role-${String(index).padStart(3, '0')}`
        const directoryName = packageDirectoryOf(name)

        await mkdir(join(root, directoryName), { recursive: true })
        await writeFile(
          join(root, directoryName, 'SKILL.md'),
          `---\nname: ${name}\ndescription: Role ${index}.\nmetadata:\n  notarium.kind: role\n---\n\nInstructions ${index}.`,
        )
      }),
    )
    const library = createFsRoleLibrary({
      publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
      rootForSpace: () => root,
    })

    await expect(library.listManifests(location)).resolves.toMatchObject({ truncated: true })
    await expect(library.getSkill(location, 'role-299')).resolves.toMatchObject({
      directoryName: packageDirectoryOf('role-299'),
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
    const library = createFsRoleLibrary({
      publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
      rootForSpace: () => root,
    })
    const roles = createRolesService({
      catalog: async () => [],
      library,
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
    const library = createFsRoleLibrary({
      publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
      rootForSpace: () => root,
    })
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      library,
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
    const library = createFsRoleLibrary({
      publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
      rootForSpace: () => root,
    })
    const failure = new Error('storage unavailable')
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      library: {
        ...library,
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
    const library = createFsRoleLibrary({
      publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
      rootForSpace: () => root,
    })

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
    const library = createFsRoleLibrary({
      publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
      rootForSpace: () => root,
    })
    const roles = createRolesService({
      catalog: async () => [],
      library,
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
    ).resolves.toBeNull()
  })

  it('rejects traversal paths before writing outside the package directory', async () => {
    const library = createFsRoleLibrary({
      publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
      rootForSpace: () => root,
    })

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
      const library = createFsRoleLibrary({
        publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
        rootForSpace: () => root,
      })
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
      expect((await createLocalFsFiles(root).scan()).map((entry) => entry.path)).toContain(
        `_projects/${Buffer.from(projectId).toString('base64url')}/${packageDirectoryOf('project-role')}/SKILL.md`,
      )
    },
  )
})
