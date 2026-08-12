// One executable contract for all favorites implementations. The kind-collapse rule
// moved INSIDE `add`'s transaction (#327) — a clear issued outside it targets the
// pre-canonical id — and its scope is the part no single-owner test can see: the
// same entity is favoritable by every owner, in every space, at once.

import { describe, expect, it } from 'vitest'

import type {
  FavoriteRecord,
  FavoritesPersistence,
} from '../../packages/server/src/services/metaDb/types'

export type FavoritesContractFactory = () => Promise<{
  persistence: FavoritesPersistence
  teardown?: () => Promise<void>
}>

const favorite = (over: Partial<FavoriteRecord> = {}): FavoriteRecord => ({
  owner: 'user:al',
  space: 'team',
  kind: 'folder',
  entityId: 'shared-id',
  createdAt: '2026-06-23T10:00:00.000Z',
  rank: null,
  ...over,
})

export const describeFavoritesContract = (
  name: string,
  factory: FavoritesContractFactory,
): void => {
  describe(`FavoritesPersistence contract — ${name}`, { timeout: 15_000 }, () => {
    it('collapses one entity to a single kind without reaching past its owner or space', async () => {
      const { persistence, teardown } = await factory()

      try {
        await persistence.add(favorite())
        // The same entity, favorited by a NEIGHBOUR and in another space of the same
        // owner: neither is this write's business.
        await persistence.add(favorite({ owner: 'user:bo' }))
        await persistence.add(favorite({ space: 'other' }))

        // The folder surfaced as a project: one row, the newest kind.
        await persistence.add(favorite({ kind: 'project' }))

        expect(await persistence.has('user:al', 'team', 'folder', 'shared-id')).toBe(false)
        expect(await persistence.has('user:al', 'team', 'project', 'shared-id')).toBe(true)
        expect(await persistence.has('user:bo', 'team', 'folder', 'shared-id')).toBe(true)
        expect(await persistence.has('user:al', 'other', 'folder', 'shared-id')).toBe(true)
      } finally {
        await teardown?.()
      }
    })

    it('unfavorites the entity whatever kind it is stored under, and only there', async () => {
      const { persistence, teardown } = await factory()

      try {
        await persistence.add(favorite({ kind: 'project' }))
        await persistence.add(favorite({ owner: 'user:bo', kind: 'project' }))

        // The caller unfavorites a FOLDER — the row says project, because the entity
        // has since been marked as one.
        await persistence.removeByEntity('user:al', 'team', 'shared-id')

        expect(await persistence.list('user:al', 'team')).toEqual([])
        expect(await persistence.ids('user:bo', 'team', 'project')).toEqual(['shared-id'])
      } finally {
        await teardown?.()
      }
    })
  })
}
