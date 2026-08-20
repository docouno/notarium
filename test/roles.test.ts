import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'

import { AbilityHealthSchema } from '@notarium/contract'

import { SYSTEM_PRINCIPAL } from '../packages/server/src/services/authz'
import type { Ctx } from '../packages/server/src/services/mcp/gateway'
import { activateRole } from '../packages/server/src/services/mcp/tools/roles'
import { loadSavedSessionRole } from '../packages/server/src/services/mcp/tools/session/session'
import {
  AbilityUnavailableError,
  createInMemoryRoleLibrary,
  createRolesService,
  InMemoryAbilityAvailability,
  inMemoryAbilityPersistence,
  loadBundledAbilityInventory,
  packageRevision,
  parseRoleContextTarget,
  parseSkillFile,
  RoleAlreadyExistsError,
  roleContextTargetOf,
  RoleDependencyConflictError,
  type RolesService,
  type SkillPackage,
  withCatalogProvenance,
} from '../packages/server/src/services/roles'

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
    const library = createInMemoryRoleLibrary()
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      library,
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
      role: { name: 'grooming' },
      location: { scope: 'personal', space: 'space-personal' },
      skills: [{ name: 'grooming-evidence' }],
      truncated: false,
    })
  })

  /** Stated against the pair MCP actually calls, because a source the resolver cannot
   *  reach there is not a source at all. This rule used to be proven twice: once here
   *  and once against a second, human-facing pair with its own System fallback and no
   *  production caller — so the proof that mattered rested on the copy nothing ran. */
  it('activates System roles by default and lets the owner disable them', async () => {
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      library: createInMemoryRoleLibrary(),
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
    // Answering at all IS the health verdict here: the loader drops an unsound role
    // rather than handing back a summary that says so.
    await expect(
      roles.loadEffective(context, SYSTEM_PRINCIPAL, 'research', 4_000),
    ).resolves.toMatchObject({
      role: { name: 'research', source: 'system' },
      locator,
      skills: [{ name: 'research-evidence' }],
    })

    await roles.setEnabled(context, SYSTEM_PRINCIPAL, locator, false)
    await expect(roles.listEffective(context, SYSTEM_PRINCIPAL)).resolves.toEqual({
      roles: [],
      truncated: false,
    })
    await expect(roles.resolveEffective(context, SYSTEM_PRINCIPAL, 'research')).resolves.toBeNull()
    await expect(
      roles.loadEffective(context, SYSTEM_PRINCIPAL, 'research', 4_000),
    ).resolves.toBeNull()
  })

  /** Activation without resume is half a link: the episode would raise the role once
   *  and lose it on the next call. The binding is stored by locator, so the System arm
   *  has to survive the same round trip the Owned arm does. */
  it('resumes a System role from its saved binding, and drops it when disabled', async () => {
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      library: createInMemoryRoleLibrary(),
      ...inMemoryAbilityPersistence(),
    })
    const context = { personalSpace: null }
    const locator = { source: 'system', kind: 'role', packageId: 'ZME09f9AROG8' } as const

    await expect(
      roles.loadSavedRole(context, SYSTEM_PRINCIPAL, locator, 4_000),
    ).resolves.toMatchObject({
      source: 'system',
      role: { source: 'system', name: 'research' },
      skills: [{ name: 'research-evidence' }],
      locator,
    })

    await roles.setEnabled(context, SYSTEM_PRINCIPAL, locator, false)
    await expect(roles.loadSavedRole(context, SYSTEM_PRINCIPAL, locator, 4_000)).resolves.toBeNull()
  })

  it('uses Owned over System, but an explicit disable reveals the System fallback', async () => {
    const library = createInMemoryRoleLibrary()
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      library,
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
      role: { source: 'owned', instructions: 'Personal instructions.' },
    })
    await roles.setEnabled(context, SYSTEM_PRINCIPAL, locator, false)
    await expect(
      roles.loadEffective(context, SYSTEM_PRINCIPAL, 'research', 4_000),
    ).resolves.toMatchObject({ role: { source: 'system' } })
  })

  it('skips wrong-kind and disabled Owned candidates before choosing a broader fallback', async () => {
    const library = createInMemoryRoleLibrary()
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      library,
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
      {
        source: 'owned',
        kind: 'role',
        packageId: shared.noteId,
        location: { scope: 'space', spaceId: 'shared' },
      },
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
      location: { scope: 'personal', space: 'personal' },
      locator: expectedLocator,
    })
  })

  it('rejects a Space locator alias for a package in the Personal root', async () => {
    const library = createInMemoryRoleLibrary()
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      library,
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
      library: createInMemoryRoleLibrary(),
      ...inMemoryAbilityPersistence(),
    })

    await expect(roles.listBundledAbilities(SYSTEM_PRINCIPAL)).rejects.toThrow(
      /duplicate bundled ability identity/,
    )
  })

  it('copies the skills a Catalog role links, and no others', async () => {
    const library = createInMemoryRoleLibrary()
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
      library,
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
      library: createInMemoryRoleLibrary(),
      ...inMemoryAbilityPersistence(),
    })

    await expect(roles.listBundledAbilities(SYSTEM_PRINCIPAL)).rejects.toThrow(/missing/)
    // A memoized failure would outlive whatever caused it and pin the whole process
    // to its first bad read — the Catalog would stay empty until a restart.
    await expect(roles.listBundledAbilities(SYSTEM_PRINCIPAL)).resolves.not.toHaveLength(0)
  })

  it('preserves malformed exact attachments in health and never falls back past them', async () => {
    const library = createInMemoryRoleLibrary()
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      library,
      ...inMemoryAbilityPersistence(),
    })
    const role = pkg('research', 'Broken replacement.', 'Broken instructions.')
    role.files.set(
      'SKILL.md',
      Buffer.from(
        '---\nname: research\ndescription: Broken replacement.\nmetadata:\n  notarium.kind: role\n  notarium.skills: "[[notarium-id:space:broken|evidence]]"\n---\n\nBroken instructions.',
      ),
    )
    await library.putIfAbsent({ scope: 'personal', space: 'personal' }, role)
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
    ).resolves.toBeNull()

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
    const library = createInMemoryRoleLibrary()
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      library,
    })
    const home = { scope: 'personal' as const, space: 'personal' }
    const unwritable = '[[notarium-id:space:broken|ev\u2028idence]]'
    const writable = '[[notarium-id:space:broken|evidence]]'
    const roleId = 'Unwritable_1'
    await library.putIfAbsent(home, {
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
    })
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
    const library = createInMemoryRoleLibrary()
    const abilityAvailability = new InMemoryAbilityAvailability()
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      library,
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

    await library.putIfAbsent(space, {
      ...skillPkg('disabled-skill', 'Disabled skill.'),
      directoryName: disabledId,
    })
    await library.putIfAbsent(space, {
      ...skillPkg('unavailable-skill', 'Unavailable skill.'),
      directoryName: unavailableId,
    })
    await library.putIfAbsent(space, {
      ...pkg('wrong-kind', 'A role, not a skill.', 'Wrong kind.'),
      directoryName: wrongKindId,
    })
    await abilityAvailability.set('shared', unavailableId, {
      mode: 'selected-projects',
      projectIds: ['project-b'],
    })
    await library.putIfAbsent(project, {
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
    })
    await roles.setEnabled(
      context,
      SYSTEM_PRINCIPAL,
      {
        source: 'owned',
        kind: 'skill',
        packageId: disabledId,
        location: { scope: 'space', spaceId: 'shared' },
      },
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
    ).resolves.toBeNull()
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
    const library = createInMemoryRoleLibrary()
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      library,
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
    await library.putIfAbsent(space, {
      ...skillPkg('evidence', 'A real dependency.'),
      directoryName: dependencyId,
    })
    await library.putIfAbsent(space, {
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
    })

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
    const library = createInMemoryRoleLibrary()
    const abilityAvailability = new InMemoryAbilityAvailability()
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      library,
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
    const library = createInMemoryRoleLibrary()
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      library,
      ...inMemoryAbilityPersistence(),
    })
    await roles.createCustomRole('private-role', 'Private.', 'Private.', {
      scope: 'personal',
      space: 'personal',
    })
    const narrowed = {
      id: 'pat:alice:narrowed',
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
    const library = createInMemoryRoleLibrary()
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      library,
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
      role: {
        scope: 'project',
        description: 'Project wording.',
        instructions: 'Project rules win.',
      },
      location: project,
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
      role: { scope: 'personal', instructions: expect.not.stringContaining('Project rules win.') },
    })
  })

  it('loads an owned dependency only by its locator across rename and replacement', async () => {
    const library = createInMemoryRoleLibrary()
    const roles = createRolesService({
      catalog: async () => [],
      library,
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
      role: { name: 'exact-role' },
      packageId: roleId,
      skills: [{ name: 'renamed-evidence', instructions: 'Exact body.' }],
    })

    const missingExact = createRolesService({
      catalog: async () => [],
      library: {
        ...library,
        getSkillByDirectory: async (location, id) =>
          id === dependencyId ? null : library.getSkillByDirectory(location, id),
      },
      ...inMemoryAbilityPersistence(),
    })
    await expect(
      missingExact.loadSavedRole(context, SYSTEM_PRINCIPAL, savedLocator, 4_000),
    ).resolves.toBeNull()
  })

  it('keeps context preset identity stable when the role label changes', () => {
    const location = { scope: 'personal' as const, space: 'personal' }
    const packageId = 'AbCdefGhij_1'

    expect(roleContextTargetOf({ role: { name: 'before' }, location, packageId }).id).toBe(
      roleContextTargetOf({ role: { name: 'after' }, location, packageId }).id,
    )
  })

  it('resolves a cross-placement locator only with the full effective context', async () => {
    const library = createInMemoryRoleLibrary()
    const abilityAvailability = new InMemoryAbilityAvailability()
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: async () => [],
      library,
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
    ).resolves.toBeNull()
    await abilityAvailability.set('shared', dependencyId, {
      mode: 'selected-projects',
      projectIds: ['project-a', 'project-b'],
    })
    await expect(
      roles.loadEffective(context('project-a'), SYSTEM_PRINCIPAL, 'cross-role', 4_000),
    ).resolves.toMatchObject({
      skills: [{ name: 'shared-evidence', instructions: 'Shared exact body.' }],
    })
    await expect(
      roles.loadEffective(context('project-b'), SYSTEM_PRINCIPAL, 'cross-role', 4_000),
    ).resolves.toMatchObject({
      skills: [{ name: 'shared-evidence', instructions: 'Shared exact body.' }],
    })
    await expect(
      roles.loadEffective(context('project-c'), SYSTEM_PRINCIPAL, 'cross-role', 4_000),
    ).resolves.toBeNull()
  })

  it('rehydrates a renamed session role by exact package and never by a replacement name', async () => {
    const library = createInMemoryRoleLibrary()
    const roles = createRolesService({
      catalog: async () => [],
      library,
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
    }

    await expect(
      loadSavedSessionRole(roles, { personalSpace: 'personal' }, SYSTEM_PRINCIPAL, saved, 4_000),
    ).resolves.toMatchObject({
      role: { name: 'renamed-role', instructions: 'Renamed body.' },
      packageId,
    })
    const missingExact = createRolesService({
      catalog: async () => [],
      library: {
        ...library,
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
    ).resolves.toBeNull()

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
          roleLocator: {
            ...saved.roleLocator,
            location: { scope: 'space' as const, spaceId: 'personal' },
          },
        },
        4_000,
      ),
    ).resolves.toBeNull()
  })

  it('resumes a bound role only where its reach still answers', async () => {
    const library = createInMemoryRoleLibrary()
    const availability = new InMemoryAbilityAvailability()
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: async () => [],
      library,
      abilityAvailability: availability,
    })
    const base = await roles.createCustomRole('review', 'Team review.', 'The team way.', {
      scope: 'space',
      space: 'shared',
    })
    const locator = spaceRoleLocator(base.packageId, 'shared')

    await roles.setAbilityAvailability({ personalSpace: 'personal' }, SYSTEM_PRINCIPAL, locator, {
      mode: 'selected-projects',
      projectIds: ['project-a'],
    })

    // Where the reach answers, resume and activation agree.
    await expect(
      roles.loadSavedRole(projectContext('project-a', 'shared'), SYSTEM_PRINCIPAL, locator, 4_000),
    ).resolves.toMatchObject({ role: { name: 'review' } })

    // And where it does not, they must STILL agree: a listing that refuses to offer
    // the role and a resume that hands over its instructions are the same session
    // telling the agent two different things about the same role.
    await expect(
      roles.loadEffective(projectContext('project-b', 'shared'), SYSTEM_PRINCIPAL, 'review', 4_000),
    ).resolves.toBeNull()
    await expect(
      roles.loadSavedRole(projectContext('project-b', 'shared'), SYSTEM_PRINCIPAL, locator, 4_000),
    ).resolves.toBeNull()
  })

  it('resumes a Space role whose skill reaches only the project being resumed in', async () => {
    const library = createInMemoryRoleLibrary()
    const availability = new InMemoryAbilityAvailability()
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: async () => [],
      library,
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
    ).resolves.toMatchObject({ role: { name: 'review' } })
    await expect(
      roles.loadSavedRole(projectContext('project-a', 'shared'), SYSTEM_PRINCIPAL, locator, 4_000),
    ).resolves.toMatchObject({ role: { name: 'review' }, skills: [{ name: 'evidence' }] })
  })

  it('maps a role publication race after the precheck to already-exists', async () => {
    const library = createInMemoryRoleLibrary()
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      library,
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
    const library = createInMemoryRoleLibrary()
    const abilityAvailability = new InMemoryAbilityAvailability()
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      library,
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
      skills: [{ name: 'grooming-evidence' }],
    })
    await expect(
      roles.loadEffective(context('project-b'), SYSTEM_PRINCIPAL, 'grooming', 4_000),
    ).resolves.toMatchObject({
      skills: [{ name: 'grooming-evidence' }],
    })
    expect(
      await roles.loadEffective(context('project-c'), SYSTEM_PRINCIPAL, 'grooming', 4_000),
    ).toBeNull()
    expect(await library.get(projectC, 'grooming-evidence')).toBeNull()
  })

  it('rejects a linked-skill collision instead of binding a role to different bytes', async () => {
    const library = createInMemoryRoleLibrary()
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      library,
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
    const library = createInMemoryRoleLibrary()
    const roles = createRolesService({
      catalog: async () => [],
      library,
      ...inMemoryAbilityPersistence(),
    })
    await library.putIfAbsent(
      { scope: 'personal', space: 'personal' },
      pkg('long-role', 'Long role.', 'x'.repeat(1_000)),
    )

    const loaded = await roles.loadEffective(
      { personalSpace: 'personal' },
      SYSTEM_PRINCIPAL,
      'long-role',
      100,
    )
    expect(loaded!.role.instructions.length).toBeLessThanOrEqual(400)
    expect(loaded!.role.instructions.length).toBeGreaterThan(0)
    expect(loaded?.truncated).toBe(true)
  })

  it('budgets linked names and descriptions even when their instruction bodies are empty', async () => {
    const library = createInMemoryRoleLibrary()
    const dependencies = Array.from({ length: 8 }, (_, index) => ({
      ...skillPkg(`support-${index}`, `Supporting description ${index} ${'x'.repeat(80)}`),
      directoryName: `Support${index}aBcD`,
    }))
    const role = pkg('bounded-role', 'Bounded role.', '')
    const links = dependencies
      .map(
        ({ directoryName }, index) => `[[notarium-id:personal:${directoryName}|support-${index}]]`,
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
      library,
      ...inMemoryAbilityPersistence(),
    })
    const personal = { scope: 'personal' as const, space: 'personal' }

    for (const dependency of dependencies) {
      await library.putIfAbsent(personal, dependency)
    }
    await library.putIfAbsent(personal, role)
    const loaded = await roles.loadEffective(
      { personalSpace: personal.space },
      SYSTEM_PRINCIPAL,
      'bounded-role',
      100,
    )
    const returnedCharacters =
      loaded!.role.name.length +
      loaded!.role.description.length +
      loaded!.role.instructions.length +
      loaded!.skills.reduce(
        (total, skill) =>
          total + skill.name.length + skill.description.length + skill.instructions.length,
        0,
      )

    expect(returnedCharacters).toBeLessThanOrEqual(400)
    expect(loaded?.skills.length).toBeLessThan(dependencies.length)
    expect(loaded?.truncated).toBe(true)
  })

  it('forks every file in a complete Agent Skills package', async () => {
    const library = createInMemoryRoleLibrary()
    const role = pkg('resource-role', 'Resource role.', 'Instructions.')
    role.files.set('scripts/run.sh', Buffer.from('#!/bin/sh\necho safe-copy\n'))
    role.files.set('references/guide.md', Buffer.from('# Guide\n\nSupporting evidence.'))
    role.files.set('assets/template.bin', Buffer.from([0, 1, 2, 255]))
    const roles = createRolesService({
      catalog: async () => [catalogPackage(role)],
      library,
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
    const library = createInMemoryRoleLibrary()
    const roles = createRolesService({
      catalog: async () => [],
      library,
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
    const library = createInMemoryRoleLibrary()
    const roles = createRolesService({
      catalog: async () => [],
      library,
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
    const backing = createInMemoryRoleLibrary()
    const location = { scope: 'personal' as const, space: 'personal' }
    await backing.putIfAbsent(location, pkg('known-role', 'Known role.', 'Direct instructions.'))
    const roles = createRolesService({
      catalog: async () => [],
      library: {
        ...backing,
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
      role: { name: 'known-role', scope: 'personal', instructions: 'Direct instructions.' },
    })
  })

  it('stops progressive linked-skill reads when the role consumes the output budget', async () => {
    const backing = createInMemoryRoleLibrary()
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
      library: {
        ...backing,
        getSkill: async (where, name) => {
          reads.push(name)
          return backing.getSkill(where, name)
        },
      },
      ...inMemoryAbilityPersistence(),
    })

    await expect(
      roles.loadEffective({ personalSpace: 'personal' }, SYSTEM_PRINCIPAL, 'progressive-role', 100),
    ).resolves.toMatchObject({ truncated: true, skills: [] })
    expect(reads).toEqual(['progressive-role'])
  })

  it('rejects a catalog manifest whose owned provenance rewrite would exceed the shared bound', async () => {
    const name = 'near-limit'
    const revision = `sha256:${'a'.repeat(64)}`
    let source = ''

    for (let padding = 15_500; padding < 16_384; padding++) {
      const candidate = `---\nname: ${name}\ndescription: Near limit.\nmetadata:\n  notarium.kind: role\n  notarium.source: catalog\n  notarium.package-id: ${packageDirectoryOf(name)}\n  padding: ${'x'.repeat(padding)}\n---\n`

      try {
        parseSkillFile(candidate, name)
        parseSkillFile(withCatalogProvenance(candidate, packageDirectoryOf(name), revision), name)
      } catch {
        try {
          parseSkillFile(candidate, name)
          source = candidate
          break
        } catch {
          // The source itself crossed the bound; keep searching is pointless.
          break
        }
      }
    }
    expect(source).not.toBe('')
    const roles = createRolesService({
      catalog: async () => [
        {
          directoryName: packageDirectoryOf(name),
          files: new Map([['SKILL.md', Buffer.from(source)]]),
        },
      ],
      library: createInMemoryRoleLibrary(),
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
    const library = createInMemoryRoleLibrary()
    const roles = createRolesService({
      catalog: async () => [catalogPackage(role)],
      library,
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
      library: createInMemoryRoleLibrary(),
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
    await expect(
      roles.setAbilityAvailability({ personalSpace: 'personal' }, SYSTEM_PRINCIPAL, asSpace, {
        mode: 'all-projects',
      }),
    ).rejects.toBeInstanceOf(AbilityUnavailableError)

    // The base/version entries ask the same address question, so they get the same
    // answer: `space` borrowed for a personal library is not a place, and Personal
    // has no projects to fork into.
    await expect(
      roles.createRoleVersion(SYSTEM_PRINCIPAL, asSpace, 'personal', 'project-web'),
    ).rejects.toBeInstanceOf(AbilityUnavailableError)
  })

  it('gives a personal role no versions, no base and nowhere to be promoted to', async () => {
    const library = createInMemoryRoleLibrary()
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      library,
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
      roles.moveRolePlacement(SYSTEM_PRINCIPAL, inProject(other.packageId), 'personal'),
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
      library: createInMemoryRoleLibrary(),
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
      spaceRoleLocator(created.packageId, 'shared'),
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
      library: createInMemoryRoleLibrary(),
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
      spaceRoleLocator(shared.packageId, 'shared'),
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
    const library = createInMemoryRoleLibrary()
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      library,
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
      library: createInMemoryRoleLibrary(),
      ...inMemoryAbilityPersistence(),
    })
    const base = await roles.createCustomRole(
      'review',
      'Team review.',
      '# Team review\n\nThe team way.',
      { scope: 'space', space: 'shared' },
    )
    const version = await roles.createRoleVersion(
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

  it('keeps an override self-sufficient when the base does not reach its project', async () => {
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      library: createInMemoryRoleLibrary(),
      ...inMemoryAbilityPersistence(),
    })
    const base = await roles.createCustomRole('review', 'Team review.', 'The team way.', {
      scope: 'space',
      space: 'shared',
    })
    await roles.createRoleVersion(
      SYSTEM_PRINCIPAL,
      spaceRoleLocator(base.packageId, 'shared'),
      null,
      'project-web',
    )
    await roles.setAbilityAvailability(
      { personalSpace: null },
      SYSTEM_PRINCIPAL,
      spaceRoleLocator(base.packageId, 'shared'),
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
      library: createInMemoryRoleLibrary(),
      ...inMemoryAbilityPersistence(),
    })
    const base = await roles.createCustomRole('review', 'Team review.', 'The team way.', {
      scope: 'space',
      space: 'shared',
    })
    const locator = spaceRoleLocator(base.packageId, 'shared')
    await roles.createRoleVersion(SYSTEM_PRINCIPAL, locator, null, 'project-web')

    await expect(
      roles.createRoleVersion(SYSTEM_PRINCIPAL, locator, null, 'project-web'),
    ).rejects.toBeInstanceOf(RoleAlreadyExistsError)
  })

  it('lets a role narrowed to two projects depend on a skill that reaches both', async () => {
    const library = createInMemoryRoleLibrary()
    const availability = new InMemoryAbilityAvailability()
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      library,
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
    await expect(
      roles.createCustomRole(
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
      ),
    ).rejects.toBeInstanceOf(RoleDependencyConflictError)
  })

  it('makes health a fact about a role AND a project, not about a role alone', async () => {
    const library = createInMemoryRoleLibrary()
    const availability = new InMemoryAbilityAvailability()
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      library,
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
      spaceRoleLocator(role.packageId, 'shared'),
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
    ).resolves.toMatchObject({ role: { name: 'review' } })
    // Fail-closed where the dependency does not reach.
    await expect(
      roles.loadEffective(
        projectContext('project-web', 'shared'),
        SYSTEM_PRINCIPAL,
        'review',
        4_000,
      ),
    ).resolves.toBeNull()
  })

  /** "Does this package exist" had two answers: the listing and the detail demanded a
   *  projected identity, the base/version pair did not — so the pair handed out
   *  addresses the same server then answered 404 for, and the two writes that share
   *  those addresses answered 500 instead of 404 for the very same package. */
  it('answers one way about a package the projection has not caught up with', async () => {
    const inner = createInMemoryRoleLibrary()
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      library: {
        ...inner,
        // A package on disk that the read model has not projected yet. The real library
        // calls this normal: external files land in a mount all the time.
        readableNoteIds: async (location, directoryNames) =>
          new Map(
            [...(await inner.readableNoteIds(location, directoryNames))].filter(
              ([directoryName]) => directoryName !== unprojected,
            ),
          ),
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
    await expect(
      roles.setEnabled({ personalSpace: null }, SYSTEM_PRINCIPAL, baseLocator, false),
    ).rejects.toBeInstanceOf(AbilityUnavailableError)
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
      library: createInMemoryRoleLibrary(),
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
      library: createInMemoryRoleLibrary(),
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
    await roles.setEnabled({ personalSpace: null }, SYSTEM_PRINCIPAL, skillLocator, false)

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
      library: createInMemoryRoleLibrary(),
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
      library: createInMemoryRoleLibrary(),
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

    await roles.setEnabled({ personalSpace: 'personal' }, SYSTEM_PRINCIPAL, locator, false)

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
      library: createInMemoryRoleLibrary(),
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

    await roles.setAbilityAvailability({ personalSpace: 'personal' }, SYSTEM_PRINCIPAL, locator, {
      mode: 'selected-projects',
      projectIds: ['project-a'],
    })

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
    const library = createInMemoryRoleLibrary()
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      library,
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
    await expect(roles.loadSavedRole(context, SYSTEM_PRINCIPAL, locator, 4_000)).resolves.toBeNull()
    // ...so the two answers have to agree that it is not raisable.
    await expect(roles.resolveSavedRole(context, SYSTEM_PRINCIPAL, locator)).resolves.toBeNull()
  })

  /** Add installs dependencies and grants them reach BEFORE it publishes the role. A
   *  dependency that already existed is REUSED, so that grant widens a skill the owner
   *  already had — and if the role then fails to publish, the caller is told nothing
   *  happened while the widening stays. `moveRolePlacement` compensates; this did not. */
  /** The preview claims it mirrors what the agent loads. A role whose attachment no
   *  longer resolves is refused by resume — so the preview has to say so, rather than
   *  drawing it as the selected role and charging its layer to the budget. */
  it('reports an addressed role as inactive when resume would refuse it', async () => {
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      library: createInMemoryRoleLibrary(),
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
    await roles.setEnabled(context, SYSTEM_PRINCIPAL, skillLocator, false)

    // Resume refuses the role...
    await expect(roles.loadSavedRole(context, SYSTEM_PRINCIPAL, locator, 4_000)).resolves.toBeNull()
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

  it('does not widen a shared skill when the role it was added for fails to publish', async () => {
    const library = createInMemoryRoleLibrary()
    const availability = new InMemoryAbilityAvailability()
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      library,
      abilityAvailability: availability,
    })
    const dependency = await roles.addSkillFromCatalog(
      'grooming-evidence',
      { scope: 'space', space: 'shared' },
      { mode: 'selected-projects', projectIds: ['project-a'] },
    )
    const reachBefore = await availability.get('shared', dependency.packageId)
    const putIfAbsent = library.putIfAbsent.bind(library)

    library.putIfAbsent = async (location, candidate) => {
      // Dependencies go to the Space home; the role itself is the LAST thing published
      // and the only thing published at the project placement.
      if (location.scope === 'project') {
        throw new Error('the destination refused the role package')
      }

      return putIfAbsent(location, candidate)
    }

    await expect(
      roles.addFromCatalog(
        'grooming',
        { scope: 'project', space: 'shared', projectId: 'project-b' },
        null,
      ),
    ).rejects.toThrow('the destination refused the role package')

    await expect(availability.get('shared', dependency.packageId)).resolves.toEqual(reachBefore)
  })

  /** Compensation undoes what did NOT land. Once the role is published it is live, and
   *  taking its dependencies' reach back left it effective and fail-closed forever —
   *  with no way out, because Add then answers 409. */
  it('keeps a landed role reachable when the step after publication fails', async () => {
    const library = createInMemoryRoleLibrary()
    const availability = new InMemoryAbilityAvailability()
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      library,
      abilityAvailability: availability,
    })
    const home = { scope: 'space', space: 'shared' } as const
    const placement = { scope: 'project', space: 'shared', projectId: 'project-b' } as const
    const dependency = await roles.addSkillFromCatalog('grooming-evidence', home, {
      mode: 'selected-projects',
      projectIds: ['project-a'],
    })
    const awaitReadable = library.awaitReadableNoteIds.bind(library)

    // Fails AFTER putIfAbsent has landed the role at its placement.
    library.awaitReadableNoteIds = async (location, ids) => {
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

  /** Reach is written BEFORE the package is readable at its new home. For a role the
   *  ABSENCE of a row reads as all-projects, so publishing first opens a window in
   *  which a role narrowed to one project answers in every project of its Space —
   *  the invariant `createCustomRole` already states and orders itself by. */
  it('never leaves a promoted role reachable from a project it was narrowed away from', async () => {
    const library = createInMemoryRoleLibrary()
    const availability = new InMemoryAbilityAvailability()
    const insideTheWindow: unknown[] = []
    const set = availability.set.bind(availability)
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      library,
      abilityAvailability: availability,
      abilityPlacement: { moveOwnedRolePlacement: async () => {} },
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
      {
        source: 'owned',
        kind: 'role',
        packageId: version.packageId,
        location: { scope: 'project', spaceId: 'shared', projectId: 'project-web' },
      },
      null,
    )

    expect(insideTheWindow).toEqual([null])
  })

  it('promotes a version with its address, its state and a reach that does not widen', async () => {
    const moveOwnedRolePlacement = vi.fn(async () => {})
    const library = createInMemoryRoleLibrary()
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
      library,
      abilityAvailability: availability,
      abilityPlacement: { moveOwnedRolePlacement },
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

    const promoted = await roles.moveRolePlacement(SYSTEM_PRINCIPAL, locator, null)

    expect(promoted.locator).toEqual(spaceRoleLocator(version.packageId, 'shared'))
    expect(promoted.availability).toEqual({
      mode: 'selected-projects',
      projectIds: ['project-web'],
    })
    // Placement is part of the address, so the rows keyed by it move in one call.
    expect(moveOwnedRolePlacement).toHaveBeenCalledWith({
      fromTargetId: `project:project-web:${version.packageId}`,
      toTargetId: `space:shared:${version.packageId}`,
      fromLocator: expect.stringContaining('project'),
      toLocator: expect.stringContaining('space'),
    })
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
    const library = createInMemoryRoleLibrary()
    const availability = new InMemoryAbilityAvailability()
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      library,
      abilityAvailability: availability,
      abilityPlacement: {
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
    // The promotion itself goes through; only putting the package BACK is refused,
    // so the role stays at the Space root whatever the rollback does about its reach.
    const move = library.movePackage.bind(library)
    let moves = 0

    library.movePackage = async (from, to, directoryName) => {
      moves += 1

      return moves === 1 ? move(from, to, directoryName) : false
    }

    await expect(
      roles.moveRolePlacement(
        SYSTEM_PRINCIPAL,
        {
          source: 'owned',
          kind: 'role',
          packageId: version.packageId,
          location: { scope: 'project', spaceId: 'shared', projectId: 'project-web' },
        },
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
    const library = createInMemoryRoleLibrary()
    const roles = createRolesService({
      catalog: async () => [],
      library,
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

    await roles.setEnabled(context, SYSTEM_PRINCIPAL, locator, false)
    await expect(
      roles.loadEffective(context, SYSTEM_PRINCIPAL, 'review', 4_000),
    ).resolves.toBeNull()

    const promoted = await roles.moveRolePlacement(SYSTEM_PRINCIPAL, locator, null)

    // The preference row is keyed by the LOCATOR, and a promotion changes it. Left
    // behind, the row names a placement that no longer exists and the absent row at
    // the new one reads as enabled — so the role the owner turned off comes back on.
    await expect(
      roles.effectiveRoleAt({ personalSpace: null }, SYSTEM_PRINCIPAL, promoted.locator),
    ).resolves.toBeNull()
  })

  it('refuses to promote onto an occupied name before anything moves', async () => {
    const moveOwnedRolePlacement = vi.fn(async () => {})
    const library = createInMemoryRoleLibrary()
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      library,
      abilityPlacement: { moveOwnedRolePlacement },
    })
    const base = await roles.createCustomRole('review', 'Team review.', 'The team way.', {
      scope: 'space',
      space: 'shared',
    })
    const version = await roles.createRoleVersion(
      SYSTEM_PRINCIPAL,
      spaceRoleLocator(base.packageId, 'shared'),
      null,
      'project-web',
    )

    await expect(
      roles.moveRolePlacement(
        SYSTEM_PRINCIPAL,
        {
          source: 'owned',
          kind: 'role',
          packageId: version.packageId,
          location: { scope: 'project', spaceId: 'shared', projectId: 'project-web' },
        },
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
    const library = createInMemoryRoleLibrary()
    const availability = new InMemoryAbilityAvailability()
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      library,
      abilityAvailability: availability,
      abilityPlacement: {
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
        {
          source: 'owned',
          kind: 'role',
          packageId: version.packageId,
          location: { scope: 'project', spaceId: 'shared', projectId: 'project-web' },
        },
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
