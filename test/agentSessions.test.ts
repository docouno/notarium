import { describe, expect, it } from 'vitest'
import { AGENT_SESSION_STATE } from '@notarium/contract'

import {
  createAgentSessions,
  NoSuchAgentSessionError,
} from '../packages/server/src/services/agentSessions'
import { InMemoryAgentSessions } from './fake-server/agentSessions'

const ids = (...values: string[]): (() => string) => {
  const remaining = [...values]

  return () => {
    const id = remaining.shift()

    if (!id) {
      throw new Error('test id queue exhausted')
    }

    return id
  }
}

describe('agent sessions service', () => {
  it('nudges the owner after committed session mutations, never on misses', async () => {
    const persistence = new InMemoryAgentSessions()
    const changed: string[] = []
    const sessions = createAgentSessions({
      persistence,
      mintId: ids('ses_aaaaaaaaaaaa'),
      onChange: (owner) => changed.push(owner),
    })

    expect(await sessions.attach('alice')).toBeNull()
    await expect(sessions.attach('alice', 'ses_missing00000')).rejects.toBeInstanceOf(
      NoSuchAgentSessionError,
    )
    expect(changed).toEqual([])

    const started = await sessions.start('alice', { name: 'work' }, 'unused')
    await sessions.attach('alice', started.session?.record.id)
    await sessions.setRole(started.session!, {
      name: 'grooming',
      locator: {
        source: 'owned',
        kind: 'role',
        packageId: 'AbCdefGhij_1',
        location: { scope: 'personal', spaceId: 'personal-a' },
      },
      contextProjectId: null,
    })

    expect(changed).toEqual(['alice', 'alice', 'alice'])
  })

  it('nudges every owner whose expired sessions are pruned before an early exit', async () => {
    const persistence = new InMemoryAgentSessions()
    persistence.seed([
      {
        id: 'ses_aliceold000',
        owner: 'alice',
        name: 'old work',
        named: true,
        parentId: null,
        createdAt: '2026-06-01T00:00:00.000Z',
        lastSeenAt: '2026-06-01T00:00:00.000Z',
        calls: 1,
        role: null,
        roleLocator: null,
        roleContextProjectId: null,
        projectId: null,
      },
    ])
    const changed: string[] = []
    const sessions = createAgentSessions({
      persistence,
      now: () => new Date('2026-08-04T12:00:00.000Z'),
      onChange: (owner) => changed.push(owner),
    })

    await expect(
      sessions.start('bob', { id: 'ses_missing00000' }, 'unused'),
    ).rejects.toBeInstanceOf(NoSuchAgentSessionError)

    expect(persistence.snapshot()).toEqual([])
    expect(changed).toEqual(['alice'])
  })

  it('attaches explicitly or only to exactly one active owner session', async () => {
    const persistence = new InMemoryAgentSessions()
    let now = new Date('2026-08-04T12:00:00.000Z')
    const sessions = createAgentSessions({
      persistence,
      now: () => now,
      mintId: ids('ses_aaaaaaaaaaaa', 'ses_bbbbbbbbbbbb', 'ses_cccccccccccc'),
    })

    expect(await sessions.attach('alice')).toBeNull()
    const first = await sessions.start('alice', { name: 'one' }, 'unused')
    expect(await sessions.attach('alice')).toMatchObject({
      attach: 'inferred',
      record: { id: 'ses_aaaaaaaaaaaa', calls: 2 },
    })
    expect(await sessions.attach('bob')).toBeNull()
    await expect(sessions.attach('bob', 'ses_aaaaaaaaaaaa')).rejects.toBeInstanceOf(
      NoSuchAgentSessionError,
    )

    await sessions.start('alice', { name: 'two' }, 'unused')
    expect(await sessions.attach('alice')).toBeNull()
    now = new Date('2026-08-04T13:00:00.000Z')
    expect(await sessions.attach('alice', first.session?.record.id)).toMatchObject({
      attach: 'declared',
      record: { id: 'ses_aaaaaaaaaaaa', lastSeenAt: now.toISOString(), calls: 3 },
    })
  })

  it('previews explicit, named, and inferred starts without touching the episode', async () => {
    const persistence = new InMemoryAgentSessions()
    const changed: string[] = []
    const sessions = createAgentSessions({
      persistence,
      now: () => new Date('2026-08-04T12:00:00.000Z'),
      mintId: ids('ses_aaaaaaaaaaaa'),
      onChange: (owner) => changed.push(owner),
    })
    const started = await sessions.start('alice', { name: 'work' }, 'unused', 'project-a')
    const id = started.session!.record.id
    const before = persistence.snapshot()[0]

    await expect(sessions.preview('alice', { id })).resolves.toMatchObject({
      id,
      projectId: 'project-a',
    })
    await expect(sessions.preview('alice', { name: 'work' })).resolves.toMatchObject({ id })
    await expect(sessions.preview('alice', undefined)).resolves.toMatchObject({ id })
    await expect(sessions.preview('bob', { id })).resolves.toBeNull()
    await expect(sessions.read('alice', id)).resolves.toMatchObject({
      attach: 'declared',
      record: { id, projectId: 'project-a' },
    })
    await expect(sessions.read('alice')).resolves.toMatchObject({
      attach: 'inferred',
      record: { id, projectId: 'project-a' },
    })
    await expect(sessions.read('bob', id)).rejects.toBeInstanceOf(NoSuchAgentSessionError)
    expect(persistence.snapshot()[0]).toEqual(before)
    expect(changed).toEqual(['alice'])
  })

  it('linearizes concurrent unaddressed first starts into one episode', async () => {
    const persistence = new InMemoryAgentSessions()
    const sessions = createAgentSessions({
      persistence,
      now: () => new Date('2026-08-04T12:00:00.000Z'),
      mintId: ids('ses_aaaaaaaaaaaa', 'ses_bbbbbbbbbbbb'),
    })

    const starts = await Promise.all([
      sessions.start('alice', undefined, 'personal · now'),
      sessions.start('alice', undefined, 'personal · now'),
    ])

    expect(starts.map(({ session }) => session?.state).sort()).toEqual([
      AGENT_SESSION_STATE.new,
      AGENT_SESSION_STATE.resumed,
    ])
    expect(new Set(starts.map(({ session }) => session?.record.id))).toEqual(
      new Set(['ses_aaaaaaaaaaaa']),
    )
    expect(persistence.snapshot()).toEqual([
      expect.objectContaining({ id: 'ses_aaaaaaaaaaaa', calls: 2, parentId: null }),
    ])
  })

  it('creates, resumes, forks and disambiguates by the documented rules', async () => {
    const persistence = new InMemoryAgentSessions()
    let now = new Date('2026-08-04T12:00:00.000Z')
    const sessions = createAgentSessions({
      persistence,
      now: () => now,
      mintId: ids(
        'ses_aaaaaaaaaaaa',
        'ses_bbbbbbbbbbbb',
        'ses_cccccccccccc',
        'ses_dddddddddddd',
        'ses_eeeeeeeeeeee',
        'ses_ffffffffffff',
        'ses_gggggggggggg',
        'ses_hhhhhhhhhhhh',
      ),
    })

    const automatic = await sessions.start('alice', undefined, 'personal · now')
    expect(automatic.session).toMatchObject({
      state: AGENT_SESSION_STATE.new,
      attach: 'inferred',
      record: { id: 'ses_aaaaaaaaaaaa', name: 'personal · now', named: false, calls: 1 },
    })
    expect(await sessions.start('alice', undefined, 'unused')).toMatchObject({
      session: {
        state: AGENT_SESSION_STATE.resumed,
        attach: 'inferred',
        record: { id: 'ses_aaaaaaaaaaaa', calls: 2 },
      },
    })

    const named = await sessions.start('alice', { name: 'work' }, 'unused')
    expect(named.session).toMatchObject({
      state: AGENT_SESSION_STATE.new,
      record: { id: 'ses_cccccccccccc', named: true, parentId: null },
    })
    await sessions.setRole(named.session!, {
      name: 'grooming',
      locator: {
        source: 'owned',
        kind: 'role',
        packageId: 'AbCdefGhij_1',
        location: { scope: 'personal', spaceId: 'personal-a' },
      },
      contextProjectId: null,
    })
    const fork = await sessions.start('alice', { name: 'work' }, 'unused')
    expect(fork.session).toMatchObject({
      state: AGENT_SESSION_STATE.forked,
      record: {
        id: 'ses_dddddddddddd',
        parentId: 'ses_cccccccccccc',
        name: 'work',
        role: 'grooming',
        roleLocator: {
          source: 'owned',
          kind: 'role',
          packageId: 'AbCdefGhij_1',
          location: { scope: 'personal', spaceId: 'personal-a' },
        },
        roleContextProjectId: null,
        projectId: null,
      },
    })
    const ambiguous = await sessions.start('alice', { name: 'work' }, 'unused')
    expect(ambiguous.session).toBeUndefined()
    expect(ambiguous.recentSessions?.map(({ id }) => id)).toEqual([
      'ses_dddddddddddd',
      'ses_cccccccccccc',
    ])

    const freshAmidAmbiguity = await sessions.start('alice', undefined, 'fresh automatic')
    expect(freshAmidAmbiguity.session).toMatchObject({
      state: AGENT_SESSION_STATE.new,
      record: { id: 'ses_ffffffffffff', named: false },
    })
    expect(freshAmidAmbiguity.recentSessions?.map(({ id }) => id)).not.toContain('ses_eeeeeeeeeeee')

    await sessions.start('bob', { name: 'sleeping' }, 'unused')
    now = new Date('2026-08-04T15:00:00.000Z')
    expect(await sessions.start('bob', { name: 'sleeping' }, 'unused')).toMatchObject({
      session: {
        state: AGENT_SESSION_STATE.resumed,
        record: { id: 'ses_gggggggggggg', calls: 2, parentId: null },
      },
    })
  })

  it('persists a project hint only from start and preserves it across resume and fork', async () => {
    const persistence = new InMemoryAgentSessions()
    let now = new Date('2026-08-04T12:00:00.000Z')
    const sessions = createAgentSessions({
      persistence,
      now: () => now,
      mintId: ids('ses_aaaaaaaaaaaa', 'ses_bbbbbbbbbbbb', 'ses_cccccccccccc'),
    })

    const started = await sessions.start('alice', { name: 'work' }, 'unused', 'project-a')
    expect(started.session?.record.projectId).toBe('project-a')

    now = new Date('2026-08-04T15:00:00.000Z')
    const resumed = await sessions.start('alice', { name: 'work' }, 'unused')
    expect(resumed.session?.record.projectId).toBe('project-a')

    now = new Date('2026-08-04T15:01:00.000Z')
    const forked = await sessions.start('alice', { name: 'work' }, 'unused', 'project-b')
    expect(forked.session?.record).toMatchObject({
      parentId: resumed.session?.record.id,
      projectId: 'project-b',
    })

    const attached = await sessions.attach('alice', forked.session?.record.id)
    expect(attached?.record.projectId).toBe('project-b')
  })

  it('lets a second unaddressed start replace the one active owner episode hint', async () => {
    const persistence = new InMemoryAgentSessions()
    const sessions = createAgentSessions({
      persistence,
      mintId: ids('ses_aaaaaaaaaaaa', 'ses_bbbbbbbbbbbb'),
    })

    const first = await sessions.start('alice', undefined, 'first', 'project-a')
    const second = await sessions.start('alice', undefined, 'second', 'project-b')

    expect(second.session?.record).toMatchObject({
      id: first.session?.record.id,
      projectId: 'project-b',
    })
    expect(persistence.snapshot()).toHaveLength(1)
  })

  it('expires an id at the 30-day retention boundary', async () => {
    const persistence = new InMemoryAgentSessions()
    let now = new Date('2026-07-01T00:00:00.000Z')
    const sessions = createAgentSessions({
      persistence,
      now: () => now,
      mintId: ids('ses_aaaaaaaaaaaa'),
    })
    await sessions.start('alice', { name: 'old' }, 'unused')

    now = new Date('2026-07-31T00:00:00.001Z')
    await expect(
      sessions.start('alice', { id: 'ses_aaaaaaaaaaaa' }, 'unused'),
    ).rejects.toBeInstanceOf(NoSuchAgentSessionError)
  })

  it('returns retained matching sessions when same-name ambiguity is older than recent history', async () => {
    const persistence = new InMemoryAgentSessions()
    const now = new Date('2026-08-04T12:00:00.000Z')
    persistence.seed([
      {
        id: 'ses_aaaaaaaaaaaa',
        owner: 'alice',
        name: 'old work',
        named: true,
        parentId: null,
        createdAt: '2026-07-10T00:00:00.000Z',
        lastSeenAt: '2026-07-10T00:00:00.000Z',
        calls: 1,
        role: null,
        roleLocator: null,
        roleContextProjectId: null,
        projectId: null,
      },
      {
        id: 'ses_bbbbbbbbbbbb',
        owner: 'alice',
        name: 'old work',
        named: true,
        parentId: null,
        createdAt: '2026-07-11T00:00:00.000Z',
        lastSeenAt: '2026-07-11T00:00:00.000Z',
        calls: 1,
        role: null,
        roleLocator: null,
        roleContextProjectId: null,
        projectId: null,
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `ses_recent0000${index}`,
        owner: 'alice',
        name: `recent ${index}`,
        named: true,
        parentId: null,
        createdAt: `2026-08-04T0${index}:00:00.000Z`,
        lastSeenAt: `2026-08-04T0${index}:00:00.000Z`,
        calls: 1,
        role: null,
        roleLocator: null,
        roleContextProjectId: null,
        projectId: null,
      })),
    ])
    const sessions = createAgentSessions({
      persistence,
      now: () => now,
      mintId: ids('ses_cccccccccccc'),
    })

    const result = await sessions.start('alice', { name: 'old work' }, 'unused')
    expect(result.session).toBeUndefined()
    expect(result.recentSessions?.map(({ id }) => id)).toEqual([
      'ses_bbbbbbbbbbbb',
      'ses_aaaaaaaaaaaa',
    ])
  })

  it('validates parent ownership and topology in seeds', () => {
    const persistence = new InMemoryAgentSessions()

    expect(() =>
      persistence.seed([
        {
          id: 'ses_child000000',
          owner: 'alice',
          name: 'work',
          named: true,
          parentId: 'ses_parent00000',
          createdAt: '2026-08-04T12:00:00.000Z',
          lastSeenAt: '2026-08-04T12:00:00.000Z',
          calls: 1,
          role: null,
          roleLocator: null,
          roleContextProjectId: null,
          projectId: null,
        },
        {
          id: 'ses_parent00000',
          owner: 'bob',
          name: 'work',
          named: true,
          parentId: null,
          createdAt: '2026-08-04T12:00:00.000Z',
          lastSeenAt: '2026-08-04T12:00:00.000Z',
          calls: 1,
          role: null,
          roleLocator: null,
          roleContextProjectId: null,
          projectId: null,
        },
      ]),
    ).toThrow(/parent agent session/)
  })
})
