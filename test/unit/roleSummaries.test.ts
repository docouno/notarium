import { describe, expect, it } from 'vitest'

import { renderSession } from '../../packages/server/src/services/mcp/helpers/render'
import { curateRoleSummaries } from '../../packages/server/src/services/mcp/helpers/roleSummaries'
import {
  assertRoleAvailable,
  handleListRoles,
} from '../../packages/server/src/services/mcp/tools/roles'

describe('MCP role-summary curation', () => {
  it('keeps effective-role discovery inside its own token budget and reports truncation', () => {
    const input = Array.from({ length: 20 }, (_, index) => ({
      name: `role-${index}`,
      description: `Role ${index} ${'x'.repeat(900)}`,
      scope: 'personal' as const,
    }))
    const result = curateRoleSummaries(input, 1_000)
    const charged = result.roles.reduce(
      (total, role) => total + 64 + role.name.length + role.scope.length + role.description.length,
      0,
    )

    expect(charged).toBeLessThanOrEqual(4_000)
    expect(result.roles.length).toBeGreaterThan(0)
    expect(result.roles.length).toBeLessThan(input.length)
    expect(result.roles.every((role) => role.description.length <= 256)).toBe(true)
    expect(result.truncated).toBe(true)
  })

  it('returns an alphabetic prefix when names alone exceed the budget', () => {
    const input = Array.from({ length: 100 }, (_, index) => ({
      name: `role-${String(index).padStart(3, '0')}-${'n'.repeat(45)}`,
      description: 'Description.',
      scope: 'personal' as const,
    }))
    const result = curateRoleSummaries(input, 100)

    expect(result.roles.length).toBeGreaterThan(0)
    expect(result.roles.length).toBeLessThan(input.length)
    expect(result.roles.map(({ name }) => name)).toEqual(
      input.slice(0, result.roles.length).map(({ name }) => name),
    )
    expect(result.truncated).toBe(true)
  })

  it('marks a single abbreviated description and makes the abbreviation visible', () => {
    const result = curateRoleSummaries(
      [{ name: 'one-role', description: 'x'.repeat(1_024), scope: 'personal' }],
      1_000,
    )

    expect(result.roles).toHaveLength(1)
    expect(result.roles[0].description).toHaveLength(256)
    expect(result.roles[0].description.endsWith('…')).toBe(true)
    expect(result.truncated).toBe(true)
  })

  it('renders abbreviation without claiming that additional roles exist', () => {
    const markdown = renderSession(
      {
        profile: { memory: [], alwaysLoad: [] },
        roles: [{ name: 'one-role', description: 'Abbreviated…', scope: 'personal' }],
        rolesTruncated: true,
        projects: [],
        toolsHelp: [],
      },
      undefined,
      'concise',
    )

    expect(markdown).toContain('role summaries were abbreviated or omitted')
    expect(markdown).not.toContain('more added roles exist')
  })

  it('does not claim base mode when an empty bootstrap summary is bounded', () => {
    const markdown = renderSession(
      {
        profile: { memory: [], alwaysLoad: [] },
        roles: [],
        rolesTruncated: true,
        projects: [],
        toolsHelp: [],
      },
      undefined,
      'concise',
    )

    expect(markdown).toContain('No roles are visible in this bounded summary')
    expect(markdown).not.toContain('No roles have been added')
    expect(markdown).not.toContain('continue in the base mode')
  })

  it('marks unavailable-selector hints as bounded even with fewer than twenty visible roles', () => {
    expect(() =>
      assertRoleAvailable(
        [{ name: 'one-role', description: 'One role.', scope: 'personal' }],
        'missing-role',
        true,
      ),
    ).toThrow(/inventory is bounded.*list_roles/)
    expect(() => assertRoleAvailable([], 'missing-role', true)).toThrow(
      /not visible in the bounded inventory.*list_roles/,
    )
  })

  it('warns when list_roles reaches an underlying library bound', async () => {
    const result = await handleListRoles(
      {
        personalSpace: async () => 'personal',
        roles: {
          listEffective: async () => ({
            roles: [{ name: 'one-role', description: 'One role.', scope: 'personal' }],
            truncated: true,
          }),
        },
      } as never,
      { limit: 20 } as never,
    )

    expect(result.structured).toMatchObject({ total: 1, truncated: true })
    expect(result.markdown).toContain('not exhaustive')
  })
})
