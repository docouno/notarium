import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

/** The exact #267 failure shape: an editor changes search-visible body text and a
 *  graph edge without changing file size or mtime. The real seed writes the
 *  initial version through the production store, then mutates the markdown file
 *  behind its back. On the restarted stand, list/search/graph must all converge
 *  to the replacement content. */
export const externalEdits: CaseSpec = {
  name: 'external-edits',
  description:
    'A same-size, mtime-preserving external file edit that changes body search text and moves a wikilink edge (#267).',
  axes: ['search', 'graph', 'content'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'main', displayName: 'Main' })
    b.note({
      space: 'main',
      path: 'external/target-a.md',
      title: 'Target A',
      content: '# Target A\n\nThe original graph destination.',
      created: daysBefore(now, 12),
      principal: 'user:sergey',
    })
    b.note({
      space: 'main',
      path: 'external/target-b.md',
      title: 'Target B',
      content: '# Target B\n\nThe replacement graph destination.',
      created: daysBefore(now, 11),
      principal: 'user:sergey',
    })
    const probe = b.note({
      space: 'main',
      path: 'external/probe.md',
      title: 'External edit probe',
      content:
        '# External edit probe\n\nSearch marker: stale-token.\n\nGraph destination: [[Target A]].',
      created: daysBefore(now, 10),
      principal: 'user:sergey',
    })
    b.externalRewrite({
      note: probe,
      replacements: [
        { from: 'stale-token', to: 'fresh-token' },
        { from: '[[Target A]]', to: '[[Target B]]' },
      ],
    })

    return b.build()
  },
}
