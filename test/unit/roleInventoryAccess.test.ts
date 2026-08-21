import { describe, expect, it } from 'vitest'

import type { Principal } from '../../packages/server/src/services/authz'
import {
  createInMemoryRoleLibrary,
  createRolesService,
  inMemoryAbilityPersistence,
  type RoleLocation,
} from '../../packages/server/src/services/roles'
import { writableLibrary } from '../roleLibraryComposition'

const SPACE: RoleLocation = { scope: 'space', space: 'shared' }

/** A real caller, not the all-access host: `SYSTEM_PRINCIPAL` short-circuits `can`
 *  before any rule is consulted, so every gate in the service is vacuous under it. */
const reader = (spaces: readonly string[]): Principal => ({
  id: 'pat:alice:narrowed',
  username: 'alice',
  admin: false,
  scope: 'read',
  grants: new Map(spaces.map((space) => [space, 'reader' as const])),
  spaces: new Set(spaces),
  system: false,
})

describe('owned ability inventory — the placement is enumerated, so the grant is asked here', () => {
  it('answers an empty page for a Space the caller cannot read', async () => {
    const library = writableLibrary(createInMemoryRoleLibrary())
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: async () => [],
      ...library.deps,
    })

    await roles.createCustomRole('review', 'Team review.', 'The team way.', SPACE)

    // The entry takes a PLACEMENT, not a locator: nothing upstream of it has had to
    // prove the caller may see that Space. Every caller today builds the placement
    // server-side, so this is the last line of defence rather than a reachable hole —
    // and an unproven last line of defence is one refactor away from being none.
    await expect(roles.listOwnedAbilitiesAt(SPACE, reader(['other']), 'role')).resolves.toEqual({
      abilities: [],
      truncated: false,
    })
    await expect(roles.listOwnedAbilitiesAt(SPACE, reader(['other']), 'skill')).resolves.toEqual({
      abilities: [],
      truncated: false,
    })

    // Not vacuously empty: the same call by a caller who HAS the Space lists the role.
    await expect(
      roles.listOwnedAbilitiesAt(SPACE, reader(['shared']), 'role'),
    ).resolves.toMatchObject({ abilities: [{ ability: { name: 'review' } }] })
  })
})
