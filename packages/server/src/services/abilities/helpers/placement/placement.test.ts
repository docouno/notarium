import { describe, expect, it, vi } from 'vitest'

import type { AuthService } from '../../../auth'
import { type Principal, SYSTEM_PRINCIPAL } from '../../../authz'
import type { RolesService } from '../../../roles'
import type { SpaceManager } from '../../../spaces'
import { createAbilityPlacement } from './placement'

const personalSkill = {
  kind: 'skill',
  source: 'custom',
  body: {
    name: 'first-personal',
    description: 'A first-touch Personal ability.',
    instructions: '# First Personal\n\nPublish only after admission.',
    scope: 'personal',
  },
} as const

describe('Ability Personal placement admission', () => {
  it.each(['pat', 'oauth'] as const)(
    'refuses a narrowed %s principal before provisioning a missing Personal home',
    async (scheme) => {
      let personalSpace: string | null = null
      const setPersonalSpace = vi.fn(async (_username: string, space: string) => {
        personalSpace = space
      })
      const grantOwner = vi.fn(async () => undefined)
      const create = vi.fn(async ({ slug }: { slug: string }) => ({ id: `space-${slug}` }))
      const auth = {
        personalSpaceOf: vi.fn(async () => personalSpace),
        setPersonalSpace,
        grantOwner,
      } as unknown as AuthService
      const spaces = {
        capabilities: { spaceCreate: true },
        create,
        has: vi.fn(() => false),
        list: vi.fn(() => [{ id: 'shared', slug: 'shared' }]),
        resolveId: vi.fn(() => undefined),
      } as unknown as SpaceManager
      const roles = {
        canAddSkillAt: vi.fn(() => true),
      } as unknown as RolesService
      const principal: Principal = {
        id: `${scheme}:alice:token`,
        username: 'alice',
        admin: false,
        scope: 'write',
        grants: new Map([['shared', 'writer']]),
        spaces: new Set(['shared']),
        system: false,
      }
      const placement = createAbilityPlacement({ auth, roles, spaces })

      await expect(placement.prepareCreate(principal, personalSkill)).rejects.toThrow('not found')
      expect(create).not.toHaveBeenCalled()
      expect(setPersonalSpace).not.toHaveBeenCalled()
      expect(grantOwner).not.toHaveBeenCalled()
      expect(personalSpace).toBeNull()
    },
  )

  it('rejects a provisioning result that is not backed by a Personal pointer', async () => {
    const create = vi.fn(async () => ({ id: 'shared-first' }))
    const auth = {
      personalSpaceOf: vi.fn(async () => null),
      setPersonalSpace: vi.fn(),
      grantOwner: vi.fn(),
    } as unknown as AuthService
    const spaces = {
      capabilities: { spaceCreate: true },
      create,
      has: vi.fn(() => true),
      list: vi.fn(() => [{ id: 'shared-first', slug: 'shared-first' }]),
      resolveId: vi.fn(() => undefined),
    } as unknown as SpaceManager
    const roles = {
      canAddSkillAt: vi.fn(() => true),
      resolveOwnedPlacement: vi.fn((location) => location),
    } as unknown as RolesService
    const principal: Principal = {
      id: 'pat:alice:write',
      username: 'alice',
      admin: false,
      scope: 'write',
      grants: new Map([['shared-first', 'writer']]),
      spaces: null,
      system: false,
    }
    const placement = createAbilityPlacement({ auth, roles, spaces })

    await expect(placement.prepareCreate(principal, personalSkill)).rejects.toThrow(
      'durable Personal namespace',
    )
    expect(create).toHaveBeenCalledOnce()
    expect(auth.setPersonalSpace).toHaveBeenCalledWith('alice', 'shared-first')
    expect(roles.resolveOwnedPlacement).not.toHaveBeenCalled()
  })

  it('refuses a pointer-less static Personal install before mutation', async () => {
    const create = vi.fn()
    const setPersonalSpace = vi.fn()
    const grantOwner = vi.fn()
    const auth = {
      personalSpaceOf: vi.fn(async () => null),
      setPersonalSpace,
      grantOwner,
    } as unknown as AuthService
    const spaces = {
      capabilities: { spaceCreate: false },
      create,
      list: vi.fn(() => [
        { id: 'blocked', slug: 'blocked' },
        { id: 'allowed', slug: 'allowed' },
      ]),
    } as unknown as SpaceManager
    const roles = {
      canAddSkillAt: vi.fn(() => true),
      resolveOwnedPlacement: vi.fn((location) => location),
    } as unknown as RolesService
    const principal: Principal = {
      id: 'pat:alice:static',
      username: 'alice',
      admin: false,
      scope: 'write',
      grants: new Map([['allowed', 'writer']]),
      spaces: null,
      system: false,
    }
    const placement = createAbilityPlacement({ auth, roles, spaces })

    await expect(placement.personalSpaceFor(SYSTEM_PRINCIPAL)).resolves.toBeNull()
    expect(placement.personalInstallAvailable('skill', null)).toBe(false)
    await expect(placement.prepareCreate(principal, personalSkill)).rejects.toThrow(
      'installation is unavailable',
    )
    expect(create).not.toHaveBeenCalled()
    expect(setPersonalSpace).not.toHaveBeenCalled()
    expect(grantOwner).not.toHaveBeenCalled()
  })

  it.each(['pat', 'oauth'] as const)(
    'does not expose the static Personal fallback to a narrowed %s principal',
    async (scheme) => {
      const create = vi.fn()
      const setPersonalSpace = vi.fn()
      const grantOwner = vi.fn()
      const auth = {
        personalSpaceOf: vi.fn(async () => null),
        setPersonalSpace,
        grantOwner,
      } as unknown as AuthService
      const spaces = {
        capabilities: { spaceCreate: false },
        create,
        list: vi.fn(() => [{ id: 'allowed', slug: 'allowed' }]),
      } as unknown as SpaceManager
      const roles = { canAddSkillAt: vi.fn(() => true) } as unknown as RolesService
      const principal: Principal = {
        id: `${scheme}:alice:static`,
        username: 'alice',
        admin: false,
        scope: 'write',
        grants: new Map([['allowed', 'writer']]),
        spaces: new Set(['allowed']),
        system: false,
      }
      const placement = createAbilityPlacement({ auth, roles, spaces })

      expect(placement.personalInstallAvailable('skill', null)).toBe(false)
      await expect(placement.prepareCreate(principal, personalSkill)).rejects.toThrow(
        'installation is unavailable',
      )
      expect(create).not.toHaveBeenCalled()
      expect(setPersonalSpace).not.toHaveBeenCalled()
      expect(grantOwner).not.toHaveBeenCalled()
    },
  )
})
