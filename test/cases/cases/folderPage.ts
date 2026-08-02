import { composeNote, pickFragments } from '../corpus'
import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

// The FOLDERS epic (#212/#213/#214): a folder PAGE is a visible `index.md` inside the
// folder — the reader shows its body then a direct-children summary; breadcrumbs drop
// the `index` leaf; the tree hides it from the children list. This case seeds folders
// WITH pages (nested), a deep leaf for a long breadcrumb trail, and a PLAIN folder
// without a page (renders a virtual folder page). Grounded in folder-page.md.
const link = (t: string) => `[[${t}]]`

export const folderPage: CaseSpec = {
  name: 'folder-page',
  description:
    'Folders with index.md pages, nested pages, a deep breadcrumb trail and a plain (page-less) folder — the FOLDERS epic (#212/#213/#214).',
  axes: ['folder-page', 'structure', 'content'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'main', displayName: 'Main' })

    // A folder WITH a page: docs/index.md is the cover of docs/.
    b.note({
      space: 'main',
      path: 'docs/index.md',
      title: 'Documentation',
      content: `# Documentation\n\nThe cover page of the docs folder — the reader shows this body, then a summary of the direct children below.\n\n> [!info] Folder page\n> This is an \`index.md\`: breadcrumbs drop the \`index\` leaf and the tree hides it from the children list, but it stays in graph/search.\n\nStart with ${link('Getting started')} or browse ${link('Guides')}.\n`,
      tags: ['docs'],
      created: daysBefore(now, 20, 9),
      principal: 'user:sergey',
    })
    b.note({
      space: 'main',
      path: 'docs/getting-started.md',
      title: 'Getting started',
      content: '# Getting started\n\nA direct child of the docs folder.',
      tags: ['docs'],
      created: daysBefore(now, 19, 10),
      principal: 'user:sergey',
    })
    b.note({
      space: 'main',
      path: 'docs/architecture.md',
      title: 'Architecture',
      content: '# Architecture\n\nAnother direct child of docs.',
      tags: ['docs'],
      created: daysBefore(now, 18, 10),
      principal: 'user:sergey',
    })

    // A NESTED folder page: docs/guides/index.md.
    b.note({
      space: 'main',
      path: 'docs/guides/index.md',
      title: 'Guides',
      content: `# Guides\n\nThe guides section cover. Deeper pages: ${link('Seeding a stand')}, ${link('The reader')}.\n`,
      tags: ['docs'],
      created: daysBefore(now, 17, 9),
      principal: 'user:sergey',
    })
    b.note({
      space: 'main',
      path: 'docs/guides/seeding.md',
      title: 'Seeding a stand',
      content: composeNote(
        'Seeding a stand',
        pickFragments('callout-looks', 'code-typescript', 'table-basic'),
      ),
      tags: ['docs', 'guide'],
      created: daysBefore(now, 16, 10),
      principal: 'user:sergey',
    })
    b.note({
      space: 'main',
      path: 'docs/guides/reader.md',
      title: 'The reader',
      content: composeNote(
        'The reader',
        pickFragments('math-inline-dollar', 'mermaid-flowchart', 'wikilink-basic'),
      ),
      tags: ['docs', 'guide'],
      created: daysBefore(now, 15, 10),
      principal: 'user:sergey',
    })

    // A deep leaf → a long breadcrumb trail: Documentation / Guides / advanced / Tuning.
    b.note({
      space: 'main',
      path: 'docs/guides/advanced/tuning.md',
      title: 'Tuning',
      content:
        '# Tuning\n\nA deep leaf. Its breadcrumb trail is Documentation / Guides / advanced / Tuning.',
      tags: ['docs'],
      created: daysBefore(now, 14, 11),
      principal: 'user:sergey',
    })

    // A PLAIN folder without a page — the reader shows a virtual folder page (title + summary).
    b.note({
      space: 'main',
      path: 'notes/first.md',
      title: 'First note',
      content:
        '# First note\n\nA note in a plain folder with no index.md — the folder renders a virtual page.',
      tags: ['notes'],
      created: daysBefore(now, 13, 10),
      principal: 'user:sergey',
    })
    b.note({
      space: 'main',
      path: 'notes/second.md',
      title: 'Second note',
      content: '# Second note\n\nAnother plain-folder note.',
      tags: ['notes'],
      created: daysBefore(now, 12, 10),
      principal: 'user:sergey',
    })

    return b.build()
  },
}
