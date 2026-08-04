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
  it('attaches explicitly or only to exactly one active owner session', async () => {
    const persistence = new InMemoryAgentSessions()
    let now = new Date('2026-08-04T12:00:00.000Z')
    const sessions = createAgentSessions({
      persistence,
      now: () => now,
      mintId: ids('ses_aaaaaaaaaaaa', 'ses_bbbbbbbbbbbb'),
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
      record: { id: 'ses_bbbbbbbbbbbb', named: true, parentId: null },
    })
    const fork = await sessions.start('alice', { name: 'work' }, 'unused')
    expect(fork.session).toMatchObject({
      state: AGENT_SESSION_STATE.forked,
      record: {
        id: 'ses_cccccccccccc',
        parentId: 'ses_bbbbbbbbbbbb',
        name: 'work',
      },
    })
    const ambiguous = await sessions.start('alice', { name: 'work' }, 'unused')
    expect(ambiguous.session).toBeUndefined()
    expect(ambiguous.recentSessions?.map(({ id }) => id)).toEqual([
      'ses_cccccccccccc',
      'ses_bbbbbbbbbbbb',
    ])

    const freshAmidAmbiguity = await sessions.start('alice', undefined, 'fresh automatic')
    expect(freshAmidAmbiguity.session).toMatchObject({
      state: AGENT_SESSION_STATE.new,
      record: { id: 'ses_eeeeeeeeeeee', named: false },
    })
    expect(freshAmidAmbiguity.recentSessions?.map(({ id }) => id)).not.toContain('ses_dddddddddddd')

    await sessions.start('bob', { name: 'sleeping' }, 'unused')
    now = new Date('2026-08-04T15:00:00.000Z')
    expect(await sessions.start('bob', { name: 'sleeping' }, 'unused')).toMatchObject({
      session: {
        state: AGENT_SESSION_STATE.resumed,
        record: { id: 'ses_ffffffffffff', calls: 2, parentId: null },
      },
    })
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
        },
      ]),
    ).toThrow(/parent agent session/)
  })
})
