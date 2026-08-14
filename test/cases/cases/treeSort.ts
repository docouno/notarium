import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

// #314 — one compact world where Name, Created and Modified produce three
// visibly different orders in both explorer data sources. Edits are deliberate:
// the real applier writes files in timeline order, so their relative mtimes keep
// the authored modified-order even though the host cannot backdate absolute mtime.
export const treeSort: CaseSpec = {
  name: 'tree-sort',
  description:
    'Three notes and three personal-memory categories whose Name, Created and Modified orders all differ — manual QA for the shared explorer sort control (#314).',
  axes: ['structure', 'agent-memory', 'activity'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'main', displayName: 'Main' })
    b.space({ slug: 'sort-home', displayName: 'Sort Home', personalFor: 'sam' })
    b.user({
      username: 'sam',
      password: 'seed-pass',
      displayName: 'Sam',
      personalSpace: 'sort-home',
    })
    b.member({ space: 'main', username: 'sam', role: 'owner' })

    const addTriplet = (space: string, prefix: string, memory = false) => {
      const path = (title: string) =>
        memory
          ? `.notarium/memory/${title.toLowerCase()}-memory.md`
          : `${prefix}/${title.toLowerCase()}.md`

      b.note({
        space,
        path: path('Alpha'),
        title: memory ? 'alpha-memory' : 'Alpha',
        class: memory ? 'agent-memory' : undefined,
        summary: memory ? 'Alpha memory category.' : undefined,
        created: daysBefore(now, 9, 9),
        edits: [daysBefore(now, 1, 9)],
        principal: 'user:sam',
      })
      b.note({
        space,
        path: path('Bravo'),
        title: memory ? 'bravo-memory' : 'Bravo',
        class: memory ? 'agent-memory' : undefined,
        summary: memory ? 'Bravo memory category.' : undefined,
        created: daysBefore(now, 2, 9),
        principal: 'user:sam',
      })
      b.note({
        space,
        path: path('Charlie'),
        title: memory ? 'charlie-memory' : 'Charlie',
        class: memory ? 'agent-memory' : undefined,
        summary: memory ? 'Charlie memory category.' : undefined,
        created: daysBefore(now, 5, 9),
        edits: [daysBefore(now, 1, 12)],
        principal: 'user:sam',
      })
    }

    addTriplet('main', 'sort-lab')
    addTriplet('sort-home', '', true)
    return b.build()
  },
}
