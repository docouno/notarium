import { describe, expect, it } from 'vitest'

import type { ContextSetsPersistence } from '../../packages/server/src/services/metaDb/types'

export type ContextSetsContractFactory = () => Promise<{
  persistence: ContextSetsPersistence
  teardown?: () => Promise<void>
}>

const create = (persistence: ContextSetsPersistence, id: string) =>
  persistence.createSet({
    id,
    homeSpace: 'space-home',
    name: id,
    items: [],
    createdAt: '2026-08-29T00:00:00.000Z',
  })

export const describeContextSetsContract = (
  name: string,
  factory: ContextSetsContractFactory,
): void => {
  describe(`ContextSetsPersistence contract — ${name}`, { timeout: 15_000 }, () => {
    it('bulk-adds once with stable order, dedup and idempotency', async () => {
      const { persistence, teardown } = await factory()

      try {
        await create(persistence, 'set-bulk')
        const first = await persistence.addItems('set-bulk', [
          { space: 'space-a', noteId: 'a' },
          { space: 'space-b', noteId: 'b' },
          { space: 'space-a', noteId: 'a' },
        ])
        expect(first).toMatchObject({ added: ['a', 'b'], conflicts: [] })
        expect(first.set?.items).toEqual([
          { space: 'space-a', noteId: 'a' },
          { space: 'space-b', noteId: 'b' },
        ])
        const second = await persistence.addItems('set-bulk', [{ space: 'space-b', noteId: 'b' }])
        expect(second).toMatchObject({ added: [], conflicts: [] })
        expect(second.set?.items).toHaveLength(2)
      } finally {
        await teardown?.()
      }
    })

    it('does not lose concurrent single/bulk/remove updates and reports a missing set', async () => {
      const { persistence, teardown } = await factory()

      try {
        await create(persistence, 'set-race')
        await persistence.addItem('set-race', { space: 'space-old', noteId: 'old' })
        await Promise.all([
          persistence.addItems('set-race', [
            { space: 'space-a', noteId: 'a' },
            { space: 'space-b', noteId: 'b' },
          ]),
          persistence.addItem('set-race', { space: 'space-c', noteId: 'c' }),
          persistence.removeItem('set-race', { space: 'space-old', noteId: 'old' }),
        ])
        expect(
          [
            ...((await persistence.getSet('set-race'))?.items.map((item) => item.noteId) ?? []),
          ].sort(),
        ).toEqual(['a', 'b', 'c'])
        await expect(
          persistence.addItems('missing', [{ space: 'space-a', noteId: 'a' }]),
        ).resolves.toEqual({ set: null, added: [], conflicts: [] })
      } finally {
        await teardown?.()
      }
    })
  })
}
