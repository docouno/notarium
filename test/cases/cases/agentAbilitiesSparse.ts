import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

/** The other end of the same axis: a stand at its very FIRST Owned package — no role
 * anywhere, one skill, no memory and no session. Empty states,
 * skeleton geometry and first-run copy are only honest when a case actually
 * produces them — with `agent-roles` and `agent-abilities-rich` every group is
 * populated, so an empty Abilities surface never appears on a seeded stand. */
export const agentAbilitiesSparse: CaseSpec = {
  name: 'agent-abilities-sparse',
  description:
    'A first-run Abilities stand: System and Catalog plus exactly one Owned skill — no Owned role, no memory, no session: the empty group, the single-row group and the first-run copy.',
  axes: ['agent-roles', 'structure', 'auth'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)

    b.space({ slug: 'main', displayName: 'Stand owner', personalFor: 'sergey' })
    b.space({ slug: 'product', displayName: 'Product' })
    b.project({ space: 'main', path: '', displayName: 'Main' })
    b.project({ space: 'product', path: '', displayName: 'Product' })

    b.user({ username: 'sergey', password: 'sergey', displayName: 'Sergey', admin: true })
    b.member({ space: 'main', username: 'sergey', role: 'owner' })
    b.member({ space: 'product', username: 'sergey', role: 'owner' })

    b.note({
      space: 'main',
      path: 'base-profile.md',
      title: 'Stand owner base context',
      pin: true,
      created: daysBefore(now, 2),
    })

    // Exactly one Owned package in the whole stand: the step between "nothing" and
    // "a list", where a group holds a single row and the card grid has one card.
    b.agentSkill({
      name: 'evidence-check',
      description: 'Trace every claim back to its source.',
      instructions: '# Evidence check\n\nTrace every claim back to its source.',
      home: { kind: 'personal', user: 'sergey' },
    })

    return b.build()
  },
}
