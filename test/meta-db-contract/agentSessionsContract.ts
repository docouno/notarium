import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type {
  AgentSessionRecord,
  AgentSessionsPersistence,
} from '../../packages/server/src/services/metaDb/types'

export type AgentSessionsContractFactory = () => Promise<{
  persistence: AgentSessionsPersistence
  teardown?: () => Promise<void>
}>

const row = (
  id: string,
  owner: string,
  lastSeenAt: string,
  over: Partial<AgentSessionRecord> = {},
): AgentSessionRecord => ({
  id,
  owner,
  name: 'work',
  named: true,
  parentId: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  lastSeenAt,
  calls: 1,
  ...over,
})

export const describeAgentSessionsContract = (
  name: string,
  factory: AgentSessionsContractFactory,
): void => {
  describe(`AgentSessionsPersistence contract — ${name}`, { timeout: 15_000 }, () => {
    let persistence: AgentSessionsPersistence
    let teardown: (() => Promise<void>) | undefined

    beforeEach(async () => {
      ;({ persistence, teardown } = await factory())
    })

    afterEach(async () => {
      await teardown?.()
    })

    it('isolates owners, preserves the fork chain, and returns bounded matching ambiguity', async () => {
      await persistence.insert(
        row('ses_aaaaaaaaaaaa', 'alice', '2026-08-04T09:00:00.000Z', { name: 'same' }),
      )
      await persistence.insert(
        row('ses_bbbbbbbbbbbb', 'alice', '2026-08-04T10:00:00.000Z', {
          name: 'same',
          parentId: 'ses_aaaaaaaaaaaa',
          calls: 3,
        }),
      )
      await persistence.insert(
        row('ses_cccccccccccc', 'bob', '2026-08-04T11:00:00.000Z', { name: 'same' }),
      )

      expect(
        await persistence.startNamed(
          row('ses_dddddddddddd', 'alice', '2026-08-04T12:00:00.000Z', { name: 'same' }),
          '2026-08-04T10:30:00.000Z',
          '2026-08-01T00:00:00.000Z',
          10,
        ),
      ).toEqual({
        kind: 'ambiguous',
        matches: [
          expect.objectContaining({ id: 'ses_bbbbbbbbbbbb', parentId: 'ses_aaaaaaaaaaaa' }),
          expect.objectContaining({ id: 'ses_aaaaaaaaaaaa' }),
        ],
      })
      expect(await persistence.listRecent('alice', '2026-08-01T00:00:00.000Z', 1)).toEqual([
        expect.objectContaining({ id: 'ses_bbbbbbbbbbbb' }),
      ])
      expect(await persistence.listRecent('bob', '2026-08-01T00:00:00.000Z', 10)).toEqual([
        expect.objectContaining({ id: 'ses_cccccccccccc' }),
      ])
    })

    it('rejects a parent owned by another principal', async () => {
      await persistence.insert(row('ses_aaaaaaaaaaaa', 'alice', '2026-08-04T09:00:00.000Z'))

      await expect(
        persistence.insert(
          row('ses_bbbbbbbbbbbb', 'bob', '2026-08-04T10:00:00.000Z', {
            parentId: 'ses_aaaaaaaaaaaa',
          }),
        ),
      ).rejects.toThrow(/same-owner parent|parent agent session/)
    })

    it('touches only a retained owner session, increments calls, and never regresses time', async () => {
      await persistence.insert(row('ses_aaaaaaaaaaaa', 'alice', '2026-08-04T10:00:00.000Z'))

      await expect(
        persistence.touch(
          'bob',
          'ses_aaaaaaaaaaaa',
          '2026-08-04T11:00:00.000Z',
          '2026-07-01T00:00:00.000Z',
        ),
      ).resolves.toBeNull()
      await expect(
        persistence.touch(
          'alice',
          'ses_aaaaaaaaaaaa',
          '2026-08-04T09:00:00.000Z',
          '2026-07-01T00:00:00.000Z',
        ),
      ).resolves.toMatchObject({ lastSeenAt: '2026-08-04T10:00:00.000Z', calls: 2 })
      await expect(
        persistence.touch(
          'alice',
          'ses_aaaaaaaaaaaa',
          '2026-08-04T12:00:00.000Z',
          '2026-08-04T10:00:00.001Z',
        ),
      ).resolves.toBeNull()
    })

    it('atomically infers and touches exactly one active session, never zero or two', async () => {
      expect(
        await persistence.inferActiveAndTouch(
          'alice',
          '2026-08-04T08:00:00.000Z',
          '2026-08-04T10:00:00.000Z',
        ),
      ).toBeNull()

      await persistence.insert(row('ses_aaaaaaaaaaaa', 'alice', '2026-08-04T09:00:00.000Z'))
      expect(
        await persistence.inferActiveAndTouch(
          'alice',
          '2026-08-04T08:00:00.000Z',
          '2026-08-04T10:00:00.000Z',
        ),
      ).toMatchObject({ id: 'ses_aaaaaaaaaaaa', calls: 2 })

      await persistence.insert(row('ses_bbbbbbbbbbbb', 'alice', '2026-08-04T09:30:00.000Z'))
      expect(
        await persistence.inferActiveAndTouch(
          'alice',
          '2026-08-04T08:00:00.000Z',
          '2026-08-04T11:00:00.000Z',
        ),
      ).toBeNull()
    })

    it('serializes concurrent starts of one sleeping named session into resume then fork', async () => {
      await persistence.insert(
        row('ses_aaaaaaaaaaaa', 'alice', '2026-08-04T06:00:00.000Z', { name: 'same' }),
      )

      const results = await Promise.all([
        persistence.startNamed(
          row('ses_bbbbbbbbbbbb', 'alice', '2026-08-04T12:00:00.000Z', { name: 'same' }),
          '2026-08-04T10:00:00.000Z',
          '2026-07-05T00:00:00.000Z',
          10,
        ),
        persistence.startNamed(
          row('ses_cccccccccccc', 'alice', '2026-08-04T12:00:00.000Z', { name: 'same' }),
          '2026-08-04T10:00:00.000Z',
          '2026-07-05T00:00:00.000Z',
          10,
        ),
      ])

      expect(results.map(({ kind }) => kind).sort()).toEqual(['forked', 'resumed'])
      const forked = results.find((result) => result.kind === 'forked')
      expect(forked).toMatchObject({ record: { parentId: 'ses_aaaaaaaaaaaa', calls: 1 } })
      expect(await persistence.listRecent('alice', '2026-07-05T00:00:00.000Z', 10)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'ses_aaaaaaaaaaaa', calls: 2 }),
          expect.objectContaining({ parentId: 'ses_aaaaaaaaaaaa', calls: 1 }),
        ]),
      )
    })

    it('serializes concurrent first starts into one root and one fork', async () => {
      const results = await Promise.all([
        persistence.startNamed(
          row('ses_aaaaaaaaaaaa', 'alice', '2026-08-04T12:00:00.000Z', { name: 'same' }),
          '2026-08-04T10:00:00.000Z',
          '2026-07-05T00:00:00.000Z',
          10,
        ),
        persistence.startNamed(
          row('ses_bbbbbbbbbbbb', 'alice', '2026-08-04T12:00:00.000Z', { name: 'same' }),
          '2026-08-04T10:00:00.000Z',
          '2026-07-05T00:00:00.000Z',
          10,
        ),
      ])

      expect(results.map(({ kind }) => kind).sort()).toEqual(['forked', 'new'])
      const root = results.find((result) => result.kind === 'new')
      const forked = results.find((result) => result.kind === 'forked')

      if (!root || root.kind !== 'new') {
        throw new Error('missing new root outcome')
      }
      expect(forked).toMatchObject({ record: { parentId: root.record.id } })
    })

    it('prunes strictly before the boundary and nulls a surviving child parent', async () => {
      await persistence.insert(row('ses_aaaaaaaaaaaa', 'alice', '2026-07-01T00:00:00.000Z'))
      await persistence.insert(
        row('ses_bbbbbbbbbbbb', 'alice', '2026-08-01T00:00:00.000Z', {
          parentId: 'ses_aaaaaaaaaaaa',
        }),
      )
      await persistence.insert(row('ses_cccccccccccc', 'alice', '2026-07-02T00:00:00.000Z'))

      await persistence.prune('2026-07-02T00:00:00.000Z')
      expect(await persistence.listRecent('alice', '2020-01-01T00:00:00.000Z', 10)).toEqual([
        expect.objectContaining({ id: 'ses_bbbbbbbbbbbb', parentId: null }),
        expect.objectContaining({ id: 'ses_cccccccccccc' }),
      ])
    })
  })
}
