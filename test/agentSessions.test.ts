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

    const started = await sessions.start('alice', { name: 'work' }, { autoName: 'unused' })
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

  it('leaves retention to the telemetry cleanup marker flow', async () => {
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
      sessions.start('bob', { id: 'ses_missing00000' }, { autoName: 'unused' }),
    ).rejects.toBeInstanceOf(NoSuchAgentSessionError)

    expect(persistence.snapshot()).toHaveLength(1)
    expect(changed).toEqual([])
  })

  it('attaches only through an explicit owner session id', async () => {
    const persistence = new InMemoryAgentSessions()
    let now = new Date('2026-08-04T12:00:00.000Z')
    const sessions = createAgentSessions({
      persistence,
      now: () => now,
      mintId: ids('ses_aaaaaaaaaaaa', 'ses_bbbbbbbbbbbb', 'ses_cccccccccccc'),
    })

    expect(await sessions.attach('alice')).toBeNull()
    const first = await sessions.start('alice', { name: 'one' }, { autoName: 'unused' })
    expect(await sessions.attach('alice')).toBeNull()
    expect(await sessions.attach('bob')).toBeNull()
    await expect(sessions.attach('bob', 'ses_aaaaaaaaaaaa')).rejects.toBeInstanceOf(
      NoSuchAgentSessionError,
    )

    await sessions.start('alice', { name: 'two' }, { autoName: 'unused' })
    expect(await sessions.attach('alice')).toBeNull()
    now = new Date('2026-08-04T13:00:00.000Z')
    expect(await sessions.attach('alice', first.session?.record.id)).toMatchObject({
      attach: 'declared',
      record: { id: 'ses_aaaaaaaaaaaa', lastSeenAt: now.toISOString(), calls: 2 },
    })
  })

  it('previews only explicit starts without touching the episode', async () => {
    const persistence = new InMemoryAgentSessions()
    const changed: string[] = []
    const sessions = createAgentSessions({
      persistence,
      now: () => new Date('2026-08-04T12:00:00.000Z'),
      mintId: ids('ses_aaaaaaaaaaaa'),
      onChange: (owner) => changed.push(owner),
    })
    const started = await sessions.start(
      'alice',
      { name: 'work' },
      { autoName: 'unused' },
      'project-a',
    )
    const id = started.session!.record.id
    const before = persistence.snapshot()[0]

    await expect(sessions.preview('alice', { id })).resolves.toMatchObject({
      id,
      projectId: 'project-a',
    })
    await expect(sessions.preview('alice', { name: 'work' })).resolves.toMatchObject({ id })
    await expect(sessions.preview('alice', undefined)).resolves.toBeNull()
    await expect(sessions.preview('bob', { id })).resolves.toBeNull()
    await expect(sessions.read('alice', id)).resolves.toMatchObject({
      attach: 'declared',
      record: { id, projectId: 'project-a' },
    })
    await expect(sessions.read('alice')).resolves.toBeNull()
    await expect(sessions.read('bob', id)).rejects.toBeInstanceOf(NoSuchAgentSessionError)
    expect(persistence.snapshot()[0]).toEqual(before)
    expect(changed).toEqual(['alice'])
  })

  it('creates distinct roots for concurrent unaddressed starts', async () => {
    const persistence = new InMemoryAgentSessions()
    const sessions = createAgentSessions({
      persistence,
      now: () => new Date('2026-08-04T12:00:00.000Z'),
      mintId: ids('ses_aaaaaaaaaaaa', 'ses_bbbbbbbbbbbb'),
    })

    const starts = await Promise.all([
      sessions.start('alice', undefined, { autoName: 'personal · now' }),
      sessions.start('alice', undefined, { autoName: 'personal · now' }),
    ])

    expect(starts.map(({ session }) => session?.state)).toEqual([
      AGENT_SESSION_STATE.new,
      AGENT_SESSION_STATE.new,
    ])
    expect(new Set(starts.map(({ session }) => session?.record.id))).toEqual(
      new Set(['ses_aaaaaaaaaaaa', 'ses_bbbbbbbbbbbb']),
    )
    expect(persistence.snapshot()).toHaveLength(2)
    expect(persistence.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'ses_aaaaaaaaaaaa', calls: 1, parentId: null }),
        expect.objectContaining({ id: 'ses_bbbbbbbbbbbb', calls: 1, parentId: null }),
      ]),
    )
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

    const automatic = await sessions.start('alice', undefined, { autoName: 'personal · now' })
    expect(automatic.session).toMatchObject({
      state: AGENT_SESSION_STATE.new,
      attach: 'inferred',
      record: { id: 'ses_aaaaaaaaaaaa', name: 'personal · now', named: false, calls: 1 },
    })
    expect(await sessions.start('alice', undefined, { autoName: 'unused' })).toMatchObject({
      session: {
        state: AGENT_SESSION_STATE.new,
        attach: 'inferred',
        record: { id: 'ses_bbbbbbbbbbbb', calls: 1, parentId: null },
      },
    })

    const named = await sessions.start('alice', { name: 'work' }, { autoName: 'unused' })
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
    const fork = await sessions.start('alice', { name: 'work' }, { autoName: 'unused' })
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
    const ambiguous = await sessions.start('alice', { name: 'work' }, { autoName: 'unused' })
    expect(ambiguous.session).toBeUndefined()
    expect(ambiguous.recentSessions?.map(({ id }) => id)).toEqual([
      'ses_dddddddddddd',
      'ses_cccccccccccc',
    ])

    const freshAmidAmbiguity = await sessions.start('alice', undefined, {
      autoName: 'fresh automatic',
    })
    expect(freshAmidAmbiguity.session).toMatchObject({
      state: AGENT_SESSION_STATE.new,
      record: { id: 'ses_ffffffffffff', named: false },
    })
    expect(freshAmidAmbiguity.recentSessions).toBeUndefined()

    await sessions.start('bob', { name: 'sleeping' }, { autoName: 'unused' })
    now = new Date('2026-08-04T15:00:00.000Z')
    expect(await sessions.start('bob', { name: 'sleeping' }, { autoName: 'unused' })).toMatchObject(
      {
        session: {
          state: AGENT_SESSION_STATE.resumed,
          record: { id: 'ses_gggggggggggg', calls: 2, parentId: null },
        },
      },
    )
  })

  it('persists a project hint only from start and preserves it across resume and fork', async () => {
    const persistence = new InMemoryAgentSessions()
    let now = new Date('2026-08-04T12:00:00.000Z')
    const sessions = createAgentSessions({
      persistence,
      now: () => now,
      mintId: ids('ses_aaaaaaaaaaaa', 'ses_bbbbbbbbbbbb', 'ses_cccccccccccc'),
    })

    const started = await sessions.start(
      'alice',
      { name: 'work' },
      { autoName: 'unused' },
      'project-a',
    )
    expect(started.session?.record.projectId).toBe('project-a')

    now = new Date('2026-08-04T15:00:00.000Z')
    const resumed = await sessions.start('alice', { name: 'work' }, { autoName: 'unused' })
    expect(resumed.session?.record.projectId).toBe('project-a')

    now = new Date('2026-08-04T15:01:00.000Z')
    const forked = await sessions.start(
      'alice',
      { name: 'work' },
      { autoName: 'unused' },
      'project-b',
    )
    expect(forked.session?.record).toMatchObject({
      parentId: resumed.session?.record.id,
      projectId: 'project-b',
    })

    const attached = await sessions.attach('alice', forked.session?.record.id)
    expect(attached?.record.projectId).toBe('project-b')
  })

  it('keeps each unaddressed start and its project hint independent', async () => {
    const persistence = new InMemoryAgentSessions()
    const sessions = createAgentSessions({
      persistence,
      mintId: ids('ses_aaaaaaaaaaaa', 'ses_bbbbbbbbbbbb'),
    })

    const first = await sessions.start('alice', undefined, { autoName: 'first' }, 'project-a')
    const second = await sessions.start('alice', undefined, { autoName: 'second' }, 'project-b')

    expect(second.session?.record).toMatchObject({
      id: 'ses_bbbbbbbbbbbb',
      projectId: 'project-b',
    })
    expect(first.session?.record).toMatchObject({
      id: 'ses_aaaaaaaaaaaa',
      projectId: 'project-a',
    })
    expect(persistence.snapshot()).toHaveLength(2)
  })

  it('expires an id at the default 90-day Compact retention boundary', async () => {
    const persistence = new InMemoryAgentSessions()
    let now = new Date('2026-07-01T00:00:00.000Z')
    const sessions = createAgentSessions({
      persistence,
      now: () => now,
      mintId: ids('ses_aaaaaaaaaaaa'),
    })
    await sessions.start('alice', { name: 'old' }, { autoName: 'unused' })

    now = new Date('2026-09-29T00:00:00.001Z')
    await expect(
      sessions.start('alice', { id: 'ses_aaaaaaaaaaaa' }, { autoName: 'unused' }),
    ).rejects.toBeInstanceOf(NoSuchAgentSessionError)
  })

  it('uses the admitted Compact retention snapshot instead of a hard-coded 90 days', async () => {
    const persistence = new InMemoryAgentSessions()
    let now = new Date('2026-01-01T00:00:00.000Z')
    const sessions = createAgentSessions({
      persistence,
      now: () => now,
      mintId: ids('ses_aaaaaaaaaaaa'),
    })
    await sessions.start('alice', { name: 'long retention' }, { autoName: 'unused' })
    now = new Date('2026-04-11T00:00:00.000Z')

    await expect(sessions.read('alice', 'ses_aaaaaaaaaaaa')).rejects.toBeInstanceOf(
      NoSuchAgentSessionError,
    )
    await expect(
      sessions.read('alice', 'ses_aaaaaaaaaaaa', 180 * 24 * 60 * 60 * 1000),
    ).resolves.toMatchObject({ record: { id: 'ses_aaaaaaaaaaaa' } })
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

    const result = await sessions.start('alice', { name: 'old work' }, { autoName: 'unused' })
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
