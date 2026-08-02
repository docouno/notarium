import { describe, expect, it } from 'vitest'

import type { SpaceRecord } from '../metaDb'
import { buildSpaceSlugIndex, resolvableSpaceAliases, resolveSpaceRecord } from './spaceResolver'

const space = (
  id: string,
  slug: string,
  aliases: string[] = [],
  archivedAt: string | null = null,
): SpaceRecord => ({
  id,
  slug,
  aliases,
  displayName: slug,
  notesDir: slug,
  createdAt: '2026-01-01T00:00:00.000Z',
  archivedAt,
  archivedBy: archivedAt ? 'user:admin' : null,
})

describe('space reference resolver', () => {
  it('indexes current slugs before aliases, regardless of registry order', () => {
    const index = buildSpaceSlugIndex([
      space('old-owner', 'archive', ['Research']),
      space('current-owner', 'research'),
    ])

    expect(index.get('research')).toBe('current-owner')
  })

  it('normalizes a human alias exactly like the runtime resolver', () => {
    const record = space('space-id', 'research', ['Old Research'])

    expect(resolveSpaceRecord([record], 'OLD RESEARCH')).toBe(record)
  })

  it('fails closed on an alias shared by multiple spaces, regardless of registry order', () => {
    const first = space('first-id', 'first', ['retired'])
    const second = space('second-id', 'second', ['retired'])

    expect(buildSpaceSlugIndex([first, second]).has('retired')).toBe(false)
    expect(buildSpaceSlugIndex([second, first]).has('retired')).toBe(false)
    expect(resolveSpaceRecord([first, second], 'retired')).toBeNull()
    expect(resolveSpaceRecord([second, first], 'retired')).toBeNull()
    expect(resolvableSpaceAliases([first, second], first.id)).toEqual([])
    expect(resolvableSpaceAliases([first, second], second.id)).toEqual([])
  })

  it('exposes only aliases that still resolve to their owner', () => {
    const shadowed = space('old-owner', 'archive', ['research'])
    const current = space('current-owner', 'research', ['library'])

    expect(resolvableSpaceAliases([shadowed, current], shadowed.id)).toEqual([])
    expect(resolvableSpaceAliases([shadowed, current], current.id)).toEqual(['library'])
  })

  it('prefers an exact stable id over a colliding human slug', () => {
    const byId = space('research', 'work')
    const bySlug = space('other-id', 'research')

    expect(resolveSpaceRecord([bySlug, byId], 'research')).toBe(byId)
  })

  it('returns null for an unknown reference', () => {
    expect(resolveSpaceRecord([space('space-id', 'research')], 'missing')).toBeNull()
  })
})
