import { describe, expect, it } from 'vitest'

import type { OwnedAbilityLocator } from '@notarium/contract'

import {
  ownedRoleLocatorOfContextTarget,
  roleContextTargetOfLocator,
} from '../../packages/server/src/services/metaDb/abilityAddress'

const packageId = 'AbCdefGhij_1'

describe('Owned Role context target projection', () => {
  it.each([
    {
      source: 'owned',
      kind: 'role',
      packageId,
      location: { scope: 'personal', spaceId: 'space:personal/%' },
    },
    {
      source: 'owned',
      kind: 'role',
      packageId,
      location: { scope: 'space', spaceId: 'space:shared/%' },
    },
    {
      source: 'owned',
      kind: 'role',
      packageId,
      location: {
        scope: 'project',
        spaceId: 'space:shared/%',
        projectId: 'project:alpha/%',
      },
    },
  ] satisfies OwnedAbilityLocator[])('round-trips $location.scope with encoded ids', (locator) => {
    const target = roleContextTargetOfLocator(locator)

    expect(ownedRoleLocatorOfContextTarget(target)).toEqual(locator)
    expect(target.targetId).toContain('%')
  })

  it.each([
    { targetId: `space:other:${packageId}`, targetSpace: 'space-main' },
    { targetId: `project:project-a:${packageId}`, targetSpace: '' },
    { targetId: `space:not%2fcanonical:${packageId}`, targetSpace: 'not/canonical' },
    { targetId: `role:space-main:${packageId}`, targetSpace: 'space-main' },
    { targetId: 'space:space-main:not-a-package', targetSpace: 'space-main' },
  ])('fails closed for malformed or cross-space target %#', (target) => {
    expect(ownedRoleLocatorOfContextTarget(target)).toBeNull()
  })
})
