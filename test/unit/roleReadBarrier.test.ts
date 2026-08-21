import { beforeEach, describe, expect, it } from 'vitest'

import { SYSTEM_PRINCIPAL } from '../../packages/server/src/services/authz'
import {
  createInMemoryRoleLibrary,
  createRolesService,
  type EffectiveRoleContext,
  InMemoryAbilityAvailability,
  inMemoryAbilityPersistence,
  type RoleLocation,
  type RolesService,
} from '../../packages/server/src/services/roles'
import { writableLibrary, type WritableRoleLibrary } from '../roleLibraryComposition'

/**
 * The port draws ONE line through its two identity reads
 * (`RoleLibrary` in packages/server/src/services/roles/library.ts):
 * `awaitReadableNoteIds` crosses the host's publication barrier — which reconciles
 * file truth and BLOCKS MUTATIONS ACROSS THE WHOLE SPACE while it runs — and
 * `readableNoteIds` answers off the current projection without it.
 *
 * Losing the barrier on a write is loud: the package has no readable identity yet and
 * the publish fails. TAKING it on a read is silent — every answer is identical, and
 * the only difference is that listing an inventory now serialises every write in the
 * space behind it, which is the exact cost this port exists to avoid. So the barrier
 * has to be counted, not inferred from answers.
 */
const SPACE: RoleLocation = { scope: 'space', space: 'shared' }
const CONTEXT: EffectiveRoleContext = { personalSpace: 'personal' }
/** The same caller standing inside a project of the Space — the only context from
 *  which the Space's own placement is one of the reachable libraries. */
const PROJECT_CONTEXT: EffectiveRoleContext = {
  personalSpace: 'personal',
  project: {
    id: 'project-a',
    space: 'shared',
    path: 'project-a',
    slug: 'project-a',
    aliases: [],
    pathAliases: [],
    displayName: 'Project A',
    status: 'active',
    lastSeen: '2099-08-05T12:00:00.000Z',
    createdAt: '2099-08-05T12:00:00.000Z',
  },
}

let crossings: string[]
let library: WritableRoleLibrary
let roles: RolesService

const spaceRoleLocator = (packageId: string) =>
  ({
    source: 'owned',
    kind: 'role',
    packageId,
    location: { scope: 'space', spaceId: 'shared' },
  }) as const

beforeEach(() => {
  crossings = []
  library = writableLibrary(
    createInMemoryRoleLibrary({
      onBarrier: (location, directoryNames) =>
        crossings.push(
          `${location.scope}:${location.space}:${[...directoryNames].sort().join(',')}`,
        ),
    }),
  )
  roles = createRolesService({
    ...inMemoryAbilityPersistence(),
    catalog: async () => [],
    ...library.deps,
    abilityAvailability: new InMemoryAbilityAvailability(),
  })
})

describe('RolesService — which questions pay for the publication barrier', () => {
  it('crosses it to publish, and the ledger says so', async () => {
    // Liveness. Without this, every "did not cross" below would also pass against a
    // twin whose barrier was never wired up at all.
    const role = await roles.createCustomRole('review', 'Team review.', 'The team way.', SPACE)

    expect(crossings).toEqual([`space:shared:${role.packageId}`])
  })

  it('does not cross it for any read of an already published role', async () => {
    const role = await roles.createCustomRole('review', 'Team review.', 'The team way.', SPACE)
    const locator = spaceRoleLocator(role.packageId)

    crossings = []

    // Each read is asserted to have ANSWERED. A read that returned null early would
    // not cross the barrier either — and would gate nothing.
    await expect(
      roles.listOwnedAbilitiesAt(SPACE, SYSTEM_PRINCIPAL, 'role'),
    ).resolves.toMatchObject({
      abilities: [{ ability: { name: 'review', noteId: expect.any(String) } }],
    })
    await expect(
      roles.describeAbility(CONTEXT, SYSTEM_PRINCIPAL, locator, 4_000),
    ).resolves.toMatchObject({ name: 'review', noteId: expect.any(String) })
    await expect(
      roles.serializeOwnedRoleAttachments(SYSTEM_PRINCIPAL, locator, [], 'personal'),
    ).resolves.toMatchObject({ links: [], noteId: expect.any(String) })
    await expect(roles.listEffective(PROJECT_CONTEXT, SYSTEM_PRINCIPAL)).resolves.toMatchObject({
      roles: [{ name: 'review' }],
    })
    await expect(
      roles.resolveEffective(PROJECT_CONTEXT, SYSTEM_PRINCIPAL, 'review'),
    ).resolves.toMatchObject({ role: { name: 'review' } })

    expect(crossings).toEqual([])
  })

  it('does not cross it to record a preference or a reach', async () => {
    const role = await roles.createCustomRole('review', 'Team review.', 'The team way.', SPACE)
    const locator = spaceRoleLocator(role.packageId)

    crossings = []

    // These two WRITE — to durable rows, not to the library — and they still may not
    // stop the space. A toggle that reconciles the whole placement is how one user
    // switching a role off blocks every other writer in the Space.
    await roles.setEnabled(CONTEXT, SYSTEM_PRINCIPAL, locator, false)
    await roles.setAbilityAvailability(CONTEXT, SYSTEM_PRINCIPAL, locator, {
      mode: 'all-projects',
    })

    expect(crossings).toEqual([])
  })
})
