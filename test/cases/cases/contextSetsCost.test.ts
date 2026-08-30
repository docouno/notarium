import { describe, expect, it } from 'vitest'

import { buildCaseWorld } from '../build'

describe('context-sets-cost seed shape', () => {
  it('owns the heavy, isolated dedup, role, and bulk-target states', () => {
    const world = buildCaseWorld('context-sets-cost')
    const notes = world.events.filter(
      (event) => event.op === 'create' && event.path.startsWith('product/corpus/'),
    )
    const set = (name: string) => world.contextSets?.find((candidate) => candidate.name === name)

    expect(notes).toHaveLength(1_100)
    expect(set('context-heavy-1000')?.items).toHaveLength(1_000)
    expect(set('context-heavy-1000')?.attach).toEqual([
      { kind: 'project', space: 'context-cost-lab', path: 'product' },
    ])
    expect(set('context-small-5')?.items).toHaveLength(5)
    expect(set('context-role-compatibility')?.attach?.[0]).toMatchObject({
      kind: 'role',
      name: 'context-set-auditor',
    })
    expect(set('context-bulk-target')?.items).toEqual([])
    expect(world.agentRoles).toEqual([
      expect.objectContaining({
        name: 'context-set-auditor',
        target: { kind: 'project', space: 'context-cost-lab', path: 'product' },
      }),
    ])
  })
})
