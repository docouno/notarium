import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

/** A large personal corpus with a tiny memory mount: the shape that exposed
 *  memory/category reads accidentally scaling with every user note. */
export const memoryPerf: CaseSpec = {
  name: 'memory-perf',
  description:
    '2700 ordinary notes + 4 agent-memory categories in one personal space — reproduces memory-list scaling independently of response size.',
  axes: ['agent-memory', 'note-classes', 'scale'],
  build: ({ scale, now }) => {
    const b = new WorldBuilder(now)
    const corpusSize = Math.max(1, Math.round(2_700 * scale))

    b.space({ slug: 'memory-lab', displayName: 'Memory performance lab', personalFor: 'sergey' })
    b.user({
      username: 'sergey',
      password: 'seed-pass',
      displayName: 'Sergey',
      admin: true,
      personalSpace: 'memory-lab',
    })

    for (let i = 1; i <= corpusSize; i++) {
      const serial = String(i).padStart(4, '0')

      b.note({
        space: 'memory-lab',
        path: `corpus/${serial.slice(0, 2)}/note-${serial}.md`,
        title: `Corpus note ${serial}`,
        content: `# Corpus note ${serial}\n\nOrdinary knowledge outside the agent-memory mount.`,
        created: daysBefore(now, i % 365, 9),
        principal: 'user:sergey',
      })
    }

    for (const [category, summary] of [
      ['communication', 'Communication preferences.'],
      ['decisions', 'Durable decisions.'],
      ['gotchas', 'Known pitfalls.'],
      ['workflow', 'Working conventions.'],
    ] as const) {
      b.note({
        space: 'memory-lab',
        path: `.notarium/memory/${category}.md`,
        title: category,
        content:
          category === 'workflow'
            ? `# ${category}\n\nSeeded memory may cite [[Corpus note 0001]] without entering the user graph.`
            : `# ${category}\n\nSeeded memory for the large-corpus performance probe.`,
        class: 'agent-memory',
        summary,
        created: daysBefore(now, 4, 10),
        principal: 'pat:sergey:memory-perf',
      })
    }

    // Same typed mount, different semantic partition. Personal memory listing
    // must not leak this project-scoped category even though the engine's class
    // query correctly returns every agent-memory row in the space.
    b.note({
      space: 'memory-lab',
      path: '.notarium/memory/project-sentinel/project-only.md',
      title: 'project-only',
      content: '# project-only\n\nProject-partition memory must stay out of personal memory.',
      class: 'agent-memory',
      summary: 'Project-partition isolation sentinel.',
      created: daysBefore(now, 3, 10),
      principal: 'pat:sergey:memory-perf',
    })

    return b.build()
  },
}
