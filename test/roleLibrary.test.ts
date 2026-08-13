import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createLocalFsFiles, renameNoReplaceIfAvailable } from '@notarium/engine'
import {
  createFsRoleLibrary,
  createRolesService,
  loadBuiltinRoleCatalog,
  RoleAlreadyExistsError,
  RoleDependencyConflictError,
} from '../packages/server/src/services/roles'
import { itAtomicPublish } from './role-library-contract/atomicPublishGate'

let root: string
const location = { scope: 'personal' as const, space: 'personal' }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nt-role-library-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('filesystem role library bounds', () => {
  it('keeps a valid role discoverable beside an oversized package', async () => {
    await mkdir(join(root, 'wanted'), { recursive: true })
    await writeFile(
      join(root, 'wanted', 'SKILL.md'),
      '---\nname: wanted\ndescription: Wanted.\nmetadata:\n  notarium.kind: role\n---\n',
    )
    await mkdir(join(root, 'oversized'), { recursive: true })
    await writeFile(
      join(root, 'oversized', 'SKILL.md'),
      '---\nname: oversized\ndescription: Oversized.\nmetadata:\n  notarium.kind: role\n---\n',
    )
    await writeFile(join(root, 'oversized', 'resource.bin'), Buffer.alloc(8 * 1024 * 1024 + 1))
    const library = createFsRoleLibrary({
      publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
      rootForSpace: () => root,
    })
    const roles = createRolesService({ catalog: async () => [], library })

    await expect(library.get(location, 'wanted')).resolves.toMatchObject({ name: 'wanted' })
    await expect(library.get(location, 'oversized')).rejects.toThrow(/too large/)
    await expect(library.listManifests(location)).resolves.toMatchObject({
      packages: expect.arrayContaining([expect.objectContaining({ name: 'wanted' })]),
      truncated: false,
    })
    await expect(roles.listEffective({ personalSpace: 'personal' })).resolves.toMatchObject({
      roles: expect.arrayContaining([expect.objectContaining({ name: 'wanted' })]),
      truncated: false,
    })
  })

  it('reports occupied invalid role and dependency targets as stable Add conflicts', async () => {
    const library = createFsRoleLibrary({
      publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
      rootForSpace: () => root,
    })
    const roles = createRolesService({ catalog: loadBuiltinRoleCatalog, library })

    await mkdir(join(root, 'grooming'), { recursive: true })
    await writeFile(
      join(root, 'grooming', 'SKILL.md'),
      '---\nname: grooming\ndescription: Occupied.\nmetadata:\n  notarium.kind: role\n---\n',
    )
    await writeFile(join(root, 'grooming', 'oversized.bin'), Buffer.alloc(8 * 1024 * 1024 + 1))
    await expect(roles.addFromCatalog('grooming', location)).rejects.toBeInstanceOf(
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
    await expect(roles.addFromCatalog('grooming', location)).rejects.toBeInstanceOf(
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
      catalog: loadBuiltinRoleCatalog,
      library: {
        ...library,
        exists: async (_where, name) => name === 'grooming-evidence',
        get: async () => {
          throw failure
        },
      },
    })

    await expect(roles.addFromCatalog('grooming', location)).rejects.toBe(failure)
  })

  it('does not walk an oversized sibling directory without a direct SKILL.md', async () => {
    await mkdir(join(root, 'wanted'), { recursive: true })
    await writeFile(
      join(root, 'wanted', 'SKILL.md'),
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
      packages: [expect.objectContaining({ name: 'wanted' })],
      truncated: false,
    })
  })

  it('does not advertise a SKILL.md that activation would reject by the shared byte bound', async () => {
    await mkdir(join(root, 'wanted'), { recursive: true })
    await writeFile(
      join(root, 'wanted', 'SKILL.md'),
      '---\nname: wanted\ndescription: Wanted.\nmetadata:\n  notarium.kind: role\n---\n',
    )
    await mkdir(join(root, 'too-long'), { recursive: true })
    await writeFile(
      join(root, 'too-long', 'SKILL.md'),
      `---\nname: too-long\ndescription: Too long.\nmetadata:\n  notarium.kind: role\n---\n\n${'x'.repeat(300_000)}`,
    )
    const library = createFsRoleLibrary({
      publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
      rootForSpace: () => root,
    })
    const roles = createRolesService({ catalog: async () => [], library })

    await expect(roles.listEffective({ personalSpace: 'personal' })).resolves.toEqual({
      roles: [expect.objectContaining({ name: 'wanted' })],
      truncated: false,
    })
    await expect(
      roles.loadEffective({ personalSpace: 'personal' }, 'too-long', 4_000),
    ).resolves.toBeNull()
  })

  it('rejects traversal paths before writing outside the package directory', async () => {
    const library = createFsRoleLibrary({
      publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
      rootForSpace: () => root,
    })

    await expect(
      library.putIfAbsent(location, {
        name: 'safe-name',
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
        name,
        files: new Map([
          ['SKILL.md', Buffer.from(`---\nname: ${name}\ndescription: ${name}.\n---\n`)],
        ]),
      })

      await expect(library.putIfAbsent(location, packageOf(projectId))).resolves.toBe(true)
      await expect(library.putIfAbsent(project, packageOf('project-role'))).resolves.toBe(true)

      await expect(library.get(location, projectId)).resolves.toMatchObject({ name: projectId })
      await expect(library.get(project, 'project-role')).resolves.toMatchObject({
        name: 'project-role',
      })
      await expect(library.listManifests(location)).resolves.toEqual({
        packages: [expect.objectContaining({ name: projectId })],
        truncated: false,
      })
      await expect(library.listManifests(project)).resolves.toEqual({
        packages: [expect.objectContaining({ name: 'project-role' })],
        truncated: false,
      })
      expect((await createLocalFsFiles(root).scan()).map((entry) => entry.path)).toContain(
        `_projects/${Buffer.from(projectId).toString('base64url')}/project-role/SKILL.md`,
      )
    },
  )
})
