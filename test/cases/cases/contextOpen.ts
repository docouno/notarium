import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

const sizedBody = (title: string, bytes: number, link?: string): string => {
  const prefix = `# ${title}\n\n${link ? `${link}\n\n` : ''}`
  const line =
    'Context performance corpus text keeps parsing, hashing, snippets, tokens, and graph derivation representative of a real knowledge base. '

  return prefix + line.repeat(Math.max(1, Math.ceil((bytes - prefix.length) / line.length)))
}

/** Production-shaped regression case for #394. The corpus and always-load axis stay
 * fixed; SCALE changes only project-memory category count (4 at .045, 90 at 1). */
export const contextOpen: CaseSpec = {
  name: 'context-open',
  description:
    'Production-shaped #394/#399 performance stand: 3.8k notes across project/personal spaces, one editable Project Role, linked dashboard graph, large memory categories, profile, and 12 large always-load pins.',
  axes: ['agent-memory', 'agent-roles', 'activity', 'graph', 'note-classes', 'scale', 'structure'],
  build: ({ now, scale }) => {
    const b = new WorldBuilder(now)

    b.space({ slug: 'context-me', displayName: 'Context personal', personalFor: 'sergey' })
    b.space({ slug: 'context-lab', displayName: 'Context project' })
    b.user({
      username: 'sergey',
      password: 'seed-pass',
      displayName: 'Sergey',
      admin: true,
      personalSpace: 'context-me',
    })
    b.member({ space: 'context-lab', username: 'sergey', role: 'owner' })
    b.project({ space: 'context-lab', path: 'product', displayName: 'Context Product' })

    b.agentRole({
      source: 'custom',
      name: 'context-benchmark',
      description: 'Exercise exact Project Role authoring without waking the ordinary corpus.',
      instructions:
        '# Context benchmark\n\nKeep the performance marker scoped to this hidden role package.',
      target: { kind: 'project', space: 'context-lab', path: 'product' },
    })

    const corpus = (space: string, root: string, count: number) => {
      for (let index = 1; index <= count; index++) {
        const serial = String(index).padStart(4, '0')
        const previous = index === 1 ? count : index - 1
        const previousTitle = `${space} corpus ${String(previous).padStart(4, '0')}`
        const title = `${space} corpus ${serial}`

        b.note({
          space,
          path: `${root}/bucket-${String(index % 180).padStart(3, '0')}/note-${serial}.md`,
          title,
          content: sizedBody(title, 2_048, `[[${previousTitle}]]`),
          tags: ['context-open', index % 7 === 0 ? 'weekly' : 'reference'],
          created: daysBefore(now, index % 365, 9),
          principal: 'user:sergey',
        })
      }
    }

    corpus('context-lab', 'product/corpus', 1_100)
    corpus('context-me', 'corpus', 2_700)

    const projectCategories = Math.max(1, Math.round(90 * scale))

    for (let index = 1; index <= projectCategories; index++) {
      const serial = String(index).padStart(3, '0')
      const title = `project-memory-${serial}`

      b.note({
        space: 'context-lab',
        path: `.notarium/memory/${title}.md`,
        title,
        class: 'agent-memory',
        content: sizedBody(title, 6_500),
        ...(index % 2 === 0 ? { summary: `Project memory summary ${serial}.` } : {}),
        muted: index > projectCategories - 2,
        projectMemory: { space: 'context-lab', path: 'product' },
        created: daysBefore(now, index % 90, 8),
        principal: 'pat:sergey:context-open',
      })
    }

    for (let index = 1; index <= 8; index++) {
      const serial = String(index).padStart(2, '0')
      const title = `personal-memory-${serial}`

      b.note({
        space: 'context-me',
        path: `.notarium/memory/${title}.md`,
        title,
        class: 'agent-memory',
        content: sizedBody(title, 6_500),
        summary: `Personal memory summary ${serial}.`,
        created: daysBefore(now, index + 10, 8),
        principal: 'pat:sergey:context-open',
      })
    }

    for (let index = 1; index <= 6; index++) {
      const serial = String(index).padStart(2, '0')

      for (const target of [
        { space: 'context-lab', root: 'product/context', scope: 'Project' },
        { space: 'context-me', root: 'context', scope: 'Personal' },
      ]) {
        const title = `${target.scope} always-load ${serial}`

        b.note({
          space: target.space,
          path: `${target.root}/pin-${serial}.md`,
          title,
          pin: true,
          content: sizedBody(title, 13_700),
          created: daysBefore(now, index + 20, 10),
          principal: 'user:sergey',
        })
      }
    }

    b.note({
      space: 'context-me',
      path: '.notarium/profile/profile.md',
      title: 'Profile',
      class: 'profile',
      content: '# Profile\n\nSergey works on performance-sensitive TypeScript systems.',
      tags: ['always-load'],
      created: daysBefore(now, 60, 8),
      principal: 'user:sergey',
    })

    return b.build()
  },
}
