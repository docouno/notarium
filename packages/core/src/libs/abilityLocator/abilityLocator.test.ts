import { describe, expect, it } from 'vitest'

import {
  decodeAbilityLocator,
  encodeAbilityLocator,
  parseAbilityLocator,
  serializeAbilityLocator,
} from './abilityLocator'

describe('ability locator codec', () => {
  const locators = [
    { source: 'system', kind: 'role', packageId: 'ZME09f9AROG8' },
    { source: 'catalog', kind: 'skill', packageId: 'LM1Iv2rAWGEQ' },
    {
      source: 'owned',
      kind: 'skill',
      packageId: 'AbCdefGhij_1',
      location: { scope: 'space', spaceId: 'space-a' },
    },
    {
      source: 'owned',
      kind: 'role',
      packageId: 'AbCdefGhij_2',
      location: { scope: 'project', spaceId: 'space-a', projectId: 'project-a' },
    },
  ] as const

  it.each(locators)('round-trips $source $kind', (locator) => {
    const encoded = encodeAbilityLocator(locator)
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeAbilityLocator(encoded)).toEqual(locator)
    expect(parseAbilityLocator(serializeAbilityLocator(locator))).toEqual(locator)
  })

  it('rejects Project-owned skills and non-canonical extra fields', () => {
    expect(
      parseAbilityLocator(
        JSON.stringify({
          source: 'owned',
          kind: 'skill',
          packageId: 'AbCdefGhij_1',
          location: { scope: 'project', spaceId: 'space-a', projectId: 'project-a' },
        }),
      ),
    ).toBeNull()
    expect(
      parseAbilityLocator(
        JSON.stringify({
          source: 'system',
          kind: 'role',
          packageId: 'ZME09f9AROG8',
          displayName: 'research',
        }),
      ),
    ).toBeNull()
  })
})
