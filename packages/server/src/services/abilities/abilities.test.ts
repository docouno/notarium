import { describe, expect, it, vi } from 'vitest'
import type { OwnedAbilityLocator, SystemAbilityLocator } from '@notarium/contract'
import {
  analyzeDocumentState,
  DOCUMENT_ROLE,
  type NoteContent,
  noteNotFound,
  STORE_ERROR_REASON,
} from '@notarium/core'
import { ResourceAdmission } from '@notarium/engine'

import type { AuthService } from '../auth'
import type { Principal } from '../authz'
import { toolErrorMessage } from '../mcp/gateway'
import { abilityTargetPurgedError, type ProjectsPersistence } from '../metaDb'
import {
  type AbilityResolutionCandidate,
  AbilityUnavailableError,
  RoleDependencyConflictError,
  type RolesService,
} from '../roles'
import type { SpaceManager, SpaceStore } from '../spaces'
import type { StoreAccess } from '../storeAccess'
import { createAbilities } from './abilities'
import type { CustomAbilityCreator, PreparedAbilityCreate, PublishedAbility } from './types'

const owned: OwnedAbilityLocator = {
  source: 'owned',
  kind: 'skill',
  packageId: 'OwnedSkill01',
  location: { scope: 'space', spaceId: 'shared' },
}

const system: SystemAbilityLocator = {
  source: 'system',
  kind: 'skill',
  packageId: 'SystemSkil01',
}

const catalog = { source: 'catalog', kind: 'skill', packageId: 'CatalogSkl01' } as const

const targetOf = (locator: OwnedAbilityLocator, registryNoteId = locator.packageId) => ({
  locator,
  registryNoteId,
  manifestNoteId: locator.packageId,
})

const snapshotOf = (locator: OwnedAbilityLocator, registryNoteId = locator.packageId) => ({
  ...targetOf(locator, registryNoteId),
  pkg: {
    directoryName: locator.packageId,
    files: new Map([
      [
        'SKILL.md',
        Buffer.from(
          `---\nnotarium-id: ${locator.packageId}\nname: owned-skill\ndescription: Owned.\n${locator.kind === 'role' ? 'metadata:\n  notarium.kind: role\n' : ''}---\n\n# Owned skill\n\nOwned instructions.\n`,
        ),
      ],
    ]),
  },
})

const documentState = (role: (typeof DOCUMENT_ROLE)[keyof typeof DOCUMENT_ROLE]) =>
  ({ role }) as NonNullable<NoteContent['documentState']>

const principal = (scope: 'read' | 'write'): Principal => ({
  id: `pat:alice:${scope}`,
  username: 'alice',
  admin: false,
  scope,
  grants: new Map([
    ['personal', 'owner'],
    ['shared', scope === 'write' ? 'writer' : 'reader'],
  ]),
  spaces: new Set(['personal', 'shared']),
  system: false,
})

const readerWithWriteCeiling = (): Principal => ({
  ...principal('write'),
  grants: new Map([
    ['personal', 'owner'],
    ['shared', 'reader'],
  ]),
})

const world = () => {
  const describeAbility = vi.fn(async (_context, _principal, locator) =>
    locator.source === 'system'
      ? {
          locator,
          source: 'system' as const,
          title: 'System skill',
          name: 'system-skill',
          description: 'Bundled.',
          instructions: 'System instructions.',
          enabled: true,
          truncated: false,
        }
      : locator.source === 'owned'
        ? {
            locator,
            source: 'owned' as const,
            title: 'Owned skill',
            name: 'owned-skill',
            description: 'Owned.',
            instructions: 'Owned instructions.',
            enabled: true,
            noteId: 'OwnedNote001',
            origin: 'custom' as const,
            availability: { mode: 'all-projects' as const },
            truncated: false,
          }
        : {
            locator,
            source: 'catalog' as const,
            title: 'Catalog skill',
            name: 'catalog-skill',
            description: 'Template.',
            instructions: 'Catalog instructions.',
            truncated: false,
          },
  )
  const inspectAndRemoveOwned = vi.fn(async (_locator, _personal, options) => {
    await options.assertSafe(new Map([['SKILL.md', new Uint8Array()]]))
    await options.remove(async () => undefined)
    return true
  })
  const setEnabled = vi.fn(async () => undefined)
  const withCurrentOwnedTarget = vi.fn(async (locator, _principal, task) =>
    task(snapshotOf(locator, 'OwnedNote001')),
  )
  const withOwnedTarget = vi.fn(async (target, _principal, task) =>
    task(snapshotOf(target.locator, target.registryNoteId)),
  )
  const withOwnedAt = vi.fn(async (_location, _principal, kind, packageId, registryNoteId, task) =>
    task(snapshotOf({ ...owned, kind, packageId } as OwnedAbilityLocator, registryNoteId)),
  )
  const roles = {
    describeAbility,
    describeOwnedAbility: vi.fn(async (context, currentPrincipal, snapshot) =>
      describeAbility(context, currentPrincipal, snapshot.locator),
    ),
    inspectAndRemoveOwned,
    manifestPath: vi.fn(() => `.notarium/skills/${owned.packageId}/SKILL.md`),
    withCurrentOwnedTarget,
    withOwnedTarget,
    withOwnedAt,
    setEnabled,
  } as unknown as RolesService
  const source = Buffer.from(
    `---\nnotarium-id: OwnedSkill01\nname: owned-skill\ndescription: Owned.\n---\n\n# Owned skill\n\nOwned instructions.\n`,
  )
  const note: NoteContent = {
    id: 'OwnedNote001',
    content: 'Owned instructions.',
    frontmatter: {},
    versionToken: 'owned-version',
    filePath: '.notarium/skills/OwnedSkill01/SKILL.md',
    documentState: analyzeDocumentState({
      source,
      role: DOCUMENT_ROLE.skillRoot,
      skillDirectoryName: 'OwnedSkill01',
    }),
  }
  const removeDir = vi.fn(async (_path, options) => options?.beforeDetach?.([note.id!]))
  const physicalWrite = vi.fn(async () => ({
    id: 'OwnedNote001',
    filePath: note.filePath,
    versionToken: 'owned-next-version',
  }))
  const write = vi.fn(async (_input, options) => {
    const physical = () => physicalWrite()

    return options?.aroundWrite ? options.aroundWrite(physical) : physical()
  })
  const read = vi.fn(async () => note)
  const noteStore = vi.fn(async () => ({
    space: 'shared',
    store: { read, write, removeDir } as unknown as SpaceStore,
  }))
  const abilities = createAbilities({
    roles,
    spaces: {
      list: () => [
        { id: 'personal', slug: 'personal' },
        { id: 'shared', slug: 'shared' },
      ],
      has: (id: string) => id === 'personal' || id === 'shared',
    } as unknown as SpaceManager,
    auth: { personalSpaceOf: vi.fn(async () => 'personal') } as unknown as AuthService,
    store: { noteStore } as unknown as StoreAccess,
  })

  return {
    abilities,
    describeAbility,
    inspectAndRemoveOwned,
    noteStore,
    note,
    removeDir,
    physicalWrite,
    read,
    setEnabled,
    withCurrentOwnedTarget,
    withOwnedTarget,
    write,
  }
}

const discoveryWorld = (withVersionPort = false) => {
  const candidates: AbilityResolutionCandidate[] = [
    {
      source: 'system',
      kind: 'role',
      locator: { source: 'system', kind: 'role', packageId: 'SystemRole01' },
      name: 'research',
      title: 'Research',
      description: 'System research.',
      enabled: true,
      effective: true,
      health: { healthy: true, attachments: [] },
    },
    {
      source: 'owned',
      kind: 'role',
      locator: {
        source: 'owned',
        kind: 'role',
        packageId: 'OwnedRole001',
        location: { scope: 'personal', spaceId: 'personal' },
      },
      location: { scope: 'personal', space: 'personal' },
      name: 'research',
      title: 'Research override',
      description: 'Disabled override.',
      enabled: false,
      effective: false,
    },
    {
      source: 'owned',
      kind: 'skill',
      locator: {
        source: 'owned',
        kind: 'skill',
        packageId: 'OwnedSkill01',
        location: { scope: 'personal', spaceId: 'personal' },
      },
      location: { scope: 'personal', space: 'personal' },
      name: 'summarize',
      title: 'Summarize',
      description: 'Summarize text.',
      enabled: true,
      effective: true,
    },
    {
      source: 'owned',
      kind: 'role',
      locator: {
        source: 'owned',
        kind: 'role',
        packageId: 'BrokenRole01',
        location: { scope: 'personal', spaceId: 'personal' },
      },
      location: { scope: 'personal', space: 'personal' },
      name: 'broken',
      title: 'Broken',
      description: 'Broken composition.',
      enabled: true,
      effective: true,
      health: { healthy: false, attachments: [] },
    },
  ]
  const listRoleVersions = vi.fn(async () => {
    throw new Error('version metadata unavailable')
  })
  const roles = {
    listAbilityResolution: vi.fn(async () => ({ candidates, truncated: false })),
    listRoleVersions,
  } as unknown as RolesService
  const projects = withVersionPort
    ? ({
        listForSpaces: vi.fn(async () => [
          {
            id: 'project-a',
            space: 'personal',
            path: 'project-a',
            slug: 'project-a',
            aliases: [],
            pathAliases: [],
            displayName: 'Project A',
            status: 'active',
            createdAt: 'x',
            lastSeen: 'x',
          },
        ]),
      } as unknown as ProjectsPersistence)
    : undefined

  const abilities = createAbilities({
    roles,
    spaces: {
      list: () => [{ id: 'personal', slug: 'personal' }],
      has: (id: string) => id === 'personal',
    } as unknown as SpaceManager,
    auth: { personalSpaceOf: vi.fn(async () => 'personal') } as unknown as AuthService,
    projects,
    store: {} as StoreAccess,
  })

  return { abilities, listRoleVersions }
}

describe('AbilitiesService authoring policy', () => {
  it('finishes the admitted snapshot before a fair exclusive waiter can block detail reads', async () => {
    const admission = new ResourceAdmission()
    const packagePath = '.notarium/skills/OwnedSkill01'
    const snapshot = snapshotOf(owned, 'OwnedNote001')
    let outerActive = false
    const withCurrentOwnedTarget = vi.fn(async (_locator, _principal, task) => {
      const outer = await admission.admit({
        scope: 'package',
        mode: 'shared',
        owner: 'outer-authoring-read',
        path: packagePath,
      })
      outerActive = true
      const rival = admission.admit({
        scope: 'package',
        mode: 'exclusive',
        owner: 'rival-package-mutation',
        path: packagePath,
      })
      void rival.then((lease) => lease.settle())

      try {
        return await task(snapshot)
      } finally {
        outerActive = false
        outer.settle()
      }
    })
    const describeOwnedAbility = vi.fn(async () => {
      expect(outerActive).toBe(false)
      return {
        locator: owned,
        source: 'owned' as const,
        title: 'Owned skill',
        name: 'owned-skill',
        description: 'Owned.',
        instructions: 'Owned instructions.',
        enabled: true,
        noteId: 'OwnedNote001',
        origin: 'custom' as const,
        availability: { mode: 'all-projects' as const },
        truncated: false,
      }
    })
    const roles = {
      withCurrentOwnedTarget,
      describeOwnedAbility,
      // The former callback path reached this ordinary exact reader and queued a
      // second shared lease behind `rival-package-mutation`.
      describeAbility: vi.fn(async () => {
        const nested = await admission.admit({
          scope: 'package',
          mode: 'shared',
          owner: 'nested-ordinary-detail',
          path: packagePath,
        })
        nested.settle()
        return null
      }),
    } as unknown as RolesService
    const note = world().note
    const abilities = createAbilities({
      roles,
      spaces: {
        list: () => [{ id: 'shared', slug: 'shared' }],
        has: () => true,
      } as unknown as SpaceManager,
      auth: { personalSpaceOf: vi.fn(async () => null) } as unknown as AuthService,
      store: {
        noteStore: vi.fn(async () => ({
          space: 'shared',
          store: { read: vi.fn(async () => note) } as unknown as SpaceStore,
        })),
      } as unknown as StoreAccess,
    })

    await expect(abilities.get('authoring', principal('write'), owned)).resolves.toMatchObject({
      ability: { noteId: 'OwnedNote001' },
    })
    expect(describeOwnedAbility).toHaveBeenCalledOnce()
    expect(roles.describeAbility).not.toHaveBeenCalled()
  })

  it('keeps Catalog human-readable but outside the authoring surface', async () => {
    const { abilities, describeAbility } = world()

    await expect(abilities.get('human', principal('read'), catalog)).resolves.toMatchObject({
      ability: { source: 'catalog' },
    })
    await expect(abilities.get('authoring', principal('write'), catalog)).resolves.toBeNull()
    expect(describeAbility).toHaveBeenCalledTimes(1)
  })

  it('requires the write ceiling and grant for Owned, returning its CAS token', async () => {
    const { abilities, noteStore } = world()

    await expect(abilities.get('authoring', principal('read'), owned)).resolves.toBeNull()
    await expect(abilities.get('authoring', principal('write'), owned)).resolves.toMatchObject({
      ability: { source: 'owned', locator: owned },
      writable: true,
      versionToken: 'owned-version',
    })
    expect(noteStore).toHaveBeenCalledTimes(1)
  })

  it('preserves an operational Owned read failure for the opaque MCP boundary', async () => {
    const { abilities, read } = world()
    const failure = new Error('sqlite read failed at /private/meta.db')
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

    read.mockRejectedValueOnce(failure)
    await expect(abilities.get('authoring', principal('write'), owned)).rejects.toBe(failure)
    const message = toolErrorMessage(failure, 'get_ability')

    expect(message).toBe('internal error')
    expect(message).not.toContain('/private/meta.db')
    errorLog.mockRestore()
  })

  it('keeps a typed Owned read not-found as absence', async () => {
    const { abilities, read } = world()

    read.mockRejectedValueOnce(noteNotFound('gone'))
    await expect(abilities.get('authoring', principal('write'), owned)).resolves.toBeNull()
  })

  it('refuses every Owned edit to a write token that only has a reader grant', async () => {
    const { abilities, setEnabled } = world()

    await expect(
      abilities.edit(readerWithWriteCeiling(), owned, { enabled: false }),
    ).rejects.toThrow(/not found|no such Owned ability/)
    expect(setEnabled).not.toHaveBeenCalled()
  })

  it('does not reach the physical write when final target revalidation fails', async () => {
    const { abilities, physicalWrite, withOwnedTarget } = world()

    withOwnedTarget.mockResolvedValueOnce(null)
    await expect(
      abilities.edit(principal('write'), owned, {
        versionToken: 'owned-version',
        instructions: '# Owned skill\n\nChanged instructions.',
      }),
    ).resolves.toMatchObject({
      steps: [{ step: 'document', outcome: 'failed', error: 'not found' }],
    })
    expect(physicalWrite).not.toHaveBeenCalled()
  })

  it('does not apply later steps when a prepared document no-op races a write', async () => {
    const { abilities, note, physicalWrite, read, setEnabled } = world()

    read
      .mockResolvedValueOnce(note)
      .mockResolvedValueOnce({ ...note, versionToken: 'concurrent-version' })

    await expect(
      abilities.edit(principal('write'), owned, {
        versionToken: 'owned-version',
        instructions: '# Owned skill\n\nOwned instructions.\n',
        enabled: false,
      }),
    ).resolves.toMatchObject({
      steps: [
        {
          step: 'document',
          outcome: 'failed',
          reason: STORE_ERROR_REASON.versionConflict,
        },
      ],
    })
    expect(physicalWrite).not.toHaveBeenCalled()
    expect(setEnabled).not.toHaveBeenCalled()
  })

  it('turns an authored CAS conflict into an actionable get_ability retry', async () => {
    const { abilities, write } = world()
    write.mockRejectedValueOnce(
      Object.assign(new Error('note changed since read: OwnedNote001'), {
        reason: STORE_ERROR_REASON.versionConflict,
      }),
    )

    await expect(
      abilities.edit(principal('write'), owned, {
        versionToken: 'stale-version',
        instructions: '# Owned skill\n\nChanged instructions.',
      }),
    ).resolves.toMatchObject({
      locator: owned,
      steps: [
        {
          step: 'document',
          outcome: 'failed',
          reason: STORE_ERROR_REASON.versionConflict,
          error: expect.stringMatching(/call get_ability.*versionToken/i),
        },
      ],
    })
  })

  it('keeps unexpected nested write failures out of ability step output', async () => {
    const { abilities, setEnabled, write } = world()
    const secret = 'postgres://agent:super-secret@db.internal/notarium'
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

    write.mockRejectedValueOnce(new Error(secret))
    await expect(
      abilities.edit(principal('write'), owned, {
        versionToken: 'owned-version',
        instructions: '# Owned skill\n\nChanged.',
      }),
    ).resolves.toMatchObject({
      steps: [{ step: 'document', outcome: 'failed', error: 'internal error' }],
    })

    setEnabled.mockRejectedValueOnce(new Error(secret))
    await expect(
      abilities.edit(principal('write'), owned, { enabled: false }),
    ).resolves.toMatchObject({
      steps: [{ step: 'enabled', outcome: 'failed', error: 'internal error' }],
    })

    write.mockRejectedValueOnce(
      new RoleDependencyConflictError(`dependency failed in private-project-id`, {
        attachment: 'summarize',
        verdict: 'unavailable',
        rule: 'widen its reach',
        projectId: 'private-project-id',
      }),
    )
    const dependency = await abilities.edit(principal('write'), owned, {
      versionToken: 'owned-version',
      instructions: '# Owned skill\n\nChanged again.',
    })
    expect(dependency.steps).toEqual([
      {
        step: 'document',
        outcome: 'failed',
        error: 'skill attachment "summarize" is unavailable; widen its reach',
      },
    ])
    expect(JSON.stringify(dependency)).not.toContain('private-project-id')

    setEnabled.mockRejectedValueOnce(
      abilityTargetPurgedError('ability target private-project-id/private-note was purged'),
    )
    await expect(
      abilities.edit(principal('write'), owned, { enabled: false }),
    ).resolves.toMatchObject({
      steps: [{ step: 'enabled', outcome: 'failed', error: 'not found' }],
    })
    expect(errorLog).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(errorLog.mock.calls)).toContain(secret)
    errorLog.mockRestore()
  })

  it('does not infer a stale authoring ref move from a sibling-project collision', async () => {
    const stale: OwnedAbilityLocator = {
      source: 'owned',
      kind: 'role',
      packageId: 'MovedRole001',
      location: { scope: 'project', spaceId: 'shared', projectId: 'project-a' },
    }
    const describeAbility = vi.fn(async (_context, _principal, locator) =>
      locator === stale
        ? null
        : {
            locator,
            source: 'owned' as const,
            title: 'Moved role',
            name: 'moved-role',
            description: 'Moved.',
            instructions: 'Moved instructions.',
            enabled: true,
            noteId: 'MovedNote001',
            origin: 'custom' as const,
            availability: { mode: 'all-projects' as const },
            health: { healthy: true, attachments: [] },
            truncated: false,
          },
    )
    const withCurrentOwnedTarget = vi.fn(async () => null)
    const roles = {
      describeAbility,
      describeOwnedAbility: vi.fn(async (context, currentPrincipal, snapshot) =>
        describeAbility(context, currentPrincipal, snapshot.locator),
      ),
      withCurrentOwnedTarget,
      listRoleVersions: vi.fn(async () => []),
      findRoleBase: vi.fn(async () => null),
    } as unknown as RolesService
    const note = { ...world().note, id: 'MovedNote001' }
    const projects = {
      getById: vi.fn(async () => ({ id: 'project-a', space: 'shared' })),
      listForSpaces: vi.fn(async () => [
        {
          id: 'project-a',
          space: 'shared',
          path: 'project-a',
          slug: 'project-a',
          aliases: [],
          pathAliases: [],
          displayName: 'Project A',
          status: 'active',
          createdAt: 'x',
          lastSeen: 'x',
        },
        {
          id: 'project-b',
          space: 'shared',
          path: 'project-b',
          slug: 'project-b',
          aliases: [],
          pathAliases: [],
          displayName: 'Project B',
          status: 'active',
          createdAt: 'x',
          lastSeen: 'x',
        },
      ]),
    } as unknown as ProjectsPersistence
    const abilities = createAbilities({
      roles,
      projects,
      spaces: {
        list: () => [
          { id: 'personal', slug: 'personal' },
          { id: 'shared', slug: 'shared' },
        ],
        has: () => true,
      } as unknown as SpaceManager,
      auth: { personalSpaceOf: vi.fn(async () => 'personal') } as unknown as AuthService,
      store: {
        noteStore: vi.fn(async () => ({
          space: 'shared',
          store: { read: vi.fn(async () => note) } as unknown as SpaceStore,
        })),
      } as unknown as StoreAccess,
    })

    await expect(abilities.get('authoring', principal('write'), stale)).resolves.toBeNull()
    expect(withCurrentOwnedTarget).toHaveBeenCalledWith(
      stale,
      expect.anything(),
      expect.any(Function),
      'read',
    )
  })

  it('resolves a stale authoring ref only through its recorded move target', async () => {
    const stale: OwnedAbilityLocator = {
      source: 'owned',
      kind: 'role',
      packageId: 'MovedRole001',
      location: { scope: 'project', spaceId: 'shared', projectId: 'project-a' },
    }
    const moved: OwnedAbilityLocator = {
      source: 'owned',
      kind: 'role',
      packageId: stale.packageId,
      location: { scope: 'space', spaceId: 'shared' },
    }
    const withCurrentOwnedTarget = vi.fn(async (_locator, _principal, task) =>
      task(snapshotOf(moved, 'MovedNote001')),
    )
    const withOwnedTarget = vi.fn(async (target, _principal, task) =>
      task(snapshotOf(target.locator, target.registryNoteId)),
    )
    const describeAbility = vi.fn(async (_context, _principal, locator) =>
      locator === stale
        ? null
        : {
            locator,
            source: 'owned' as const,
            title: 'Moved role',
            name: 'moved-role',
            description: 'Moved.',
            instructions: 'Moved instructions.',
            enabled: true,
            noteId: 'MovedNote001',
            origin: 'custom' as const,
            availability: { mode: 'all-projects' as const },
            health: { healthy: true, attachments: [] },
            truncated: false,
          },
    )
    const roles = {
      describeAbility,
      describeOwnedAbility: vi.fn(async (context, currentPrincipal, snapshot) =>
        describeAbility(context, currentPrincipal, snapshot.locator),
      ),
      withCurrentOwnedTarget,
      withOwnedTarget,
      listRoleVersions: vi.fn(async () => []),
    } as unknown as RolesService
    const note = { ...world().note, id: 'MovedNote001' }
    const abilities = createAbilities({
      roles,
      projects: {
        getById: vi.fn(async () => ({ id: 'project-a', space: 'shared' })),
        listForSpaces: vi.fn(async () => []),
      } as unknown as ProjectsPersistence,
      spaces: {
        list: () => [{ id: 'shared', slug: 'shared' }],
        has: () => true,
      } as unknown as SpaceManager,
      auth: { personalSpaceOf: vi.fn(async () => null) } as unknown as AuthService,
      store: {
        noteStore: vi.fn(async () => ({
          space: 'shared',
          store: { read: vi.fn(async () => note) } as unknown as SpaceStore,
        })),
      } as unknown as StoreAccess,
    })

    await expect(abilities.get('authoring', principal('write'), stale)).resolves.toMatchObject({
      ability: { locator: moved },
    })
    expect(withCurrentOwnedTarget).toHaveBeenCalledWith(
      stale,
      expect.anything(),
      expect.any(Function),
      'read',
    )
  })

  it.each(['get', 'save', 'edit', 'remove'] as const)(
    'lets the placement authority choose the target before %s reads a reoccupied source',
    async (operation) => {
      const stale: OwnedAbilityLocator = {
        source: 'owned',
        kind: 'role',
        packageId: 'MovedRole001',
        location: { scope: 'project', spaceId: 'shared', projectId: 'project-a' },
      }
      const moved: OwnedAbilityLocator = {
        ...stale,
        location: { scope: 'project', spaceId: 'shared', projectId: 'project-b' },
      }
      const noteIdOf = (locator: OwnedAbilityLocator) =>
        locator.location.scope === 'project' && locator.location.projectId === 'project-b'
          ? 'MovedNote001'
          : 'CollisionNote'
      const pathOf = (projectId: string) =>
        `.notarium/skills/_projects/${Buffer.from(projectId).toString('base64url')}/${stale.packageId}/SKILL.md`

      const noteOf = (noteId: string): NoteContent => {
        const projectId = noteId === 'MovedNote001' ? 'project-b' : 'project-a'
        const source = Buffer.from(
          `---\nnotarium-id: ${stale.packageId}\nname: moved-role\nmetadata:\n  notarium.kind: role\n---\n\n# Moved role\n`,
        )

        return {
          id: noteId,
          content: '# Moved role',
          frontmatter: {},
          versionToken: `${noteId}-version`,
          filePath: pathOf(projectId),
          documentState: analyzeDocumentState({
            source,
            role: DOCUMENT_ROLE.skillRoot,
            skillDirectoryName: stale.packageId,
          }),
        }
      }
      const describeAbility = vi.fn(async (_context, _principal, locator: OwnedAbilityLocator) => ({
        locator,
        source: 'owned' as const,
        title: 'Moved role',
        name: 'moved-role',
        description: 'Moved.',
        instructions: 'Moved instructions.',
        enabled: true,
        noteId: noteIdOf(locator),
        origin: 'custom' as const,
        availability: { mode: 'selected-projects' as const, projectIds: ['project-b'] },
        health: { healthy: true, attachments: [] },
        truncated: false,
      }))
      const withCurrentOwnedTarget = vi.fn(async (_locator, _principal, task) =>
        task(snapshotOf(moved, 'MovedNote001')),
      )
      const withOwnedTarget = vi.fn(async (target, _principal, task) =>
        task(snapshotOf(target.locator, target.registryNoteId)),
      )
      const setEnabled = vi.fn(async () => undefined)
      const inspectAndRemoveOwned = vi.fn(async (_locator, _personal, options) => {
        await options.assertSafe(new Map([['SKILL.md', new Uint8Array()]]))
        await options.remove(async () => undefined)
        return true
      })
      const roles = {
        describeAbility,
        describeOwnedAbility: vi.fn(async (context, currentPrincipal, snapshot) =>
          describeAbility(context, currentPrincipal, snapshot.locator),
        ),
        withCurrentOwnedTarget,
        withOwnedTarget,
        setEnabled,
        inspectAndRemoveOwned,
        listRoleVersions: vi.fn(async () => []),
        findRoleBase: vi.fn(async () => null),
      } as unknown as RolesService
      const write = vi.fn(async (input, options) => {
        const physical = async () => ({
          id: input.originalId,
          filePath: input.originalId === 'MovedNote001' ? pathOf('project-b') : pathOf('project-a'),
          versionToken: `${input.originalId}-next`,
        })

        return options?.aroundWrite ? options.aroundWrite(physical) : physical()
      })
      const noteStore = vi.fn(async (_principal: Principal, noteId: string) => ({
        space: 'shared',
        store: {
          read: vi.fn(async () => noteOf(noteId)),
          write,
          removeDir: vi.fn(async (_path, options) => options?.beforeDetach?.([noteId])),
        } as unknown as SpaceStore,
      }))
      const abilities = createAbilities({
        roles,
        projects: {
          getById: vi.fn(async (id) => ({ id, space: 'shared' })),
          listForSpaces: vi.fn(async () => []),
        } as unknown as ProjectsPersistence,
        spaces: {
          list: () => [{ id: 'shared', slug: 'shared' }],
          has: () => true,
        } as unknown as SpaceManager,
        auth: { personalSpaceOf: vi.fn(async () => null) } as unknown as AuthService,
        store: { noteStore } as unknown as StoreAccess,
      })

      if (operation === 'get') {
        await expect(abilities.get('authoring', principal('write'), stale)).resolves.toMatchObject({
          ability: { locator: moved, noteId: 'MovedNote001' },
        })
      } else if (operation === 'save') {
        await abilities.save(principal('write'), stale, {
          content: '# Moved role\n\nUpdated.',
          description: 'Updated.',
          covers: ['project-b'],
          versionToken: 'MovedNote001-version',
        })
        expect(write).toHaveBeenCalledWith(
          expect.objectContaining({ originalId: 'MovedNote001' }),
          expect.objectContaining({ aroundWrite: expect.any(Function), resourceAdmitted: true }),
        )
      } else if (operation === 'edit') {
        await abilities.edit(principal('write'), stale, { enabled: false })
        expect(setEnabled).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          expect.objectContaining({ locator: moved, registryNoteId: 'MovedNote001' }),
          false,
        )
      } else {
        await abilities.remove(principal('write'), stale, { principal: 'pat:alice:write' })
        expect(inspectAndRemoveOwned).toHaveBeenCalledWith(
          expect.objectContaining(targetOf(moved, 'MovedNote001')),
          null,
          expect.objectContaining({ remove: expect.any(Function) }),
        )
      }

      expect(withCurrentOwnedTarget).toHaveBeenCalledWith(
        stale,
        expect.anything(),
        expect.any(Function),
        'read',
      )
      expect(describeAbility).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        stale,
        expect.anything(),
      )
    },
  )

  it.each(['get', 'save', 'edit', 'remove'] as const)(
    'keeps the admitted identity live through stale %s linearization',
    async (operation) => {
      let admitted = false
      let revalidating = false
      let reoccupied = false
      const authority = snapshotOf(owned, 'OwnedNote001')
      const withCurrentOwnedTarget = vi.fn(async (_locator, _principal, task) => {
        admitted = true
        try {
          return await task(authority)
        } finally {
          admitted = false
          reoccupied = operation === 'remove'
        }
      })
      const withOwnedTarget = vi.fn(async (target, _principal, task) => {
        if (reoccupied) {
          return null
        }
        revalidating = true
        try {
          return await task(snapshotOf(target.locator, target.registryNoteId))
        } finally {
          revalidating = false
        }
      })
      const describeAbility = vi.fn(async (_context, _principal, locator) => ({
        locator,
        source: 'owned' as const,
        title: 'Owned skill',
        name: 'owned-skill',
        description: 'Owned.',
        instructions: 'Owned instructions.',
        enabled: true,
        noteId: 'OwnedNote001',
        origin: 'custom' as const,
        availability: { mode: 'selected-projects' as const, projectIds: [] },
        truncated: false,
      }))
      const note = world().note
      const write = vi.fn(async (_input, options) => {
        const physical = async () => {
          if (!revalidating) {
            throw new Error('write escaped final target revalidation')
          }

          return { id: note.id, filePath: note.filePath, versionToken: 'next-version' }
        }

        return options?.aroundWrite ? options.aroundWrite(physical) : physical()
      })
      const removeDir = vi.fn()
      const inspectAndRemoveOwned = vi.fn(async (target) => {
        expect(target).toMatchObject(targetOf(owned, 'OwnedNote001'))
        if (reoccupied) {
          throw new AbilityUnavailableError('ability package changed before delete')
        }

        return true
      })
      const roles = {
        describeAbility,
        describeOwnedAbility: vi.fn(async (context, currentPrincipal, snapshot) =>
          describeAbility(context, currentPrincipal, snapshot.locator),
        ),
        withCurrentOwnedTarget,
        withOwnedTarget,
        inspectAndRemoveOwned,
        setAbilityAvailability: vi.fn(),
      } as unknown as RolesService
      const abilities = createAbilities({
        roles,
        spaces: {
          list: () => [{ id: 'shared', slug: 'shared' }],
          has: () => true,
        } as unknown as SpaceManager,
        auth: { personalSpaceOf: vi.fn(async () => null) } as unknown as AuthService,
        store: {
          noteStore: vi.fn(async () => ({
            space: 'shared',
            store: {
              read: vi.fn(async () => {
                if (!admitted) {
                  throw new Error('read escaped admitted identity')
                }

                return note
              }),
              write,
              removeDir,
            } as unknown as SpaceStore,
          })),
        } as unknown as StoreAccess,
      })

      if (operation === 'get') {
        await expect(abilities.get('authoring', principal('write'), owned)).resolves.toMatchObject({
          ability: { noteId: 'OwnedNote001' },
        })
      } else if (operation === 'save') {
        await expect(
          abilities.save(principal('write'), owned, {
            content: '# Owned skill\n\nUpdated.',
            description: 'Updated.',
            covers: [],
            versionToken: 'owned-version',
          }),
        ).resolves.toMatchObject({
          steps: [
            { step: 'document', outcome: 'applied' },
            { step: 'availability', outcome: 'failed' },
          ],
        })
        expect(write).toHaveBeenCalledOnce()
      } else if (operation === 'edit') {
        await expect(
          abilities.edit(principal('write'), owned, {
            instructions: '# Owned skill\n\nUpdated.',
            versionToken: 'owned-version',
          }),
        ).resolves.toMatchObject({ steps: [{ step: 'document', outcome: 'applied' }] })
        expect(write).toHaveBeenCalledOnce()
      } else {
        await expect(
          abilities.remove(principal('write'), owned, { principal: principal('write').id }),
        ).rejects.toThrow('not found')
        expect(removeDir).not.toHaveBeenCalled()
      }
    },
  )

  it('serves System read-only on the write surface without inventing a token', async () => {
    const { abilities } = world()
    const result = await abilities.get('authoring', principal('write'), system)

    expect(result).toMatchObject({ ability: { source: 'system' }, writable: false })
    expect(result).not.toHaveProperty('versionToken')
  })

  it('mints a document target only from a writable skill-root candidate', () => {
    const { abilities, note } = world()
    const candidate = {
      space: 'shared',
      store: {} as SpaceStore,
      note,
    }

    expect(abilities.authorizeDocument(principal('write'), candidate)).not.toBeNull()
    expect(abilities.authorizeDocument(principal('read'), candidate)).toBeNull()
    expect(
      abilities.authorizeDocument(principal('write'), {
        ...candidate,
        note: { ...note, documentState: documentState(DOCUMENT_ROLE.generic) },
      }),
    ).toBeNull()
  })

  it('keeps human skill-root delete package-wide when the manifest projection is invalid', async () => {
    const { abilities, note, removeDir } = world()
    const target = abilities.authorizeDocument(principal('write'), {
      space: 'shared',
      store: { removeDir } as unknown as SpaceStore,
      note: { ...note, documentState: documentState(DOCUMENT_ROLE.skillRoot) },
    })

    expect(target).not.toBeNull()
    await expect(
      abilities.removeDocument(principal('write'), target!, { principal: 'pat:alice:write' }),
    ).resolves.toBe(true)
    expect(removeDir).toHaveBeenCalledWith(
      '.notarium/skills/OwnedSkill01',
      expect.objectContaining({ internalAddress: true }),
    )

    const replacementRemoveDir = vi.fn(async (_path, options) =>
      options?.beforeDetach?.(['ReplacementNote']),
    )
    const replacementTarget = abilities.authorizeDocument(principal('write'), {
      space: 'shared',
      store: { removeDir: replacementRemoveDir } as unknown as SpaceStore,
      note: { ...note, documentState: documentState(DOCUMENT_ROLE.skillRoot) },
    })

    await expect(
      abilities.removeDocument(principal('write'), replacementTarget!, {
        principal: 'pat:alice:write',
      }),
    ).rejects.toThrow('not found')
  })

  it('binds human package delete to the live manifest path, not a sibling package id', async () => {
    const packageId = 'MovedRole001'
    const pathAt = (projectId: string) =>
      `.notarium/skills/_projects/${Buffer.from(projectId).toString('base64url')}/${packageId}/SKILL.md`
    const actual: OwnedAbilityLocator = {
      source: 'owned',
      kind: 'role',
      packageId,
      location: { scope: 'project', spaceId: 'shared', projectId: 'project-b' },
    }
    const withOwnedAt = vi.fn(
      async (location, _principal, _kind, _packageId, registryNoteId, task) =>
        location.scope === 'project' && location.projectId === 'project-b'
          ? task(targetOf(actual, registryNoteId))
          : null,
    )
    const inspectAndRemoveOwned = vi.fn(async (expected, _personal, options) => {
      await options.assertSafe(new Map([['SKILL.md', new Uint8Array()]]))
      await options.remove(async (victimNoteIds?: readonly string[]) => {
        if (!victimNoteIds?.includes(expected.registryNoteId)) {
          throw new AbilityUnavailableError('ability document changed before delete')
        }
      })
      return true
    })
    const roles = {
      withOwnedAt,
      manifestPath: vi.fn((location) =>
        location.scope === 'project'
          ? pathAt(location.projectId!)
          : `.notarium/skills/${packageId}/SKILL.md`,
      ),
      inspectAndRemoveOwned,
    } as unknown as RolesService
    const source = Buffer.from(
      `---\nnotarium-id: ${packageId}\nname: moved-role\nmetadata:\n  notarium.kind: role\n---\n\n# Moved role\n`,
    )
    const note: NoteContent = {
      id: 'MovedRoleNote',
      content: '# Moved role',
      frontmatter: {},
      versionToken: 'moved-version',
      filePath: pathAt('project-b'),
      documentState: analyzeDocumentState({
        source,
        role: DOCUMENT_ROLE.skillRoot,
        skillDirectoryName: packageId,
      }),
    }
    const removeDir = vi.fn(async (_path, options) => options?.beforeDetach?.([note.id!]))
    const abilities = createAbilities({
      roles,
      projects: {
        listForSpaces: vi.fn(async () => [
          { id: 'project-a', space: 'shared' },
          { id: 'project-b', space: 'shared' },
        ]),
      } as unknown as ProjectsPersistence,
      spaces: {
        list: () => [{ id: 'shared', slug: 'shared' }],
        has: () => true,
      } as unknown as SpaceManager,
      auth: { personalSpaceOf: vi.fn(async () => null) } as unknown as AuthService,
      store: {} as StoreAccess,
    })
    const target = abilities.authorizeDocument(principal('write'), {
      space: 'shared',
      store: { removeDir } as unknown as SpaceStore,
      note,
    })

    expect(target).not.toBeNull()
    await expect(
      abilities.removeDocument(principal('write'), target!, { principal: 'pat:alice:write' }),
    ).resolves.toBe(true)
    expect(inspectAndRemoveOwned).toHaveBeenCalledWith(
      targetOf(actual, note.id),
      null,
      expect.objectContaining({ assertSafe: expect.any(Function), remove: expect.any(Function) }),
    )
    expect(withOwnedAt).not.toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-a' }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    )
    expect(removeDir).toHaveBeenCalledWith(
      `.notarium/skills/_projects/${Buffer.from('project-b').toString('base64url')}/${packageId}`,
      expect.objectContaining({ internalAddress: true }),
    )

    const replacedRemoveDir = vi.fn(async (_path, options) =>
      options?.beforeDetach?.(['ReplacementNote']),
    )
    const replacedTarget = abilities.authorizeDocument(principal('write'), {
      space: 'shared',
      store: { removeDir: replacedRemoveDir } as unknown as SpaceStore,
      note,
    })

    expect(replacedTarget).not.toBeNull()
    await expect(
      abilities.removeDocument(principal('write'), replacedTarget!, {
        principal: 'pat:alice:write',
      }),
    ).rejects.toThrow('not found')
  })

  it.each([
    'references/checklist.md',
    '.private/hidden.md',
    'nested/deeper/notes.md',
    'references/UPPER.MD',
    'assets/template.bin',
    'assets/template.bin (symbolic link)',
  ])('fails closed on auxiliary package member %s inside the detach checkpoint', async (member) => {
    const { abilities, inspectAndRemoveOwned, removeDir } = world()

    inspectAndRemoveOwned.mockImplementationOnce(async (_locator, _personal, options) => {
      await options.assertSafe(
        new Map([
          ['SKILL.md', new Uint8Array()],
          [member, new Uint8Array()],
        ]),
      )
      return false
    })

    await expect(
      abilities.remove(principal('write'), owned, { principal: 'pat:alice:write' }),
    ).rejects.toThrow(`contains auxiliary member "${member}"`)
    expect((await abilities.get('human', principal('write'), owned))?.ability.name).toBe(
      'owned-skill',
    )
    expect(removeDir).not.toHaveBeenCalled()
  })

  it('fails closed on an empty auxiliary directory from the exact member roster', async () => {
    const { abilities, inspectAndRemoveOwned, removeDir } = world()

    inspectAndRemoveOwned.mockImplementationOnce(async (_locator, _personal, options) => {
      await options.assertSafe(new Map([['SKILL.md', new Uint8Array()]]), [
        'SKILL.md',
        'references',
      ])
      return false
    })

    await expect(
      abilities.remove(principal('write'), owned, { principal: 'pat:alice:write' }),
    ).rejects.toThrow('contains auxiliary member "references"')
    expect(removeDir).not.toHaveBeenCalled()
  })

  it('removes a single-SKILL.md package with one required tombstone', async () => {
    const { abilities, removeDir } = world()

    await expect(
      abilities.remove(principal('write'), owned, { principal: 'pat:alice:write' }),
    ).resolves.toMatchObject({ name: 'owned-skill' })
    expect(removeDir).toHaveBeenCalledWith(
      '.notarium/skills/OwnedSkill01',
      expect.objectContaining({
        internalAddress: true,
        requiredRevision: true,
        beforeDetach: expect.any(Function),
      }),
    )
  })

  it('keeps human multi-file package delete on its existing best-effort path', async () => {
    const { abilities, inspectAndRemoveOwned, note, removeDir } = world()

    inspectAndRemoveOwned.mockImplementationOnce(async (_locator, _personal, options) => {
      await options.assertSafe(
        new Map([
          ['SKILL.md', new Uint8Array()],
          ['references/checklist.md', new Uint8Array()],
          ['assets/template.bin', new Uint8Array()],
        ]),
      )
      await options.remove(async () => undefined)
      return true
    })
    const target = abilities.authorizeDocument(principal('write'), {
      space: 'shared',
      store: { removeDir } as unknown as SpaceStore,
      note,
    })

    expect(target).not.toBeNull()
    await expect(
      abilities.removeDocument(principal('write'), target!, { principal: 'pat:alice:write' }),
    ).resolves.toBe(true)
    expect(removeDir).toHaveBeenCalledWith(
      '.notarium/skills/OwnedSkill01',
      expect.not.objectContaining({ requiredRevision: true }),
    )
  })
})

describe('AbilitiesService agent discovery', () => {
  it('projects runtime winners separately from addressable authoring candidates', async () => {
    const { abilities } = discoveryWorld()
    const context = { personalSpace: 'personal' }
    const runtime = await abilities.list('runtime', context, principal('read'), { limit: 20 })
    const authoring = await abilities.list('authoring', context, principal('read'), { limit: 20 })

    expect(runtime.abilities).toMatchObject([
      expect.objectContaining({ name: 'broken', healthy: false }),
      expect.objectContaining({ name: 'research', source: 'system' }),
      expect.objectContaining({ name: 'summarize', kind: 'skill' }),
    ])
    expect(authoring.abilities.filter(({ name }) => name === 'research')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'system', effective: true }),
        expect.objectContaining({ source: 'owned', enabled: false, effective: false }),
      ]),
    )
  })

  it('uses compact keyset tokens bound to the view and filter fingerprint', async () => {
    const { abilities } = discoveryWorld()
    const context = { personalSpace: 'personal' }
    const first = await abilities.list('runtime', context, principal('read'), { limit: 1 })

    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]{16}$/)
    const second = await abilities.list('runtime', context, principal('read'), {
      limit: 1,
      cursor: first.nextCursor,
    })

    expect(second.abilities[0]?.name).not.toBe(first.abilities[0]?.name)
    await expect(
      abilities.list('authoring', context, principal('read'), {
        limit: 1,
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow('bad cursor')
  })

  it('binds discovery cursors to the resolved project identity', async () => {
    const { abilities } = discoveryWorld()
    const project = (id: string) => ({
      id,
      space: 'personal',
      path: id,
      slug: id,
      aliases: [],
      pathAliases: [],
      displayName: id,
      status: 'active' as const,
      createdAt: 'x',
      lastSeen: 'x',
    })
    const first = await abilities.list(
      'runtime',
      { personalSpace: 'personal', project: project('project-a') },
      principal('read'),
      { limit: 1 },
    )

    expect(first.nextCursor).toEqual(expect.any(String))
    await expect(
      abilities.list(
        'runtime',
        { personalSpace: 'personal', project: project('project-b') },
        principal('read'),
        { limit: 1, cursor: first.nextCursor },
      ),
    ).rejects.toThrow('bad cursor')
  })

  it('keeps bootstrap bundle independent from authoring version metadata', async () => {
    const { abilities, listRoleVersions } = discoveryWorld(true)

    await expect(
      abilities.list('bundle', { personalSpace: 'personal' }, principal('read'), { limit: 50 }),
    ).resolves.toMatchObject({
      abilities: [
        expect.objectContaining({ name: 'research', kind: 'role' }),
        expect.objectContaining({ name: 'summarize', kind: 'skill' }),
      ],
      truncated: false,
    })
    expect(listRoleVersions).not.toHaveBeenCalled()
  })
})

describe('AbilitiesService custom create lifecycle', () => {
  const manifest = (id: string) =>
    new Map([
      [
        'SKILL.md',
        Buffer.from(
          `---\nnotarium-id: ${id}\nname: reserved-skill\ndescription: Reserved skill.\n---\n\n# Reserved skill\n\nBody.\n`,
        ),
      ],
    ])

  it('delegates the prepared package and replay identity to the durable creator', async () => {
    const roles = {
      // Durable replay wins over mutable name inventories; the creator performs
      // the System/Owned checks only after it knows this is a fresh operation.
      hasSystemAbility: vi.fn(async () => true),
      // A committed durable replay is already visible by name. The outer service
      // must still reach the durable operation before the admitted name check.
      hasOwnedAbilityAt: vi.fn(async () => true),
      canAddSkillAt: vi.fn(() => true),
      prepareCustomSkill: vi.fn(() => ({
        directoryName: 'PkgPrepared1',
        files: manifest('PkgPrepared1'),
      })),
    } as unknown as RolesService
    const createDurably = vi.fn(
      async (input: Parameters<CustomAbilityCreator['createDurably']>[0]) => {
        const { pkg } = await input.preparePackage()
        expect(pkg.directoryName).toBe('PkgPrepared1')
        return {
          kind: 'skill' as const,
          body: input.prepared.body,
          location: input.prepared.location as never,
          ability: {
            name: 'reserved-skill',
            title: 'Reserved skill',
            description: 'Reserved skill.',
            scope: 'space' as const,
            space: 'shared',
            availability: { mode: 'selected-projects' as const, projectIds: ['project-one'] },
            packageId: 'PkgPrepared1',
            noteId: 'ActualNote01',
          },
          locator: {
            source: 'owned' as const,
            kind: 'skill' as const,
            packageId: 'PkgPrepared1',
            location: { scope: 'space' as const, spaceId: 'shared' },
          },
          versionToken: 'version-one',
          replayed: true,
        } as PublishedAbility
      },
    )
    const customCreator: CustomAbilityCreator = {
      createDurably,
    }
    const abilities = createAbilities({
      roles,
      spaces: {} as SpaceManager,
      auth: {} as AuthService,
      store: {} as StoreAccess,
      customCreator,
    })
    const prepared = {
      kind: 'skill',
      source: 'custom',
      body: {
        name: 'reserved-skill',
        description: 'Reserved skill.',
        instructions: '# Reserved skill\n\nBody.',
        scope: 'space',
        space: 'shared',
        availability: { mode: 'selected-projects', projects: ['shared/project'] },
      },
      principal: principal('write'),
      personalSpace: 'personal',
      location: { scope: 'space', space: 'shared' },
      availability: { mode: 'selected-projects', projectIds: ['project-one'] },
    } as unknown as PreparedAbilityCreate
    const created = await abilities.create(
      prepared,
      { principal: 'pat:alice:write' },
      { idempotencyKey: 'retry-one', scopeKey: 'shared/skill/reserved-skill' },
    )

    expect(created).toMatchObject({
      locator: { packageId: 'PkgPrepared1' },
      ability: { packageId: 'PkgPrepared1', noteId: 'ActualNote01' },
      versionToken: 'version-one',
      replayed: true,
    })
    expect(createDurably).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: {
          idempotencyKey: 'retry-one',
          scopeKey: 'shared/skill/reserved-skill',
          systemNamePolicy: 'allow',
        },
      }),
    )
  })

  it('allows human System overrides while an agent policy rejects only the same kind', async () => {
    const roles = {
      hasSystemAbility: vi.fn(async (kind: string) => kind === 'role'),
      hasOwnedAbilityAt: vi.fn(async () => false),
    } as unknown as RolesService
    const createDurably = vi.fn(async ({ prepared }) => {
      return { kind: prepared.kind } as unknown as PublishedAbility
    })
    const abilities = createAbilities({
      roles,
      spaces: {} as SpaceManager,
      auth: {} as AuthService,
      store: {} as StoreAccess,
      customCreator: { createDurably },
    })
    const role = {
      kind: 'role',
      source: 'custom',
      body: {
        name: 'research',
        description: 'Human override.',
        instructions: '# Research\n\nOverride.',
        scope: 'personal',
      },
      principal: principal('write'),
      personalSpace: 'personal',
      location: { scope: 'personal', space: 'personal' },
    } as unknown as PreparedAbilityCreate
    const skill = {
      ...role,
      kind: 'skill',
      body: { ...role.body, description: 'Cross-kind skill.' },
    } as unknown as PreparedAbilityCreate

    await expect(abilities.create(role)).resolves.toMatchObject({ kind: 'role' })
    await expect(abilities.create(role, undefined, { systemNamePolicy: 'reject' })).rejects.toThrow(
      'conflicts with a System ability',
    )
    await expect(
      abilities.create(skill, undefined, { systemNamePolicy: 'reject' }),
    ).resolves.toMatchObject({ kind: 'skill' })
    expect(createDurably).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ operation: { systemNamePolicy: 'allow' } }),
    )
    expect(createDurably).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ operation: { systemNamePolicy: 'reject' } }),
    )
  })
})
