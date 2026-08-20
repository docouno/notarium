import { describe, expect, it } from 'vitest'

import type { AgentAbilitySummary } from '@notarium/contract'

import {
  abilityReaches,
  contextRoleSummaryOf,
} from '../../packages/server/src/apps/server/routes/wire'

/** The reach filter on the project agent-context door. It was the only thing standing
 *  between a narrowed Space role and a picker that offers it — and forcing it to say
 *  "yes" left the whole suite green, browser gate included, because every assertion
 *  about that list was a POSITIVE one. These are the negative half. */
describe('agent-context role reach', () => {
  type OwnedSummary = Extract<AgentAbilitySummary, { source: 'owned' }>

  const spaceRole = (availability?: OwnedSummary['availability']): AgentAbilitySummary =>
    ({
      source: 'owned',
      kind: 'role',
      locator: {
        source: 'owned',
        kind: 'role',
        packageId: 'RoleAAAAAAAA',
        location: { scope: 'space', spaceId: 'shared' },
      },
      title: 'Review',
      name: 'review',
      description: 'Review it.',
      noteId: 'RoleAAAAAAAA',
      origin: 'custom',
      enabled: true,
      availability,
    }) as unknown as AgentAbilitySummary

  it('refuses a Space role in a project its reach does not name', () => {
    const narrowed = spaceRole({ mode: 'selected-projects', projectIds: ['project-a'] })

    expect(abilityReaches(narrowed, 'project-a')).toBe(true)
    expect(abilityReaches(narrowed, 'project-b')).toBe(false)
    expect(contextRoleSummaryOf(narrowed, 'project-b')).toBeNull()
    expect(contextRoleSummaryOf(narrowed, 'project-a')).toMatchObject({ locator: { kind: 'role' } })
  })

  it('reads an absent row per KIND, the way the service does', () => {
    // A role with no row reaches everywhere — that default is what lets availability
    // arrive with no data migration behind it.
    expect(abilityReaches(spaceRole(undefined), 'project-b')).toBe(true)

    // A SKILL with no row reaches nothing. The wire copy of this formula was written
    // kind-blind and answered "everywhere" for both.
    const skill = {
      ...spaceRole(undefined),
      locator: {
        source: 'owned',
        kind: 'skill',
        packageId: 'SkillAAAAAAA',
        location: { scope: 'space', spaceId: 'shared' },
      },
    } as unknown as AgentAbilitySummary

    expect(abilityReaches(skill, 'project-b')).toBe(false)
  })

  it('asks reach only when the caller is inside a project', () => {
    const narrowed = spaceRole({ mode: 'selected-projects', projectIds: ['project-a'] })

    expect(contextRoleSummaryOf(narrowed)).toMatchObject({ locator: { kind: 'role' } })
  })
})
