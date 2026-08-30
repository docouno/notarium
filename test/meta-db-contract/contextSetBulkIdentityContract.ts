import { describe, expect, it } from 'vitest'

import type { IdentityPersistence } from '@notarium/core'

import type { ContextSetsPersistence } from '../../packages/server/src/services/metaDb/types'

export type ContextSetBulkIdentityContractFactory = () => Promise<{
  contextSets: ContextSetsPersistence
  identity: IdentityPersistence
  updateCount(): Promise<number>
  teardown(): Promise<void>
}>

export const describeContextSetBulkIdentityContract = (
  name: string,
  factory: ContextSetBulkIdentityContractFactory,
): void => {
  describe(`ContextSets bulk identity contract — ${name}`, { timeout: 15_000 }, () => {
    it('collects every conflict before rollback and updates membership exactly once', async () => {
      const fixture = await factory()

      try {
        await fixture.identity.claimMany(
          ['a', 'b'].map((id) => ({
            id,
            filePath: `${id}.md`,
            space: 'real-space',
            createdAt: null,
            materialized: true,
            deletedAt: null,
            legacyNameAliases: [],
          })),
        )
        await fixture.contextSets.createSet({
          id: 'bulk-observed',
          homeSpace: 'set-home',
          name: 'Bulk observed',
          items: [],
          createdAt: '2026-08-30T00:00:00.000Z',
        })

        const conflicted = await fixture.contextSets.addItems('bulk-observed', [
          { space: 'wrong-space', noteId: 'a' },
          { space: 'wrong-space', noteId: 'b' },
        ])

        expect(conflicted).toEqual({ set: null, added: [], conflicts: ['a', 'b'] })
        expect(await fixture.contextSets.getSet('bulk-observed')).toMatchObject({ items: [] })
        expect(await fixture.updateCount()).toBe(0)

        const applied = await fixture.contextSets.addItems('bulk-observed', [
          { space: 'real-space', noteId: 'a' },
          { space: 'real-space', noteId: 'b' },
        ])

        expect(applied).toMatchObject({ added: ['a', 'b'], conflicts: [] })
        expect(applied.set?.items.map((item) => item.noteId)).toEqual(['a', 'b'])
        expect(await fixture.updateCount()).toBe(1)

        await fixture.contextSets.addItems('bulk-observed', [
          { space: 'real-space', noteId: 'a' },
          { space: 'real-space', noteId: 'b' },
        ])
        expect(await fixture.updateCount()).toBe(1)
      } finally {
        await fixture.teardown()
      }
    })
  })
}
