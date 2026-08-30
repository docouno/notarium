import { describe, expect, it } from 'vitest'

import type { IdentityRecord } from '@notarium/core'

import { InMemoryIdentity } from './identity'

describe('InMemoryIdentity durable read parity', () => {
  it('restores seeded settlement lineage for exact point and batch reads', async () => {
    const retired: IdentityRecord = {
      id: 'lineageold01',
      legacyNameAliases: [],
      filePath: 'lineage.md',
      space: 'alpha',
      createdAt: null,
      materialized: true,
      deletedAt: '2026-06-12T10:00:00.000Z',
      settlementSuccessorId: 'lineagenew01',
    }
    const identity = new InMemoryIdentity([
      retired,
      { ...retired, id: 'lineagenew01', deletedAt: null, settlementSuccessorId: undefined },
    ])

    await expect(identity.findById(retired.id)).resolves.toMatchObject({
      id: retired.id,
      settlementSuccessorId: 'lineagenew01',
    })
    await expect(identity.findByIds([retired.id])).resolves.toEqual([
      expect.objectContaining({ id: retired.id, settlementSuccessorId: 'lineagenew01' }),
    ])
  })
})
