import { describe, expect, it } from 'vitest'

import type { Principal, SpaceRole } from '../../packages/server/src/services/authz'
import {
  AbilityUnavailableError,
  createInMemoryRoleLibrary,
  createRolesService,
  InMemoryAbilityAvailability,
  inMemoryAbilityPersistence,
  RoleDependencyConflictError,
  type RoleLocation,
  type SkillHomeLocation,
} from '../../packages/server/src/services/roles'
import { writableLibrary } from '../roleLibraryComposition'

/** Every entry of `RolesService` that asks `can()` and had no test able to see the
 *  answer. The whole file exists because of ONE property of the all-access host:
 *  `SYSTEM_PRINCIPAL` short-circuits `can` to `true` on its first line, so a suite
 *  built on it cannot distinguish a gate from its absence. Nine of the twelve `can`
 *  sites in the ability service could be replaced by the literal `true` without a
 *  single byte of the full run changing.
 *
 *  Every case here is therefore stated twice: once for a principal the gate must
 *  refuse, and once for a principal it must let through. The second half is not
 *  politeness — without it, "returns null" is satisfiable by a world where the role
 *  simply is not there, which is exactly the state a vacuous test settles into. */

const PERSONAL = { scope: 'personal', space: 'personal' } as const satisfies SkillHomeLocation
const SHARED = { scope: 'space', space: 'shared' } as const satisfies RoleLocation
const PROJECT = {
  scope: 'project',
  space: 'shared',
  projectId: 'project-a',
} as const satisfies RoleLocation

/** A real caller. `system: false` is the entire point: it is the only way any rule in
 *  `authz` is consulted at all. */
const principal = (
  scope: 'read' | 'write' | 'manage',
  grants: ReadonlyArray<readonly [string, SpaceRole]>,
): Principal => ({
  id: `pat:alice:${scope}:${grants.map(([space]) => space).join('+') || 'none'}`,
  username: 'alice',
  admin: false,
  scope,
  grants: new Map(grants),
  spaces: new Set(grants.map(([space]) => space)),
  system: false,
})

/** Owner of another space entirely, at the highest scope a credential can carry. The
 *  ceiling is deliberately maximal so that a refusal can only be about MEMBERSHIP —
 *  a read-scope principal would refuse for two reasons at once and prove neither. */
const outsider = principal('manage', [['other', 'owner']])
/** Inside the space and allowed to read it, and nothing more. Used against every
 *  `space:write` gate, so a refusal names the verb rather than the space. */
const reader = principal('read', [
  ['shared', 'reader'],
  ['personal', 'owner'],
])
const writer = principal('write', [
  ['shared', 'writer'],
  ['personal', 'owner'],
])

/** The two addresses every case below hands the service. Written as two builders
 *  rather than one over `RoleLocation`, because the locator seam distinguishes them:
 *  a project address carries the project id and a Space one may not. */
const sharedRole = (packageId: string) =>
  ({
    source: 'owned',
    kind: 'role',
    packageId,
    location: { scope: 'space', spaceId: SHARED.space },
  }) as const

const projectRole = (packageId: string) =>
  ({
    source: 'owned',
    kind: 'role',
    packageId,
    location: { scope: 'project', spaceId: PROJECT.space, projectId: PROJECT.projectId },
  }) as const

const projectContext = {
  personalSpace: 'personal',
  project: {
    id: 'project-a',
    space: 'shared',
    path: 'a',
    slug: 'a',
    aliases: [],
    pathAliases: [],
    displayName: 'A',
    status: 'active' as const,
    createdAt: '2026-08-17T00:00:00Z',
    lastSeen: '2026-08-17T00:00:00Z',
  },
}

const world = () => {
  const library = writableLibrary(createInMemoryRoleLibrary())
  const abilityAvailability = new InMemoryAbilityAvailability()
  const roles = createRolesService({
    ...inMemoryAbilityPersistence(),
    abilityAvailability,
    catalog: async () => [],
    ...library.deps,
  })

  return { roles, library, abilityAvailability }
}

describe('ability service authorization — the nine gates the system principal cannot see', () => {
  it('calls a role dependency unavailable when the author cannot read its home', async () => {
    const { roles } = world()
    const skill = await roles.createCustomSkill('helper', 'Helper.', 'Help out.', PERSONAL)
    const attachment = {
      kind: 'exact' as const,
      locator: {
        source: 'owned' as const,
        kind: 'skill' as const,
        packageId: skill.packageId,
        location: { scope: 'personal' as const, spaceId: 'personal' },
      },
      label: 'helper',
    }

    // Health READS the packages a role depends on, so the grant is asked before the
    // read — and a role whose dependency is unreadable is fail-closed, not healthy.
    // Authoring is the one caller that reaches this gate with a principal no outer
    // gate has already vetted: `createCustomRole` takes the principal precisely so
    // that the dependency check has one.
    await expect(
      roles.createCustomRole('review', 'Review.', 'The way.', PERSONAL, {
        principal: outsider,
        attachments: [attachment],
        personalSpace: 'personal',
      }),
    ).rejects.toBeInstanceOf(RoleDependencyConflictError)

    await expect(
      roles.createCustomRole('review', 'Review.', 'The way.', PERSONAL, {
        principal: reader,
        attachments: [attachment],
        personalSpace: 'personal',
      }),
    ).resolves.toMatchObject({ name: 'review' })
  })

  it('refuses to set a reach for a caller who may only read the Space', async () => {
    const { roles, abilityAvailability } = world()
    const base = await roles.createCustomRole('review', 'Review.', 'The way.', SHARED)
    const locator = sharedRole(base.packageId)
    const narrowed = { mode: 'selected-projects' as const, projectIds: ['project-a'] }

    await expect(
      roles.setAbilityAvailability({ personalSpace: 'personal' }, reader, locator, narrowed),
    ).rejects.toBeInstanceOf(AbilityUnavailableError)
    // Refused BEFORE the row was touched: reach decides where a role answers at all,
    // so a refusal that still wrote would be the whole failure this gate prevents.
    await expect(abilityAvailability.get('shared', base.packageId)).resolves.toMatchObject({
      mode: 'all-projects',
    })

    await expect(
      roles.setAbilityAvailability({ personalSpace: 'personal' }, writer, locator, narrowed),
    ).resolves.toBeUndefined()
    await expect(abilityAvailability.get('shared', base.packageId)).resolves.toMatchObject(narrowed)
  })

  it('lists no project versions of a base in a Space the caller cannot read', async () => {
    const { roles } = world()
    const base = await roles.createCustomRole('review', 'Review.', 'The way.', SHARED)
    const locator = sharedRole(base.packageId)

    await roles.createRoleVersion(writer, locator, 'personal', 'project-a')

    await expect(
      roles.listRoleVersions(outsider, locator, 'personal', ['project-a']),
    ).resolves.toEqual([])
    // The version really is there, so the empty answer above is about the grant.
    await expect(
      roles.listRoleVersions(reader, locator, 'personal', ['project-a']),
    ).resolves.toMatchObject([{ projectId: 'project-a' }])
  })

  it('finds no base for a version whose Space the caller cannot read', async () => {
    const { roles } = world()
    const base = await roles.createCustomRole('review', 'Review.', 'The way.', SHARED)
    const version = await roles.createRoleVersion(
      writer,
      sharedRole(base.packageId),
      'personal',
      'project-a',
    )
    const locator = projectRole(version.packageId)

    await expect(roles.findRoleBase(outsider, locator, 'personal')).resolves.toBeNull()
    await expect(roles.findRoleBase(reader, locator, 'personal')).resolves.toMatchObject({
      packageId: base.packageId,
    })
  })

  it('refuses to fork a base into a project version for a read-only caller', async () => {
    const { roles, library } = world()
    const base = await roles.createCustomRole('review', 'Review.', 'The way.', SHARED)
    const locator = sharedRole(base.packageId)

    await expect(
      roles.createRoleVersion(reader, locator, 'personal', 'project-a'),
    ).rejects.toBeInstanceOf(AbilityUnavailableError)
    // A version is a package published into the project library; the refusal has to
    // land before that, not after.
    await expect(library.getSkill(PROJECT, 'review')).resolves.toBeNull()

    await expect(
      roles.createRoleVersion(writer, locator, 'personal', 'project-a'),
    ).resolves.toMatchObject({ name: 'review', scope: 'project' })
  })

  it('refuses to promote a project version for a read-only caller', async () => {
    const { roles, library } = world()
    const version = await roles.createCustomRole('review', 'Review.', 'The way.', PROJECT)
    const locator = projectRole(version.packageId)

    await expect(roles.moveRolePlacement(reader, locator, 'personal')).rejects.toBeInstanceOf(
      AbilityUnavailableError,
    )
    // Nothing moved: the package is still where it was, and the Space root is free.
    await expect(library.getSkillByDirectory(PROJECT, version.packageId)).resolves.not.toBeNull()
    await expect(library.getSkillByDirectory(SHARED, version.packageId)).resolves.toBeNull()

    await expect(roles.moveRolePlacement(writer, locator, 'personal')).resolves.toMatchObject({
      locator: { location: { scope: 'space', spaceId: 'shared' } },
    })
  })

  it('refuses to rewrite a role attachment list for a read-only caller', async () => {
    const { roles } = world()
    const base = await roles.createCustomRole('review', 'Review.', 'The way.', SHARED)
    const locator = sharedRole(base.packageId)

    await expect(
      roles.serializeOwnedRoleAttachments(reader, locator, [], 'personal'),
    ).rejects.toBeInstanceOf(AbilityUnavailableError)
    await expect(
      roles.serializeOwnedRoleAttachments(writer, locator, [], 'personal'),
    ).resolves.toMatchObject({ links: [] })
  })

  it('resolves nothing at an address whose Space the caller cannot read', async () => {
    const { roles } = world()
    const base = await roles.createCustomRole('review', 'Review.', 'The way.', SHARED)
    const locator = sharedRole(base.packageId)

    // `addressedRoleAt` is addressed rather than enumerated — nothing upstream of it has
    // had to prove the caller may see the Space the locator names.
    await expect(roles.addressedRoleAt(locator, outsider, 'personal')).resolves.toBeNull()
    await expect(roles.addressedRoleAt(locator, reader, 'personal')).resolves.toMatchObject({
      role: { name: 'review' },
    })

    // `addressedRoleStatus` reaches the SAME gate through a second entry, and it is the
    // one the context-identity door calls on every request. Declared here because the
    // gate it leans on is otherwise unobserved: removing `can(space:read)` from
    // `addressedOwnedRole` left the whole run green, while a narrowed credential
    // reached a Space it is not in.
    await expect(
      roles.addressedRoleStatus({ personalSpace: 'personal' }, outsider, locator),
    ).resolves.toBeNull()
    await expect(
      roles.addressedRoleStatus({ personalSpace: 'personal' }, reader, locator),
    ).resolves.toMatchObject({ role: { role: { name: 'review' } } })
  })

  it('reloads no saved role bound to a Space the caller cannot read', async () => {
    const { roles } = world()
    const base = await roles.createCustomRole('review', 'Review.', 'The way.', SHARED)
    const locator = sharedRole(base.packageId)

    // The saved binding names a placement the CONTEXT reaches, and the context is
    // built from the project the caller is in — not from what the caller may read.
    await expect(roles.loadSavedRole(projectContext, outsider, locator, 4_000)).resolves.toBeNull()
    await expect(
      roles.loadSavedRole(projectContext, reader, locator, 4_000),
    ).resolves.toMatchObject({ role: { name: 'review' } })

    // Both entries of the saved binding, because they share ONE gate: `resolveSavedRole`
    // and `loadSavedRole` are two callers of `savedRoleEntry`, and a suite that only
    // knew the loading one would let the cheap resolver drift out from behind it.
    await expect(roles.resolveSavedRole(projectContext, outsider, locator)).resolves.toBeNull()
    await expect(roles.resolveSavedRole(projectContext, reader, locator)).resolves.toMatchObject({
      role: { name: 'review' },
    })
  })
})
