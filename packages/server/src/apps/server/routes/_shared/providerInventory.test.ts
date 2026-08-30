import { describe, expect, it } from 'vitest'

import {
  PROVIDER_INVENTORY_FETCH_LIMIT,
  providerInventoryAfter,
  providerInventoryPage,
} from './providerInventory'

const values = Array.from({ length: 205 }, (_, index) => ({
  id: `id-${String(index).padStart(3, '0')}`,
  name: `Resource ${String(index).padStart(3, '0')}`,
}))
const keyOf = (value: (typeof values)[number]) => [value.name, value.id] as const

describe('provider inventory cursor', () => {
  it('walks fixed keyset pages without widening the limit', () => {
    const first = providerInventoryPage(values.slice(0, 101), values.length, keyOf)
    expect(providerInventoryAfter(first.nextCursor ?? undefined)).toEqual({
      sort: 'Resource 099',
      id: 'id-099',
    })
    const second = providerInventoryPage(values.slice(100, 201), values.length, keyOf)
    const third = providerInventoryPage(values.slice(200), values.length, keyOf)

    expect([first.items.length, second.items.length, third.items.length]).toEqual([100, 100, 5])
    expect(first.total).toBe(205)
    expect(third.nextCursor).toBeNull()
    expect(
      new Set([...first.items, ...second.items, ...third.items].map(({ id }) => id)).size,
    ).toBe(205)
  })

  it('fails closed on a malformed cursor', () => {
    expect(providerInventoryAfter('not-a-cursor')).toBe('invalid')
  })

  it('uses exactly one look-ahead row at the page boundary', () => {
    const complete = providerInventoryPage(values.slice(0, 100), 100, keyOf)
    const continued = providerInventoryPage(
      values.slice(0, PROVIDER_INVENTORY_FETCH_LIMIT),
      101,
      keyOf,
    )

    expect(complete).toMatchObject({ total: 100, nextCursor: null })
    expect(complete.items).toHaveLength(100)
    expect(continued.items).toHaveLength(100)
    expect(continued.nextCursor).not.toBeNull()
  })
})
