import { describe, expect, it } from 'vitest'
import {
  agentsExplorerStorageKey,
  agentsExplorerVersions,
  naturalAgentsExplorerDataset,
  resolveAgentsExplorerScope,
  resolveAgentsExplorerState,
} from './AgentsExplorerProvider'

describe('Agents Explorer state', () => {
  it('derives the natural dataset from the central Agents subsection', () => {
    expect(naturalAgentsExplorerDataset('/agents/abilities/roles')).toBe('roles')
    expect(naturalAgentsExplorerDataset('/agents/abilities/skills/owned/exact')).toBe('skills')
    expect(naturalAgentsExplorerDataset('/agents/context')).toBe('memory')
    expect(naturalAgentsExplorerDataset('/m/note-id')).toBe('memory')
    expect(naturalAgentsExplorerDataset('/agents/activity/session-id')).toBe('sessions')
  })

  it('keeps a manual dataset across route changes and reload resolution', () => {
    const stored = JSON.stringify({ dataset: 'sessions', mode: 'manual' })

    expect(resolveAgentsExplorerState(stored, 'memory')).toEqual({
      dataset: 'sessions',
      mode: 'manual',
    })
    expect(resolveAgentsExplorerState(stored, 'roles')).toEqual({
      dataset: 'sessions',
      mode: 'manual',
    })
  })

  it('rebinds natural state to the current route and rejects malformed storage', () => {
    expect(
      resolveAgentsExplorerState(JSON.stringify({ dataset: 'roles', mode: 'natural' }), 'skills'),
    ).toEqual({ dataset: 'skills', mode: 'natural' })
    expect(resolveAgentsExplorerState('{broken', 'memory')).toEqual({
      dataset: 'memory',
      mode: 'natural',
    })
  })

  it('isolates persistence by owner and stable Space id', () => {
    expect(agentsExplorerStorageKey('alice', 'space-a')).toBe(
      'notarium:agents-explorer:alice:space-a',
    )
    expect(agentsExplorerStorageKey('@system', 'space-a')).not.toBe(
      agentsExplorerStorageKey('alice', 'space-a'),
    )
    expect(agentsExplorerStorageKey('alice', 'space-b')).not.toBe(
      agentsExplorerStorageKey('alice', 'space-a'),
    )
  })
})

// Every Agents listing waits on this: null is "not resolved yet", and a listing sent
// then is an owner-global bounded scan whose answer the scoped one replaces.
describe('Agents Explorer scope', () => {
  const spaces = [
    { id: 'space-1', slug: 'team', aliases: ['old-team'] },
    { id: 'space-2', slug: 'lab' },
  ]
  const personal = { id: 'personal-1', slug: 'ada' }

  it('resolves the active Space by slug and by a slug it used to answer to', () => {
    expect(resolveAgentsExplorerScope('lab', spaces, personal)).toEqual({ spaceId: 'space-2' })
    expect(resolveAgentsExplorerScope('old-team', spaces, personal)).toEqual({ spaceId: 'space-1' })
  })

  it('resolves the personal domain, which the workspace list leaves out', () => {
    expect(resolveAgentsExplorerScope('ada', spaces, personal)).toEqual({ spaceId: 'personal-1' })
  })

  it('has no scope while the space table does not name the active slug', () => {
    expect(resolveAgentsExplorerScope('', spaces, personal)).toBeNull()
    expect(resolveAgentsExplorerScope('team', [], null)).toBeNull()
  })
})

// The stream is per-Space and replays nothing missed while it was down, so a
// reconnect is the moment every held Agents answer becomes unverified.
describe('Agents Explorer freshness after a reconnect', () => {
  const held = { roles: 3, skills: 1, memory: 0, sessions: 2 }

  it('moves the reload key of every dataset, not only the one with a live signal', () => {
    const before = agentsExplorerVersions(held, 4)
    const after = agentsExplorerVersions(held, 5)

    expect(after.roles).not.toBe(before.roles)
    expect(after.skills).not.toBe(before.skills)
    expect(after.memory).not.toBe(before.memory)
    expect(after.sessions).not.toBe(before.sessions)
  })

  it('still moves one dataset alone when only that one was invalidated', () => {
    const before = agentsExplorerVersions(held, 4)
    const after = agentsExplorerVersions({ ...held, skills: held.skills + 1 }, 4)

    expect(after.skills).not.toBe(before.skills)
    expect(after.roles).toBe(before.roles)
    expect(after.memory).toBe(before.memory)
    expect(after.sessions).toBe(before.sessions)
  })
})
