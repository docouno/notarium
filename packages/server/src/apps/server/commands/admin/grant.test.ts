import { describe, expect, it, vi } from 'vitest'

import type { SpaceRecord, UserRecord } from '../../../../services/metaDb'
import { grantSpaceMember } from './grant'

const user: UserRecord = {
  username: 'recovery',
  displayName: 'Recovery User',
  passwordHash: null,
  admin: false,
  disabledAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  personalSpace: null,
}

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

const harness = (records: SpaceRecord[], existingUser: UserRecord | null = user) => ({
  auth: {
    getUser: vi.fn(async () => existingUser),
  },
  spaces: { list: vi.fn(async () => records) },
  grantMemberToActiveSpace: vi.fn(async (spaceId: string) => {
    const record = records.find((candidate) => candidate.id === spaceId)

    if (!record) {
      return { status: 'missing' as const }
    }

    return record.archivedAt
      ? { status: 'archived' as const, space: record }
      : { status: 'granted' as const, space: record }
  }),
  now: () => new Date('2026-08-02T12:00:00.000Z'),
})

describe('admin grant', () => {
  it.each([
    ['current slug', 'research'],
    ['past alias', 'old-research'],
    ['stable id', 'space-id'],
  ])('resolves %s and persists only the stable id', async (_label, reference) => {
    const record = space('space-id', 'research', ['old-research'])
    const deps = harness([record])

    await expect(
      grantSpaceMember(deps, { username: user.username, space: reference, role: 'reader' }),
    ).resolves.toBe(record)
    expect(deps.grantMemberToActiveSpace).toHaveBeenCalledWith(
      'space-id',
      user.username,
      'reader',
      '2026-08-02T12:00:00.000Z',
    )
  })

  it('rejects an unknown space without writing a membership', async () => {
    const deps = harness([space('space-id', 'research')])

    await expect(
      grantSpaceMember(deps, { username: user.username, space: 'missing', role: 'owner' }),
    ).rejects.toThrow('no such space: missing')
    expect(deps.grantMemberToActiveSpace).not.toHaveBeenCalled()
  })

  it('rejects an alias shared by multiple spaces without writing a membership', async () => {
    const deps = harness([
      space('first-id', 'first', ['retired']),
      space('second-id', 'second', ['retired']),
    ])

    await expect(
      grantSpaceMember(deps, { username: user.username, space: 'retired', role: 'owner' }),
    ).rejects.toThrow('no such space: retired')
    expect(deps.grantMemberToActiveSpace).not.toHaveBeenCalled()
  })

  it.each(['scratch', 'old-scratch', 'archived-id'])(
    'rejects archived reference %s without writing a membership',
    async (reference) => {
      const deps = harness([
        space('archived-id', 'scratch', ['old-scratch'], '2026-08-01T00:00:00.000Z'),
      ])

      await expect(
        grantSpaceMember(deps, { username: user.username, space: reference, role: 'writer' }),
      ).rejects.toThrow('space is archived: scratch')
      expect(deps.grantMemberToActiveSpace).toHaveBeenCalledOnce()
    },
  )

  it('keeps the existing no-such-user check ahead of space resolution', async () => {
    const deps = harness([space('space-id', 'research')], null)

    await expect(
      grantSpaceMember(deps, { username: 'missing', space: 'research', role: 'reader' }),
    ).rejects.toThrow('no such user: missing')
    expect(deps.spaces.list).not.toHaveBeenCalled()
    expect(deps.grantMemberToActiveSpace).not.toHaveBeenCalled()
  })

  it('fails if the resolved space is purged before the atomic write', async () => {
    const deps = harness([space('space-id', 'research')])
    deps.grantMemberToActiveSpace.mockResolvedValueOnce({ status: 'missing' })

    await expect(
      grantSpaceMember(deps, { username: user.username, space: 'research', role: 'owner' }),
    ).rejects.toThrow('no such space: research')
  })

  it('uses the atomically re-read current slug when a concurrent rename wins first', async () => {
    const before = space('space-id', 'research')
    const after = space('space-id', 'library', ['research'])
    const deps = harness([before])
    deps.grantMemberToActiveSpace.mockResolvedValueOnce({ status: 'granted', space: after })

    await expect(
      grantSpaceMember(deps, { username: user.username, space: 'research', role: 'reader' }),
    ).resolves.toBe(after)
  })
})
