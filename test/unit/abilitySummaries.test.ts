import { describe, expect, it } from 'vitest'

import { ABILITY_CONTINUATION_REASON, ABILITY_LIST_VIEW } from '@notarium/contract'

import { curateAbilitySummaries } from '../../packages/server/src/services/mcp/helpers/abilitySummaries'
import { renderSession } from '../../packages/server/src/services/mcp/helpers/render'
import { abilityNextAction } from '../../packages/server/src/services/mcp/tools/abilities'
import { abilityFailureText } from '../../packages/server/src/services/mcp/tools/roles'

describe('MCP ability-summary curation', () => {
  it('keeps mixed discovery inside one exact token budget', () => {
    const input = Array.from({ length: 20 }, (_, index) => ({
      name: `ability-${index}`,
      title: `Ability ${index}`,
      description: `Ability ${index} ${'x'.repeat(900)}`,
      kind: index % 2 === 0 ? ('role' as const) : ('skill' as const),
      source: 'owned' as const,
      scope: 'personal' as const,
    }))
    const result = curateAbilitySummaries(input, 1_000)
    const charged = result.abilities.reduce(
      (total, ability) =>
        total +
        64 +
        ability.name.length +
        ability.title.length +
        ability.description.length +
        ability.kind.length +
        ability.source.length +
        ('scope' in ability ? ability.scope.length : 0),
      0,
    )

    expect(charged).toBeLessThanOrEqual(4_000)
    expect(result.abilities.length).toBeGreaterThan(0)
    expect(result.abilities.length).toBeLessThan(input.length)
    expect(result.abilities.every((ability) => ability.description.length <= 256)).toBe(true)
    expect(result.truncated).toBe(true)
  })

  it('keeps roles before skills and never adds authoring refs to the bundle', () => {
    const result = curateAbilitySummaries(
      [
        {
          name: 'a-skill',
          title: 'A skill',
          description: 'Skill.',
          kind: 'skill',
          source: 'system',
        },
        {
          name: 'z-role',
          title: 'Z role',
          description: 'Role.',
          kind: 'role',
          source: 'owned',
          scope: 'personal',
        },
      ],
      1_000,
    )

    expect(result.abilities.map(({ kind }) => kind)).toEqual(['role', 'skill'])
    expect(result.abilities.some((ability) => 'ref' in ability)).toBe(false)
  })

  it('renders the exact structured continuation when bootstrap is truncated', () => {
    const nextAction = abilityNextAction(
      { view: ABILITY_LIST_VIEW.runtime, project: 'team/main', limit: 50 },
      ABILITY_CONTINUATION_REASON.abilitiesTruncated,
    )
    const markdown = renderSession(
      {
        profile: { memory: [], alwaysLoad: [] },
        abilities: [],
        abilitiesTruncated: true,
        nextAction,
        projects: [],
        toolsHelp: [],
      },
      undefined,
      'concise',
    )

    expect(markdown).toContain('No abilities fit in this bounded summary')
    expect(markdown).toContain(JSON.stringify(nextAction))
    expect(markdown).not.toContain('list_roles')
  })

  it('points bounded role failures at the unified inventory', () => {
    const failure = {
      ok: false as const,
      reason: 'not-found' as const,
      remediation: [{ kind: 'list-abilities' as const, view: 'runtime' as const }],
    }

    expect(
      abilityFailureText('role', 'missing-role', failure, {
        names: ['one-role'],
        truncated: true,
      }),
    ).toMatch(/available roles: one-role.*bounded inventory.*list_abilities/)
    expect(
      abilityFailureText('role', 'missing-role', failure, { names: [], truncated: true }),
    ).toMatch(/no such role.*bounded inventory.*list_abilities/)
  })
})
