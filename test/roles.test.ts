import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'

import { ABILITY_KIND, AbilityHealthSchema, type OwnedAbilityLocator } from '@notarium/contract'
import { exactOwnerObservation, parseAbilityLocator, serializeAbilityLocator } from '@notarium/core'

import { clientFailureOf } from '../packages/server/src/libs/clientFailure'
import { type Principal, SYSTEM_PRINCIPAL } from '../packages/server/src/services/authz'
import type { Ctx } from '../packages/server/src/services/mcp/gateway'
import { activateRole, activateSkill } from '../packages/server/src/services/mcp/tools/roles'
import { loadSavedSessionRole } from '../packages/server/src/services/mcp/tools/session/session'
import {
  AbilityUnavailableError,
  createInMemoryAbilityPlacement,
  createInMemoryRoleLibrary,
  createProjectedRolePackageScope,
  createRolesService,
  InMemoryAbilityAvailability,
  inMemoryAbilityPersistence,
  InMemoryAbilityPreferences,
  loadBundledAbilityInventory,
  packageRevision,
  parseRoleContextTarget,
  parseSkillFile,
  RoleAlreadyExistsError,
  roleContextTargetOf,
  RoleDependencyConflictError,
  RoleInstallUnavailableError,
  type RoleLibraryComposition,
  type RoleLocation,
  rolePackageMoveRollbackError,
  RolePlacementUnconfirmedError,
  type RolePublicationTarget,
  type RolesService,
  SkillAlreadyExistsError,
  type SkillPackage,
  withCatalogProvenance,
} from '../packages/server/src/services/roles'
import { interceptPublication, writableLibrary } from './roleLibraryComposition'

/** Everything an Owned library holds, in one answer. The service answers per KIND —
 *  no caller ever wants both — so a test about what Add LEFT there asks twice. */
const ownedNames = async (
  roles: RolesService,
  location: { scope: 'personal' | 'space' | 'project'; space: string; projectId?: string },
): Promise<string[]> => {
  const [roleListing, skillListing] = await Promise.all([
    roles.listOwnedAbilitiesAt(location, SYSTEM_PRINCIPAL, 'role'),
    roles.listOwnedAbilitiesAt(location, SYSTEM_PRINCIPAL, 'skill'),
  ])

  return [...roleListing.abilities, ...skillListing.abilities]
    .map(({ ability }) => ability.name)
    .sort()
}

const packageDirectoryOf = (name: string): string =>
  Buffer.from(name).toString('base64url').padEnd(12, 'A').slice(0, 12)

const loadedOf = <T>(outcome: { ok: boolean; loaded?: T }): T => {
  expect(outcome.ok).toBe(true)
  if (!outcome.loaded) {
    throw new Error('expected a loaded ability outcome')
  }

  return outcome.loaded
}

const capturedTarget = async (
  roles: RolesService,
  principal: Principal,
  locator: OwnedAbilityLocator,
) => {
  const target = await roles.captureCurrentOwnedTarget(locator, principal)

  if (!target) {
    throw new AbilityUnavailableError('no such Owned ability')
  }

  return target
}

const capturedRoleTarget = async (
  roles: RolesService,
  principal: Principal,
  locator: Extract<OwnedAbilityLocator, { kind: 'role' }>,
) => {
  const target = await capturedTarget(roles, principal, locator)

  if (target.locator.kind !== ABILITY_KIND.role) {
    throw new AbilityUnavailableError('no such Owned Role')
  }

  return { ...target, locator: target.locator }
}

const forkRoleVersion = async (
  roles: RolesService,
  principal: Principal,
  locator: Extract<OwnedAbilityLocator, { kind: 'role' }>,
  personalSpace: string | null,
  projectId: string,
) => {
  const source = await roles.captureCurrentOwnedTarget(locator, principal)

  if (!source || source.locator.kind !== ABILITY_KIND.role) {
    throw new AbilityUnavailableError('no such Owned Role')
  }

  return roles.createRoleVersion(
    principal,
    { ...source, locator: source.locator },
    personalSpace,
    projectId,
  )
}

const pkg = (name: string, description: string, body: string): SkillPackage => ({
  directoryName: packageDirectoryOf(name),
  files: new Map([
    [
      'SKILL.md',
      Buffer.from(
        `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  notarium.kind: role\n---\n\n${body}`,
      ),
    ],
  ]),
})

const skillPkg = (name: string, description: string, body = ''): SkillPackage => ({
  directoryName: packageDirectoryOf(name),
  files: new Map([
    ['SKILL.md', Buffer.from(`---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`)],
  ]),
})

const claimed = (source: SkillPackage, registryNoteId: string): SkillPackage => {
  const files = new Map(source.files)
  const manifest = Buffer.from(files.get('SKILL.md')!).toString('utf8')

  files.set(
    'SKILL.md',
    Buffer.from(manifest.replace('---\n', `---\nnotarium-id: ${registryNoteId}\n`)),
  )
  return { ...source, files }
}

const catalogPackage = (sourcePackage: SkillPackage): SkillPackage => {
  const files = new Map(sourcePackage.files)
  const raw = Buffer.from(files.get('SKILL.md')!).toString('utf8')
  const identity = `  notarium.source: catalog\n  notarium.package-id: ${sourcePackage.directoryName}\n`
  const manifest = raw.includes('\nmetadata:\n')
    ? raw.replace('\nmetadata:\n', `\nmetadata:\n${identity}`)
    : raw.replace('\n---\n', `\nmetadata:\n${identity}---\n`)

  files.set('SKILL.md', Buffer.from(manifest))
  return { ...sourcePackage, files }
}

describe('role catalog and owned libraries', () => {
  it('forwards the fenced raw-member roster through the owned removal adapter', async () => {
    const directoryName = 'AbCdefGhij_1'
    const composition = createInMemoryRoleLibrary()
    const files = new Map<string, Uint8Array>([
      [
        'SKILL.md',
        Buffer.from(
          '---\nname: roster-proof\ndescription: Roster forwarding proof.\n---\n\nInstructions.',
        ),
      ],
    ])
    const members = ['SKILL.md', 'references']
    const inspectAndRemove = vi.fn(async (_location, _packageId, options) => {
      await options.assertSafe({ directoryName, files }, members)
      return true
    })
    const roles = createRolesService({
      catalog: async () => [],
      ...composition,
      library: { ...composition.library, inspectAndRemove },
      ...inMemoryAbilityPersistence(),
    })
    const assertSafe = vi.fn()
    const remove = vi.fn()

    await expect(
      roles.inspectAndRemoveOwned(
        {
          locator: {
            source: 'owned',
            kind: 'skill',
            packageId: directoryName,
            location: { scope: 'personal', spaceId: 'personal' },
          },
          registryNoteId: 'RegistryNote1',
          manifestNoteId: 'ManifestNote1',
        },
        'personal',
        { assertSafe, remove },
      ),
    ).resolves.toBe(true)
    expect(assertSafe).toHaveBeenCalledWith(files, members)
    expect(inspectAndRemove).toHaveBeenCalledWith(
      { scope: 'personal', space: 'personal' },
      directoryName,
      expect.objectContaining({
        expected: {
          kind: 'skill',
          registryNoteId: 'RegistryNote1',
          manifestNoteId: 'ManifestNote1',
        },
        remove,
      }),
    )
  })

  it('rejects a recorded move target that changes package identity or Space', async () => {
    const stale = {
      source: 'owned',
      kind: 'role',
      packageId: 'AbCdefGhij_1',
      location: { scope: 'project', spaceId: 'shared', projectId: 'project-a' },
    } as const
    const invalidTargets = [
      {
        ...stale,
        kind: 'skill' as const,
        location: { scope: 'space' as const, spaceId: 'shared' },
      },
      {
        ...stale,
        location: { scope: 'space' as const, spaceId: 'other-space' },
      },
      {
        ...stale,
        packageId: 'ZyXwvUtsrq_2',
        location: { scope: 'space' as const, spaceId: 'shared' },
      },
      {
        source: 'system' as const,
        kind: 'role' as const,
        packageId: stale.packageId,
      },
    ]

    for (const invalid of invalidTargets) {
      const roles = createRolesService({
        ...inMemoryAbilityPersistence(),
        catalog: loadBundledAbilityInventory,
        ...createInMemoryRoleLibrary(),
        abilityPlacement: {
          resolveMovedOwnedRoleLocator: async () => ({
            toLocator: serializeAbilityLocator(invalid),
            registryNoteId: 'RegistryNote1',
            manifestNoteId: 'ManifestNote1',
          }),
          moveOwnedRolePlacement: async () => 'applied',
        },
      })

      await expect(roles.captureCurrentOwnedTarget(stale, SYSTEM_PRINCIPAL)).resolves.toBeNull()
    }
  })

  it('uses no-row input but lets a recorded identity retire a reoccupied source', async () => {
    const source = { scope: 'project' as const, space: 'shared', projectId: 'project-a' }
    const target = { scope: 'space' as const, space: 'shared' }
    const packageId = 'AbCdefGhij_1'
    const stale = {
      source: 'owned',
      kind: 'role',
      packageId,
      location: { scope: 'project', spaceId: 'shared', projectId: 'project-a' },
    } as const
    const moved = { ...stale, location: { scope: 'space', spaceId: 'shared' } } as const
    const backing = writableLibrary(createInMemoryRoleLibrary())
    const original = {
      ...claimed(pkg('original-role', 'Original.', 'Original body.'), 'ManifestOriginal'),
      directoryName: packageId,
    }
    const collision = {
      ...claimed(pkg('collision-role', 'Collision.', 'Collision body.'), 'CollisionManifest'),
      directoryName: packageId,
    }

    await backing.putIfAbsent(target, original)
    await backing.putIfAbsent(source, collision)
    let recorded: {
      toLocator: string
      registryNoteId: string
      manifestNoteId: string
    } | null = null
    const reads: RoleLocation[] = []
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: async () => [],
      publication: backing.deps.publication,
      library: {
        ...backing.deps.library,
        captureExactPackage: async (location, directoryName) => {
          reads.push(location)
          const snapshot = await backing.deps.library.captureExactPackage(location, directoryName)

          return snapshot
            ? {
                ...snapshot,
                registryNoteId:
                  location.scope === 'space' ? 'RegistryOriginal' : 'CollisionRegistry',
              }
            : null
        },
      },
      abilityPlacement: {
        resolveMovedOwnedRoleLocator: async () => recorded,
        moveOwnedRolePlacement: async () => 'applied',
      },
    })

    await expect(roles.captureCurrentOwnedTarget(stale, SYSTEM_PRINCIPAL)).resolves.toMatchObject({
      locator: stale,
    })
    expect(reads).toEqual([source])

    reads.length = 0
    recorded = {
      toLocator: serializeAbilityLocator(moved),
      registryNoteId: 'RegistryOriginal',
      manifestNoteId: 'ManifestOriginal',
    }
    await expect(roles.captureCurrentOwnedTarget(stale, SYSTEM_PRINCIPAL)).resolves.toMatchObject({
      locator: moved,
    })
    // The old placement is a TOMBSTONE once a row exists. Its live collision is never
    // even opened; only the recorded target is exact-read.
    expect(reads).toEqual([target])
  })

  it.each([
    ['missing target', null, 'OriginalRegistry', 'ManifestOriginal'],
    [
      'reoccupied target with stale projection',
      claimed(pkg('other-role', 'Other.', 'Other body.'), 'OtherRegistry'),
      'OriginalRegistry',
      'ManifestOriginal',
    ],
    [
      'wrong target kind',
      claimed(skillPkg('other-skill', 'Other skill.'), 'OriginalRegistry'),
      'OriginalRegistry',
      'OriginalRegistry',
    ],
    [
      'wrong projected identity',
      claimed(pkg('original-role', 'Original.', 'Body.'), 'OriginalRegistry'),
      'OtherRegistry',
      'OriginalRegistry',
    ],
  ] as const)(
    'fails closed on a recorded move with %s',
    async (_case, targetPackage, projectedRegistryNoteId, recordedManifestNoteId) => {
      const source = { scope: 'project' as const, space: 'shared', projectId: 'project-a' }
      const target = { scope: 'space' as const, space: 'shared' }
      const packageId = 'AbCdefGhij_1'
      const stale = {
        source: 'owned',
        kind: 'role',
        packageId,
        location: { scope: 'project', spaceId: 'shared', projectId: 'project-a' },
      } as const
      const moved = { ...stale, location: { scope: 'space', spaceId: 'shared' } } as const
      const backing = writableLibrary(createInMemoryRoleLibrary())

      await backing.putIfAbsent(source, {
        ...pkg('collision-role', 'Collision.', 'Collision body.'),
        directoryName: packageId,
      })
      if (targetPackage) {
        await backing.putIfAbsent(target, { ...targetPackage, directoryName: packageId })
      }
      const roles = createRolesService({
        ...inMemoryAbilityPersistence(),
        catalog: async () => [],
        publication: backing.deps.publication,
        library: {
          ...backing.deps.library,
          captureExactPackage: async (location, directoryName) => {
            const snapshot = await backing.deps.library.captureExactPackage(location, directoryName)

            return snapshot ? { ...snapshot, registryNoteId: projectedRegistryNoteId } : null
          },
        },
        abilityPlacement: {
          resolveMovedOwnedRoleLocator: async () => ({
            toLocator: serializeAbilityLocator(moved),
            registryNoteId: 'OriginalRegistry',
            manifestNoteId: recordedManifestNoteId,
          }),
          moveOwnedRolePlacement: async () => 'applied',
        },
      })

      await expect(roles.captureCurrentOwnedTarget(stale, SYSTEM_PRINCIPAL)).resolves.toBeNull()
    },
  )

  it('fails closed on a recorded target whose exact manifest is corrupt', async () => {
    const packageId = 'AbCdefGhij_1'
    const stale = {
      source: 'owned',
      kind: 'role',
      packageId,
      location: { scope: 'project', spaceId: 'shared', projectId: 'project-a' },
    } as const
    const moved = { ...stale, location: { scope: 'space', spaceId: 'shared' } } as const
    const composition = createInMemoryRoleLibrary()
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: async () => [],
      publication: composition.publication,
      library: {
        ...composition.library,
        captureExactPackage: async () => ({
          pkg: {
            directoryName: packageId,
            files: new Map([['SKILL.md', Buffer.from('not valid frontmatter')]]),
          },
          kind: ABILITY_KIND.role,
          registryNoteId: 'OriginalRegistry',
          manifestNoteId: 'OriginalRegistry',
          filePath: `.notarium/skills/${packageId}/SKILL.md`,
          versionToken: 'invalid-version',
        }),
      },
      abilityPlacement: {
        resolveMovedOwnedRoleLocator: async () => ({
          toLocator: serializeAbilityLocator(moved),
          registryNoteId: 'OriginalRegistry',
          manifestNoteId: 'OriginalRegistry',
        }),
        moveOwnedRolePlacement: async () => 'applied',
      },
    })

    await expect(roles.captureCurrentOwnedTarget(stale, SYSTEM_PRINCIPAL)).resolves.toBeNull()
  })

  it('retries authority when a back-move commits while the shared read waits', async () => {
    const source = { scope: 'project' as const, space: 'shared', projectId: 'project-a' }
    const target = { scope: 'space' as const, space: 'shared' }
    const packageId = 'AbCdefGhij_1'
    const stale = {
      source: 'owned',
      kind: 'role',
      packageId,
      location: { scope: 'project', spaceId: 'shared', projectId: 'project-a' },
    } as const
    const moved = { ...stale, location: { scope: 'space', spaceId: 'shared' } } as const
    const backing = writableLibrary(createInMemoryRoleLibrary())

    await backing.putIfAbsent(target, {
      ...claimed(pkg('original-role', 'Original.', 'Original body.'), packageId),
      directoryName: packageId,
    })
    const hop = {
      toLocator: serializeAbilityLocator(moved),
      registryNoteId: packageId,
      manifestNoteId: packageId,
    }
    let authorityReads = 0
    const readLocations: RoleLocation[] = []
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: async () => [],
      publication: backing.deps.publication,
      library: {
        ...backing.deps.library,
        captureExactPackage: (location, directoryName) => {
          readLocations.push(location)
          return backing.deps.library.captureExactPackage(location, directoryName)
        },
      },
      abilityPlacement: {
        // First selection says source. Its under-lease recheck sees the move; the
        // second selection and recheck agree on target.
        resolveMovedOwnedRoleLocator: async () => (++authorityReads === 1 ? null : hop),
        moveOwnedRolePlacement: async () => 'applied',
      },
    })

    await expect(roles.captureCurrentOwnedTarget(stale, SYSTEM_PRINCIPAL)).resolves.toMatchObject({
      locator: moved,
    })
    expect(readLocations).toEqual([source, target])
    expect(authorityReads).toBe(4)
  })

  it.each([
    ['same kind', claimed(pkg('review', 'Replacement.', 'Replacement body.'), 'ReplacementId')],
    ['cross kind', claimed(skillPkg('review', 'Replacement skill.'), 'ReplacementSkillId')],
  ] as const)(
    'rejects a carried target reoccupied by %s at the same address and name',
    async (_case, replacement) => {
      const packageId = 'AbCdefGhij_1'
      const locator = {
        source: 'owned' as const,
        kind: 'role' as const,
        packageId,
        location: { scope: 'space' as const, spaceId: 'shared' },
      }
      const original = claimed(pkg('review', 'Original.', 'Original body.'), 'OriginalId')
      let current = { ...original, directoryName: packageId }
      let registryNoteId = 'OriginalRegistry'

      const exact: RoleLibraryComposition['library']['captureExactPackage'] = async () => {
        const manifest = current.files.get('SKILL.md')!
        const owner = exactOwnerObservation(manifest)
        const parsed = parseSkillFile(Buffer.from(manifest).toString('utf8'), current.directoryName)

        return owner.kind === 'claimed'
          ? {
              pkg: current,
              kind: parsed.role ? ABILITY_KIND.role : ABILITY_KIND.skill,
              registryNoteId,
              manifestNoteId: owner.id,
              filePath: `.notarium/skills/${current.directoryName}/SKILL.md`,
              versionToken: 'current-version',
            }
          : null
      }
      const composition = createInMemoryRoleLibrary()
      const roles = createRolesService({
        ...inMemoryAbilityPersistence(),
        catalog: async () => [],
        publication: composition.publication,
        library: {
          ...composition.library,
          captureExactPackage: exact,
          withExactPackageMutation: async (location, directoryName, expected, task) => {
            const snapshot = await exact(location, directoryName)

            return snapshot &&
              snapshot.kind === expected.kind &&
              snapshot.registryNoteId === expected.registryNoteId &&
              snapshot.manifestNoteId === expected.manifestNoteId
              ? task(snapshot)
              : null
          },
        },
      })
      const target = await roles.captureCurrentOwnedTarget(locator, SYSTEM_PRINCIPAL)

      expect(target).toMatchObject({
        registryNoteId: 'OriginalRegistry',
        manifestNoteId: 'OriginalId',
      })
      current = { ...replacement, directoryName: packageId }
      registryNoteId = 'ReplacementRegistry'
      const called = vi.fn()

      await expect(
        roles.withOwnedTargetMutation(target!, SYSTEM_PRINCIPAL, async (proof) => {
          called(proof)
          return true
        }),
      ).resolves.toBeNull()
      expect(called).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['same kind', claimed(pkg('review', 'Replacement.', 'Replacement body.'), 'ReplacementId')],
    ['cross kind', claimed(skillPkg('review', 'Replacement skill.'), 'ReplacementSkillId')],
  ] as const)(
    'rechecks move source kind and both identities under admission after %s replacement',
    async (_case, replacement) => {
      const source = { scope: 'project' as const, space: 'shared', projectId: 'project-web' }
      const destination = { scope: 'space' as const, space: 'shared' }
      const packageId = 'AbCdefGhij_1'
      const composition = createInMemoryRoleLibrary()
      const library = writableLibrary(composition)

      await library.putIfAbsent(source, {
        ...claimed(pkg('review', 'Original.', 'Original body.'), 'OriginalId'),
        directoryName: packageId,
      })
      ;(composition.library as typeof composition.library & { clear(): void }).clear()
      await library.putIfAbsent(source, { ...replacement, directoryName: packageId })
      const publisher = await composition.publication.publicationFor(destination)

      expect(publisher).not.toBeNull()
      await expect(
        publisher!.moveFrom(
          source,
          packageId,
          {
            kind: ABILITY_KIND.role,
            registryNoteId: packageId,
            manifestNoteId: 'OriginalId',
          },
          {
            beforeMove: async () => undefined,
            finalize: async () => undefined,
            rollback: async () => undefined,
          },
        ),
      ).rejects.toBeInstanceOf(AbilityUnavailableError)
      await expect(library.getByDirectory(source, packageId)).resolves.not.toBeNull()
      await expect(library.getByDirectory(destination, packageId)).resolves.toBeNull()
    },
  )

  it('does not persist a session role when context assembly fails', async () => {
    const setRole = vi.fn()
    const contextFailure = new Error('context store unavailable')
    const ctx = {
      roles: {},
      agentSessions: { setRole },
      session: {},
      personalSpace: () => Promise.reject(contextFailure),
    } as unknown as Ctx

    await expect(
      activateRole(ctx, { personalSpace: 'personal' }, 'research', 4_000, {
        source: 'owned',
        role: {
          source: 'owned',
          name: 'research',
          title: 'Research',
          description: 'Research.',
          instructions: 'Research carefully.',
          scope: 'personal',
        },
        skills: [],
        truncated: false,
        location: { scope: 'personal', space: 'personal' },
        packageId: 'AbCdefGhij_1',
        locator: {
          source: 'owned',
          kind: 'role',
          packageId: 'AbCdefGhij_1',
          location: { scope: 'personal', spaceId: 'personal' },
        },
      }),
    ).rejects.toBe(contextFailure)
    expect(setRole).not.toHaveBeenCalled()
  })

  it('derives one reversible stable context target per exact owned placement', () => {
    const personal = roleContextTargetOf({
      role: { name: 'research' },
      location: { scope: 'personal', space: 'space:one' },
      packageId: 'AbCdefGhij_1',
    })
    const project = roleContextTargetOf({
      role: { name: 'research' },
      location: { scope: 'project', space: 'shared', projectId: 'project:one' },
      packageId: 'ZyXwvUtsrq_2',
    })

    expect(personal.id).not.toBe(project.id)
    expect(parseRoleContextTarget(personal.id)).toEqual({
      scope: 'personal',
      ownerId: 'space:one',
      packageId: 'AbCdefGhij_1',
    })
    expect(parseRoleContextTarget(project.id)).toEqual({
      scope: 'project',
      ownerId: 'project:one',
      packageId: 'ZyXwvUtsrq_2',
    })
    expect(parseRoleContextTarget('project:broken')).toBeNull()
  })

  it('keeps Catalog packages discovery-only until Add copies a role and its linked skill', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      ...library.deps,
      ...inMemoryAbilityPersistence(),
    })
    const context = { personalSpace: 'space-personal' }

    expect(
      (await roles.listBundledAbilities(SYSTEM_PRINCIPAL))
        .filter(({ source, locator }) => source === 'catalog' && locator.kind === 'role')
        .map(({ name }) => name),
    ).toEqual(['grooming'])
    // Discovery-only means nothing has been ADDED yet. A System role ships with the
    // host and is effective without an Add, so the claim is about the Owned arm.
    expect(
      await roles.listEffective(context, SYSTEM_PRINCIPAL).then(({ roles: listed, truncated }) => ({
        owned: listed.filter((role) => role.source === 'owned'),
        truncated,
      })),
    ).toEqual({
      owned: [],
      truncated: false,
    })
    const catalogRole = (await roles.listBundledAbilities(SYSTEM_PRINCIPAL)).find(
      ({ source, locator }) => source === 'catalog' && locator.kind === 'role',
    )!

    expect(
      await roles.describeAbility(context, SYSTEM_PRINCIPAL, catalogRole.locator, 4_000),
    ).toMatchObject({
      name: 'grooming',
      title: 'Grooming',
      source: 'catalog',
      instructions: expect.stringContaining('Establish the underlying pain'),
      truncated: false,
    })
    expect(
      (await roles.listBundledAbilities(SYSTEM_PRINCIPAL))
        .filter(({ source, locator }) => source === 'catalog' && locator.kind === 'skill')
        .map(({ name }) => name),
    ).toEqual(['grooming-evidence'])
    const catalogSkill = (await roles.listBundledAbilities(SYSTEM_PRINCIPAL)).find(
      ({ source, locator }) => source === 'catalog' && locator.kind === 'skill',
    )!

    expect(
      await roles.describeAbility(context, SYSTEM_PRINCIPAL, catalogSkill.locator, 4_000),
    ).toMatchObject({
      name: 'grooming-evidence',
      title: 'Evidence for grooming',
      source: 'catalog',
      instructions: expect.stringContaining('Read the current product contract'),
      truncated: false,
    })

    const added = await roles.addFromCatalog(
      'grooming',
      {
        scope: 'personal',
        space: 'space-personal',
      },
      null,
    )
    expect(added).toMatchObject({
      name: 'grooming',
      scope: 'personal',
      origin: 'catalog:KMVMY5-vK4y1',
    })
    expect(added.originRevision).toMatch(/^sha256:[a-f0-9]{64}$/)
    const installedRole = (await library.get(
      { scope: 'personal', space: 'space-personal' },
      'grooming',
    ))!
    expect(installedRole.directoryName).toMatch(/^[A-Za-z0-9_-]{12}$/)
    const installedRoleManifest = Buffer.from(installedRole.files.get('SKILL.md')!).toString('utf8')
    expect(installedRoleManifest).toContain(`notarium-id: ${installedRole.directoryName}`)
    expect(installedRoleManifest).not.toContain('notarium.source:')
    expect(installedRoleManifest).not.toContain('notarium.package-id:')
    const installedDependency = (await library.get(
      { scope: 'personal', space: 'space-personal' },
      'grooming-evidence',
    ))!
    expect(Buffer.from(installedRole.files.get('SKILL.md')!).toString('utf8')).toContain(
      `[[notarium-id:personal:${installedDependency.directoryName}|grooming-evidence]]`,
    )
    const location = { scope: 'personal' as const, space: 'space-personal' }
    const owned = await ownedNames(roles, location)

    // Exactly two, not "at least these": Add copies the role AND the one skill it
    // links, and copying anything else would be the failure this test is here for.
    expect(owned).toEqual(['grooming', 'grooming-evidence'])
    expect(await roles.listOwnedAbilitiesAt(location, SYSTEM_PRINCIPAL, 'skill')).toMatchObject({
      abilities: expect.arrayContaining([
        {
          ability: expect.objectContaining({
            name: 'grooming-evidence',
            source: 'owned',
            origin: 'catalog',
            originRevision: expect.stringMatching(/^sha256:/),
            noteId: installedDependency.directoryName,
          }),
        },
      ]),
      truncated: false,
    })
    expect(await roles.listEffective(context, SYSTEM_PRINCIPAL)).toMatchObject({
      roles: expect.arrayContaining([
        expect.objectContaining({ name: 'grooming', source: 'owned', scope: 'personal' }),
      ]),
      truncated: false,
    })
    expect(await roles.loadEffective(context, SYSTEM_PRINCIPAL, 'grooming', 4_000)).toMatchObject({
      ok: true,
      loaded: {
        role: { name: 'grooming' },
        location: { scope: 'personal', space: 'space-personal' },
        skills: [{ name: 'grooming-evidence' }],
        truncated: false,
      },
    })
  })

  /** Stated against the pair MCP actually calls, because a source the resolver cannot
   *  reach there is not a source at all. This rule used to be proven twice: once here
   *  and once against a second, human-facing pair with its own System fallback and no
   *  production caller — so the proof that mattered rested on the copy nothing ran. */
  it('activates System roles by default and lets the owner disable them', async () => {
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      ...writableLibrary(createInMemoryRoleLibrary()).deps,
      ...inMemoryAbilityPersistence(),
    })
    const context = { personalSpace: null }
    const locator = { source: 'system', kind: 'role', packageId: 'ZME09f9AROG8' } as const

    await expect(roles.listEffective(context, SYSTEM_PRINCIPAL)).resolves.toMatchObject({
      roles: [{ name: 'research', source: 'system' }],
    })
    await expect(
      roles.resolveEffective(context, SYSTEM_PRINCIPAL, 'research'),
    ).resolves.toMatchObject({ role: { name: 'research', source: 'system' }, locator })
    // Loading is a typed outcome: success carries the resolved package, while a
    // disabled System candidate stays diagnosable instead of collapsing to null.
    await expect(
      roles.loadEffective(context, SYSTEM_PRINCIPAL, 'research', 4_000),
    ).resolves.toMatchObject({
      ok: true,
      loaded: {
        role: { name: 'research', source: 'system' },
        locator,
        skills: [{ name: 'research-evidence' }],
      },
    })

    await roles.setEnabled(context, SYSTEM_PRINCIPAL, locator, false)
    await expect(roles.listEffective(context, SYSTEM_PRINCIPAL)).resolves.toEqual({
      roles: [],
      truncated: false,
    })
    await expect(roles.resolveEffective(context, SYSTEM_PRINCIPAL, 'research')).resolves.toBeNull()
    await expect(
      roles.loadEffective(context, SYSTEM_PRINCIPAL, 'research', 4_000),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'disabled',
      source: 'system',
      access: 'system',
      remediation: [{ kind: 'open-agents-ui' }],
    })
  })

  /** Activation without resume is half a link: the episode would raise the role once
   *  and lose it on the next call. The binding is stored by locator, so the System arm
   *  has to survive the same round trip the Owned arm does. */
  it('resumes a System role from its saved binding, and drops it when disabled', async () => {
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      ...writableLibrary(createInMemoryRoleLibrary()).deps,
      ...inMemoryAbilityPersistence(),
    })
    const context = { personalSpace: null }
    const locator = { source: 'system', kind: 'role', packageId: 'ZME09f9AROG8' } as const

    await expect(
      roles.loadSavedRole(context, SYSTEM_PRINCIPAL, locator, 4_000),
    ).resolves.toMatchObject({
      ok: true,
      loaded: {
        source: 'system',
        role: { source: 'system', name: 'research' },
        skills: [{ name: 'research-evidence' }],
        locator,
      },
    })

    await roles.setEnabled(context, SYSTEM_PRINCIPAL, locator, false)
    await expect(
      roles.loadSavedRole(context, SYSTEM_PRINCIPAL, locator, 4_000),
    ).resolves.toMatchObject({ ok: false, reason: 'disabled', source: 'system' })
  })

  it('uses Owned over System, but an explicit disable reveals the System fallback', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      ...library.deps,
      ...inMemoryAbilityPersistence(),
    })
    const context = { personalSpace: 'personal' }
    const created = await roles.createCustomRole(
      'research',
      'Personal research.',
      'Personal instructions.',
      { scope: 'personal', space: 'personal' },
    )
    const locator = {
      source: 'owned',
      kind: 'role',
      packageId: created.noteId,
      location: { scope: 'personal', spaceId: 'personal' },
    } as const

    await expect(
      roles.loadEffective(context, SYSTEM_PRINCIPAL, 'research', 4_000),
    ).resolves.toMatchObject({
      ok: true,
      loaded: { role: { source: 'owned', instructions: 'Personal instructions.' } },
    })
    await roles.setEnabled(
      context,
      SYSTEM_PRINCIPAL,
      await capturedTarget(roles, SYSTEM_PRINCIPAL, locator),
      false,
    )
    await expect(
      roles.loadEffective(context, SYSTEM_PRINCIPAL, 'research', 4_000),
    ).resolves.toMatchObject({ ok: true, loaded: { role: { source: 'system' } } })
  })

  it('skips wrong-kind and disabled Owned candidates before choosing a broader fallback', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      ...library.deps,
      ...inMemoryAbilityPersistence(),
    })
    const context = {
      personalSpace: 'personal',
      project: {
        id: 'project-a',
        space: 'shared',
        path: 'main',
        slug: 'main',
        aliases: [],
        pathAliases: [],
        displayName: 'Main',
        status: 'active' as const,
        createdAt: 'x',
        lastSeen: 'x',
      },
    }
    const personal = await roles.createCustomRole(
      'fallback-role',
      'Personal fallback.',
      'Use the personal fallback.',
      { scope: 'personal', space: 'personal' },
    )
    const shared = await roles.createCustomRole(
      'fallback-role',
      'Disabled shared role.',
      'Do not use this role.',
      { scope: 'space', space: 'shared' },
    )
    await roles.setEnabled(
      context,
      SYSTEM_PRINCIPAL,
      await capturedTarget(roles, SYSTEM_PRINCIPAL, {
        source: 'owned',
        kind: 'role',
        packageId: shared.noteId,
        location: { scope: 'space', spaceId: 'shared' },
      }),
      false,
    )
    await library.putIfAbsent(
      { scope: 'project', space: 'shared', projectId: 'project-a' },
      {
        ...skillPkg('fallback-role', 'A narrower Skill, not a Role.'),
        directoryName: 'ProjSkill__1',
      },
    )

    const expectedLocator = {
      source: 'owned',
      kind: 'role',
      packageId: personal.noteId,
      location: { scope: 'personal', spaceId: 'personal' },
    }
    // The list names the winner by SOURCE and SCOPE — the only form a summary carries;
    // the two by-name doors carry the address itself, so that is where it is asserted.
    await expect(roles.listEffective(context, SYSTEM_PRINCIPAL)).resolves.toMatchObject({
      roles: expect.arrayContaining([
        expect.objectContaining({ name: 'fallback-role', source: 'owned', scope: 'personal' }),
      ]),
    })
    await expect(
      roles.resolveEffective(context, SYSTEM_PRINCIPAL, 'fallback-role'),
    ).resolves.toMatchObject({
      location: { scope: 'personal', space: 'personal' },
      locator: expectedLocator,
    })
    await expect(
      roles.loadEffective(context, SYSTEM_PRINCIPAL, 'fallback-role', 4_000),
    ).resolves.toMatchObject({
      ok: true,
      loaded: {
        location: { scope: 'personal', space: 'personal' },
        locator: expectedLocator,
      },
    })
    const resolution = await roles.listAbilityResolution(context, SYSTEM_PRINCIPAL)

    expect(
      resolution.candidates.filter(({ kind, name }) => kind === 'role' && name === 'fallback-role'),
    ).toMatchObject([
      expect.objectContaining({ source: 'owned', enabled: true, effective: true }),
      expect.objectContaining({ source: 'owned', enabled: false, effective: false }),
    ])
  })

  it('uses one reach-aware winner kernel for standalone skills and role discovery', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const abilityAvailability = new InMemoryAbilityAvailability()
    const roles = createRolesService({
      catalog: async () => [],
      ...library.deps,
      ...inMemoryAbilityPersistence(),
      abilityAvailability,
    })
    const context = {
      personalSpace: 'personal',
      project: {
        id: 'project-a',
        space: 'shared',
        path: 'main',
        slug: 'main',
        aliases: [],
        pathAliases: [],
        displayName: 'Main',
        status: 'active' as const,
        createdAt: 'x',
        lastSeen: 'x',
      },
    }
    await roles.createCustomSkill('standalone', 'Personal fallback.', 'Personal body.', {
      scope: 'personal',
      space: 'personal',
    })
    const shared = await roles.createCustomSkill(
      'standalone',
      'Shared candidate.',
      'Shared body.',
      { scope: 'space', space: 'shared' },
      { mode: 'selected-projects', projectIds: ['project-b'] },
    )
    const first = (await roles.listAbilityResolution(context, SYSTEM_PRINCIPAL)).candidates.filter(
      ({ kind, name }) => kind === 'skill' && name === 'standalone',
    )

    expect(first).toMatchObject([
      expect.objectContaining({
        location: expect.objectContaining({ scope: 'personal' }),
        effective: true,
      }),
      expect.objectContaining({
        location: expect.objectContaining({ scope: 'space' }),
        effective: false,
      }),
    ])
    await abilityAvailability.set('shared', shared.packageId, {
      mode: 'selected-projects',
      projectIds: ['project-a'],
    })
    const second = (await roles.listAbilityResolution(context, SYSTEM_PRINCIPAL)).candidates.filter(
      ({ kind, name }) => kind === 'skill' && name === 'standalone',
    )

    expect(second).toMatchObject([
      expect.objectContaining({
        location: expect.objectContaining({ scope: 'personal' }),
        effective: false,
      }),
      expect.objectContaining({
        location: expect.objectContaining({ scope: 'space' }),
        effective: true,
      }),
    ])
    const outsideProject = (
      await roles.listAbilityResolution({ personalSpace: 'personal' }, SYSTEM_PRINCIPAL)
    ).candidates.filter(({ kind, name }) => kind === 'skill' && name === 'standalone')

    expect(outsideProject).toMatchObject([
      expect.objectContaining({
        location: expect.objectContaining({ scope: 'personal' }),
        effective: true,
      }),
    ])
  })

  it('rejects a Space locator alias for a package in the Personal root', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      ...library.deps,
      ...inMemoryAbilityPersistence(),
    })
    const created = await roles.createCustomRole(
      'personal-only',
      'Personal only.',
      'Personal instructions.',
      { scope: 'personal', space: 'personal' },
    )

    await expect(
      roles.describeAbility(
        { personalSpace: 'personal' },
        SYSTEM_PRINCIPAL,
        {
          source: 'owned',
          kind: 'role',
          packageId: created.noteId,
          location: { scope: 'space', spaceId: 'personal' },
        },
        4_000,
      ),
    ).resolves.toBeNull()
  })

  it('rejects duplicate exact identities in the bundled inventory', async () => {
    const inventory = await loadBundledAbilityInventory()
    const grooming = inventory.find(({ directoryName }) => directoryName === 'grooming')!
    const duplicate = {
      directoryName: 'grooming-copy',
      files: new Map(grooming.files),
    }
    const roles = createRolesService({
      catalog: async () => [...inventory, duplicate],
      ...writableLibrary(createInMemoryRoleLibrary()).deps,
      ...inMemoryAbilityPersistence(),
    })

    await expect(roles.listBundledAbilities(SYSTEM_PRINCIPAL)).rejects.toThrow(
      /duplicate bundled ability identity/,
    )
  })

  it('copies the skills a Catalog role links, and no others', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const linked = skillPkg('linked-evidence', 'The one the role names.', 'Linked body.')
    const bystander = skillPkg('other-evidence', 'A skill the role never names.', 'Other body.')
    const role = pkg('bundled-role', 'Bundled role.', 'Body.')

    role.files.set(
      'SKILL.md',
      Buffer.from(
        `---\nname: bundled-role\ndescription: Bundled role.\nmetadata:\n  notarium.kind: role\n  notarium.skills: "[[linked-evidence]]"\n---\n\nBody.`,
      ),
    )
    const roles = createRolesService({
      catalog: async () => [role, linked, bystander].map(catalogPackage),
      ...library.deps,
      ...inMemoryAbilityPersistence(),
    })
    const location = { scope: 'personal' as const, space: 'space-personal' }

    await roles.addFromCatalog('bundled-role', location, null)

    // Add forks ONE coherent bundle. The Catalog stays discovery-only, so a skill the
    // role does not name has no business landing in the owner's library — and with a
    // catalog of one skill nothing could tell the two behaviours apart.
    await expect(ownedNames(roles, location)).resolves.toEqual(['bundled-role', 'linked-evidence'])
  })

  it('asks the inventory again after a read that failed', async () => {
    const inventory = await loadBundledAbilityInventory()
    let reads = 0
    const roles = createRolesService({
      catalog: async () => {
        reads += 1

        if (reads === 1) {
          throw new Error('bundled ability inventory is missing from the artifact')
        }

        return inventory
      },
      ...writableLibrary(createInMemoryRoleLibrary()).deps,
      ...inMemoryAbilityPersistence(),
    })

    await expect(roles.listBundledAbilities(SYSTEM_PRINCIPAL)).rejects.toThrow(/missing/)
    // A memoized failure would outlive whatever caused it and pin the whole process
    // to its first bad read — the Catalog would stay empty until a restart.
    await expect(roles.listBundledAbilities(SYSTEM_PRINCIPAL)).resolves.not.toHaveLength(0)
  })

  it('preserves malformed exact attachments in health and never falls back past them', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      ...library.deps,
      ...inMemoryAbilityPersistence(),
    })
    const role = pkg('research', 'Broken replacement.', 'Broken instructions.')
    role.files.set(
      'SKILL.md',
      Buffer.from(
        '---\nname: research\ndescription: Broken replacement.\nmetadata:\n  notarium.kind: role\n  notarium.skills: "[[notarium-id:space:broken|evidence]]"\n---\n\nBroken instructions.',
      ),
    )
    await library.putIfAbsent(
      { scope: 'personal', space: 'personal' },
      claimed(role, role.directoryName),
    )
    const locator = {
      source: 'owned',
      kind: 'role',
      packageId: role.directoryName,
      location: { scope: 'personal', spaceId: 'personal' },
    } as const

    await expect(
      roles.describeAbility({ personalSpace: 'personal' }, SYSTEM_PRINCIPAL, locator, 4_000),
    ).resolves.toMatchObject({
      health: {
        healthy: false,
        attachments: [
          {
            attachment: {
              kind: 'invalid',
              raw: '[[notarium-id:space:broken|evidence]]',
            },
            health: 'invalid-locator',
          },
        ],
      },
    })
    await expect(
      roles.loadEffective({ personalSpace: 'personal' }, SYSTEM_PRINCIPAL, 'research', 4_000),
    ).resolves.toMatchObject({ ok: false, reason: 'unhealthy' })

    await expect(
      roles.serializeOwnedRoleAttachments(
        SYSTEM_PRINCIPAL,
        locator,
        [
          {
            kind: 'invalid',
            raw: '[[notarium-id:space:broken|evidence]]',
            reason: 'invalid-locator',
          },
        ],
        'personal',
      ),
    ).resolves.toMatchObject({ links: ['[[notarium-id:space:broken|evidence]]'] })
    await expect(
      roles.serializeOwnedRoleAttachments(SYSTEM_PRINCIPAL, locator, [], 'personal'),
    ).resolves.toMatchObject({ links: [] })
    await expect(
      roles.serializeOwnedRoleAttachments(
        SYSTEM_PRINCIPAL,
        locator,
        [
          {
            kind: 'invalid',
            raw: '[[notarium-id:space:different|evidence]]',
            reason: 'invalid-locator',
          },
        ],
        'personal',
      ),
    ).rejects.toBeInstanceOf(RoleDependencyConflictError)
  })

  /** Reading is deliberately wider than writing: the wire carries every token the parser
   *  produces, so a hand-edited package stays OPENABLE. Writing is narrower by a rule
   *  that is not ours — `yaml.stringify` puts U+2028 and friends into quotes raw, and the
   *  durable-frontmatter gate refuses the line. That seam showed as a bare 400 from a gate
   *  three layers down which knows nothing about attachments. It has to be named here. */
  it('refuses an attachment it cannot write back, and says which one', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      ...library.deps,
    })
    const home = { scope: 'personal' as const, space: 'personal' }
    const unwritable = '[[notarium-id:space:broken|ev\u2028idence]]'
    const writable = '[[notarium-id:space:broken|evidence]]'
    const roleId = 'Unwritable_1'
    await library.putIfAbsent(
      home,
      claimed(
        {
          ...pkg('unwritable-role', 'Carries a token YAML cannot write.', 'Body.'),
          directoryName: roleId,
          files: new Map([
            [
              'SKILL.md',
              Buffer.from(
                `---\nname: unwritable-role\ndescription: Carries a token YAML cannot write.\nmetadata:\n  notarium.kind: role\n  notarium.skills: "${unwritable} ${writable}"\n---\n\nBody.`,
              ),
            ],
          ]),
        },
        roleId,
      ),
    )
    const locator = {
      source: 'owned',
      kind: 'role',
      packageId: roleId,
      location: { scope: 'personal', spaceId: 'personal' },
    } as const

    // Readable: the whole point of the `invalid` arm, and the reason the detail door
    // stopped answering 500.
    await expect(
      roles.describeAbility({ personalSpace: 'personal' }, SYSTEM_PRINCIPAL, locator, 4_000),
    ).resolves.toMatchObject({ health: { attachments: [{}, {}] } })

    // The writable neighbour on its own still goes through — the refusal is about the
    // token, not about the package.
    await expect(
      roles.serializeOwnedRoleAttachments(
        SYSTEM_PRINCIPAL,
        locator,
        [{ kind: 'invalid', raw: writable, reason: 'invalid-locator' }],
        'personal',
      ),
    ).resolves.toMatchObject({ links: [writable] })

    await expect(
      roles.serializeOwnedRoleAttachments(
        SYSTEM_PRINCIPAL,
        locator,
        [
          { kind: 'invalid', raw: unwritable, reason: 'invalid-locator' },
          { kind: 'invalid', raw: writable, reason: 'invalid-locator' },
        ],
        'personal',
      ),
    ).rejects.toThrow(/cannot be written back to SKILL\.md/)
  })

  it('classifies every exact attachment failure before activation', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const abilityAvailability = new InMemoryAbilityAvailability()
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      ...library.deps,
      abilityAvailability,
    })
    const space = { scope: 'space' as const, space: 'shared' }
    const project = { scope: 'project' as const, space: 'shared', projectId: 'project-a' }
    const disabledId = 'DisabledSk_1'
    const unavailableId = 'Unavailabl_1'
    const wrongKindId = 'WrongKind__1'
    const roleId = 'HealthRole_1'
    const context = {
      personalSpace: null,
      project: {
        id: 'project-a',
        space: 'shared',
        path: 'project-a',
        slug: 'project-a',
        aliases: [],
        pathAliases: [],
        displayName: 'Project A',
        status: 'active' as const,
        createdAt: 'x',
        lastSeen: 'x',
      },
    }

    await library.putIfAbsent(
      space,
      claimed(
        { ...skillPkg('disabled-skill', 'Disabled skill.'), directoryName: disabledId },
        disabledId,
      ),
    )
    await library.putIfAbsent(
      space,
      claimed(
        { ...skillPkg('unavailable-skill', 'Unavailable skill.'), directoryName: unavailableId },
        unavailableId,
      ),
    )
    await library.putIfAbsent(
      space,
      claimed(
        { ...pkg('wrong-kind', 'A role, not a skill.', 'Wrong kind.'), directoryName: wrongKindId },
        wrongKindId,
      ),
    )
    await abilityAvailability.set('shared', unavailableId, {
      mode: 'selected-projects',
      projectIds: ['project-b'],
    })
    await library.putIfAbsent(
      project,
      claimed(
        {
          ...pkg('health-matrix', 'Exercise every attachment health.', 'Health matrix.'),
          directoryName: roleId,
          files: new Map([
            [
              'SKILL.md',
              Buffer.from(
                `---\nname: health-matrix\ndescription: Exercise every attachment health.\nmetadata:\n  notarium.kind: role\n  notarium.skills: "[[notarium-id:system:_55UeQqGnMrH|research-evidence]] [[notarium-id:space:MissingSkil1|missing-skill]] [[notarium-id:space:${disabledId}|disabled-skill]] [[notarium-id:space:${unavailableId}|unavailable-skill]] [[notarium-id:space:${wrongKindId}|wrong-kind]] [[notarium-id:space:broken|invalid-skill]]"\n---\n\nHealth matrix.`,
              ),
            ],
          ]),
        },
        roleId,
      ),
    )
    await roles.setEnabled(
      context,
      SYSTEM_PRINCIPAL,
      await capturedTarget(roles, SYSTEM_PRINCIPAL, {
        source: 'owned',
        kind: 'skill',
        packageId: disabledId,
        location: { scope: 'space', spaceId: 'shared' },
      }),
      false,
    )

    const detail = await roles.describeAbility(
      context,
      SYSTEM_PRINCIPAL,
      {
        source: 'owned',
        kind: 'role',
        packageId: roleId,
        location: { scope: 'project', spaceId: 'shared', projectId: 'project-a' },
      },
      4_000,
    )
    expect(detail?.health).toMatchObject({
      healthy: false,
      attachments: [
        { health: 'healthy' },
        { health: 'missing' },
        { health: 'disabled' },
        { health: 'unavailable' },
        { health: 'wrong-kind' },
        { health: 'invalid-locator' },
      ],
    })
    await expect(
      roles.loadEffective(context, SYSTEM_PRINCIPAL, 'health-matrix', 4_000),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'unhealthy',
      source: 'owned',
      health: {
        healthy: false,
        attachments: [
          { health: 'healthy' },
          { health: 'missing' },
          { health: 'disabled' },
          { health: 'unavailable' },
          { health: 'wrong-kind' },
          { health: 'invalid-locator' },
        ],
      },
    })
  })

  /** A hand-edited or imported `SKILL.md` is a supported way in — the package is
   *  file-first — so what it can say has to stay inside what the detail door can
   *  answer with. It did not: a locator whose label was past the wire's 64-character
   *  bound came back as an EXACT attachment, and a token four characters past the
   *  bound `invalid.raw` carries came back as raw the wire refused. Both made
   *  `AbilityHealthSchema.parse` throw on the door — a 500 for a package the host had
   *  just called valid, with no way to open or repair the role. Read here through the
   *  very schema that door parses with. */
  it('answers with a health the wire carries when a package names an attachment it may not', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      ...library.deps,
      abilityAvailability: new InMemoryAbilityAvailability(),
    })
    const space = { scope: 'space' as const, space: 'shared' }
    const dependencyId = 'Dependency_1'
    const roleId = 'OverlongRl_1'
    const context = { personalSpace: null }
    const overlongLabel = 'a'.repeat(65)
    // The WIDEST token the parser recognises. It has to survive, and the wire has to
    // carry it: the authored list is rebuilt from what came back, so an attachment
    // missing here is an attachment deleted from the author's file on the next attach.
    const longestToken = `[[${'z'.repeat(1_024)}]]`
    await library.putIfAbsent(
      space,
      claimed(
        { ...skillPkg('evidence', 'A real dependency.'), directoryName: dependencyId },
        dependencyId,
      ),
    )
    await library.putIfAbsent(
      space,
      claimed(
        {
          ...pkg('overlong-role', 'Names what it may not.', 'Overlong.'),
          directoryName: roleId,
          files: new Map([
            [
              'SKILL.md',
              Buffer.from(
                `---\nname: overlong-role\ndescription: Names what it may not.\nmetadata:\n  notarium.kind: role\n  notarium.skills: "[[notarium-id:space:${dependencyId}|${overlongLabel}]] ${longestToken}"\n---\n\nOverlong.`,
              ),
            ],
          ]),
        },
        roleId,
      ),
    )

    const detail = await roles.describeAbility(
      context,
      SYSTEM_PRINCIPAL,
      {
        source: 'owned',
        kind: 'role',
        packageId: roleId,
        location: { scope: 'space', spaceId: 'shared' },
      },
      4_000,
    )

    expect(() => AbilityHealthSchema.parse(detail?.health)).not.toThrow()
    // One attachment per authored token — the no-loss invariant this file's own parser
    // docblock states, asserted as a COUNT because that is how losing one shows up.
    expect(detail?.health?.attachments).toHaveLength(2)
    expect(detail?.health).toMatchObject({
      healthy: false,
      attachments: [{ health: 'invalid-locator' }, { health: 'invalid-locator' }],
    })
    expect(detail?.health?.attachments[1]!.attachment).toMatchObject({
      kind: 'invalid',
      raw: longestToken,
    })
  })

  it('requires all-project availability for a Space Role but accepts the matching Project Role', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const abilityAvailability = new InMemoryAbilityAvailability()
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      ...library.deps,
      abilityAvailability,
    })
    const skillId = 'SelectedSk_1'
    const space = { scope: 'space' as const, space: 'shared' }
    const project = { scope: 'project' as const, space: 'shared', projectId: 'project-a' }
    await library.putIfAbsent(space, {
      ...skillPkg('selected-skill', 'Available to one project.'),
      directoryName: skillId,
    })
    await abilityAvailability.set('shared', skillId, {
      mode: 'selected-projects',
      projectIds: ['project-a'],
    })
    const attachment = {
      kind: 'exact' as const,
      locator: {
        source: 'owned' as const,
        kind: 'skill' as const,
        packageId: skillId,
        location: { scope: 'space' as const, spaceId: 'shared' },
      },
      label: 'selected-skill',
    }

    await expect(
      roles.createCustomRole('space-role', 'Space role.', 'Space role.', space, {
        principal: SYSTEM_PRINCIPAL,
        attachments: [attachment],
      }),
    ).rejects.toBeInstanceOf(RoleDependencyConflictError)
    await expect(
      roles.createCustomRole('project-role', 'Project role.', 'Project role.', project, {
        principal: SYSTEM_PRINCIPAL,
        attachments: [attachment],
      }),
    ).resolves.toMatchObject({ name: 'project-role', scope: 'project' })
  })

  it('does not expose Personal Owned abilities through a narrowed principal', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      ...library.deps,
      ...inMemoryAbilityPersistence(),
    })
    await roles.createCustomRole('private-role', 'Private.', 'Private.', {
      scope: 'personal',
      space: 'personal',
    })
    const narrowed = {
      id: 'pat:alice:narrowed',
      userId: 'alice',
      username: 'alice',
      admin: false,
      scope: 'read' as const,
      grants: new Map([['personal', 'owner' as const]]),
      spaces: new Set<string>(),
      system: false,
    }

    await expect(
      roles
        .listEffective({ personalSpace: 'personal' }, narrowed)
        .then(({ roles: listed, truncated }) => ({
          owned: listed.filter((role) => role.source === 'owned'),
          truncated,
        })),
    ).resolves.toEqual({
      owned: [],
      truncated: false,
    })
    // …and the narrowing is about PLACEMENTS, so what ships with the host is untouched:
    // an empty list would pass the filter above for the wrong reason.
    await expect(
      roles.listEffective({ personalSpace: 'personal' }, narrowed),
    ).resolves.toMatchObject({ roles: [{ name: 'research', source: 'system' }] })
  })

  it('never overwrites an owned fork and lets a project fork shadow personal', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      ...library.deps,
      ...inMemoryAbilityPersistence(),
    })
    const personal = { scope: 'personal' as const, space: 'personal' }
    const project = { scope: 'project' as const, space: 'shared', projectId: 'project-a' }

    await roles.addFromCatalog('grooming', personal, null)
    await expect(roles.addFromCatalog('grooming', personal, null)).rejects.toBeInstanceOf(
      RoleAlreadyExistsError,
    )
    await library.putIfAbsent(project, pkg('grooming', 'Project wording.', 'Project rules win.'))

    expect(
      await roles.loadEffective(
        {
          personalSpace: 'personal',
          project: {
            id: 'project-a',
            space: 'shared',
            path: 'a',
            slug: 'a',
            aliases: [],
            pathAliases: [],
            displayName: 'A',
            status: 'active',
            createdAt: 'x',
            lastSeen: 'x',
          },
        },
        SYSTEM_PRINCIPAL,
        'grooming',
        4_000,
      ),
    ).toMatchObject({
      ok: true,
      loaded: {
        role: {
          scope: 'project',
          description: 'Project wording.',
          instructions: 'Project rules win.',
        },
        location: project,
      },
    })
    // Outside a project the chain has no project link, so the same name resolves to
    // the personal body — the override is not a replacement, it is a narrower place.
    expect(
      await roles.loadEffective(
        { personalSpace: personal.space },
        SYSTEM_PRINCIPAL,
        'grooming',
        4_000,
      ),
    ).toMatchObject({
      ok: true,
      loaded: {
        role: {
          scope: 'personal',
          instructions: expect.not.stringContaining('Project rules win.'),
        },
      },
    })
  })

  it('loads an owned dependency only by its locator across rename and replacement', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const roles = createRolesService({
      catalog: async () => [],
      ...library.deps,
      ...inMemoryAbilityPersistence(),
    })
    const personal = { scope: 'personal' as const, space: 'personal' }
    const dependencyId = 'AbCdefGhij_1'
    const roleId = 'ZyXwvUtsrq_2'

    await library.putIfAbsent(personal, {
      ...skillPkg('renamed-evidence', 'Renamed exact evidence.', 'Exact body.'),
      directoryName: dependencyId,
    })
    await library.putIfAbsent(personal, {
      ...pkg('exact-role', 'Exact role.', 'Use exact evidence.'),
      directoryName: roleId,
      files: new Map([
        [
          'SKILL.md',
          Buffer.from(
            `---\nname: exact-role\ndescription: Exact role.\nmetadata:\n  notarium.kind: role\n  notarium.skills: "[[notarium-id:personal:${dependencyId}|old-evidence]]"\n---\n\nUse exact evidence.`,
          ),
        ],
      ]),
    })
    await library.putIfAbsent(personal, {
      ...skillPkg('old-evidence', 'Same-name replacement.', 'Wrong body.'),
      directoryName: 'LmNopQrstu_3',
    })

    const context = { personalSpace: personal.space }
    const savedLocator = {
      source: 'owned',
      kind: 'role',
      packageId: roleId,
      location: { scope: 'personal', spaceId: personal.space },
    } as const

    await expect(
      roles.loadSavedRole(context, SYSTEM_PRINCIPAL, savedLocator, 4_000),
    ).resolves.toMatchObject({
      ok: true,
      loaded: {
        role: { name: 'exact-role' },
        packageId: roleId,
        skills: [{ name: 'renamed-evidence', instructions: 'Exact body.' }],
      },
    })

    const missingExact = createRolesService({
      catalog: async () => [],
      publication: library.deps.publication,
      library: {
        ...library.deps.library,
        getSkillByDirectory: async (location, id) =>
          id === dependencyId ? null : library.getSkillByDirectory(location, id),
      },
      ...inMemoryAbilityPersistence(),
    })
    await expect(
      missingExact.loadSavedRole(context, SYSTEM_PRINCIPAL, savedLocator, 4_000),
    ).resolves.toMatchObject({ ok: false, reason: 'unhealthy' })
  })

  it('keeps context preset identity stable when the role label changes', () => {
    const location = { scope: 'personal' as const, space: 'personal' }
    const packageId = 'AbCdefGhij_1'

    expect(roleContextTargetOf({ role: { name: 'before' }, location, packageId }).id).toBe(
      roleContextTargetOf({ role: { name: 'after' }, location, packageId }).id,
    )
  })

  it('resolves a cross-placement locator only with the full effective context', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const abilityAvailability = new InMemoryAbilityAvailability()
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: async () => [],
      ...library.deps,
      abilityAvailability,
    })
    const space = { scope: 'space' as const, space: 'shared' }
    const dependencyId = 'AbCdefGhij_1'
    const roleId = 'ZyXwvUtsrq_2'

    await library.putIfAbsent(space, {
      ...skillPkg('shared-evidence', 'Shared evidence.', 'Shared exact body.'),
      directoryName: dependencyId,
    })
    for (const projectId of ['project-a', 'project-b', 'project-c']) {
      await library.putIfAbsent(
        { scope: 'project', space: 'shared', projectId },
        {
          directoryName: roleId,
          files: new Map([
            [
              'SKILL.md',
              Buffer.from(
                `---\nname: cross-role\ndescription: Cross role.\nmetadata:\n  notarium.kind: role\n  notarium.skills: "[[notarium-id:space:${dependencyId}|shared-evidence]]"\n---\n\nCross.`,
              ),
            ],
          ]),
        },
      )
    }
    const context = (id: string) => ({
      personalSpace: null,
      project: {
        id,
        space: 'shared',
        path: id,
        slug: id,
        aliases: [],
        pathAliases: [],
        displayName: id,
        status: 'active' as const,
        createdAt: 'x',
        lastSeen: 'x',
      },
    })

    await expect(
      roles.loadEffective(context('project-a'), SYSTEM_PRINCIPAL, 'cross-role', 4_000),
    ).resolves.toMatchObject({ ok: false, reason: 'unhealthy' })
    await abilityAvailability.set('shared', dependencyId, {
      mode: 'selected-projects',
      projectIds: ['project-a', 'project-b'],
    })
    await expect(
      roles.loadEffective(context('project-a'), SYSTEM_PRINCIPAL, 'cross-role', 4_000),
    ).resolves.toMatchObject({
      ok: true,
      loaded: { skills: [{ name: 'shared-evidence', instructions: 'Shared exact body.' }] },
    })
    await expect(
      roles.loadEffective(context('project-b'), SYSTEM_PRINCIPAL, 'cross-role', 4_000),
    ).resolves.toMatchObject({
      ok: true,
      loaded: { skills: [{ name: 'shared-evidence', instructions: 'Shared exact body.' }] },
    })
    await expect(
      roles.loadEffective(context('project-c'), SYSTEM_PRINCIPAL, 'cross-role', 4_000),
    ).resolves.toMatchObject({ ok: false, reason: 'unhealthy' })
  })

  it('rehydrates a renamed session role by exact package and never by a replacement name', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const roles = createRolesService({
      catalog: async () => [],
      ...library.deps,
      ...inMemoryAbilityPersistence(),
    })
    const personal = { scope: 'personal' as const, space: 'personal' }
    const packageId = 'AbCdefGhij_1'
    await library.putIfAbsent(personal, {
      ...pkg('renamed-role', 'Renamed role.', 'Renamed body.'),
      directoryName: packageId,
    })
    await library.putIfAbsent(personal, {
      ...pkg('old-role', 'Replacement role.', 'Wrong body.'),
      directoryName: 'ZyXwvUtsrq_2',
    })
    const saved = {
      id: 'ses_aaaaaaaaaaaa',
      owner: 'alice',
      name: 'work',
      named: true,
      parentId: null,
      createdAt: 'x',
      lastSeenAt: 'x',
      calls: 1,
      role: 'old-role',
      roleLocator: {
        source: 'owned' as const,
        kind: 'role' as const,
        packageId,
        location: { scope: 'personal' as const, spaceId: 'personal' },
      },
      roleContextProjectId: null,
      projectId: null,
    }

    await expect(
      loadSavedSessionRole(roles, { personalSpace: 'personal' }, SYSTEM_PRINCIPAL, saved, 4_000),
    ).resolves.toMatchObject({
      ok: true,
      loaded: { role: { name: 'renamed-role', instructions: 'Renamed body.' }, packageId },
    })
    const missingExact = createRolesService({
      catalog: async () => [],
      publication: library.deps.publication,
      library: {
        ...library.deps.library,
        getSkillByDirectory: async (location, id) =>
          id === packageId ? null : library.getSkillByDirectory(location, id),
      },
      ...inMemoryAbilityPersistence(),
    })
    await expect(
      loadSavedSessionRole(
        missingExact,
        { personalSpace: 'personal' },
        SYSTEM_PRINCIPAL,
        saved,
        4_000,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'gone' })

    // A resume reaches the SAME placements resolution does, and a Space scope
    // borrowed for the caller's own personal library is not one of them: the two are
    // one directory, and `personal` is what grants the writer rules. A context whose
    // project happens to live in that space is exactly where the borrowed name would
    // otherwise look legitimate.
    await expect(
      loadSavedSessionRole(
        roles,
        {
          personalSpace: 'personal',
          project: {
            id: 'project-mine',
            space: 'personal',
            slug: 'mine',
            path: 'mine',
            aliases: [],
            pathAliases: [],
            displayName: 'Mine',
            status: 'active',
            createdAt: 'x',
            lastSeen: 'x',
          },
        },
        SYSTEM_PRINCIPAL,
        {
          ...saved,
          roleContextProjectId: 'project-mine',
          projectId: null,
          roleLocator: {
            ...saved.roleLocator,
            location: { scope: 'space' as const, spaceId: 'personal' },
          },
        },
        4_000,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'gone' })
  })

  it('offers both current and saved projects for a resumed role context mismatch', async () => {
    const roles = createRolesService({
      catalog: async () => [],
      ...writableLibrary(createInMemoryRoleLibrary()).deps,
      ...inMemoryAbilityPersistence(),
    })
    const saved = {
      id: 'ses_aaaaaaaaaaaa',
      owner: 'alice',
      name: 'work',
      named: true,
      parentId: null,
      createdAt: 'x',
      lastSeenAt: 'x',
      calls: 1,
      role: 'review',
      roleLocator: {
        source: 'system' as const,
        kind: 'role' as const,
        packageId: 'ZME09f9AROG8',
      },
      roleContextProjectId: 'project-a',
      projectId: 'project-b',
    }

    await expect(
      loadSavedSessionRole(
        roles,
        projectContext('project-b', 'shared'),
        SYSTEM_PRINCIPAL,
        saved,
        4_000,
        { saved: 'team/a', current: 'team/b' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'context-mismatch',
      remediation: [
        { kind: 'reactivate-role', role: 'review', project: 'team/b' },
        { kind: 'reactivate-role', role: 'review', project: 'team/a' },
      ],
    })
  })

  it('resumes a bound role only where its reach still answers', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const availability = new InMemoryAbilityAvailability()
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: async () => [],
      ...library.deps,
      abilityAvailability: availability,
    })
    const base = await roles.createCustomRole('review', 'Team review.', 'The team way.', {
      scope: 'space',
      space: 'shared',
    })
    const locator = spaceRoleLocator(base.packageId, 'shared')

    await roles.setAbilityAvailability(
      { personalSpace: 'personal' },
      SYSTEM_PRINCIPAL,
      await capturedTarget(roles, SYSTEM_PRINCIPAL, locator),
      {
        mode: 'selected-projects',
        projectIds: ['project-a'],
      },
    )

    // Where the reach answers, resume and activation agree.
    await expect(
      roles.loadSavedRole(projectContext('project-a', 'shared'), SYSTEM_PRINCIPAL, locator, 4_000),
    ).resolves.toMatchObject({ ok: true, loaded: { role: { name: 'review' } } })

    // And where it does not, they must STILL agree: a listing that refuses to offer
    // the role and a resume that hands over its instructions are the same session
    // telling the agent two different things about the same role.
    await expect(
      roles.loadEffective(projectContext('project-b', 'shared'), SYSTEM_PRINCIPAL, 'review', 4_000),
    ).resolves.toMatchObject({ ok: false, reason: 'out-of-reach' })
    await expect(
      roles.loadSavedRole(projectContext('project-b', 'shared'), SYSTEM_PRINCIPAL, locator, 4_000),
    ).resolves.toMatchObject({ ok: false, reason: 'out-of-reach' })
  })

  it('resumes a Space role whose skill reaches only the project being resumed in', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const availability = new InMemoryAbilityAvailability()
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: async () => [],
      ...library.deps,
      abilityAvailability: availability,
    })
    const space = { scope: 'space' as const, space: 'shared' }
    const skillId = 'EvidenceAbCd'

    await library.putIfAbsent(space, {
      ...skillPkg('evidence', 'Shared evidence.', 'Evidence body.'),
      directoryName: skillId,
    })
    await availability.set('shared', skillId, {
      mode: 'selected-projects',
      projectIds: ['project-a'],
    })
    const role = await roles.createCustomRole('review', 'Team review.', 'The team way.', space, {
      principal: SYSTEM_PRINCIPAL,
      attachments: [
        {
          kind: 'exact',
          locator: {
            source: 'owned',
            kind: 'skill',
            packageId: skillId,
            location: { scope: 'space', spaceId: 'shared' },
          },
          label: 'evidence',
        },
      ],
      availability: { mode: 'selected-projects', projectIds: ['project-a'] },
    })
    const locator = spaceRoleLocator(role.packageId, 'shared')

    // A Space placement carries no project of its own. Judged by the placement rather
    // than by the caller's context, every narrowed dependency reads as unavailable and
    // the role resumes NOWHERE — while `use_role` activates it right here.
    await expect(
      roles.loadEffective(projectContext('project-a', 'shared'), SYSTEM_PRINCIPAL, 'review', 4_000),
    ).resolves.toMatchObject({ ok: true, loaded: { role: { name: 'review' } } })
    await expect(
      roles.loadSavedRole(projectContext('project-a', 'shared'), SYSTEM_PRINCIPAL, locator, 4_000),
    ).resolves.toMatchObject({
      ok: true,
      loaded: { role: { name: 'review' }, skills: [{ name: 'evidence' }] },
    })
  })

  it('maps a role publication race after the precheck to already-exists', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      ...library.deps,
      ...inMemoryAbilityPersistence(),
    })
    const location = { scope: 'personal' as const, space: 'personal' }
    const results = await Promise.allSettled([
      roles.addFromCatalog('grooming', location, null),
      roles.addFromCatalog('grooming', location, null),
    ])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toBeInstanceOf(RoleAlreadyExistsError)
    expect(await library.get(location, 'grooming')).not.toBeNull()
  })

  it('reuses one Space-owned linked skill across project roles and expands its bindings', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const abilityAvailability = new InMemoryAbilityAvailability()
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      ...library.deps,
      abilityAvailability,
    })
    const projectA = { scope: 'project' as const, space: 'shared', projectId: 'project-a' }
    const projectB = { scope: 'project' as const, space: 'shared', projectId: 'project-b' }
    const projectC = { scope: 'project' as const, space: 'shared', projectId: 'project-c' }
    const space = { scope: 'space' as const, space: 'shared' }

    await expect(roles.addFromCatalog('grooming', projectA, null)).resolves.toMatchObject({
      name: 'grooming',
      scope: 'project',
    })
    const dependency = await library.get(space, 'grooming-evidence')
    expect(dependency).not.toBeNull()
    expect(await library.get(projectA, 'grooming-evidence')).toBeNull()

    await expect(roles.addFromCatalog('grooming', projectB, null)).resolves.toMatchObject({
      name: 'grooming',
      scope: 'project',
    })
    expect(await library.get(space, 'grooming-evidence')).toEqual(dependency)
    expect(await library.get(projectB, 'grooming-evidence')).toBeNull()
    expect(await abilityAvailability.get('shared', dependency!.directoryName)).toEqual({
      homeSpace: 'shared',
      packageId: dependency!.directoryName,
      mode: 'selected-projects',
      projectIds: ['project-a', 'project-b'],
    })

    const context = (projectId: string) => ({
      personalSpace: null,
      project: {
        id: projectId,
        space: 'shared',
        path: projectId,
        slug: projectId,
        aliases: [],
        pathAliases: [],
        displayName: projectId,
        status: 'active' as const,
        createdAt: 'x',
        lastSeen: 'x',
      },
    })
    await expect(
      roles.loadEffective(context('project-a'), SYSTEM_PRINCIPAL, 'grooming', 4_000),
    ).resolves.toMatchObject({
      ok: true,
      loaded: { skills: [{ name: 'grooming-evidence' }] },
    })
    await expect(
      roles.loadEffective(context('project-b'), SYSTEM_PRINCIPAL, 'grooming', 4_000),
    ).resolves.toMatchObject({
      ok: true,
      loaded: { skills: [{ name: 'grooming-evidence' }] },
    })
    expect(
      await roles.loadEffective(context('project-c'), SYSTEM_PRINCIPAL, 'grooming', 4_000),
    ).toMatchObject({ ok: false })
    expect(await library.get(projectC, 'grooming-evidence')).toBeNull()
  })

  it('rejects a linked-skill collision instead of binding a role to different bytes', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      ...library.deps,
      ...inMemoryAbilityPersistence(),
    })
    const personal = { scope: 'personal' as const, space: 'personal' }
    await library.putIfAbsent(personal, {
      directoryName: packageDirectoryOf('grooming-evidence'),
      files: new Map([
        [
          'SKILL.md',
          Buffer.from(
            '---\nname: grooming-evidence\ndescription: Different owned skill.\n---\n\nDo something else.',
          ),
        ],
      ]),
    })

    await expect(roles.addFromCatalog('grooming', personal, null)).rejects.toBeInstanceOf(
      RoleDependencyConflictError,
    )
    expect(await library.get(personal, 'grooming')).toBeNull()
    expect(
      Buffer.from(
        (await library.get(personal, 'grooming-evidence'))!.files.get('SKILL.md')!,
      ).toString('utf8'),
    ).toContain('Different owned skill')
  })

  it('reports truncation instead of silently exceeding the requested budget', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const roles = createRolesService({
      catalog: async () => [],
      ...library.deps,
      ...inMemoryAbilityPersistence(),
    })
    await library.putIfAbsent(
      { scope: 'personal', space: 'personal' },
      pkg('long-role', 'Long role.', 'x'.repeat(1_000)),
    )

    const loaded = loadedOf(
      await roles.loadEffective({ personalSpace: 'personal' }, SYSTEM_PRINCIPAL, 'long-role', 100),
    )
    expect(loaded.role.instructions.length).toBeLessThanOrEqual(400)
    expect(loaded.role.instructions.length).toBeGreaterThan(0)
    expect(loaded.truncated).toBe(true)
  })

  it('returns metadata for all 64 attachments while charging only instruction bodies', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const dependencies = Array.from({ length: 64 }, (_, index) => ({
      ...skillPkg(
        `support-${index.toString().padStart(2, '0')}`,
        `Supporting description ${index} ${'x'.repeat(900)}`,
        `body-${index}`,
      ),
      directoryName: `S${index.toString().padStart(3, '0')}portAbCd`,
    }))
    const role = pkg('bounded-role', 'Bounded role.', '')
    const links = dependencies
      .map(
        ({ directoryName }, index) =>
          `[[notarium-id:personal:${directoryName}|support-${index.toString().padStart(2, '0')}]]`,
      )
      .join(' ')
    role.files.set(
      'SKILL.md',
      Buffer.from(
        `---\nname: bounded-role\ndescription: Bounded role.\nmetadata:\n  notarium.kind: role\n  notarium.skills: "${links}"\n---\n`,
      ),
    )
    const roles = createRolesService({
      catalog: async () => [],
      ...library.deps,
      ...inMemoryAbilityPersistence(),
    })
    const personal = { scope: 'personal' as const, space: 'personal' }

    for (const dependency of dependencies) {
      await library.putIfAbsent(personal, dependency)
    }
    await library.putIfAbsent(personal, role)
    const loaded = loadedOf(
      await roles.loadEffective(
        { personalSpace: personal.space },
        SYSTEM_PRINCIPAL,
        'bounded-role',
        100,
      ),
    )
    expect(loaded.skills).toHaveLength(64)
    expect(loaded.skills[0]).toMatchObject({
      name: 'support-00',
      description: expect.stringContaining('x'.repeat(900)),
      state: 'loaded',
      instructions: 'body-0',
    })
    expect(loaded.skills.some((skill) => skill.state === 'omitted-by-budget')).toBe(true)
    expect(loaded.truncated).toBe(false)
  })

  it('omits linked instruction bodies as a strict prefix and never slices one', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const location = { scope: 'personal' as const, space: 'personal' }
    const large = skillPkg('large-support', 'Large support.', 'x'.repeat(401))
    const small = skillPkg('small-support', 'Small support.', 'fits')
    const role = pkg('prefix-role', 'Prefix role.', '')
    role.files.set(
      'SKILL.md',
      Buffer.from(
        `---\nname: prefix-role\ndescription: Prefix role.\nmetadata:\n  notarium.kind: role\n  notarium.skills: "[[notarium-id:personal:${large.directoryName}|large-support]] [[notarium-id:personal:${small.directoryName}|small-support]]"\n---\n`,
      ),
    )
    await library.putIfAbsent(location, large)
    await library.putIfAbsent(location, small)
    await library.putIfAbsent(location, role)
    const roles = createRolesService({
      catalog: async () => [],
      ...library.deps,
      ...inMemoryAbilityPersistence(),
    })

    const loaded = loadedOf(
      await roles.loadEffective(
        { personalSpace: location.space },
        SYSTEM_PRINCIPAL,
        'prefix-role',
        100,
      ),
    )

    expect(loaded.skills).toEqual([
      expect.objectContaining({ name: 'large-support', state: 'omitted-by-budget' }),
      expect.objectContaining({ name: 'small-support', state: 'omitted-by-budget' }),
    ])
    expect(loaded.skills.every((skill) => !('instructions' in skill))).toBe(true)
    expect(loaded.truncated).toBe(false)
  })

  it('loads role attachments from the health snapshot instead of silently dropping a raced read', async () => {
    const backing = writableLibrary(createInMemoryRoleLibrary())
    const location = { scope: 'personal' as const, space: 'personal' }
    const dependency = {
      ...skillPkg('snapshot-support', 'Snapshot support.', 'Stable body.'),
      directoryName: 'SnapSkilAb12',
    }
    const role = {
      ...pkg('snapshot-role', 'Snapshot role.', 'Role body.'),
      directoryName: 'SnapRoleAb12',
    }
    role.files.set(
      'SKILL.md',
      Buffer.from(
        `---\nname: snapshot-role\ndescription: Snapshot role.\nmetadata:\n  notarium.kind: role\n  notarium.skills: "[[notarium-id:personal:${dependency.directoryName}|snapshot-support]]"\n---\n\nRole body.`,
      ),
    )
    await backing.putIfAbsent(location, dependency)
    await backing.putIfAbsent(location, role)
    let dependencyReads = 0
    const roles = createRolesService({
      catalog: async () => [],
      publication: backing.deps.publication,
      library: {
        ...backing.deps.library,
        getSkillByDirectory: async (where, directoryName) => {
          if (directoryName !== dependency.directoryName) {
            return backing.getSkillByDirectory(where, directoryName)
          }
          dependencyReads += 1
          return dependencyReads === 1
            ? backing.getSkillByDirectory(where, directoryName)
            : { ...pkg('wrong-kind', 'Wrong kind.', 'Wrong body.'), directoryName }
        },
      },
      ...inMemoryAbilityPersistence(),
    })

    await expect(
      roles.loadEffective(
        { personalSpace: location.space },
        SYSTEM_PRINCIPAL,
        'snapshot-role',
        4_000,
      ),
    ).resolves.toMatchObject({
      ok: true,
      loaded: {
        skills: [
          {
            name: 'snapshot-support',
            state: 'loaded',
            instructions: 'Stable body.',
          },
        ],
      },
    })
    expect(dependencyReads).toBe(1)
  })

  it('activates the same effective skill winner as discovery and keeps its body whole', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const personal = { scope: 'personal' as const, space: 'personal' }
    const space = { scope: 'space' as const, space: 'shared' }
    await library.putIfAbsent(
      personal,
      skillPkg('research-evidence', 'Personal evidence.', 'Personal body.'),
    )
    await library.putIfAbsent(
      space,
      skillPkg('research-evidence', 'Space evidence.', 'Space body.'),
    )
    const persistence = inMemoryAbilityPersistence()
    await persistence.abilityAvailability.set(
      space.space,
      packageDirectoryOf('research-evidence'),
      {
        mode: 'all-projects',
      },
    )
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      ...library.deps,
      ...persistence,
    })
    const context = {
      personalSpace: personal.space,
      project: {
        id: 'project-a',
        space: space.space,
        path: 'project-a',
        slug: 'project-a',
        aliases: [],
        pathAliases: [],
        displayName: 'Project A',
        status: 'active' as const,
        createdAt: 'x',
        lastSeen: 'x',
      },
    }
    const runtimeWinner = (await roles.listAbilityResolution(context, SYSTEM_PRINCIPAL)).candidates
      .filter((candidate) => candidate.kind === 'skill' && candidate.name === 'research-evidence')
      .find((candidate) => candidate.effective)

    await expect(
      roles.loadEffectiveSkill(context, SYSTEM_PRINCIPAL, 'research-evidence', 4_000),
    ).resolves.toMatchObject({
      ok: true,
      loaded: {
        skill: {
          source: 'owned',
          kind: 'skill',
          scope: 'space',
          name: runtimeWinner?.name,
          instructions: 'Space body.',
        },
        locator: runtimeWinner?.locator,
      },
    })
  })

  it('returns wrong-kind only when the other runtime tool has an active winner', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const location = { scope: 'personal' as const, space: 'personal' }
    await library.putIfAbsent(
      location,
      skillPkg('skill-only', 'A standalone skill.', 'Skill body.'),
    )
    const roles = createRolesService({
      catalog: async () => [],
      ...library.deps,
      ...inMemoryAbilityPersistence(),
    })

    await expect(
      roles.loadEffective({ personalSpace: location.space }, SYSTEM_PRINCIPAL, 'skill-only', 4_000),
    ).resolves.toEqual({
      ok: false,
      reason: 'wrong-kind',
      actual: 'skill',
      remediation: [{ kind: 'call-other-kind', actual: 'skill' }],
    })
  })

  it('fails closed when a standalone skill body exceeds its activation budget', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const location = { scope: 'personal' as const, space: 'personal' }
    await library.putIfAbsent(
      location,
      skillPkg('oversized-skill', 'Oversized skill.', 'x'.repeat(70_000)),
    )
    const roles = createRolesService({
      catalog: async () => [],
      ...library.deps,
      ...inMemoryAbilityPersistence(),
    })

    await expect(
      roles.loadEffectiveSkill(
        { personalSpace: location.space },
        SYSTEM_PRINCIPAL,
        'oversized-skill',
        16_000,
      ),
    ).rejects.toMatchObject({
      name: 'SkillTooLargeForActivation',
      requiredTokens: 17_500,
      maxTokens: 16_000,
    })
  })

  it('rejects a skill package that would silently discard notarium.skills links', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const location = { scope: 'personal' as const, space: 'personal' }
    const linkedSkill = skillPkg('linked-skill', 'Linked skill.', 'Linked body.')
    const invalid = skillPkg('invalid-composite', 'Invalid composite.', 'Body.')
    const empty = skillPkg('empty-composite', 'Empty composite.', 'Body.')
    invalid.files.set(
      'SKILL.md',
      Buffer.from(
        `---\nname: invalid-composite\ndescription: Invalid composite.\nmetadata:\n  notarium.skills: "[[notarium-id:personal:${linkedSkill.directoryName}|linked-skill]]"\n---\n\nBody.`,
      ),
    )
    empty.files.set(
      'SKILL.md',
      Buffer.from(
        '---\nname: empty-composite\ndescription: Empty composite.\nmetadata:\n  notarium.skills: ""\n---\n\nBody.',
      ),
    )
    await library.putIfAbsent(location, linkedSkill)
    await library.putIfAbsent(location, invalid)
    await library.putIfAbsent(location, empty)
    const roles = createRolesService({
      catalog: async () => [],
      ...library.deps,
      ...inMemoryAbilityPersistence(),
    })

    const resolution = await roles.listAbilityResolution(
      { personalSpace: location.space },
      SYSTEM_PRINCIPAL,
    )
    const names = resolution.candidates.map((candidate) => candidate.name)

    expect(names).not.toContain('invalid-composite')
    expect(names).not.toContain('empty-composite')
    await expect(
      roles.loadEffectiveSkill(
        { personalSpace: location.space },
        SYSTEM_PRINCIPAL,
        'invalid-composite',
        4_000,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'not-found' })
  })

  it('forks every file in a complete Agent Skills package', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const role = pkg('resource-role', 'Resource role.', 'Instructions.')
    role.files.set('scripts/run.sh', Buffer.from('#!/bin/sh\necho safe-copy\n'))
    role.files.set('references/guide.md', Buffer.from('# Guide\n\nSupporting evidence.'))
    role.files.set('assets/template.bin', Buffer.from([0, 1, 2, 255]))
    const roles = createRolesService({
      catalog: async () => [catalogPackage(role)],
      ...library.deps,
      ...inMemoryAbilityPersistence(),
    })
    const location = { scope: 'personal' as const, space: 'personal' }

    await expect(roles.listBundledAbilities(SYSTEM_PRINCIPAL)).resolves.toEqual([
      expect.objectContaining({ name: 'resource-role' }),
    ])
    await roles.addFromCatalog('resource-role', location, null)
    const installed = await library.get(location, 'resource-role')

    expect([...installed!.files.keys()].sort()).toEqual([
      'SKILL.md',
      'assets/template.bin',
      'references/guide.md',
      'scripts/run.sh',
    ])
    expect(Buffer.from(installed!.files.get('scripts/run.sh')!)).toEqual(
      Buffer.from(role.files.get('scripts/run.sh')!),
    )
    expect(Buffer.from(installed!.files.get('references/guide.md')!)).toEqual(
      Buffer.from(role.files.get('references/guide.md')!),
    )
    expect(Buffer.from(installed!.files.get('assets/template.bin')!)).toEqual(
      Buffer.from(role.files.get('assets/template.bin')!),
    )
    expect(Buffer.from(installed!.files.get('SKILL.md')!).toString('utf8')).toContain(
      `notarium.origin: catalog:${role.directoryName}`,
    )
  })

  it('does not expose malformed owned provenance as Catalog ancestry', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const roles = createRolesService({
      catalog: async () => [],
      ...library.deps,
      ...inMemoryAbilityPersistence(),
    })
    const location = { scope: 'personal' as const, space: 'personal' }
    const hostile = pkg('claimed-role', 'Claimed role.', 'Instructions.')
    hostile.files.set(
      'SKILL.md',
      Buffer.from(
        '---\nname: claimed-role\ndescription: Claimed role.\nmetadata:\n  notarium.kind: role\n  notarium.origin: catalog:not-a-package\n  notarium.originRevision: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n---\n\nInstructions.',
      ),
    )
    await library.putIfAbsent(location, hostile)

    const [summary] = (await roles.listEffective({ personalSpace: 'personal' }, SYSTEM_PRINCIPAL))
      .roles
    expect(summary).toMatchObject({ name: 'claimed-role', scope: 'personal' })
    expect(summary).not.toHaveProperty('origin')
    expect(summary).not.toHaveProperty('originRevision')
  })

  it('keeps valid catalog provenance after the owned package is renamed', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const roles = createRolesService({
      catalog: async () => [],
      ...library.deps,
      ...inMemoryAbilityPersistence(),
    })
    const location = { scope: 'personal' as const, space: 'personal' }
    const renamed = pkg('renamed-role', 'Renamed role.', 'Instructions.')
    renamed.files.set(
      'SKILL.md',
      Buffer.from(
        '---\nname: renamed-role\ndescription: Renamed role.\nmetadata:\n  notarium.kind: role\n  notarium.origin: catalog:AbCdefGhij_1\n  notarium.originRevision: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n---\n\nInstructions.',
      ),
    )
    await library.putIfAbsent(location, renamed)

    await expect(
      roles.listEffective({ personalSpace: 'personal' }, SYSTEM_PRINCIPAL),
    ).resolves.toEqual({
      roles: [
        expect.objectContaining({
          name: 'renamed-role',
          origin: 'catalog:AbCdefGhij_1',
        }),
      ],
      truncated: false,
    })
  })

  it('frames package revision fields so NUL bytes cannot create an ambiguous digest', () => {
    const skill = Buffer.from('---\nname: framed\ndescription: Framed.\n---\n')
    const oneFile = new Map<string, Uint8Array>([
      ['SKILL.md', skill],
      ['a', Buffer.from('x\0b\0y')],
    ])
    const twoFiles = new Map<string, Uint8Array>([
      ['SKILL.md', skill],
      ['a', Buffer.from('x')],
      ['b', Buffer.from('y')],
    ])

    expect(packageRevision(oneFile)).not.toBe(packageRevision(twoFiles))
  })

  it('activates an exact known role outside a truncated discovery window', async () => {
    const backing = writableLibrary(createInMemoryRoleLibrary())
    const location = { scope: 'personal' as const, space: 'personal' }
    await backing.putIfAbsent(location, pkg('known-role', 'Known role.', 'Direct instructions.'))
    const roles = createRolesService({
      catalog: async () => [],
      publication: backing.deps.publication,
      library: {
        ...backing.deps.library,
        listManifests: async () => ({ packages: [], truncated: true }),
      },
      ...inMemoryAbilityPersistence(),
    })

    await expect(
      roles.listEffective({ personalSpace: 'personal' }, SYSTEM_PRINCIPAL),
    ).resolves.toEqual({
      roles: [],
      truncated: true,
    })
    await expect(
      roles.loadEffective({ personalSpace: 'personal' }, SYSTEM_PRINCIPAL, 'known-role', 4_000),
    ).resolves.toMatchObject({
      ok: true,
      loaded: {
        role: { name: 'known-role', scope: 'personal', instructions: 'Direct instructions.' },
      },
    })
  })

  it('uses the same stable package for listing and exact same-name activation', async () => {
    const backing = writableLibrary(createInMemoryRoleLibrary())
    const location = { scope: 'personal' as const, space: 'personal' }
    const first = {
      ...skillPkg('duplicate-skill', 'First duplicate.', 'First instructions.'),
      directoryName: 'AbCdefGhij_1',
    }
    const second = {
      ...skillPkg('duplicate-skill', 'Second duplicate.', 'Second instructions.'),
      directoryName: 'ZyXwvUtsrq_2',
    }
    const persistence = inMemoryAbilityPersistence()
    const roles = createRolesService({
      catalog: async () => [],
      publication: backing.deps.publication,
      library: {
        ...backing.deps.library,
        listManifests: async (where) =>
          where.scope === location.scope && where.space === location.space
            ? { packages: [first, second], truncated: false }
            : { packages: [], truncated: false },
        getAbilitiesNamed: async (where, name) =>
          where.scope === location.scope &&
          where.space === location.space &&
          name === 'duplicate-skill'
            ? new Map([[ABILITY_KIND.skill, first]])
            : new Map(),
      },
      ...persistence,
    })
    const context = { personalSpace: 'personal' }
    const resolution = await roles.listAbilityResolution(context, SYSTEM_PRINCIPAL)
    const listed = resolution.candidates.find(
      (candidate) => candidate.name === 'duplicate-skill' && candidate.effective,
    )
    const loaded = loadedOf(
      await roles.loadEffectiveSkill(context, SYSTEM_PRINCIPAL, 'duplicate-skill', 4_000),
    )

    expect(listed?.locator.packageId).toBe(first.directoryName)
    expect(loaded.locator.packageId).toBe(first.directoryName)
    expect(loaded.skill.instructions).toBe('First instructions.')
    if (loaded.locator.source !== 'owned') {
      throw new Error('expected the owned duplicate package')
    }

    await persistence.abilityPreferences.setEnabled(
      '@system',
      { locator: loaded.locator, registryNoteId: first.directoryName },
      false,
      'x',
    )
    const disabledResolution = await roles.listAbilityResolution(context, SYSTEM_PRINCIPAL)

    expect(
      disabledResolution.candidates.find(
        (candidate) => candidate.name === 'duplicate-skill' && candidate.effective,
      ),
    ).toBeUndefined()
    await expect(
      roles.loadEffectiveSkill(context, SYSTEM_PRINCIPAL, 'duplicate-skill', 4_000),
    ).resolves.toMatchObject({ ok: false, reason: 'disabled' })
  })

  it('resolves stable same-name external packages independently for each ability kind', async () => {
    const backing = writableLibrary(createInMemoryRoleLibrary())
    const location = { scope: 'personal' as const, space: 'personal' }
    const skill = {
      ...skillPkg('shared-name', 'External skill.', 'Skill instructions.'),
      directoryName: 'AbCdefGhij_1',
    }
    const role = {
      ...pkg('shared-name', 'External role.', 'Role instructions.'),
      directoryName: 'ZyXwvUtsrq_2',
    }
    const roles = createRolesService({
      catalog: async () => [],
      publication: backing.deps.publication,
      library: {
        ...backing.deps.library,
        listManifests: async (where) =>
          where.scope === location.scope && where.space === location.space
            ? { packages: [skill, role], truncated: false }
            : { packages: [], truncated: false },
        getAbilitiesNamed: async (where, name) =>
          where.scope === location.scope && where.space === location.space && name === 'shared-name'
            ? new Map([
                [ABILITY_KIND.skill, skill],
                [ABILITY_KIND.role, role],
              ])
            : new Map(),
      },
      ...inMemoryAbilityPersistence(),
    })
    const context = { personalSpace: 'personal' }
    const resolution = await roles.listAbilityResolution(context, SYSTEM_PRINCIPAL)
    const effective = resolution.candidates
      .filter((candidate) => candidate.name === 'shared-name' && candidate.effective)
      .map((candidate) => ({ kind: candidate.kind, packageId: candidate.locator.packageId }))

    expect(effective).toEqual([
      { kind: 'skill', packageId: skill.directoryName },
      { kind: 'role', packageId: role.directoryName },
    ])
    expect(
      loadedOf(await roles.loadEffective(context, SYSTEM_PRINCIPAL, 'shared-name', 4_000)),
    ).toMatchObject({
      locator: { kind: 'role', packageId: role.directoryName },
      role: { instructions: 'Role instructions.' },
    })
    expect(
      loadedOf(await roles.loadEffectiveSkill(context, SYSTEM_PRINCIPAL, 'shared-name', 4_000)),
    ).toMatchObject({
      locator: { kind: 'skill', packageId: skill.directoryName },
      skill: { instructions: 'Skill instructions.' },
    })
    const ctx = { principal: SYSTEM_PRINCIPAL, roles } as Ctx

    await expect(
      activateRole(ctx, context, 'shared-name', 4_000, undefined, undefined, {
        alwaysLoad: [],
      }),
    ).resolves.toMatchObject({ instructions: 'Role instructions.' })
    await expect(activateSkill(ctx, context, 'shared-name', 4_000)).resolves.toMatchObject({
      instructions: 'Skill instructions.',
    })
  })

  it('reports every linked skill when the role body consumes the output budget', async () => {
    const backing = writableLibrary(createInMemoryRoleLibrary())
    const location = { scope: 'personal' as const, space: 'personal' }
    const role = pkg('progressive-role', 'Progressive role.', 'x'.repeat(1_000))
    role.files.set(
      'SKILL.md',
      Buffer.from(
        `---\nname: progressive-role\ndescription: Progressive role.\nmetadata:\n  notarium.kind: role\n  notarium.skills: "[[notarium-id:personal:${packageDirectoryOf('support-one')}|support-one]] [[notarium-id:personal:${packageDirectoryOf('support-two')}|support-two]]"\n---\n\n${'x'.repeat(1_000)}`,
      ),
    )
    await backing.putIfAbsent(location, role)
    await backing.putIfAbsent(location, skillPkg('support-one', 'First support.', 'First body.'))
    await backing.putIfAbsent(location, skillPkg('support-two', 'Second support.', 'Second body.'))
    const reads: string[] = []
    const roles = createRolesService({
      catalog: async () => [],
      publication: backing.deps.publication,
      library: {
        ...backing.deps.library,
        getAbilitiesNamed: async (where, name) => {
          reads.push(name)
          return backing.getAbilitiesNamed(where, name)
        },
      },
      ...inMemoryAbilityPersistence(),
    })

    await expect(
      roles.loadEffective({ personalSpace: 'personal' }, SYSTEM_PRINCIPAL, 'progressive-role', 100),
    ).resolves.toMatchObject({
      ok: true,
      loaded: {
        truncated: true,
        skills: [
          { name: 'support-one', state: 'omitted-by-budget' },
          { name: 'support-two', state: 'omitted-by-budget' },
        ],
      },
    })
    expect(reads).toEqual(['progressive-role'])
  })

  it('rejects a catalog manifest whose owned provenance rewrite would exceed the shared bound', async () => {
    const name = 'near-limit'
    const revision = `sha256:${'a'.repeat(64)}`
    let source = ''
    let lower = 15_500
    let upper = 16_383

    // Manifest validity is monotonic by padding length. Binary search preserves the
    // exact source-valid/rewrite-invalid boundary without hundreds of 16 KiB YAML parses.
    while (lower <= upper) {
      const padding = Math.floor((lower + upper) / 2)
      const candidate = `---\nname: ${name}\ndescription: Near limit.\nmetadata:\n  notarium.kind: role\n  notarium.source: catalog\n  notarium.package-id: ${packageDirectoryOf(name)}\n  padding: ${'x'.repeat(padding)}\n---\n`

      try {
        parseSkillFile(candidate, name)
      } catch {
        upper = padding - 1
        continue
      }
      try {
        parseSkillFile(withCatalogProvenance(candidate, packageDirectoryOf(name), revision), name)
        lower = padding + 1
      } catch {
        source = candidate
        upper = padding - 1
      }
    }
    expect(source).not.toBe('')
    expect(() => parseSkillFile(source, name)).not.toThrow()
    expect(() =>
      parseSkillFile(withCatalogProvenance(source, packageDirectoryOf(name), revision), name),
    ).toThrow(/frontmatter is too large/u)
    const roles = createRolesService({
      catalog: async () => [
        {
          directoryName: packageDirectoryOf(name),
          files: new Map([['SKILL.md', Buffer.from(source)]]),
        },
      ],
      ...writableLibrary(createInMemoryRoleLibrary()).deps,
      ...inMemoryAbilityPersistence(),
    })

    await expect(roles.listBundledAbilities(SYSTEM_PRINCIPAL)).resolves.toHaveLength(1)
    await expect(
      roles.addFromCatalog(name, { scope: 'personal', space: 'personal' }, null),
    ).rejects.toThrow(/frontmatter is too large/)
  })

  it('rejects a catalog package whose provenance rewrite would cross the package bound', async () => {
    const role = pkg('package-limit', 'Package limit.', 'Instructions.')
    const skillBytes = role.files.get('SKILL.md')!.byteLength
    role.files.set('assets/fill.bin', Buffer.alloc(8 * 1024 * 1024 - skillBytes))
    const library = writableLibrary(createInMemoryRoleLibrary())
    const roles = createRolesService({
      catalog: async () => [catalogPackage(role)],
      ...library.deps,
      ...inMemoryAbilityPersistence(),
    })

    await expect(roles.listBundledAbilities(SYSTEM_PRINCIPAL)).rejects.toThrow(
      /package is too large/,
    )
    await expect(
      library.get({ scope: 'personal', space: 'personal' }, 'package-limit'),
    ).resolves.toBeNull()
  })
  // ── V18 · one role, its reach, and its project versions ────────────────

  const projectContext = (id: string, space: string) => ({
    personalSpace: 'personal',
    project: {
      id,
      space,
      path: id,
      slug: id,
      aliases: [],
      pathAliases: [],
      displayName: id,
      status: 'active' as const,
      createdAt: 'x',
      lastSeen: 'x',
    },
  })

  const spaceRoleLocator = (packageId: string, spaceId: string) =>
    ({
      source: 'owned',
      kind: 'role',
      packageId,
      location: { scope: 'space', spaceId },
    }) as const

  it("refuses a locator that calls one library by the other placement's name", async () => {
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      ...writableLibrary(createInMemoryRoleLibrary()).deps,
      ...inMemoryAbilityPersistence(),
    })
    const shared = await roles.createCustomRole('review', 'Review.', 'Review carefully.', {
      scope: 'space',
      space: 'shared',
    })
    const mine = await roles.createCustomRole('notes', 'Notes.', 'Take notes.', {
      scope: 'personal',
      space: 'personal',
    })
    const asPersonal = {
      source: 'owned',
      kind: 'role',
      packageId: shared.packageId,
      location: { scope: 'personal', spaceId: 'shared' },
    } as const
    const asSpace = {
      source: 'owned',
      kind: 'role',
      packageId: mine.packageId,
      location: { scope: 'space', spaceId: 'personal' },
    } as const

    await expect(
      roles.addressedRoleAt(
        spaceRoleLocator(shared.packageId, 'shared'),
        SYSTEM_PRINCIPAL,
        'personal',
      ),
    ).resolves.toMatchObject({ role: { name: 'review' } })

    // A shared package sitting in the same directory as a personal one must not
    // answer to the personal address: `personal` is what grants the caller write.
    await expect(
      roles.addressedRoleAt(asPersonal, SYSTEM_PRINCIPAL, 'personal'),
    ).resolves.toBeNull()
    await expect(roles.addressedRoleAt(asSpace, SYSTEM_PRINCIPAL, 'personal')).resolves.toBeNull()
    await expect(
      roles.serializeOwnedRoleAttachments(SYSTEM_PRINCIPAL, asPersonal, [], 'personal'),
    ).rejects.toBeInstanceOf(AbilityUnavailableError)
    const asSpaceTarget = await roles.captureCurrentOwnedTarget(asSpace, SYSTEM_PRINCIPAL)

    expect(asSpaceTarget).not.toBeNull()
    await expect(
      roles.setAbilityAvailability(
        { personalSpace: 'personal' },
        SYSTEM_PRINCIPAL,
        asSpaceTarget!,
        { mode: 'all-projects' },
      ),
    ).rejects.toBeInstanceOf(AbilityUnavailableError)

    // The base/version entries ask the same address question, so they get the same
    // answer: `space` borrowed for a personal library is not a place, and Personal
    // has no projects to fork into.
    await expect(
      forkRoleVersion(roles, SYSTEM_PRINCIPAL, asSpace, 'personal', 'project-web'),
    ).rejects.toBeInstanceOf(AbilityUnavailableError)
  })

  it('gives a personal role no versions, no base and nowhere to be promoted to', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      ...library.deps,
      ...inMemoryAbilityPersistence(),
    })
    const mine = await roles.createCustomRole('notes', 'Notes.', 'Take notes.', {
      scope: 'personal',
      space: 'personal',
    })
    // The packages this asks about really exist, so the assertions below fail the
    // moment an entry answers the borrowed address instead of refusing it.
    const sameName = await roles.createCustomRole('notes', 'Notes.', 'Project notes.', {
      scope: 'project',
      space: 'personal',
      projectId: 'project-web',
    })
    const other = await roles.createCustomRole('drafts', 'Drafts.', 'Draft freely.', {
      scope: 'project',
      space: 'personal',
      projectId: 'project-web',
    })
    const inProject = (packageId: string) =>
      ({
        source: 'owned',
        kind: 'role',
        packageId,
        location: { scope: 'project', spaceId: 'personal', projectId: 'project-web' },
      }) as const

    // A `space`-scoped address naming the caller's OWN space is not an address at all,
    // so the borrowed spelling answers nothing in either direction.
    await expect(
      roles.listRoleVersions(
        SYSTEM_PRINCIPAL,
        {
          source: 'owned',
          kind: 'role',
          packageId: mine.packageId,
          location: { scope: 'space', spaceId: 'personal' },
        },
        'personal',
        ['project-web'],
      ),
    ).resolves.toEqual([])
    // The base IS Personal, because the effective chain for a project of the caller's
    // own space is `personal → project` with no Space link between them: the project
    // package really does override the personal one by name, which is what the library
    // listing has always shown by collapsing the two into one role with a version.
    // Only the borrowed `space` spelling above has nothing to point at.
    await expect(
      roles.findRoleBase(SYSTEM_PRINCIPAL, inProject(sameName.packageId), 'personal'),
    ).resolves.toEqual({
      source: 'owned',
      kind: 'role',
      packageId: mine.packageId,
      location: { scope: 'personal', spaceId: 'personal' },
    })
    // Seeing what you override is not the same as being able to promote into it: a
    // promotion into a personal root would turn a project role into one of the owner's
    // own, in a library the space rules do not govern. Still refused.
    await expect(
      roles.moveRolePlacement(
        SYSTEM_PRINCIPAL,
        await capturedRoleTarget(roles, SYSTEM_PRINCIPAL, inProject(other.packageId)),
        'personal',
      ),
    ).rejects.toBeInstanceOf(AbilityUnavailableError)
    // Refused BEFORE anything moved: a promotion into a personal root would have
    // turned a project role into one of the owner's own, in a library the space
    // rules do not govern.
    await expect(
      library.getSkillByDirectory(
        { scope: 'project', space: 'personal', projectId: 'project-web' },
        other.packageId,
      ),
    ).resolves.not.toBeNull()
    await expect(
      library.getSkillByDirectory({ scope: 'personal', space: 'personal' }, other.packageId),
    ).resolves.toBeNull()
  })

  it('gives a Space role a reach, and resolves it only where that reach says', async () => {
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      ...writableLibrary(createInMemoryRoleLibrary()).deps,
      ...inMemoryAbilityPersistence(),
    })
    const created = await roles.createCustomRole(
      'review',
      'Review the release.',
      'Review carefully.',
      { scope: 'space', space: 'shared' },
    )
    await roles.setAbilityAvailability(
      { personalSpace: null },
      SYSTEM_PRINCIPAL,
      await capturedTarget(roles, SYSTEM_PRINCIPAL, spaceRoleLocator(created.packageId, 'shared')),
      { mode: 'selected-projects', projectIds: ['project-api'] },
    )

    await expect(
      roles.resolveEffective(projectContext('project-api', 'shared'), SYSTEM_PRINCIPAL, 'review'),
    ).resolves.toMatchObject({ location: { scope: 'space', space: 'shared' } })
    await expect(
      roles.resolveEffective(projectContext('project-web', 'shared'), SYSTEM_PRINCIPAL, 'review'),
    ).resolves.toBeNull()
    // The list obeys the same gate as activation, in BOTH directions: offering a role
    // that cannot then be activated here is worse than a shorter list, and dropping one
    // the reach does cover would make the setting unusable rather than narrow.
    await expect(
      roles
        .listEffective(projectContext('project-web', 'shared'), SYSTEM_PRINCIPAL)
        .then(({ roles: listed }) => listed.filter((role) => role.name === 'review')),
    ).resolves.toEqual([])
    await expect(
      roles.listEffective(projectContext('project-api', 'shared'), SYSTEM_PRINCIPAL),
    ).resolves.toMatchObject({
      roles: expect.arrayContaining([expect.objectContaining({ name: 'review' })]),
    })
    // Outside a project the Space link is not in the chain at all, so a reach setting
    // has nothing to say here — the same answer as before V18, not a new refusal.
    await expect(
      roles.resolveEffective({ personalSpace: 'personal' }, SYSTEM_PRINCIPAL, 'review'),
    ).resolves.toBeNull()
  })

  it('lets a narrowed Space role fall back to Personal instead of disappearing', async () => {
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      ...writableLibrary(createInMemoryRoleLibrary()).deps,
      ...inMemoryAbilityPersistence(),
    })
    await roles.createCustomRole('review', 'Personal review.', 'My own way.', {
      scope: 'personal',
      space: 'personal',
    })
    const shared = await roles.createCustomRole('review', 'Team review.', 'The team way.', {
      scope: 'space',
      space: 'shared',
    })
    await roles.setAbilityAvailability(
      { personalSpace: null },
      SYSTEM_PRINCIPAL,
      await capturedTarget(roles, SYSTEM_PRINCIPAL, spaceRoleLocator(shared.packageId, 'shared')),
      { mode: 'selected-projects', projectIds: ['project-api'] },
    )

    await expect(
      roles.resolveEffective(projectContext('project-api', 'shared'), SYSTEM_PRINCIPAL, 'review'),
    ).resolves.toMatchObject({ location: { scope: 'space', space: 'shared' } })
    await expect(
      roles.resolveEffective(projectContext('project-web', 'shared'), SYSTEM_PRINCIPAL, 'review'),
    ).resolves.toMatchObject({ location: { scope: 'personal', space: 'personal' } })
  })

  it('resolves a Space role everywhere while no reach was ever recorded', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      ...library.deps,
      ...inMemoryAbilityPersistence(),
    })
    // Published behind the service's back, exactly like a role that predates
    // availability: no row, and therefore no data migration to perform.
    await library.putIfAbsent(
      { scope: 'space', space: 'shared' },
      { ...pkg('legacy-review', 'Legacy review.', 'Review.'), directoryName: 'LegacyRole_1' },
    )

    await expect(
      roles.resolveEffective(
        projectContext('project-web', 'shared'),
        SYSTEM_PRINCIPAL,
        'legacy-review',
      ),
    ).resolves.toMatchObject({ location: { scope: 'space', space: 'shared' } })
  })

  it('forks a Space base into a project version and keeps the two bodies apart', async () => {
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      ...writableLibrary(createInMemoryRoleLibrary()).deps,
      ...inMemoryAbilityPersistence(),
    })
    const base = await roles.createCustomRole(
      'review',
      'Team review.',
      '# Team review\n\nThe team way.',
      { scope: 'space', space: 'shared' },
    )
    const version = await forkRoleVersion(
      roles,
      SYSTEM_PRINCIPAL,
      spaceRoleLocator(base.packageId, 'shared'),
      null,
      'project-web',
    )

    expect(base.title).toBe('Team review')
    expect(version.packageId).not.toBe(base.packageId)
    expect(version).toMatchObject({ name: 'review', scope: 'project', projectId: 'project-web' })
    // The authored H1 IS the role's title and lives in the body, so a copy that
    // rebuilt the package from its parsed parts would silently rename the version.
    expect(version.title).toBe(base.title)
    // The version wins in its own project and nowhere else.
    await expect(
      roles.resolveEffective(projectContext('project-web', 'shared'), SYSTEM_PRINCIPAL, 'review'),
    ).resolves.toMatchObject({ location: { scope: 'project', projectId: 'project-web' } })
    await expect(
      roles.resolveEffective(projectContext('project-api', 'shared'), SYSTEM_PRINCIPAL, 'review'),
    ).resolves.toMatchObject({ location: { scope: 'space', space: 'shared' } })
  })

  it('copies the admitted source snapshot when its address is reoccupied behind the destination fence', async () => {
    const backing = writableLibrary(createInMemoryRoleLibrary())
    const baseLocation = { scope: 'space', space: 'shared' } as const
    const destination = {
      scope: 'project',
      space: 'shared',
      projectId: 'project-web',
    } as const
    const original = {
      ...claimed(
        pkg('review', 'Original review.', '# Original review\n\nOriginal body.'),
        'OriginalManifest',
      ),
      directoryName: 'OriginalPkg1',
    }
    const reoccupant = {
      ...claimed(
        pkg('collision', 'Collision review.', '# Collision review\n\nCollision body.'),
        'CollisionManifest',
      ),
      directoryName: original.directoryName,
    }

    await backing.putIfAbsent(baseLocation, original)
    let destinationChecked = false
    let sourceAdmitted = false
    const roles = createRolesService({
      catalog: async () => [],
      ...inMemoryAbilityPersistence(),
      publication: backing.deps.publication,
      library: {
        ...backing.deps.library,
        captureExactPackage: async (location, directoryName) => {
          sourceAdmitted = true
          try {
            return await backing.deps.library.captureExactPackage(location, directoryName)
          } finally {
            sourceAdmitted = false
          }
        },
        exists: async (location, name, options) => {
          if (
            location.scope === destination.scope &&
            location.projectId === destination.projectId
          ) {
            expect(sourceAdmitted).toBe(false)
            destinationChecked = true
          }

          return backing.deps.library.exists(location, name, options)
        },
        getByDirectory: async (location, directoryName) =>
          destinationChecked &&
          location.scope === baseLocation.scope &&
          location.space === baseLocation.space &&
          directoryName === original.directoryName
            ? reoccupant
            : backing.deps.library.getByDirectory(location, directoryName),
      },
    })
    const version = await forkRoleVersion(
      roles,
      SYSTEM_PRINCIPAL,
      spaceRoleLocator(original.directoryName, 'shared'),
      null,
      destination.projectId,
    )

    expect(destinationChecked).toBe(true)
    expect(version).toMatchObject({
      name: 'review',
      title: 'Original review',
      description: 'Original review.',
    })
    await expect(
      roles.resolveEffective(
        projectContext(destination.projectId, destination.space),
        SYSTEM_PRINCIPAL,
        'review',
      ),
    ).resolves.toMatchObject({ role: { title: 'Original review' } })
    await expect(
      roles.resolveEffective(
        projectContext(destination.projectId, destination.space),
        SYSTEM_PRINCIPAL,
        'collision',
      ),
    ).resolves.toBeNull()
  })

  it('keeps an override self-sufficient when the base does not reach its project', async () => {
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      ...writableLibrary(createInMemoryRoleLibrary()).deps,
      ...inMemoryAbilityPersistence(),
    })
    const base = await roles.createCustomRole('review', 'Team review.', 'The team way.', {
      scope: 'space',
      space: 'shared',
    })
    await forkRoleVersion(
      roles,
      SYSTEM_PRINCIPAL,
      spaceRoleLocator(base.packageId, 'shared'),
      null,
      'project-web',
    )
    await roles.setAbilityAvailability(
      { personalSpace: null },
      SYSTEM_PRINCIPAL,
      await capturedTarget(roles, SYSTEM_PRINCIPAL, spaceRoleLocator(base.packageId, 'shared')),
      { mode: 'selected-projects', projectIds: ['project-api'] },
    )

    // The version was created BY an explicit act for this project; it does not ask
    // the base for permission to exist there.
    await expect(
      roles.resolveEffective(projectContext('project-web', 'shared'), SYSTEM_PRINCIPAL, 'review'),
    ).resolves.toMatchObject({ location: { scope: 'project', projectId: 'project-web' } })
  })

  it('refuses a second version of one role in the same project', async () => {
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      ...writableLibrary(createInMemoryRoleLibrary()).deps,
      ...inMemoryAbilityPersistence(),
    })
    const base = await roles.createCustomRole('review', 'Team review.', 'The team way.', {
      scope: 'space',
      space: 'shared',
    })
    const locator = spaceRoleLocator(base.packageId, 'shared')
    await forkRoleVersion(roles, SYSTEM_PRINCIPAL, locator, null, 'project-web')

    await expect(
      forkRoleVersion(roles, SYSTEM_PRINCIPAL, locator, null, 'project-web'),
    ).rejects.toBeInstanceOf(RoleAlreadyExistsError)
  })

  it('lets a role narrowed to two projects depend on a skill that reaches both', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const availability = new InMemoryAbilityAvailability()
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      ...library.deps,
      abilityAvailability: availability,
    })
    const skillId = 'ReachSkill1_'.slice(0, 12)
    await library.putIfAbsent(
      { scope: 'space', space: 'shared' },
      { ...skillPkg('reach-skill', 'Reaches two projects.'), directoryName: skillId },
    )
    await availability.set('shared', skillId, {
      mode: 'selected-projects',
      projectIds: ['project-api', 'project-web'],
    })
    const attachment = {
      kind: 'exact' as const,
      locator: {
        source: 'owned' as const,
        kind: 'skill' as const,
        packageId: skillId,
        location: { scope: 'space' as const, spaceId: 'shared' },
      },
      label: 'reach-skill',
    }

    // The role covers exactly the projects the skill reaches — authoring must allow
    // it, because resolution does.
    await expect(
      roles.createCustomRole(
        'review',
        'Review.',
        'Review.',
        { scope: 'space', space: 'shared' },
        {
          principal: SYSTEM_PRINCIPAL,
          attachments: [attachment],
          availability: { mode: 'selected-projects', projectIds: ['project-api', 'project-web'] },
        },
      ),
    ).resolves.toMatchObject({ name: 'review' })
    // One project further than the skill reaches leaves the role fail-closed there,
    // which is a state authoring refuses rather than publishes.
    const wider = roles.createCustomRole(
      'wider',
      'Wider.',
      'Wider.',
      { scope: 'space', space: 'shared' },
      {
        principal: SYSTEM_PRINCIPAL,
        attachments: [attachment],
        availability: {
          mode: 'selected-projects',
          projectIds: ['project-api', 'project-web', 'project-mobile'],
        },
      },
    )

    await expect(wider).rejects.toBeInstanceOf(RoleDependencyConflictError)
    await expect(wider).rejects.toMatchObject({
      details: {
        attachment: 'reach-skill',
        verdict: 'unavailable',
        projectId: 'project-mobile',
        rule: 'an attachment must reach every project covered by the role',
      },
    })
  })

  it('makes health a fact about a role AND a project, not about a role alone', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const availability = new InMemoryAbilityAvailability()
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      ...library.deps,
      abilityAvailability: availability,
    })
    const skillId = 'SharedSkill1'
    await library.putIfAbsent(
      { scope: 'space', space: 'shared' },
      { ...skillPkg('shared-skill', 'A skill with a reach of its own.'), directoryName: skillId },
    )
    await availability.set('shared', skillId, { mode: 'all-projects' })
    const role = await roles.createCustomRole(
      'review',
      'Team review.',
      'The team way.',
      { scope: 'space', space: 'shared' },
      {
        principal: SYSTEM_PRINCIPAL,
        attachments: [
          {
            kind: 'exact',
            locator: {
              source: 'owned',
              kind: 'skill',
              packageId: skillId,
              location: { scope: 'space', spaceId: 'shared' },
            },
            label: 'shared-skill',
          },
        ],
      },
    )
    // The role reaches both projects; its skill later narrows to one of them. That
    // pair is ordinary now — a role is not healthy or unhealthy on its own.
    await roles.setAbilityAvailability(
      { personalSpace: null },
      SYSTEM_PRINCIPAL,
      await capturedTarget(roles, SYSTEM_PRINCIPAL, spaceRoleLocator(role.packageId, 'shared')),
      { mode: 'selected-projects', projectIds: ['project-api', 'project-web'] },
    )
    await availability.set('shared', skillId, {
      mode: 'selected-projects',
      projectIds: ['project-api'],
    })

    await expect(
      roles.loadEffective(
        projectContext('project-api', 'shared'),
        SYSTEM_PRINCIPAL,
        'review',
        4_000,
      ),
    ).resolves.toMatchObject({ ok: true, loaded: { role: { name: 'review' } } })
    // Fail-closed where the dependency does not reach.
    await expect(
      roles.loadEffective(
        projectContext('project-web', 'shared'),
        SYSTEM_PRINCIPAL,
        'review',
        4_000,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'unhealthy' })
  })

  /** "Does this package exist" had two answers: the listing and the detail demanded a
   *  projected identity, the base/version pair did not — so the pair handed out
   *  addresses the same server then answered 404 for, and the two writes that share
   *  those addresses answered 500 instead of 404 for the very same package. */
  it('answers one way about a package the projection has not caught up with', async () => {
    const inner = writableLibrary(createInMemoryRoleLibrary())
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      publication: inner.deps.publication,
      library: {
        ...inner.deps.library,
        // A package on disk that the read model has not projected yet. The real library
        // calls this normal: external files land in a mount all the time.
        readableNoteIds: async (location, directoryNames) =>
          new Map(
            [...(await inner.readableNoteIds(location, directoryNames))].filter(
              ([directoryName]) => directoryName !== unprojected,
            ),
          ),
        captureExactPackage: async (location, directoryName, expectedRegistryNoteId) =>
          directoryName === unprojected
            ? null
            : inner.captureExactPackage(location, directoryName, expectedRegistryNoteId),
      },
    })
    const base = await roles.createCustomRole('review', 'Review.', 'Review it.', {
      scope: 'space',
      space: 'shared',
    })
    const unprojected = base.packageId
    const version = await roles.createCustomRole('review', 'Project review.', 'Its own way.', {
      scope: 'project',
      space: 'shared',
      projectId: 'project-web',
    })
    const baseLocator = {
      source: 'owned',
      kind: 'role',
      packageId: base.packageId,
      location: { scope: 'space', spaceId: 'shared' },
    } as const

    // The detail already refuses it, so nothing else may hand its address out…
    await expect(
      roles.describeAbility({ personalSpace: null }, SYSTEM_PRINCIPAL, baseLocator, 4_000),
    ).resolves.toBeNull()
    await expect(
      roles.findRoleBase(
        SYSTEM_PRINCIPAL,
        {
          source: 'owned',
          kind: 'role',
          packageId: version.packageId,
          location: { scope: 'project', spaceId: 'shared', projectId: 'project-web' },
        },
        null,
      ),
    ).resolves.toBeNull()
    await expect(
      roles.listRoleVersions(SYSTEM_PRINCIPAL, baseLocator, null, ['project-web']),
    ).resolves.toEqual([])
    // …and the writes that take it must refuse it the same way the reader does.
    await expect(roles.captureCurrentOwnedTarget(baseLocator, SYSTEM_PRINCIPAL)).resolves.toBeNull()
    await expect(
      roles.serializeOwnedRoleAttachments(SYSTEM_PRINCIPAL, baseLocator, [], null),
    ).rejects.toBeInstanceOf(AbilityUnavailableError)
  })

  /** A project inside the caller's PERSONAL space falls back to Personal, not to a
   *  Space root — Personal IS that space's root. The listing already collapses the two
   *  into one role with a version; both detail answers denied the relation, so the same
   *  server said "this is a version" and "this has no base" about one pair. */
  it('answers base and versions for a project inside the personal space', async () => {
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      ...writableLibrary(createInMemoryRoleLibrary()).deps,
    })
    const base = await roles.createCustomRole('review', 'Personal review.', 'The personal way.', {
      scope: 'personal',
      space: 'personal',
    })
    const version = await roles.createCustomRole('review', 'Project review.', 'The project way.', {
      scope: 'project',
      space: 'personal',
      projectId: 'work',
    })
    const baseLocator = {
      source: 'owned',
      kind: 'role',
      packageId: base.packageId,
      location: { scope: 'personal', spaceId: 'personal' },
    } as const
    const versionLocator = {
      source: 'owned',
      kind: 'role',
      packageId: version.packageId,
      location: { scope: 'project', spaceId: 'personal', projectId: 'work' },
    } as const

    await expect(roles.findRoleBase(SYSTEM_PRINCIPAL, versionLocator, 'personal')).resolves.toEqual(
      baseLocator,
    )
    await expect(
      roles.listRoleVersions(SYSTEM_PRINCIPAL, baseLocator, 'personal', ['work']),
    ).resolves.toEqual([{ projectId: 'work', locator: versionLocator }])
  })

  /** Enable/Disable is an OWNER-scoped override — a fact about the caller, not about
   *  the world. Five of the six attachment verdicts describe the shared package;
   *  `disabled` describes the reader, and letting it refuse a WRITE makes the composition
   *  of a shared role depend on who opened it. */
  it('lets a role be saved by someone who turned one of its skills off for themselves', async () => {
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      ...writableLibrary(createInMemoryRoleLibrary()).deps,
    })
    const home = { scope: 'space', space: 'shared' } as const
    const skill = await roles.createCustomSkill('evidence', 'Evidence.', 'Gather it.', home)
    const skillLocator = {
      source: 'owned',
      kind: 'skill',
      packageId: skill.packageId,
      location: { scope: 'space', spaceId: 'shared' },
    } as const
    const attachments = [{ kind: 'exact', locator: skillLocator, label: 'evidence' }] as const
    const role = await roles.createCustomRole('team-review', 'Review.', 'Review it.', home, {
      principal: SYSTEM_PRINCIPAL,
      attachments,
      personalSpace: null,
    })
    const roleLocator = {
      source: 'owned',
      kind: 'role',
      packageId: role.packageId,
      location: { scope: 'space', spaceId: 'shared' },
    } as const

    // The owner turns the shared skill off FOR THEMSELVES. Nothing about the package changed.
    await roles.setEnabled(
      { personalSpace: null },
      SYSTEM_PRINCIPAL,
      await capturedTarget(roles, SYSTEM_PRINCIPAL, skillLocator),
      false,
    )

    await expect(
      roles.serializeOwnedRoleAttachments(SYSTEM_PRINCIPAL, roleLocator, attachments, null),
    ).resolves.toMatchObject({ links: [expect.stringContaining(skill.packageId)] })
  })

  /** Personal IS the root of the caller's own space, so a role placed in a PROJECT of
   *  that space depends on personal skills. The reader already answers that way; this
   *  asks whether the writer that produces the token agrees, in both directions. */
  it('lets a role in a project of the personal space hold and resave a personal skill', async () => {
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      ...writableLibrary(createInMemoryRoleLibrary()).deps,
    })
    const skill = await roles.createCustomSkill('evidence', 'Evidence.', 'Gather it.', {
      scope: 'personal',
      space: 'personal',
    })
    const attachments = [
      {
        kind: 'exact',
        locator: {
          source: 'owned',
          kind: 'skill',
          packageId: skill.packageId,
          location: { scope: 'personal', spaceId: 'personal' },
        },
        label: 'evidence',
      },
    ] as const
    const role = await roles.createCustomRole(
      'review',
      'Review.',
      'Review it.',
      {
        scope: 'project',
        space: 'personal',
        projectId: 'project-web',
      },
      { principal: SYSTEM_PRINCIPAL, attachments, personalSpace: 'personal' },
    )
    const roleLocator = {
      source: 'owned',
      kind: 'role',
      packageId: role.packageId,
      location: { scope: 'project', spaceId: 'personal', projectId: 'project-web' },
    } as const

    // The detail surface calls this attachment healthy, so resaving the very list it
    // just handed back has to be accepted: a refusal here leaves the list of such a
    // role permanently uneditable while its body still saves.
    await expect(
      roles.describeAbility(
        {
          personalSpace: 'personal',
          project: {
            id: 'project-web',
            space: 'personal',
            path: 'web',
            slug: 'web',
            aliases: [],
            pathAliases: [],
            displayName: 'Web',
            status: 'active' as const,
            createdAt: 'x',
            lastSeen: 'x',
          },
        },
        SYSTEM_PRINCIPAL,
        roleLocator,
        4_000,
      ),
    ).resolves.toMatchObject({
      health: { attachments: [{ health: 'healthy' }] },
    })
    await expect(
      roles.serializeOwnedRoleAttachments(SYSTEM_PRINCIPAL, roleLocator, attachments, 'personal'),
    ).resolves.toMatchObject({ links: [expect.stringContaining(skill.packageId)] })
  })

  /** Two questions, two producers. One answer served both until a member who had
   *  turned a shared role off FOR THEMSELVES could no longer edit the shared context
   *  of that role — a private reading preference deciding a shared write. */
  it('keeps a shared role editable by a member who turned it off for themselves', async () => {
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      ...writableLibrary(createInMemoryRoleLibrary()).deps,
    })
    const role = await roles.createCustomRole('review', 'Review.', 'The way.', {
      scope: 'space',
      space: 'shared',
    })
    const locator = {
      source: 'owned',
      kind: 'role',
      packageId: role.packageId,
      location: { scope: 'space', spaceId: 'shared' },
    } as const

    await roles.setEnabled(
      { personalSpace: 'personal' },
      SYSTEM_PRINCIPAL,
      await capturedTarget(roles, SYSTEM_PRINCIPAL, locator),
      false,
    )

    // The address still names the same shared role: pins, sets and ordering stay editable.
    await expect(
      roles.addressedRoleAt(locator, SYSTEM_PRINCIPAL, 'personal'),
    ).resolves.toMatchObject({ role: { name: 'review' } })
    // ...and it is no longer effective FOR THIS READER, so no preview offers it.
    await expect(
      roles.effectiveRoleAt({ personalSpace: 'personal' }, SYSTEM_PRINCIPAL, locator),
    ).resolves.toBeNull()
  })

  /** The preview door asks about a role INSIDE a project, so reach is part of the
   *  question. Answering it without reach offered a role the resolver then refused. */
  it('offers a Space role only in the projects its reach covers', async () => {
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      ...writableLibrary(createInMemoryRoleLibrary()).deps,
    })
    const role = await roles.createCustomRole('review', 'Review.', 'The way.', {
      scope: 'space',
      space: 'shared',
    })
    const locator = {
      source: 'owned',
      kind: 'role',
      packageId: role.packageId,
      location: { scope: 'space', spaceId: 'shared' },
    } as const

    await roles.setAbilityAvailability(
      { personalSpace: 'personal' },
      SYSTEM_PRINCIPAL,
      await capturedTarget(roles, SYSTEM_PRINCIPAL, locator),
      {
        mode: 'selected-projects',
        projectIds: ['project-a'],
      },
    )

    await expect(
      roles.effectiveRoleAt(projectContext('project-a', 'shared'), SYSTEM_PRINCIPAL, locator),
    ).resolves.toMatchObject({ role: { name: 'review' } })
    await expect(
      roles.effectiveRoleAt(projectContext('project-b', 'shared'), SYSTEM_PRINCIPAL, locator),
    ).resolves.toBeNull()
    // Editing its shared context is not a per-project question at all.
    await expect(
      roles.addressedRoleAt(locator, SYSTEM_PRINCIPAL, 'personal'),
    ).resolves.toMatchObject({ role: { name: 'review' } })
  })

  /** Resume refuses an unsound role. A surface that reports the binding as live has
   *  to refuse it too, or the page says a role is active while the agent has none. */
  it('reports no active saved role when resume would drop it as unsound', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      ...library.deps,
    })
    const space = { scope: 'space' as const, space: 'shared' }
    const roleId = 'BrokenRole_1'

    await library.putIfAbsent(space, {
      directoryName: roleId,
      files: new Map([
        [
          'SKILL.md',
          Buffer.from(
            '---\nname: review\ndescription: Review.\nmetadata:\n  notarium.kind: role\n' +
              '  notarium.skills: "[[notarium-id:space:MissingSk_1|evidence]]"\n---\n\nReview it.',
          ),
        ],
      ]),
    })
    const locator = {
      source: 'owned',
      kind: 'role',
      packageId: roleId,
      location: { scope: 'space', spaceId: 'shared' },
    } as const
    // A Space role is addressable only from inside a project — that is where the
    // chain has a Space link at all.
    const context = {
      personalSpace: null,
      project: {
        id: 'project-a',
        space: 'shared',
        path: 'project-a',
        slug: 'project-a',
        aliases: [],
        pathAliases: [],
        displayName: 'Project A',
        status: 'active' as const,
        createdAt: 'x',
        lastSeen: 'x',
      },
    }

    // The binding still ADDRESSES a live, enabled, in-reach package...
    await expect(
      roles.loadSavedRole(context, SYSTEM_PRINCIPAL, locator, 4_000),
    ).resolves.toMatchObject({ ok: false, reason: 'unhealthy' })
    // ...so the two answers have to agree that it is not raisable.
    await expect(roles.resolveSavedRole(context, SYSTEM_PRINCIPAL, locator)).resolves.toBeNull()
  })

  /** The preview claims it mirrors what the agent loads. A role whose attachment no
   *  longer resolves is refused by resume — so the preview has to say so, rather than
   *  drawing it as the selected role and charging its layer to the budget. */
  it('reports an addressed role as inactive when resume would refuse it', async () => {
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      ...writableLibrary(createInMemoryRoleLibrary()).deps,
    })
    const home = { scope: 'space', space: 'shared' } as const
    const skill = await roles.createCustomSkill('evidence', 'Evidence.', 'Gather it.', home)
    const skillLocator = {
      source: 'owned',
      kind: 'skill',
      packageId: skill.packageId,
      location: { scope: 'space', spaceId: 'shared' },
    } as const
    const role = await roles.createCustomRole('review', 'Review.', 'Review it.', home, {
      principal: SYSTEM_PRINCIPAL,
      attachments: [{ kind: 'exact', locator: skillLocator, label: 'evidence' }],
      personalSpace: null,
    })
    const locator = {
      source: 'owned',
      kind: 'role',
      packageId: role.packageId,
      location: { scope: 'space', spaceId: 'shared' },
    } as const
    // Standing INSIDE a project of the role's space, because that is the only place a
    // Space role is in the chain at all. Asked from Personal it is `out-of-reach`
    // whatever its health, and a health test standing there would prove nothing.
    const context = {
      personalSpace: null,
      project: {
        id: 'project-a',
        space: 'shared',
        path: 'a',
        slug: 'a',
        aliases: [],
        pathAliases: [],
        displayName: 'A',
        status: 'active' as const,
        createdAt: 'x',
        lastSeen: 'x',
      },
    }

    await expect(
      roles.addressedRoleStatus(context, SYSTEM_PRINCIPAL, locator),
    ).resolves.toMatchObject({ active: true })

    // The owner switches the attached skill off for themselves. The package is untouched.
    await roles.setEnabled(
      context,
      SYSTEM_PRINCIPAL,
      await capturedTarget(roles, SYSTEM_PRINCIPAL, skillLocator),
      false,
    )

    // Resume refuses the role...
    await expect(
      roles.loadSavedRole(context, SYSTEM_PRINCIPAL, locator, 4_000),
    ).resolves.toMatchObject({ ok: false, reason: 'unhealthy' })
    // ...so the preview must not call it live — while still naming it, because its
    // shared context stays editable.
    await expect(
      roles.addressedRoleStatus(context, SYSTEM_PRINCIPAL, locator),
    ).resolves.toMatchObject({
      active: false,
      inactive: 'unhealthy',
      role: { role: { name: 'review' } },
    })
    await expect(roles.effectiveRoleAt(context, SYSTEM_PRINCIPAL, locator)).resolves.toBeNull()
  })

  /** The placement plan of ONE Add, settled before any of it lands. A role is not
   *  one package: its linked skills go to the home its dependencies live in, and the
   *  role package to the target itself. A host that can publish one and not the other
   *  used to discover that after the dependencies were already on disk. */
  describe('the placement plan is settled before the first package lands', () => {
    const projectPlacement = { scope: 'project', space: 'shared', projectId: 'project-b' } as const

    /** One composition that refuses a writer for chosen placements, and counts every
     *  resolve — so a case can assert both WHICH placements were asked for and that
     *  each was asked exactly once. */
    const countingComposition = (
      composition: RoleLibraryComposition,
      unavailable: (location: RoleLocation) => boolean = () => false,
    ) => {
      const key = (location: RoleLocation) =>
        `${location.scope}:${location.space}:${location.projectId ?? ''}`
      const asked: string[] = []
      const resolved: string[] = []

      return {
        asked,
        resolved,
        deps: {
          library: composition.library,
          publication: {
            availableFor: (target: RolePublicationTarget) => {
              if (target.kind === 'prospective-personal') {
                return composition.publication.availableFor(target)
              }
              asked.push(key(target.location))

              return !unavailable(target.location) && composition.publication.availableFor(target)
            },
            publicationFor: async (location: RoleLocation) => {
              resolved.push(key(location))

              return unavailable(location) ? null : composition.publication.publicationFor(location)
            },
          },
        },
      }
    }

    it('refuses the whole Add when only the role placement is unpublishable', async () => {
      const library = writableLibrary(createInMemoryRoleLibrary())
      const availability = new InMemoryAbilityAvailability()
      const composition = countingComposition(
        library.deps,
        (location) => location.scope === 'project',
      )
      const roles = createRolesService({
        ...inMemoryAbilityPersistence(),
        catalog: loadBundledAbilityInventory,
        ...composition.deps,
        abilityAvailability: availability,
      })

      await expect(roles.addFromCatalog('grooming', projectPlacement, null)).rejects.toBeInstanceOf(
        RoleInstallUnavailableError,
      )
      // Both placements were asked about, and the refusal of one stopped the other
      // before it wrote: no dependency package, no reach row, nothing to undo.
      expect(composition.asked).toContain('project:shared:project-b')
      expect(composition.resolved).not.toContain('project:shared:project-b')
      await expect(
        library.listManifests({ scope: 'space', space: 'shared' }),
      ).resolves.toMatchObject({ packages: [] })
      await expect(library.listManifests(projectPlacement)).resolves.toMatchObject({ packages: [] })
    })

    it('refuses it when only the dependency home is unpublishable', async () => {
      const library = writableLibrary(createInMemoryRoleLibrary())
      const composition = countingComposition(
        library.deps,
        (location) => location.scope === 'space',
      )
      const roles = createRolesService({
        ...inMemoryAbilityPersistence(),
        catalog: loadBundledAbilityInventory,
        ...composition.deps,
      })

      await expect(roles.addFromCatalog('grooming', projectPlacement, null)).rejects.toBeInstanceOf(
        RoleInstallUnavailableError,
      )
      await expect(library.listManifests(projectPlacement)).resolves.toMatchObject({ packages: [] })
    })

    it('resolves each distinct placement exactly once, and reuses one for a shared home', async () => {
      const library = writableLibrary(createInMemoryRoleLibrary())
      const composition = countingComposition(library.deps)
      const roles = createRolesService({
        ...inMemoryAbilityPersistence(),
        catalog: loadBundledAbilityInventory,
        ...composition.deps,
      })

      await roles.addFromCatalog('grooming', projectPlacement, null)
      // Two distinct placements, two resolves — the dependency loop and the role
      // write both used handles taken before either of them ran.
      expect(composition.resolved).toEqual(['space:shared:', 'project:shared:project-b'])

      composition.resolved.length = 0
      // Personal keeps its dependencies at home, so one placement and ONE handle.
      await roles.addFromCatalog('grooming', { scope: 'personal', space: 'personal' }, 'personal')
      expect(composition.resolved).toEqual(['personal:personal:'])
    })

    it('keeps a compatible dependency that already landed when the role commit is refused', async () => {
      const library = writableLibrary(createInMemoryRoleLibrary())
      const availability = new InMemoryAbilityAvailability()
      let refuse = true
      const roles = createRolesService({
        ...inMemoryAbilityPersistence(),
        catalog: loadBundledAbilityInventory,
        ...interceptPublication(library.deps, {
          putIfAbsent: (location, _candidate, next) =>
            location.scope === 'project' && refuse
              ? Promise.reject(new RoleInstallUnavailableError('the medium refused this pathname'))
              : next(),
        }),
        abilityAvailability: availability,
      })

      await expect(roles.addFromCatalog('grooming', projectPlacement, null)).rejects.toBeInstanceOf(
        RoleInstallUnavailableError,
      )
      // The failing target is absent — but the dependency that DID land stays. The
      // port has no package removal, and a retry is the honest way back.
      await expect(library.listManifests(projectPlacement)).resolves.toMatchObject({ packages: [] })
      const dependencies = await library.listManifests({ scope: 'space', space: 'shared' })
      const dependency = await library.get({ scope: 'space', space: 'shared' }, 'grooming-evidence')

      expect(dependencies.packages).toHaveLength(1)
      expect(dependency).not.toBeNull()
      await expect(availability.get('shared', dependency!.directoryName)).resolves.toMatchObject({
        projectIds: ['project-b'],
      })

      refuse = false
      await expect(roles.addFromCatalog('grooming', projectPlacement, null)).resolves.toMatchObject(
        { name: 'grooming' },
      )
      // Retry converged on the SAME dependency rather than forking a second copy.
      await expect(
        library.listManifests({ scope: 'space', space: 'shared' }),
      ).resolves.toMatchObject({ packages: dependencies.packages })
    })

    it('does not name a failure after the commit unavailable', async () => {
      const library = writableLibrary(createInMemoryRoleLibrary())
      const roles = createRolesService({
        ...inMemoryAbilityPersistence(),
        catalog: loadBundledAbilityInventory,
        ...library.deps,
      })

      // The projection barrier runs AFTER the package is on disk. Answering
      // "unavailable" here would invite a retry that then conflicts with the very
      // package this call published.
      library.deps.library.awaitReadableNoteIds = async () => {
        throw new Error('the projection barrier timed out')
      }

      const failed = await roles
        .addFromCatalog('grooming', projectPlacement, null)
        .catch((error: unknown) => error)

      expect(failed).not.toBeInstanceOf(RoleInstallUnavailableError)
      expect(failed).toMatchObject({ message: 'the projection barrier timed out' })
    })

    it('keeps every stable package conflict ahead of publication refusal', async () => {
      const composition = createInMemoryRoleLibrary()
      const seeded = createRolesService({
        ...inMemoryAbilityPersistence(),
        catalog: loadBundledAbilityInventory,
        ...composition,
      })
      const personal = { scope: 'personal', space: 'personal' } as const
      const space = { scope: 'space', space: 'shared' } as const

      await seeded.addFromCatalog('grooming', personal, 'personal')
      await seeded.createCustomRole('custom-role', 'Custom role.', '# Custom role', personal)
      await seeded.createCustomSkill('custom-skill', 'Custom skill.', '# Custom skill', personal)
      await seeded.createCustomSkill('space-skill', 'Space skill.', '# Space skill', space)
      const base = await seeded.createCustomRole(
        'versioned-role',
        'Versioned role.',
        '# Versioned role',
        space,
      )
      await forkRoleVersion(
        seeded,
        SYSTEM_PRINCIPAL,
        spaceRoleLocator(base.packageId, space.space),
        null,
        'project-web',
      )

      const publicationFor = vi.fn(async () => null)
      const refused = createRolesService({
        ...inMemoryAbilityPersistence(),
        catalog: loadBundledAbilityInventory,
        library: composition.library,
        publication: { availableFor: () => false, publicationFor },
      })

      await expect(refused.addFromCatalog('grooming', personal, 'personal')).rejects.toBeInstanceOf(
        RoleAlreadyExistsError,
      )
      await expect(
        refused.addSkillFromCatalog('grooming-evidence', personal),
      ).rejects.toBeInstanceOf(SkillAlreadyExistsError)
      await expect(
        refused.createCustomRole('custom-role', 'Custom role.', '# Custom role', personal),
      ).rejects.toBeInstanceOf(RoleAlreadyExistsError)
      await expect(
        refused.createCustomSkill('custom-skill', 'Custom skill.', '# Custom skill', personal),
      ).rejects.toBeInstanceOf(SkillAlreadyExistsError)
      await expect(
        refused.createCustomSkill('space-skill', 'Space skill.', '# Space skill', space),
      ).rejects.toBeInstanceOf(SkillAlreadyExistsError)
      await expect(
        forkRoleVersion(
          refused,
          SYSTEM_PRINCIPAL,
          spaceRoleLocator(base.packageId, space.space),
          null,
          'project-web',
        ),
      ).rejects.toBeInstanceOf(RoleAlreadyExistsError)
      expect(publicationFor).not.toHaveBeenCalled()
    })

    it('resolves a custom Space role publisher before writing reach metadata', async () => {
      const composition = createInMemoryRoleLibrary()
      const availability = new InMemoryAbilityAvailability()
      const set = vi.spyOn(availability, 'set')
      const publicationFor = vi.fn(async () => null)
      const roles = createRolesService({
        ...inMemoryAbilityPersistence(),
        catalog: async () => [],
        library: composition.library,
        publication: { availableFor: () => true, publicationFor },
        abilityAvailability: availability,
      })

      await expect(
        roles.createCustomRole(
          'custom-role',
          'Custom role.',
          '# Custom role',
          { scope: 'space', space: 'shared' },
          { availability: { mode: 'selected-projects', projectIds: ['project-web'] } },
        ),
      ).rejects.toBeInstanceOf(RoleInstallUnavailableError)
      expect(publicationFor).toHaveBeenCalledOnce()
      expect(set).not.toHaveBeenCalled()
    })

    it('maps authority name races to the dependency and final-role conflict domains', async () => {
      const dependencyComposition = createInMemoryRoleLibrary()
      const dependencyRoles = createRolesService({
        ...inMemoryAbilityPersistence(),
        catalog: loadBundledAbilityInventory,
        ...interceptPublication(dependencyComposition, {
          putIfAbsent: async () => {
            throw Object.assign(new Error('name raced'), { code: 'SKILL_NAME_CONFLICT' })
          },
        }),
      })

      await expect(
        dependencyRoles.addFromCatalog('grooming', projectPlacement, null),
      ).rejects.toBeInstanceOf(RoleDependencyConflictError)

      const roleComposition = createInMemoryRoleLibrary()
      let writes = 0
      const roleRoles = createRolesService({
        ...inMemoryAbilityPersistence(),
        catalog: loadBundledAbilityInventory,
        ...interceptPublication(roleComposition, {
          putIfAbsent: async (_location, _candidate, next) => {
            writes++
            if (writes === 2) {
              throw Object.assign(new Error('name raced'), { code: 'SKILL_NAME_CONFLICT' })
            }

            return next()
          },
        }),
      })

      await expect(
        roleRoles.addFromCatalog('grooming', projectPlacement, null),
      ).rejects.toBeInstanceOf(RoleAlreadyExistsError)
    })
  })

  it('retains a shared skill grant when the role it was added for fails to publish', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const availability = new InMemoryAbilityAvailability()
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      ...interceptPublication(library.deps, {
        // Dependencies go to the Space home; the role itself is the LAST thing
        // published and the only thing published at the project placement.
        putIfAbsent: (location, _pkg, next) => {
          if (location.scope === 'project') {
            throw new Error('the destination refused the role package')
          }

          return next()
        },
      }),
      abilityAvailability: availability,
    })
    const dependency = await roles.addSkillFromCatalog(
      'grooming-evidence',
      { scope: 'space', space: 'shared' },
      { mode: 'selected-projects', projectIds: ['project-a'] },
    )
    const reachBefore = await availability.get('shared', dependency.packageId)

    await expect(
      roles.addFromCatalog(
        'grooming',
        { scope: 'project', space: 'shared', projectId: 'project-b' },
        null,
      ),
    ).rejects.toThrow('the destination refused the role package')

    await expect(availability.get('shared', dependency.packageId)).resolves.toEqual({
      ...reachBefore,
      projectIds: ['project-a', 'project-b'],
    })
  })

  it('does not erase a concurrent successful Add when an earlier role publication fails', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const availability = new InMemoryAbilityAvailability()
    const lateRefusal = new RoleInstallUnavailableError('the project-b role commit was refused')
    let reachedLateCommit!: () => void
    let refuseLateCommit!: () => void
    const atLateCommit = new Promise<void>((resolve) => {
      reachedLateCommit = resolve
    })
    const blockedCommit = new Promise<boolean>((_resolve, reject) => {
      refuseLateCommit = () => reject(lateRefusal)
    })
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      ...interceptPublication(library.deps, {
        putIfAbsent: (location, _pkg, next) => {
          if (location.scope === 'project' && location.projectId === 'project-b') {
            reachedLateCommit()
            return blockedCommit
          }

          return next()
        },
      }),
      abilityAvailability: availability,
    })
    const space = { scope: 'space', space: 'shared' } as const
    const projectB = { scope: 'project', space: 'shared', projectId: 'project-b' } as const
    const projectC = { scope: 'project', space: 'shared', projectId: 'project-c' } as const
    const addB = roles.addFromCatalog('grooming', projectB, null)

    await atLateCommit
    const dependency = await library.get(space, 'grooming-evidence')

    expect(dependency).not.toBeNull()
    await expect(availability.get('shared', dependency!.directoryName)).resolves.toMatchObject({
      projectIds: ['project-b'],
    })

    await expect(roles.addFromCatalog('grooming', projectC, null)).resolves.toMatchObject({
      name: 'grooming',
      projectId: 'project-c',
    })
    await expect(library.listManifests(space)).resolves.toMatchObject({
      packages: [expect.objectContaining({ directoryName: dependency!.directoryName })],
    })
    refuseLateCommit()
    await expect(addB).rejects.toBe(lateRefusal)

    await expect(availability.get('shared', dependency!.directoryName)).resolves.toEqual({
      homeSpace: 'shared',
      packageId: dependency!.directoryName,
      mode: 'selected-projects',
      projectIds: ['project-b', 'project-c'],
    })
    await expect(
      roles.loadEffective(
        projectContext('project-c', 'shared'),
        SYSTEM_PRINCIPAL,
        'grooming',
        4_000,
      ),
    ).resolves.toMatchObject({
      ok: true,
      loaded: {
        role: { name: 'grooming' },
        skills: [{ name: 'grooming-evidence' }],
      },
    })
  })

  /** Dependency-first Add keeps completed grants across every later failure. Once the
   *  role is published, removing them would leave a live role permanently unhealthy:
   *  retry cannot repair it because the role itself now conflicts. */
  it('keeps a landed role reachable when the step after publication fails', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const availability = new InMemoryAbilityAvailability()
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      ...library.deps,
      abilityAvailability: availability,
    })
    const home = { scope: 'space', space: 'shared' } as const
    const placement = { scope: 'project', space: 'shared', projectId: 'project-b' } as const
    const dependency = await roles.addSkillFromCatalog('grooming-evidence', home, {
      mode: 'selected-projects',
      projectIds: ['project-a'],
    })
    const awaitReadable = library.awaitReadableNoteIds.bind(library)

    // Fails AFTER putIfAbsent has landed the role at its placement. Patched on the
    // object the SERVICE holds — the writable wrapper is a copy, and a service
    // that never saw the patch would sail through the case.
    library.deps.library.awaitReadableNoteIds = async (location, ids) => {
      if (location.scope === 'project') {
        throw new Error('the projection barrier timed out')
      }

      return awaitReadable(location, ids)
    }

    await expect(roles.addFromCatalog('grooming', placement, null)).rejects.toThrow(
      'the projection barrier timed out',
    )

    // The role really is published — the library port cannot take it back...
    await expect(library.get(placement, 'grooming')).resolves.not.toBeNull()
    // ...so its dependency must still reach the project it was installed for, or the
    // role is effective and permanently unusable.
    await expect(availability.get('shared', dependency.packageId)).resolves.toMatchObject({
      projectIds: expect.arrayContaining(['project-a', 'project-b']),
    })
  })

  /** Every owned door takes an ADDRESS and a claim about what stands at it, and the
   *  two are independent: a locator is a string a caller kept, and the package at that
   *  address is whatever the library holds now. Answering from the address alone hands
   *  a caller the bytes of a different ability under the identity it asked for — so
   *  each door re-derives the locator from the manifest it actually read and refuses
   *  unless the two are the same address, kind included. */
  it('refuses every owned door when the package is not the ability the locator names', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const roles = createRolesService({
      catalog: async () => [],
      ...library.deps,
      ...inMemoryAbilityPersistence(),
    })
    const space = { scope: 'space', space: 'shared' } as const
    const project = { scope: 'project', space: 'shared', projectId: 'project-web' } as const
    const standalone = claimed(skillPkg('field-notes', 'Field notes.'), 'ManifestNote1')
    const packageId = standalone.directoryName

    await expect(library.putIfAbsent(space, standalone)).resolves.toBe(true)
    await expect(library.putIfAbsent(project, standalone)).resolves.toBe(true)

    const asRole = {
      source: 'owned',
      kind: 'role',
      packageId,
      location: { scope: 'space', spaceId: 'shared' },
    } as const
    const target = { locator: asRole, registryNoteId: packageId, manifestNoteId: 'ManifestNote1' }

    // A Space-placed standalone skill, addressed as a Role. The address exists, the
    // package is there, and the identity it carries is the one the caller expects —
    // only the KIND disagrees, and that is enough to make it a different ability.
    await expect(roles.captureCurrentOwnedTarget(asRole, SYSTEM_PRINCIPAL)).resolves.toBeNull()
    await expect(roles.captureOwnedTarget(target, SYSTEM_PRINCIPAL)).resolves.toBeNull()
    await expect(
      roles.withOwnedTargetMutation(target, SYSTEM_PRINCIPAL, async () => 'mutated'),
    ).resolves.toBeNull()
    await expect(
      roles.resolveOwnedAt(space, SYSTEM_PRINCIPAL, ABILITY_KIND.role, packageId),
    ).resolves.toBeNull()
    await expect(
      roles.captureOwnedAt(space, SYSTEM_PRINCIPAL, ABILITY_KIND.role, packageId, packageId),
    ).resolves.toBeNull()

    // …and the same package one placement down, where the kind it DOES have has no
    // address at all: a standalone skill is addressed by its Space or by Personal, so a
    // project placement names a locator that cannot be spelled. The doors that answer
    // with a locator have nothing to answer with, and must not invent one.
    await expect(
      roles.resolveOwnedAt(project, SYSTEM_PRINCIPAL, ABILITY_KIND.skill, packageId),
    ).resolves.toBeNull()
    await expect(
      roles.captureOwnedAt(project, SYSTEM_PRINCIPAL, ABILITY_KIND.skill, packageId, packageId),
    ).resolves.toBeNull()
    // The same package at that project, addressed as a Role: here the manifest yields
    // NO owned locator at all — a standalone skill has no project spelling — so there
    // is nothing to compare the caller's address against, and "nothing" is a refusal
    // rather than a licence to hand back the bytes.
    const asProjectRole = {
      source: 'owned',
      kind: 'role',
      packageId,
      location: { scope: 'project', spaceId: 'shared', projectId: 'project-web' },
    } as const

    await expect(
      roles.captureCurrentOwnedTarget(asProjectRole, SYSTEM_PRINCIPAL),
    ).resolves.toBeNull()
    await expect(
      roles.captureOwnedTarget(
        { locator: asProjectRole, registryNoteId: packageId, manifestNoteId: 'ManifestNote1' },
        SYSTEM_PRINCIPAL,
      ),
    ).resolves.toBeNull()

    // The control: the SAME package answers every one of those doors at the address
    // whose kind it really has, so none of the refusals above is a door that is simply
    // shut.
    const asSkill = {
      source: 'owned',
      kind: 'skill',
      packageId,
      location: { scope: 'space', spaceId: 'shared' },
    } as const

    await expect(roles.captureCurrentOwnedTarget(asSkill, SYSTEM_PRINCIPAL)).resolves.toMatchObject(
      {
        locator: asSkill,
      },
    )
    await expect(
      roles.captureOwnedAt(space, SYSTEM_PRINCIPAL, ABILITY_KIND.skill, packageId, packageId),
    ).resolves.toMatchObject({ locator: asSkill })
  })

  it('keeps distinct physical and projected identities through move and stale resolution', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const source = { scope: 'project' as const, space: 'shared', projectId: 'project-web' }
    const packageId = 'AbCdefGhij_1'
    const manifestNoteId = 'ForeignClaim1'
    const stale = {
      source: 'owned',
      kind: 'role',
      packageId,
      location: { scope: 'project', spaceId: 'shared', projectId: 'project-web' },
    } as const
    const staleKey = serializeAbilityLocator(stale)
    let trail: {
      toLocator: string
      registryNoteId: string
      manifestNoteId: string
    } | null = null
    const moveOwnedRolePlacement = vi.fn(async (move) => {
      trail = {
        toLocator: move.toLocator,
        registryNoteId: move.registryNoteId,
        manifestNoteId: move.manifestNoteId,
      }
      return 'applied' as const
    })
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: async () => [],
      ...library.deps,
      abilityPlacement: {
        resolveMovedOwnedRoleLocator: async (fromLocator) =>
          fromLocator === staleKey ? trail : null,
        moveOwnedRolePlacement,
      },
    })

    await library.putIfAbsent(source, {
      ...claimed(pkg('review', 'Project review.', 'The project way.'), manifestNoteId),
      directoryName: packageId,
    })

    const promoted = await roles.moveRolePlacement(
      SYSTEM_PRINCIPAL,
      await capturedRoleTarget(roles, SYSTEM_PRINCIPAL, stale),
      null,
    )

    expect(moveOwnedRolePlacement).toHaveBeenCalledWith(
      expect.objectContaining({
        registryNoteId: packageId,
        manifestNoteId,
      }),
    )
    await expect(roles.captureCurrentOwnedTarget(stale, SYSTEM_PRINCIPAL)).resolves.toMatchObject({
      locator: promoted.locator,
    })
  })

  /** A move has THREE durable effects — the package bytes, the reach row and the
   *  placement trail — and the barrier that catches a foreign identity at the new
   *  home runs after all three have landed. So the assertion is not "it threw": it is
   *  that nothing of the move survives the refusal, and that the refusal is a typed
   *  bounded failure the routes already answer for rather than a bare 500. */
  it('undoes every durable effect when post-move projection resolves a foreign identity', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const availability = new InMemoryAbilityAvailability()
    const preferences = new InMemoryAbilityPreferences()
    const roles = createRolesService({
      catalog: async () => [],
      ...library.deps,
      abilityAvailability: availability,
      abilityPreferences: preferences,
      abilityPlacement: createInMemoryAbilityPlacement({ abilityPreferences: preferences }),
    })
    const project = { scope: 'project', space: 'shared', projectId: 'project-web' } as const
    const spaceRoot = { scope: 'space', space: 'shared' } as const
    const version = await roles.createCustomRole(
      'projection-race',
      'Post-move projection race.',
      'Keep the committed identity whole.',
      project,
    )
    const locator = {
      source: 'owned',
      kind: 'role',
      packageId: version.packageId,
      location: { scope: 'project', spaceId: 'shared', projectId: 'project-web' },
    } as const
    const target = await capturedRoleTarget(roles, SYSTEM_PRINCIPAL, locator)
    const awaitReadable = library.deps.library.awaitReadableNoteIds.bind(library.deps.library)

    library.deps.library.awaitReadableNoteIds = async (location, packageIds) => {
      const projected = new Map(await awaitReadable(location, packageIds))

      if (location.scope === 'space' && packageIds.includes(version.packageId)) {
        projected.set(version.packageId, 'ForeignRegistry')
      }

      return projected
    }

    const failure = await roles
      .moveRolePlacement(SYSTEM_PRINCIPAL, target, null)
      .then(() => null)
      .catch((error: unknown) => error)

    // Typed and bounded: a bare Error carries no client failure at all, and the two
    // callers turn that into a 500 and into a `message: 'internal error'` step whose
    // locator points at the placement this role was supposed to have left.
    expect(failure).toBeInstanceOf(RoleInstallUnavailableError)
    expect(clientFailureOf(failure)).toEqual({
      kind: 'actionable',
      message: expect.stringContaining('projection-race'),
    })
    // 1. The bytes are back where they started, and the new home is empty again.
    await expect(library.getSkillByDirectory(project, version.packageId)).resolves.not.toBeNull()
    await expect(library.getSkillByDirectory(spaceRoot, version.packageId)).resolves.toBeNull()
    // 2. The reach row a Space placement needs was written before the move and must
    //    not outlive it: a project-placed role's reach IS its placement.
    await expect(availability.get('shared', version.packageId)).resolves.toBeNull()
    // 3. The placement trail must not redirect the address the role still stands at.
    expect(preferences.movedLocator(serializeAbilityLocator(locator))).toBeNull()
    // …which is the same thing said from the caller's side: a recapture of the
    // original locator answers at the project, not at the Space.
    await expect(roles.captureCurrentOwnedTarget(locator, SYSTEM_PRINCIPAL)).resolves.toMatchObject(
      { locator: { location: { scope: 'project' } } },
    )
  })

  /** The undo is a real move back, so it can fail the same way the forward one can.
   *  When it does, the package IS at its new home and the target-owned state must
   *  stay with it — the existing "committed, undo impossible" outcome, not a second
   *  contract invented for this barrier. */
  it('keeps the new home whole when the post-move undo cannot land', async () => {
    const availability = new InMemoryAbilityAvailability()
    const preferences = new InMemoryAbilityPreferences()
    const composition = createInMemoryRoleLibrary()
    let undoAttempted = false
    const library = writableLibrary(
      interceptPublication(composition, {
        moveFrom: async (into, _from, _directoryName, _expected, _lifecycle, next) => {
          // Only the REVERSE move — the one whose destination is the project — is
          // refused, so the forward move commits all three effects first.
          if (into.scope === 'project') {
            undoAttempted = true
            return { status: 'missing' as const }
          }

          return next()
        },
      }),
    )
    const roles = createRolesService({
      catalog: async () => [],
      ...library.deps,
      abilityAvailability: availability,
      abilityPreferences: preferences,
      abilityPlacement: createInMemoryAbilityPlacement({ abilityPreferences: preferences }),
    })
    const project = { scope: 'project', space: 'shared', projectId: 'project-web' } as const
    const spaceRoot = { scope: 'space', space: 'shared' } as const
    const version = await roles.createCustomRole(
      'undo-refused',
      'The undo is refused.',
      'Keep the committed identity whole.',
      project,
    )
    const locator = {
      source: 'owned',
      kind: 'role',
      packageId: version.packageId,
      location: { scope: 'project', spaceId: 'shared', projectId: 'project-web' },
    } as const
    const target = await capturedRoleTarget(roles, SYSTEM_PRINCIPAL, locator)
    const awaitReadable = library.deps.library.awaitReadableNoteIds.bind(library.deps.library)

    library.deps.library.awaitReadableNoteIds = async (location, packageIds) => {
      const projected = new Map(await awaitReadable(location, packageIds))

      if (location.scope === 'space' && packageIds.includes(version.packageId)) {
        projected.set(version.packageId, 'ForeignRegistry')
      }

      return projected
    }

    await expect(roles.moveRolePlacement(SYSTEM_PRINCIPAL, target, null)).rejects.toBeInstanceOf(
      RoleInstallUnavailableError,
    )
    expect(undoAttempted).toBe(true)
    await expect(library.getSkillByDirectory(spaceRoot, version.packageId)).resolves.not.toBeNull()
    // The package is at the Space, so the state that describes a Space placement stays
    // with it: clearing reach here would publish the role into every project.
    await expect(availability.get('shared', version.packageId)).resolves.toMatchObject({
      mode: 'selected-projects',
      projectIds: ['project-web'],
    })
    // The address is undone BEFORE the bytes are, so a package that could not come
    // home has to have that address put back on it — named, not merely present, and
    // said again from the caller's side: the locator its owner still holds resolves
    // at the placement the package actually kept.
    expect(preferences.movedLocator(serializeAbilityLocator(locator))).toBe(
      serializeAbilityLocator(spaceRoleLocator(version.packageId, 'shared')),
    )
    await expect(roles.captureCurrentOwnedTarget(locator, SYSTEM_PRINCIPAL)).resolves.toMatchObject(
      { locator: { location: { scope: 'space' } } },
    )
  })

  /** One committed move whose post-move barrier does not confirm the new home — the
   *  only door into the undo path, and the state on the far side of it is what the
   *  cases below are about. So what varies is only which durable effect refuses and
   *  how the barrier fails; the twenty lines that get a move committed are not what
   *  any of them says. */
  const committedMove = async (options: {
    availability?: InMemoryAbilityAvailability
    intercept?: Parameters<typeof interceptPublication>[1]
    placement?: (
      base: ReturnType<typeof createInMemoryAbilityPlacement>,
    ) => ReturnType<typeof createInMemoryAbilityPlacement>
    barrier: 'foreign-identity' | 'unanswered'
  }) => {
    const availability = options.availability ?? new InMemoryAbilityAvailability()
    const preferences = new InMemoryAbilityPreferences()
    const composition = createInMemoryRoleLibrary()
    const library = writableLibrary(
      options.intercept ? interceptPublication(composition, options.intercept) : composition,
    )
    const base = createInMemoryAbilityPlacement({ abilityPreferences: preferences })
    const roles = createRolesService({
      catalog: async () => [],
      ...library.deps,
      abilityAvailability: availability,
      abilityPreferences: preferences,
      abilityPlacement: options.placement ? options.placement(base) : base,
    })
    const project = { scope: 'project', space: 'shared', projectId: 'project-web' } as const
    const spaceRoot = { scope: 'space', space: 'shared' } as const
    const version = await roles.createCustomRole(
      'committed-move',
      'A move that is already committed.',
      'Keep the committed identity whole.',
      project,
    )
    const locator = {
      source: 'owned',
      kind: 'role',
      packageId: version.packageId,
      location: { scope: 'project', spaceId: 'shared', projectId: 'project-web' },
    } as const
    const target = await capturedRoleTarget(roles, SYSTEM_PRINCIPAL, locator)
    const awaitReadable = library.deps.library.awaitReadableNoteIds.bind(library.deps.library)

    // The barrier is the last step of the move, so it is where a POST-COMMIT failure
    // is injected: an identity that is not the one this move committed, or no answer
    // at all. Both leave all three durable effects at the new home.
    library.deps.library.awaitReadableNoteIds = async (location, packageIds) => {
      if (location.scope !== 'space' || !packageIds.includes(version.packageId)) {
        return awaitReadable(location, packageIds)
      }
      if (options.barrier === 'unanswered') {
        throw new Error('the projection barrier timed out')
      }
      const projected = new Map(await awaitReadable(location, packageIds))

      projected.set(version.packageId, 'ForeignRegistry')

      return projected
    }

    return {
      availability,
      failure: await roles
        .moveRolePlacement(SYSTEM_PRINCIPAL, target, null)
        .then(() => null)
        .catch((error: unknown) => error),
      library,
      locator,
      packageId: version.packageId,
      preferences,
      project,
      recapture: () => roles.captureCurrentOwnedTarget(locator, SYSTEM_PRINCIPAL),
      roles,
      spaceRoot,
    }
  }

  /** The marker a failed physical rollback raises is DIRECTIONAL: it says the
   *  transition its own call requested stayed at that call's target. Raised by the
   *  REVERSE move, that target is the placement the package came from — so the bytes
   *  are home and only the proof of it failed, which is how the layer that raises it
   *  reads its own reverse. Read as "still at the new home", it left the reach row and
   *  the trail describing a placement the package no longer occupied. */
  it('finishes the undo when the reverse move lands its bytes without proof', async () => {
    let reverseAttempted = false
    const {
      availability,
      failure,
      library,
      locator,
      packageId,
      preferences,
      project,
      recapture,
      spaceRoot,
    } = await committedMove({
      barrier: 'foreign-identity',
      intercept: {
        moveFrom: async (into, _from, _directoryName, _expected, _lifecycle, next) => {
          const result = await next()

          // Exactly the shape a `committed-error` reverse takes one layer down: the
          // directory transition IS at its target, and the claim that proves it is
          // the same package could not be carried through.
          if (into.scope === 'project' && result.status === 'moved') {
            reverseAttempted = true
            throw rolePackageMoveRollbackError(
              new AbilityUnavailableError(
                'directory moved but its claimed source resource did not reach the target',
              ),
            )
          }

          return result
        },
      },
    })

    expect(reverseAttempted).toBe(true)
    expect(failure).toBeInstanceOf(RoleInstallUnavailableError)
    // The bytes are home, so every piece of state that says where the package IS came
    // home with them — bytes, reach row and trail, or none of it.
    await expect(library.getSkillByDirectory(project, packageId)).resolves.not.toBeNull()
    await expect(library.getSkillByDirectory(spaceRoot, packageId)).resolves.toBeNull()
    await expect(availability.get('shared', packageId)).resolves.toBeNull()
    expect(preferences.movedLocator(serializeAbilityLocator(locator))).toBeNull()
    await expect(recapture()).resolves.toMatchObject({
      locator: { location: { scope: 'project' } },
    })
  })

  /** There is no transaction across a filesystem and a meta-DB, so the undo runs in
   *  the order that keeps every failure on a coherent state. The trail is the ADDRESS
   *  and goes first: nothing has moved when it runs, so its refusal costs nothing and
   *  the answer is the outcome this operation already names — the package is still at
   *  its new home, whole. Undone after the bytes instead, the same refusal left a role
   *  standing at one placement while its address redirected to the other. */
  it('refuses the whole undo when the placement trail cannot come back', async () => {
    let reverseAttempted = false
    const {
      availability,
      failure,
      library,
      locator,
      packageId,
      preferences,
      project,
      recapture,
      spaceRoot,
    } = await committedMove({
      barrier: 'foreign-identity',
      intercept: {
        moveFrom: async (into, _from, _directoryName, _expected, _lifecycle, next) => {
          reverseAttempted ||= into.scope === 'project'

          return next()
        },
      },
      placement: (base) => ({
        ...base,
        // Only the reverse hop is refused — the one whose destination is the project
        // — so the forward move commits all three effects first.
        moveOwnedRolePlacement: async (move) => {
          const destination = parseAbilityLocator(move.toLocator)

          if (destination?.source === 'owned' && destination.location.scope === 'project') {
            throw new Error('meta-DB is unavailable')
          }

          return base.moveOwnedRolePlacement(move)
        },
      }),
    })

    expect(failure).toBeInstanceOf(RoleInstallUnavailableError)
    expect(reverseAttempted).toBe(false)
    await expect(library.getSkillByDirectory(spaceRoot, packageId)).resolves.not.toBeNull()
    await expect(library.getSkillByDirectory(project, packageId)).resolves.toBeNull()
    await expect(availability.get('shared', packageId)).resolves.toMatchObject({
      mode: 'selected-projects',
      projectIds: ['project-web'],
    })
    expect(preferences.movedLocator(serializeAbilityLocator(locator))).toBe(
      serializeAbilityLocator(spaceRoleLocator(packageId, 'shared')),
    )
    // The role is whole at the home it kept: the locator its owner holds still
    // redirects there, which is what "still at its new home" has to mean.
    await expect(recapture()).resolves.toMatchObject({ locator: { location: { scope: 'space' } } })
  })

  /** Reach is the last effect the undo puts back, so it is the only one that can be
   *  left behind — and its residue is the safe one: a narrowing row makes the role
   *  reach fewer projects than it should, never more. What may not happen is the
   *  operation reporting that outcome as either of the other two. */
  it('reports an undo that could not put the reach row back as neither of the others', async () => {
    const availability = new InMemoryAbilityAvailability()
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      availability.clear = async () => {
        throw new Error('meta-DB is unavailable')
      }
      const { failure, library, locator, packageId, preferences, project, recapture, spaceRoot } =
        await committedMove({ availability, barrier: 'foreign-identity' })

      expect(failure).toBeInstanceOf(RoleInstallUnavailableError)
      // The package and the address that finds it are both home…
      await expect(library.getSkillByDirectory(project, packageId)).resolves.not.toBeNull()
      await expect(library.getSkillByDirectory(spaceRoot, packageId)).resolves.toBeNull()
      expect(preferences.movedLocator(serializeAbilityLocator(locator))).toBeNull()
      await expect(recapture()).resolves.toMatchObject({
        locator: { location: { scope: 'project' } },
      })
      // …and the row that outlived them narrows the role to the project it is standing
      // in, which its owner can rewrite through the ordinary availability door.
      await expect(availability.get('shared', packageId)).resolves.toMatchObject({
        mode: 'selected-projects',
        projectIds: ['project-web'],
      })
      expect(errorLog).toHaveBeenCalledWith(
        '[roles] failed to undo role move: durable state is split across placements',
      )
      // Not "the new home could not be released": the new home was released.
      expect(errorLog).not.toHaveBeenCalledWith(
        '[roles] failed to undo role move: the new home could not be released',
      )
    } finally {
      errorLog.mockRestore()
    }
  })

  /** The interrupted undo, and the state it may not leave behind. The address comes
   *  back first, so when the BYTES then refuse to come home the undo has to put the
   *  address back onto them — and that compensating step can fail too. Whatever it
   *  leaves is `split` by definition; what it may not leave is a role no door reaches.
   *
   *  Which is what a counter-hop left. Every reader of the trail refuses on the ROW,
   *  not on what stands at its destination (`captureOwnedTarget`, `withOwnedTargetMutation`
   *  and `captureCurrentOwnedTarget` all do), so a row pointing at the placement the
   *  package failed to reach tombstoned the placement it actually kept: the role stayed
   *  in the listing and every get/edit/save/delete/move answered `null`, with nothing
   *  but a hand-edited meta-DB to get it back. Cancelling the hop instead of answering
   *  it leaves both spellings unforwarded, and an unforwarded address answers for
   *  itself. */
  it('leaves the role reachable when the undo cannot put the address back either', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      let recorded = 0
      const {
        availability,
        failure,
        library,
        locator,
        packageId,
        preferences,
        project,
        roles,
        spaceRoot,
      } = await committedMove({
        barrier: 'foreign-identity',
        intercept: {
          // The bytes refuse to come home, which is what makes the undo reach for the
          // address it has already given back.
          moveFrom: async (into, _from, _directoryName, _expected, _lifecycle, next) =>
            into.scope === 'project' ? { status: 'missing' as const } : next(),
        },
        placement: (base) => ({
          ...base,
          moveOwnedRolePlacement: async (move) => {
            // The forward hop lands; the one that would put it BACK does not. Every
            // other step of the undo has already succeeded, so this is the last
            // durable write of the operation and nothing runs after it.
            if (move.trail === 'record' && ++recorded > 1) {
              throw new Error('meta-DB is unavailable')
            }

            return base.moveOwnedRolePlacement(move)
          },
        }),
      })

      expect(failure).toBeInstanceOf(RoleInstallUnavailableError)
      expect(errorLog).toHaveBeenCalledWith(
        '[roles] failed to undo role move: durable state is split across placements',
      )
      // The package is at the Space — the undo could not bring it back…
      await expect(library.getSkillByDirectory(spaceRoot, packageId)).resolves.not.toBeNull()
      await expect(library.getSkillByDirectory(project, packageId)).resolves.toBeNull()
      // …and NEITHER spelling forwards, so nothing tombstones the address it is at.
      expect(preferences.movedLocator(serializeAbilityLocator(locator))).toBeNull()
      expect(
        preferences.movedLocator(serializeAbilityLocator(spaceRoleLocator(packageId, 'shared'))),
      ).toBeNull()
      // Which is the whole point, said through the doors an owner actually has: the
      // role can be captured and mutated at the placement it kept.
      const kept = await roles.captureOwnedTarget(
        {
          locator: spaceRoleLocator(packageId, 'shared'),
          registryNoteId: packageId,
          manifestNoteId: packageId,
        },
        SYSTEM_PRINCIPAL,
      )

      expect(kept).not.toBeNull()
      await expect(
        roles.withOwnedTargetMutation(kept!, SYSTEM_PRINCIPAL, async () => 'reachable'),
      ).resolves.toBe('reachable')
      // The reach row is the residue this outcome is allowed to keep, and it narrows.
      await expect(availability.get('shared', packageId)).resolves.toMatchObject({
        mode: 'selected-projects',
        projectIds: ['project-web'],
      })
    } finally {
      errorLog.mockRestore()
    }
  })

  /** The barrier can fail by THROWING, and it runs after the commit. Nothing is undone
   *  for it: an "unavailable" answer invites a retry that would then race the very
   *  package this call published — the outcome the Add path refuses to produce after
   *  ITS commit. Which leaves the whole duty of the answer to be typed and to address
   *  the home the role now has. */
  it('names the new home when the post-move barrier cannot answer at all', async () => {
    const {
      availability,
      failure,
      library,
      locator,
      packageId,
      preferences,
      project,
      recapture,
      spaceRoot,
    } = await committedMove({ barrier: 'unanswered' })

    expect(failure).toBeInstanceOf(RolePlacementUnconfirmedError)
    expect(failure).not.toBeInstanceOf(RoleInstallUnavailableError)
    expect(clientFailureOf(failure)).toEqual({
      kind: 'actionable',
      message: expect.stringContaining('committed-move'),
    })
    // The barrier's own words stay in the cause, for the operator log and not the wire.
    expect((failure as RolePlacementUnconfirmedError).cause).toMatchObject({
      message: 'the projection barrier timed out',
    })
    // The address the answer carries is the one the package is at…
    expect((failure as RolePlacementUnconfirmedError).locator).toEqual(
      spaceRoleLocator(packageId, 'shared'),
    )
    // …because all three effects are still committed there: undoing a whole move over
    // a barrier that timed out would trade a readable package for a physical move
    // nobody asked for.
    await expect(library.getSkillByDirectory(spaceRoot, packageId)).resolves.not.toBeNull()
    await expect(library.getSkillByDirectory(project, packageId)).resolves.toBeNull()
    await expect(availability.get('shared', packageId)).resolves.toMatchObject({
      mode: 'selected-projects',
      projectIds: ['project-web'],
    })
    expect(preferences.movedLocator(serializeAbilityLocator(locator))).toBe(
      serializeAbilityLocator(spaceRoleLocator(packageId, 'shared')),
    )
    await expect(recapture()).resolves.toMatchObject({ locator: { location: { scope: 'space' } } })
  })

  /** Reach is written BEFORE the package is readable at its new home. For a role the
   *  ABSENCE of a row reads as all-projects, so publishing first opens a window in
   *  which a role narrowed to one project answers in every project of its Space —
   *  the invariant `createCustomRole` already states and orders itself by. */
  it('never leaves a promoted role reachable from a project it was narrowed away from', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const availability = new InMemoryAbilityAvailability()
    const insideTheWindow: unknown[] = []
    const set = availability.set.bind(availability)
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      ...library.deps,
      abilityAvailability: availability,
      abilityPlacement: {
        resolveMovedOwnedRoleLocator: async () => null,
        moveOwnedRolePlacement: async () => 'applied',
      },
    })

    availability.set = async (...args) => {
      // The one moment the window exists: the package has been published at its new
      // home and the row that narrows it has not landed yet.
      insideTheWindow.push(
        await roles.resolveEffective(
          projectContext('project-api', 'shared'),
          SYSTEM_PRINCIPAL,
          'review',
        ),
      )
      await set(...args)
    }
    const version = await roles.createCustomRole('review', 'Project review.', 'The project way.', {
      scope: 'project',
      space: 'shared',
      projectId: 'project-web',
    })

    await roles.moveRolePlacement(
      SYSTEM_PRINCIPAL,
      await capturedRoleTarget(roles, SYSTEM_PRINCIPAL, {
        source: 'owned',
        kind: 'role',
        packageId: version.packageId,
        location: { scope: 'project', spaceId: 'shared', projectId: 'project-web' },
      }),
      null,
    )

    expect(insideTheWindow).toEqual([null])
  })

  it('promotes a version with its address, its state and a reach that does not widen', async () => {
    const moveOwnedRolePlacement = vi.fn(async () => 'applied' as const)
    const library = writableLibrary(createInMemoryRoleLibrary())
    const availability = new InMemoryAbilityAvailability()
    const reachWrites: unknown[][] = []
    const set = availability.set.bind(availability)

    availability.set = async (...args) => {
      reachWrites.push(args)
      await set(...args)
    }
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      ...library.deps,
      abilityAvailability: availability,
      abilityPlacement: {
        resolveMovedOwnedRoleLocator: async () => null,
        moveOwnedRolePlacement,
      },
    })
    const version = await roles.createCustomRole('review', 'Project review.', 'The project way.', {
      scope: 'project',
      space: 'shared',
      projectId: 'project-web',
    })
    const locator = {
      source: 'owned',
      kind: 'role',
      packageId: version.packageId,
      location: { scope: 'project', spaceId: 'shared', projectId: 'project-web' },
    } as const

    const promoted = await roles.moveRolePlacement(
      SYSTEM_PRINCIPAL,
      await capturedRoleTarget(roles, SYSTEM_PRINCIPAL, locator),
      null,
    )

    expect(promoted.locator).toEqual(spaceRoleLocator(version.packageId, 'shared'))
    expect(promoted.availability).toEqual({
      mode: 'selected-projects',
      projectIds: ['project-web'],
    })
    // Placement is part of the address, so the rows keyed by it move in one call.
    expect(moveOwnedRolePlacement).toHaveBeenCalledWith(
      expect.objectContaining({
        fromLocator: expect.stringContaining('project'),
        toLocator: expect.stringContaining('space'),
        registryNoteId: version.packageId,
        manifestNoteId: version.packageId,
      }),
    )
    await expect(
      library.getSkillByDirectory(
        { scope: 'project', space: 'shared', projectId: 'project-web' },
        version.packageId,
      ),
    ).resolves.toBeNull()
    await expect(
      roles.resolveEffective(projectContext('project-web', 'shared'), SYSTEM_PRINCIPAL, 'review'),
    ).resolves.toMatchObject({ location: { scope: 'space', space: 'shared' } })
    // The version served one project; the base it became says the same out loud.
    await expect(
      roles.resolveEffective(projectContext('project-api', 'shared'), SYSTEM_PRINCIPAL, 'review'),
    ).resolves.toBeNull()
    // The reach row a promotion writes is a FRESH row, and the identity it is keyed
    // by is projected from the package's path — so it has to be read while the
    // package is still on the side it is being read from. Written blank, the row
    // falls back to matching by package id, which is only harmless for as long as an
    // Owned package stays ID-backed.
    expect(reachWrites).toContainEqual([
      'shared',
      version.packageId,
      { mode: 'selected-projects', projectIds: ['project-web'] },
      version.packageId,
    ])
  })

  it('does not widen a role whose promotion could not be undone', async () => {
    const failure = new Error('meta-DB is unavailable')
    const library = writableLibrary(createInMemoryRoleLibrary())
    const availability = new InMemoryAbilityAvailability()
    // The package lands, but the pointer finalize and the rollback both fail. The
    // typed writer result says the target remains authoritative, so target reach must
    // survive even though the caller still receives the finalize failure.
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      ...interceptPublication(library.deps, {
        moveFrom: async (_into, _from, _directoryName, _expected, lifecycle, next) => {
          const moved = await next({ ...lifecycle, finalize: async () => undefined })

          if (moved.status === 'moved') {
            throw rolePackageMoveRollbackError(failure)
          }

          return moved
        },
      }),
      abilityAvailability: availability,
      abilityPlacement: {
        resolveMovedOwnedRoleLocator: async () => null,
        moveOwnedRolePlacement: async () => {
          throw failure
        },
      },
    })
    const version = await roles.createCustomRole('review', 'Project review.', 'The project way.', {
      scope: 'project',
      space: 'shared',
      projectId: 'project-web',
    })

    await expect(
      roles.moveRolePlacement(
        SYSTEM_PRINCIPAL,
        await capturedRoleTarget(roles, SYSTEM_PRINCIPAL, {
          source: 'owned',
          kind: 'role',
          packageId: version.packageId,
          location: { scope: 'project', spaceId: 'shared', projectId: 'project-web' },
        }),
        null,
      ),
    ).rejects.toBe(failure)
    // A project version has no reach row, so clearing the one the promotion wrote
    // would leave a role sitting at the Space root that reads as all-projects — the
    // failed promotion would have widened exactly what it must not.
    await expect(availability.get('shared', version.packageId)).resolves.toMatchObject({
      mode: 'selected-projects',
      projectIds: ['project-web'],
    })
  })

  it('keeps a promoted role turned off, on a host that has no meta-DB', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const roles = createRolesService({
      catalog: async () => [],
      ...library.deps,
      // The composition a host without a meta-DB actually gets. It holds a preference
      // table, so the placement adapter it is handed has to carry that row.
      ...inMemoryAbilityPersistence(),
    })
    const version = await roles.createCustomRole('review', 'Project review.', 'The project way.', {
      scope: 'project',
      space: 'shared',
      projectId: 'project-web',
    })
    const locator = {
      source: 'owned',
      kind: 'role',
      packageId: version.packageId,
      location: { scope: 'project', spaceId: 'shared', projectId: 'project-web' },
    } as const
    const context = projectContext('project-web', 'shared')

    await roles.setEnabled(
      context,
      SYSTEM_PRINCIPAL,
      await capturedTarget(roles, SYSTEM_PRINCIPAL, locator),
      false,
    )
    await expect(
      roles.loadEffective(context, SYSTEM_PRINCIPAL, 'review', 4_000),
    ).resolves.toMatchObject({ ok: false, reason: 'disabled' })

    const promoted = await roles.moveRolePlacement(
      SYSTEM_PRINCIPAL,
      await capturedRoleTarget(roles, SYSTEM_PRINCIPAL, locator),
      null,
    )

    // The preference row is keyed by the LOCATOR, and a promotion changes it. Left
    // behind, the row names a placement that no longer exists and the absent row at
    // the new one reads as enabled — so the role the owner turned off comes back on.
    await expect(
      roles.effectiveRoleAt({ personalSpace: null }, SYSTEM_PRINCIPAL, promoted.locator),
    ).resolves.toBeNull()
  })

  it('refuses to promote onto an occupied name before anything moves', async () => {
    const moveOwnedRolePlacement = vi.fn(async () => 'applied' as const)
    const library = writableLibrary(createInMemoryRoleLibrary())
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      ...library.deps,
      abilityPlacement: {
        resolveMovedOwnedRoleLocator: async () => null,
        moveOwnedRolePlacement,
      },
    })
    const base = await roles.createCustomRole('review', 'Team review.', 'The team way.', {
      scope: 'space',
      space: 'shared',
    })
    const version = await forkRoleVersion(
      roles,
      SYSTEM_PRINCIPAL,
      spaceRoleLocator(base.packageId, 'shared'),
      null,
      'project-web',
    )

    await expect(
      roles.moveRolePlacement(
        SYSTEM_PRINCIPAL,
        await capturedRoleTarget(roles, SYSTEM_PRINCIPAL, {
          source: 'owned',
          kind: 'role',
          packageId: version.packageId,
          location: { scope: 'project', spaceId: 'shared', projectId: 'project-web' },
        }),
        null,
      ),
    ).rejects.toBeInstanceOf(RoleAlreadyExistsError)
    expect(moveOwnedRolePlacement).not.toHaveBeenCalled()
    await expect(
      library.getSkillByDirectory(
        { scope: 'project', space: 'shared', projectId: 'project-web' },
        version.packageId,
      ),
    ).resolves.not.toBeNull()
    await expect(
      library.getSkillByDirectory({ scope: 'space', space: 'shared' }, base.packageId),
    ).resolves.not.toBeNull()
  })

  it('puts a promoted package back when its durable pointers could not follow', async () => {
    const failure = new Error('meta-DB is unavailable')
    const library = writableLibrary(createInMemoryRoleLibrary())
    const availability = new InMemoryAbilityAvailability()
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      ...library.deps,
      abilityAvailability: availability,
      abilityPlacement: {
        resolveMovedOwnedRoleLocator: async () => null,
        moveOwnedRolePlacement: async () => {
          throw failure
        },
      },
    })
    const version = await roles.createCustomRole('review', 'Project review.', 'The project way.', {
      scope: 'project',
      space: 'shared',
      projectId: 'project-web',
    })

    await expect(
      roles.moveRolePlacement(
        SYSTEM_PRINCIPAL,
        await capturedRoleTarget(roles, SYSTEM_PRINCIPAL, {
          source: 'owned',
          kind: 'role',
          packageId: version.packageId,
          location: { scope: 'project', spaceId: 'shared', projectId: 'project-web' },
        }),
        null,
      ),
    ).rejects.toBe(failure)
    // A base whose context, preference and episodes still name the project placement
    // would be worse than no promotion at all.
    await expect(
      library.getSkillByDirectory(
        { scope: 'project', space: 'shared', projectId: 'project-web' },
        version.packageId,
      ),
    ).resolves.not.toBeNull()
    await expect(
      library.getSkillByDirectory({ scope: 'space', space: 'shared' }, version.packageId),
    ).resolves.toBeNull()
    // The reach written for the base it did not become must not survive either: for a
    // role a leftover row is not neutral, it is a reach.
    await expect(availability.get('shared', version.packageId)).resolves.toBeNull()
  })
})

/** The production composition seam of design 02, tested as the unit the composition
 *  root actually installs. It is the ONLY place in the exact-package path where a
 *  registry note is bound to a package ADDRESS: every strict caller downstream
 *  resolves its note by id and compares that id against a copy of itself. */
describe('projected role package scope', () => {
  const PACKAGE = {
    directoryName: 'AbCdefGhij_1',
    filePath: '.notarium/skills/_projects/cHJvamVjdC13ZWI/AbCdefGhij_1/SKILL.md',
  }

  const scopeOver = (
    notes: ReadonlyArray<{ id: string; filePath: string; versionToken?: string }>,
  ) => {
    const claimedNotes: string[] = []
    const scope = createProjectedRolePackageScope(async () => ({
      list: async () => notes,
      withExactNoteClaim: async (noteId, task) => {
        claimedNotes.push(noteId)
        const current = notes.find((note) => note.id === noteId)

        if (!current) {
          throw Object.assign(new Error('not found'), { isNotFound: true })
        }

        return task({ versionToken: 'v1', ...current })
      },
    }))

    return { claimedNotes, scope }
  }

  it('resolves an unexpected capture by path and hands its registry facts on', async () => {
    const { claimedNotes, scope } = scopeOver([{ id: 'RegistryNote1', filePath: PACKAGE.filePath }])

    await expect(
      scope('shared', PACKAGE, undefined, async (projection) => projection),
    ).resolves.toEqual({
      registryNoteId: 'RegistryNote1',
      filePath: PACKAGE.filePath,
      versionToken: 'v1',
    })
    expect(claimedNotes).toEqual(['RegistryNote1'])
  })

  it('refuses an expected registry note that no longer stands at the addressed package', async () => {
    // The package moved between the caller's read and this claim: the note is still
    // the note, and the address the caller named is no longer where it lives. Nothing
    // downstream can catch this — a mutation compares its expected registry id with
    // the very id this seam was handed.
    const { claimedNotes, scope } = scopeOver([
      { id: 'RegistryNote1', filePath: '.notarium/skills/AbCdefGhij_1/SKILL.md' },
    ])
    const task = vi.fn(async (projection: unknown) => projection)

    await expect(scope('shared', PACKAGE, 'RegistryNote1', task)).resolves.toBeNull()
    // Claimed — so the refusal is the identity check, not a candidate that was never
    // resolved — and the RoleLibrary callback never ran under it.
    expect(claimedNotes).toEqual(['RegistryNote1'])
    expect(task).not.toHaveBeenCalled()
  })

  it('refuses a claimed note with no version token', async () => {
    const { scope } = scopeOver([
      { id: 'RegistryNote1', filePath: PACKAGE.filePath, versionToken: '' },
    ])
    const task = vi.fn(async (projection: unknown) => projection)

    await expect(scope('shared', PACKAGE, 'RegistryNote1', task)).resolves.toBeNull()
    expect(task).not.toHaveBeenCalled()
  })

  it('answers absent for an address nothing is published at, and only for that', async () => {
    const { claimedNotes, scope } = scopeOver([])

    // No candidate at all: nothing is claimed, because there is nothing to claim.
    await expect(scope('shared', PACKAGE, undefined, async () => 'ran')).resolves.toBeNull()
    expect(claimedNotes).toEqual([])
    // A named candidate the store does not have is the same answer — but a store
    // failure that is NOT "no such note" stays loud.
    await expect(scope('shared', PACKAGE, 'Vanished0001', async () => 'ran')).resolves.toBeNull()

    const failing = createProjectedRolePackageScope(async () => ({
      list: async () => [],
      withExactNoteClaim: async () => {
        throw new Error('store is stopping')
      },
    }))

    await expect(failing('shared', PACKAGE, 'RegistryNote1', async () => 'ran')).rejects.toThrow(
      'store is stopping',
    )
  })
})
