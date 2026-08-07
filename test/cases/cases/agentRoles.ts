import { WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

/** Four intentionally separate principals keep the state boundary observable:
 * Fresh has catalog-only access and no personal space, proving that a rejected Add
 * remains side-effect free. Bob owns an idle personal fork, and Maya owns same-name
 * Personal + Space(team) + Project(team/other and maya-home/work) forks. The Project
 * fork wins in a project context. Sergey remains the browsable stand owner; the real
 * seeder may grant that owner access to ordinary shared spaces. */
export const agentRoles: CaseSpec = {
  name: 'agent-roles',
  description:
    'Catalog-only templates, a no-space Add edge, an idle Personal fork, and same-name Personal + Space + Project forks across four test users.',
  axes: ['agent-roles', 'agent-sessions', 'auth', 'structure'],
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
    b.user({ username: 'fresh', password: 'fresh', displayName: 'Fresh' })
    b.member({ space: 'main', username: 'sergey', role: 'owner' })
    b.member({ space: 'bob-home', username: 'bob', role: 'owner' })
    b.member({ space: 'maya-home', username: 'maya', role: 'owner' })
    b.member({ space: 'team', username: 'maya', role: 'writer' })

    b.agentRole({ name: 'grooming', target: { kind: 'personal', user: 'bob' } })
    b.agentRole({ name: 'research', target: { kind: 'personal', user: 'maya' } })
    b.agentRole({ name: 'research', target: { kind: 'space', space: 'team' } })
    b.agentRole({ name: 'research', target: { kind: 'project', space: 'team', path: 'other' } })
    b.agentRole({
      name: 'research',
      target: { kind: 'project', space: 'maya-home', path: 'work' },
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
