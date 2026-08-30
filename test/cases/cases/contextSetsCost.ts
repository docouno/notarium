import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

const sizedBody = (title: string, bytes = 2_048): string => {
  const prefix = `# ${title}\n\n`
  const line =
    'Context-set cost corpus keeps parsing, identity, access, token weighing, and presentation representative. '
  return prefix + line.repeat(Math.max(1, Math.ceil((bytes - prefix.length) / line.length)))
}

/** Dedicated #406 stand. It deliberately does not reuse `context-open`: that fixture is
 * the frozen #399 benchmark input and has a different data-root contract. */
export const contextSetsCost: CaseSpec = {
  name: 'context-sets-cost',
  description:
    'Production-shaped #406 context-set stand: 1100-note corpus, 1000-member bounded set, isolated dedup set, editable role compatibility state, and an empty bulk target.',
  axes: ['agent-memory', 'agent-roles', 'auth', 'scale', 'structure'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)

    b.space({
      slug: 'context-cost-me',
      displayName: 'Context cost personal',
      personalFor: 'sergey',
    })
    b.space({ slug: 'context-cost-lab', displayName: 'Context cost lab' })
    b.user({
      username: 'sergey',
      password: 'seed-pass',
      displayName: 'Sergey',
      admin: true,
      personalSpace: 'context-cost-me',
    })
    b.member({ space: 'context-cost-lab', username: 'sergey', role: 'owner' })
    b.project({ space: 'context-cost-lab', path: 'product', displayName: 'Heavy product' })
    b.project({ space: 'context-cost-lab', path: 'small-set', displayName: 'Small set' })

    b.agentRole({
      source: 'custom',
      name: 'context-set-auditor',
      description: 'Keeps the full unbudgeted role identity layer visible for #406.',
      instructions: '# Context set auditor\n\nInspect authored set membership without changing it.',
      target: { kind: 'project', space: 'context-cost-lab', path: 'product' },
    })

    const notes: string[] = []

    for (let index = 1; index <= 1_100; index += 1) {
      const serial = String(index).padStart(4, '0')
      const title = `Context set corpus ${serial}`
      notes.push(
        b.note({
          space: 'context-cost-lab',
          path: `product/corpus/bucket-${String(index % 100).padStart(2, '0')}/note-${serial}.md`,
          title,
          content: sizedBody(title),
          tags: ['context-sets-cost', index % 11 === 0 ? 'reference' : 'corpus'],
          created: daysBefore(now, index % 365, 9),
          principal: 'user:sergey',
        }),
      )
    }

    for (let index = 1; index <= 6; index += 1) {
      const title = `Context cost pin ${index}`
      b.note({
        space: 'context-cost-lab',
        path: `product/context/pin-${index}.md`,
        title,
        content: sizedBody(title, 13_700),
        pin: true,
        created: daysBefore(now, index + 10, 10),
        principal: 'user:sergey',
      })
    }

    const dedup = b.note({
      space: 'context-cost-lab',
      path: 'small-set/dedup-pin.md',
      title: 'Small set dedup pin',
      content: sizedBody('Small set dedup pin', 900),
      pin: true,
      created: daysBefore(now, 20, 10),
      principal: 'user:sergey',
    })
    const smallTail = notes.slice(1_000, 1_004)

    b.contextSet({
      homeSpace: 'context-cost-lab',
      name: 'context-heavy-1000',
      items: notes.slice(0, 1_000),
      attach: [{ kind: 'project', space: 'context-cost-lab', path: 'product' }],
    })
    b.contextSet({
      homeSpace: 'context-cost-lab',
      name: 'context-small-5',
      items: [dedup, ...smallTail],
      attach: [{ kind: 'project', space: 'context-cost-lab', path: 'small-set' }],
    })
    b.contextSet({
      homeSpace: 'context-cost-lab',
      name: 'context-role-compatibility',
      items: notes.slice(0, 8),
      attach: [
        {
          kind: 'role',
          name: 'context-set-auditor',
          target: { kind: 'project', space: 'context-cost-lab', path: 'product' },
        },
      ],
    })
    b.contextSet({
      homeSpace: 'context-cost-lab',
      name: 'context-bulk-target',
      items: [],
    })

    return b.build()
  },
}
