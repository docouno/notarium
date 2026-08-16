import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { IdentityPersistence, IdentityRecord } from '@notarium/core'

export type LegacyNameAliasesContractFactory = () => Promise<{
  /** Independent handles onto one identity table. */
  alpha: IdentityPersistence
  beta: IdentityPersistence
  /** Install a value the public port deliberately cannot produce. */
  corruptAliases: (id: string, raw: string) => Promise<void>
  teardown?: () => Promise<void>
}>

const AT = '2026-08-14T12:00:00.000Z'

const record = (over: Partial<IdentityRecord> & Pick<IdentityRecord, 'id'>): IdentityRecord => ({
  filePath: 'note.md',
  space: 'alpha',
  createdAt: '2020-01-02T03:04:05.000Z',
  materialized: true,
  deletedAt: null,
  addressRevision: 0,
  legacyNameAliases: [],
  ...over,
})

export const describeLegacyNameAliasesContract = (
  name: string,
  factory: LegacyNameAliasesContractFactory,
): void => {
  describe(`legacy identity aliases — ${name}`, { timeout: 15_000 }, () => {
    let alpha: IdentityPersistence
    let beta: IdentityPersistence
    let corruptAliases: (id: string, raw: string) => Promise<void>
    let teardown: (() => Promise<void>) | undefined

    beforeEach(async () => {
      ;({ alpha, beta, corruptAliases, teardown } = await factory())
      await alpha.init()
      await beta.init()
    })

    afterEach(async () => {
      await teardown?.()
    })

    it('canonicalizes valid arrays, rejects a mixed payload whole, and returns copies', async () => {
      const input = ['zeta', 'alpha', 'zeta']
      const [claimed] = await alpha.claimMany([
        record({ id: 'canonical-id', legacyNameAliases: input }),
      ])

      expect(claimed).toEqual({
        id: 'canonical-id',
        status: 'claimed',
        legacyNameAliases: ['alpha', 'zeta'],
      })
      input.push('later')
      if (claimed.status === 'claimed') {
        ;(claimed.legacyNameAliases as string[]).push('mutated-outcome')
      }
      expect((await beta.findById!('canonical-id'))?.legacyNameAliases).toEqual(['alpha', 'zeta'])

      const loaded = await beta.loadAll('alpha')
      ;(loaded[0]!.legacyNameAliases as string[]).push('mutated-load')
      expect((await alpha.findById!('canonical-id'))?.legacyNameAliases).toEqual(['alpha', 'zeta'])

      await corruptAliases('canonical-id', '["alpha",42]')
      expect((await alpha.findById!('canonical-id'))?.legacyNameAliases).toEqual([])
      await corruptAliases('canonical-id', '{broken')
      expect((await alpha.findById!('canonical-id'))?.legacyNameAliases).toEqual([])
    })

    it('atomically unions independent session additions in either arrival order', async () => {
      await alpha.claimMany([record({ id: 'union-id' })])
      const [left, right] = await Promise.all([
        alpha.mergeLegacyNameAlias({ id: 'union-id', space: 'alpha', alias: 'zeta' }),
        beta.mergeLegacyNameAlias({ id: 'union-id', space: 'alpha', alias: 'alpha' }),
      ])

      expect(left.status).toBe('merged')
      expect(right.status).toBe('merged')
      expect((await alpha.findById!('union-id'))?.legacyNameAliases).toEqual(['alpha', 'zeta'])

      await Promise.all([
        beta.mergeLegacyNameAlias({ id: 'union-id', space: 'alpha', alias: 'bravo' }),
        alpha.mergeLegacyNameAlias({ id: 'union-id', space: 'alpha', alias: 'charlie' }),
      ])
      expect((await beta.findById!('union-id'))?.legacyNameAliases).toEqual([
        'alpha',
        'bravo',
        'charlie',
        'zeta',
      ])
    })

    it('changes only the alias column and refuses absent or foreign rows', async () => {
      await alpha.claimMany([
        record({
          id: 'owned-id',
          filePath: 'before.md',
          createdAt: '2019-04-03T02:01:00.000Z',
          materialized: false,
          deletedAt: AT,
        }),
      ])
      const before = await alpha.findById!('owned-id')

      await expect(
        beta.mergeLegacyNameAlias({ id: 'owned-id', space: 'beta', alias: 'foreign' }),
      ).resolves.toEqual({ status: 'not-owned' })
      await expect(
        alpha.mergeLegacyNameAlias({ id: 'missing-id', space: 'alpha', alias: 'missing' }),
      ).resolves.toEqual({ status: 'not-owned' })
      expect(await alpha.findById!('missing-id')).toBeNull()

      await expect(
        alpha.mergeLegacyNameAlias({ id: 'owned-id', space: 'alpha', alias: 'historic' }),
      ).resolves.toEqual({ status: 'merged', id: 'owned-id', legacyNameAliases: ['historic'] })
      expect(await beta.findById!('owned-id')).toEqual({
        ...before,
        legacyNameAliases: ['historic'],
      })
    })

    it('never loses durable aliases to stale claim or settlement snapshots', async () => {
      await alpha.claimMany([
        record({ id: 'durable-id', filePath: 'old.md', legacyNameAliases: ['durable'] }),
      ])
      const [claimed] = await beta.claimMany([
        record({ id: 'durable-id', filePath: 'new.md', legacyNameAliases: [] }),
      ])

      expect(claimed).toEqual({
        id: 'durable-id',
        status: 'claimed',
        legacyNameAliases: ['durable'],
      })
      expect(await alpha.findById!('durable-id')).toMatchObject({
        filePath: 'new.md',
        legacyNameAliases: ['durable'],
      })

      const settled = await beta.settleFileClaim({
        space: 'alpha',
        filePath: 'new.md',
        current: record({
          id: 'claimant-id',
          filePath: 'new.md',
          legacyNameAliases: ['claimant'],
        }),
        observedId: 'durable-id',
        at: AT,
      })
      expect(settled).toMatchObject({
        status: 'accepted',
        record: { legacyNameAliases: ['claimant', 'durable'] },
      })
      expect((await alpha.findById!('durable-id'))?.legacyNameAliases).toEqual([
        'claimant',
        'durable',
      ])
    })

    it('carries durable claimant aliases through settlement and redirects a late ACK', async () => {
      await alpha.claimMany([
        record({
          id: 'provisional-id',
          filePath: 'handoff.md',
          legacyNameAliases: ['durable-provisional'],
        }),
        record({
          id: 'durable-id',
          filePath: 'former.md',
          deletedAt: AT,
          legacyNameAliases: ['durable-owner'],
        }),
      ])
      const settled = await beta.settleFileClaim({
        space: 'alpha',
        filePath: 'handoff.md',
        current: record({ id: 'provisional-id', filePath: 'handoff.md' }),
        observedId: 'durable-id',
        at: AT,
      })

      expect(settled).toMatchObject({
        status: 'accepted',
        retiredId: 'provisional-id',
        record: {
          id: 'durable-id',
          legacyNameAliases: ['durable-owner', 'durable-provisional'],
        },
      })
      await expect(
        alpha.mergeLegacyNameAlias({
          id: 'provisional-id',
          space: 'alpha',
          alias: 'late-provisional',
        }),
      ).resolves.toEqual({
        status: 'merged',
        id: 'durable-id',
        legacyNameAliases: ['durable-owner', 'durable-provisional', 'late-provisional'],
      })
      await expect(beta.findById!('durable-id')).resolves.toMatchObject({
        deletedAt: null,
        filePath: 'handoff.md',
        legacyNameAliases: ['durable-owner', 'durable-provisional', 'late-provisional'],
      })
    })

    it('does not treat ordinary tombstone path reuse as settlement lineage', async () => {
      await alpha.claimMany([record({ id: 'retired-id', filePath: 'reused.md' })])
      await alpha.claimMany([record({ id: 'retired-id', filePath: 'reused.md', deletedAt: AT })])
      await beta.claimMany([record({ id: 'unrelated-id', filePath: 'reused.md' })])

      await expect(
        alpha.mergeLegacyNameAlias({
          id: 'retired-id',
          space: 'alpha',
          alias: 'retired-name',
        }),
      ).resolves.toEqual({
        status: 'merged',
        id: 'retired-id',
        legacyNameAliases: ['retired-name'],
      })

      await expect(alpha.findById!('retired-id')).resolves.toMatchObject({
        legacyNameAliases: ['retired-name'],
      })
      await expect(beta.findById!('unrelated-id')).resolves.toMatchObject({
        legacyNameAliases: [],
      })
    })

    it('clears outgoing lineage when a retired identity is resurrected', async () => {
      await alpha.claimMany([record({ id: 'previous-id', filePath: 'returned.md' })])
      const forward = await alpha.settleFileClaim({
        space: 'alpha',
        filePath: 'returned.md',
        current: record({ id: 'previous-id', filePath: 'returned.md' }),
        observedId: 'successor-id',
        at: AT,
      })

      expect(forward).toMatchObject({ status: 'accepted', retiredId: 'previous-id' })
      const reverse = await alpha.settleFileClaim({
        space: 'alpha',
        filePath: 'returned.md',
        current: record({ id: 'successor-id', filePath: 'returned.md' }),
        observedId: 'previous-id',
        at: AT,
      })

      expect(reverse).toMatchObject({ status: 'accepted', retiredId: 'successor-id' })
      await expect(
        alpha.mergeLegacyNameAlias({
          id: 'previous-id',
          space: 'alpha',
          alias: 'returned-name',
        }),
      ).resolves.toEqual({
        status: 'merged',
        id: 'previous-id',
        legacyNameAliases: ['returned-name'],
      })
    })
  })
}
