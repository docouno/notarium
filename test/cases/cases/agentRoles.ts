import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

/** Five intentionally separate principals keep the state boundary observable:
 * Fresh has catalog-only access and no personal space, proving that a rejected Add
 * remains side-effect free. Bob owns an idle personal fork, and Maya owns same-name
 * Personal + Space(team) + Project(team/other and maya-home/work) forks. The Project
 * fork wins in a project context. Robin can inspect the Team placement but cannot
 * mutate it. Sergey remains the browsable stand owner; the real seeder may grant that
 * owner access to ordinary shared spaces. */
export const agentRoles: CaseSpec = {
  name: 'agent-roles',
  description:
    'Catalog-only templates, owned role precedence, independent Personal/Space/Project presets, and a role-first shared-budget trim edge.',
  axes: ['agent-roles', 'agent-sessions', 'auth', 'structure', 'scale'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'main', displayName: 'Stand owner', personalFor: 'sergey' })
    b.space({ slug: 'bob-home', displayName: 'Bob personal', personalFor: 'bob' })
    b.space({ slug: 'maya-home', displayName: 'Maya personal', personalFor: 'maya' })
    b.space({ slug: 'team', displayName: 'Team' })
    b.project({ space: 'main', path: '', displayName: 'Main' })
    b.project({ space: 'main', path: 'other', slug: 'other', displayName: 'Main' })
    b.project({ space: 'team', path: '', displayName: 'Team' })
    b.project({ space: 'team', path: 'other', slug: 'other', displayName: 'Team' })
    b.project({ space: 'maya-home', path: 'work', slug: 'work', displayName: 'Maya work' })

    b.user({ username: 'sergey', password: 'sergey', displayName: 'Sergey', admin: true })
    b.user({ username: 'bob', password: 'bob', displayName: 'Bob' })
    b.user({ username: 'maya', password: 'maya', displayName: 'Maya' })
    b.user({ username: 'robin', password: 'robin', displayName: 'Robin' })
    b.user({ username: 'fresh', password: 'fresh', displayName: 'Fresh' })
    b.member({ space: 'main', username: 'sergey', role: 'owner' })
    b.member({ space: 'bob-home', username: 'bob', role: 'owner' })
    b.member({ space: 'maya-home', username: 'maya', role: 'owner' })
    b.member({ space: 'team', username: 'maya', role: 'writer' })
    b.member({ space: 'team', username: 'robin', role: 'reader' })

    b.note({
      space: 'maya-home',
      path: 'base-profile.md',
      title: 'Base personal context',
      pin: true,
      created: daysBefore(now, 4),
    })
    const personalResearch = b.note({
      space: 'maya-home',
      path: 'personal-research-role.md',
      title: 'Personal research method',
      created: daysBefore(now, 3),
    })
    const personalGrooming = b.note({
      space: 'maya-home',
      path: 'personal-grooming-role.md',
      title: 'Personal grooming checklist',
      created: daysBefore(now, 3),
    })
    const spaceResearch = b.note({
      space: 'team',
      path: 'space-research-role.md',
      title: 'Team research conventions',
      created: daysBefore(now, 3),
    })
    b.note({
      space: 'team',
      path: 'other/base-project.md',
      title: 'Base project context',
      pin: true,
      created: daysBefore(now, 3),
    })
    const projectResearch = b.note({
      space: 'team',
      path: 'other/project-research-role.md',
      title: 'Project research brief',
      created: daysBefore(now, 2),
    })
    const projectReference = b.note({
      space: 'team',
      path: 'other/reference.md',
      title: 'Research source map',
      created: daysBefore(now, 2),
    })
    const oversizedResearch = b.note({
      space: 'team',
      path: 'other/oversized-research-role.md',
      title: 'Oversized research corpus',
      content: ['# Oversized research corpus', '', 'evidence '.repeat(22_000)].join('\n'),
      created: daysBefore(now, 1),
    })
    const workResearch = b.note({
      space: 'maya-home',
      path: 'work/project-research-role.md',
      title: 'Maya work research brief',
      created: daysBefore(now, 2),
    })

    b.agentRole({ name: 'grooming', target: { kind: 'personal', user: 'bob' } })
    b.agentRole({ name: 'research', target: { kind: 'personal', user: 'maya' } })
    b.agentRole({ name: 'grooming', target: { kind: 'personal', user: 'maya' } })
    b.agentRole({ name: 'research', target: { kind: 'space', space: 'team' } })
    b.agentRole({ name: 'research', target: { kind: 'project', space: 'team', path: 'other' } })
    b.agentRole({
      name: 'research',
      target: { kind: 'project', space: 'maya-home', path: 'work' },
    })
    b.scopePin({
      note: personalResearch,
      attach: { kind: 'role', name: 'research', target: { kind: 'personal', user: 'maya' } },
    })
    b.scopePin({
      note: personalGrooming,
      attach: { kind: 'role', name: 'grooming', target: { kind: 'personal', user: 'maya' } },
    })
    b.scopePin({
      note: spaceResearch,
      attach: { kind: 'role', name: 'research', target: { kind: 'space', space: 'team' } },
    })
    const teamProjectRole = {
      kind: 'role' as const,
      name: 'research',
      target: { kind: 'project' as const, space: 'team', path: 'other' },
    }
    b.scopePin({ note: projectResearch, attach: teamProjectRole })
    b.scopePin({ note: oversizedResearch, attach: teamProjectRole })
    b.contextSet({
      homeSpace: 'team',
      name: 'Research source set',
      items: [projectReference],
      attach: [teamProjectRole],
    })
    b.contextOrderFor({
      scope: teamProjectRole,
      entries: [
        { kind: 'pin', note: projectResearch },
        { kind: 'set', name: 'Research source set' },
        { kind: 'pin', note: oversizedResearch },
      ],
    })
    b.scopePin({
      note: workResearch,
      attach: {
        kind: 'role',
        name: 'research',
        target: { kind: 'project', space: 'maya-home', path: 'work' },
      },
    })
    b.agentSession({
      ref: 'maya-research',
      owner: 'maya',
      name: 'role research session',
      createdDaysAgo: 0.1,
      lastSeenDaysAgo: 0.01,
      calls: 4,
      role: 'research',
    })

    return b.build()
  },
}
