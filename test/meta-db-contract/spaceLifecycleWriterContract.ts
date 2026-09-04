import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SPACE_LIFECYCLE_PHASE } from '@notarium/core'

import type { MetaDb } from '../../packages/server/src/services/metaDb'

export type SpaceLifecycleWriterContractFactory = () => Promise<{
  db: MetaDb
  teardown?: () => Promise<void>
}>

export const describeSpaceLifecycleWriterContract = (
  name: string,
  factory: SpaceLifecycleWriterContractFactory,
): void => {
  describe(`space lifecycle writer contract — ${name}`, { timeout: 15_000 }, () => {
    let target: Awaited<ReturnType<SpaceLifecycleWriterContractFactory>>

    beforeEach(async () => {
      target = await factory()
      await target.db.spaces.upsert({
        id: 'space-closing',
        slug: 'closing',
        displayName: 'Closing',
        notesDir: 'closing',
        aliases: [],
        createdAt: '2026-08-11T00:00:00.000Z',
        archivedAt: null,
        archivedBy: null,
      })
      await target.db.auth.createUser({
        id: 'owner',
        username: 'owner',
        email: null,
        displayName: 'Owner',
        passwordHash: null,
        admin: false,
        disabledAt: null,
        createdAt: '2026-08-11T00:00:00.000Z',
        personalSpace: null,
      })
      await target.db.spaceLifecycle.transition({
        space: 'space-closing',
        expectedPhases: [SPACE_LIFECYCLE_PHASE.active],
        phase: SPACE_LIFECYCLE_PHASE.closing,
        changedAt: '2026-08-11T00:01:00.000Z',
      })
    })

    afterEach(async () => {
      await target.teardown?.()
    })

    it('rejects delayed space-owned producers and purge leaves no residue', async () => {
      const writes = [
        () =>
          target.db.identity.claimMany([
            {
              id: 'late-note',
              legacyNameAliases: [],
              filePath: 'late.md',
              space: 'space-closing',
              createdAt: null,
              materialized: true,
              deletedAt: null,
            },
          ]),
        () =>
          target.db.projects.upsert({
            id: 'late-project',
            space: 'space-closing',
            path: '',
            slug: 'late',
            aliases: [],
            pathAliases: [],
            displayName: 'Late',
            status: 'active',
            lastSeen: '2026-08-11T00:02:00.000Z',
            createdAt: '2026-08-11T00:02:00.000Z',
          }),
        () =>
          target.db.auth.upsertMember(
            'space-closing',
            'owner',
            'owner',
            '2026-08-11T00:02:00.000Z',
          ),
        () =>
          target.db.jobs.enqueue({
            id: 'late-job',
            space: 'space-closing',
            kind: 'export',
            principal: 'user:owner',
            createdAt: '2026-08-11T00:02:00.000Z',
          }),
        () =>
          target.db.contextSets.createSet({
            id: 'late-set',
            homeSpace: 'space-closing',
            name: 'Late',
            items: [],
            createdAt: '2026-08-11T00:02:00.000Z',
          }),
        () =>
          target.db.auth.insertPat({
            id: 'late-pat',
            userId: 'owner',
            name: 'Late',
            secretHash: 'hash',
            scope: 'read',
            spaces: ['space-closing'],
            expiresAt: null,
            lastUsedAt: null,
            revokedAt: null,
            createdAt: '2026-08-11T00:02:00.000Z',
          }),
      ]

      for (const write of writes) {
        await expect(write()).rejects.toThrow(/space lifecycle rejects/i)
      }
      await target.db.purgeSpace('space-closing')
      const cleaned = await target.db.spaceLifecycle.get('space-closing')

      await target.db.purgeSpace('space-closing')
      expect(await target.db.spaceLifecycle.get('space-closing')).toEqual(cleaned)

      expect(await target.db.identity.loadAll('space-closing')).toEqual([])
      expect(await target.db.projects.getById('late-project')).toBeNull()
      expect(await target.db.auth.grantsFor('owner')).toEqual([])
      expect(await target.db.jobs.get('late-job')).toBeNull()
      expect(await target.db.contextSets.getSet('late-set')).toBeNull()
      expect(await target.db.auth.getPat('late-pat')).toBeNull()
    })
  })
}
