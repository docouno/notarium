import { describe, expect, it } from 'vitest'
import type { AgentAbilityAvailabilityState, OwnedAbilityLocator } from '@notarium/contract'
import type { SaveInput } from '../../../../libs/wire'
import {
  type AbilitySaveEffects,
  abilitySaveLanded,
  type AbilitySaveProgress,
  abilitySaveProgress,
  runAbilitySave,
} from './abilitySave'

type OwnedRoleLocator = Extract<OwnedAbilityLocator, { kind: 'role' }>

const projectRole: OwnedRoleLocator = {
  source: 'owned',
  kind: 'role',
  packageId: 'release-captain',
  location: { scope: 'project', spaceId: 'space-1', projectId: 'project-a' },
}

const spaceRole: OwnedRoleLocator = {
  source: 'owned',
  kind: 'role',
  packageId: 'release-captain',
  location: { scope: 'space', spaceId: 'space-1' },
}

type Recorder = {
  effects: AbilitySaveEffects<{ versionToken: string }>
  documents: SaveInput[]
  moves: OwnedRoleLocator[]
  reaches: Array<{ locator: OwnedAbilityLocator; reach: AgentAbilityAvailabilityState }>
}

const recorder = (
  overrides: Partial<AbilitySaveEffects<{ versionToken: string }>> = {},
): Recorder => {
  const documents: SaveInput[] = []
  const moves: OwnedRoleLocator[] = []
  const reaches: Array<{ locator: OwnedAbilityLocator; reach: AgentAbilityAvailabilityState }> = []

  return {
    documents,
    moves,
    reaches,
    effects: {
      saveDocument: async (payload) => {
        documents.push(payload)
        return { versionToken: `v${documents.length}` }
      },
      moveHome: async (locator) => {
        moves.push(locator)
        return {
          locator: spaceRole,
          availability: { mode: 'selected-projects', projectIds: ['project-a'] },
        }
      },
      setReach: async (locator, reach) => {
        reaches.push({ locator, reach })
      },
      ...overrides,
    },
  }
}

const run = (
  progress: AbilitySaveProgress,
  effects: AbilitySaveEffects<{ versionToken: string }>,
  answer: { covers: readonly string[] | null } = { covers: ['project-a', 'project-b'] },
) => {
  let landed = progress

  return {
    result: runAbilitySave({
      progress,
      commit: (next) => {
        landed = next
      },
      payload: { content: '# Release captain', name: 'release-captain', description: '' },
      noteId: 'note-1',
      versionToken: 'seed-token',
      seedReach: null,
      answer: {
        ...answer,
        attachments: [{ kind: 'invalid', raw: 'skills/x', reason: 'invalid-locator' }],
      },
      effects,
    }),
    progress: () => landed,
  }
}

describe('ability save continuation', () => {
  it('addresses a continued save at the package the move left behind', async () => {
    const failing = recorder({
      setReach: async () => {
        throw new Error('availability rejected')
      },
    })
    const first = run(abilitySaveProgress(projectRole), failing.effects)
    await expect(first.result).rejects.toThrow('availability rejected')

    const carried = first.progress()
    expect(carried.moved).toBe(true)
    expect(carried.locator).toEqual(spaceRole)
    expect(abilitySaveLanded(carried)).toBe(true)

    // The retry: the package no longer lives where the edit started, so the document
    // write of attempt two must not be addressed there — that is the 404 loop.
    const retry = recorder()
    await run(carried, retry.effects).result

    expect(retry.documents).toHaveLength(1)
    expect(retry.documents[0]!.abilityLocator).toEqual(spaceRole)
    expect(retry.documents[0]!.versionToken).toBe('v1')
    expect(retry.moves).toEqual([])
    expect(retry.reaches).toEqual([
      {
        locator: spaceRole,
        reach: { mode: 'selected-projects', projectIds: ['project-a', 'project-b'] },
      },
    ])
  })

  it('never replays a home move that already landed', async () => {
    const failing = recorder({
      setReach: async () => {
        throw new Error('offline')
      },
    })
    const first = run(abilitySaveProgress(projectRole), failing.effects)
    await expect(first.result).rejects.toThrow('offline')
    expect(failing.moves).toEqual([projectRole])

    const retry = recorder()
    await run(first.progress(), retry.effects).result
    expect(retry.moves).toEqual([])
  })

  it('leaves the reach endpoint alone when the answer is the reach already applied', async () => {
    const first = recorder({
      setReach: async () => {
        throw new Error('boom')
      },
    })
    // The move kept `project-a`; asking for exactly that again is not a change.
    const attempt = run(abilitySaveProgress(projectRole), first.effects, {
      covers: ['project-a', 'project-b'],
    })
    await expect(attempt.result).rejects.toThrow('boom')

    const retry = recorder()
    await run(attempt.progress(), retry.effects, { covers: ['project-a'] }).result
    expect(retry.reaches).toEqual([])
  })

  it('hands the version question back to the session when the document write fails', async () => {
    const broken = recorder({
      saveDocument: async () => {
        throw new Error('conflict')
      },
    })
    const attempt = run(
      { ...abilitySaveProgress(spaceRole), versionToken: 'stale-token' },
      broken.effects,
    )
    await expect(attempt.result).rejects.toThrow('conflict')
    expect(attempt.progress().versionToken).toBeUndefined()
  })

  it('counts an untouched edit as nothing landed', () => {
    expect(abilitySaveLanded(abilitySaveProgress(spaceRole))).toBe(false)
  })

  it('counts a landed document write as landed even when nothing moved', async () => {
    const broken = recorder({
      setReach: async () => {
        throw new Error('availability rejected')
      },
    })
    const attempt = run(abilitySaveProgress(spaceRole), broken.effects, { covers: ['project-a'] })
    await expect(attempt.result).rejects.toThrow('availability rejected')

    // The document was rewritten and the reach was not: the page is showing a stale
    // body, so abandoning the edit has to re-read even though the address held still.
    const carried = attempt.progress()
    expect(carried.moved).toBe(false)
    expect(abilitySaveLanded(carried)).toBe(true)
  })
})
