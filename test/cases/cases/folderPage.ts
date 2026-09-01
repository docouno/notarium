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
    'Folders with index.md pages, nested pages, a deep breadcrumb trail, a plain (page-less) folder, and the agent-facing present/missing states MCP projects — the FOLDERS epic (#212/#213/#214) plus #415.',
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
      // The page of an active project is its agent overview — pinned, so the body
      // rides always-load while the structural marker rides the bootstrap.
      pin: true,
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

    // ── The agent-facing states (#415) ────────────────────────────────────
    // An agent browsing these folders must be able to tell a cover from a child, and
    // a folder that HAS no page from one it should leave alone. Each folder below is
    // one of those states, addressable by a project handle where the slot's create
    // action needs one.

    // A project root WITH a page: `list_notes` answers `present` and MCP loads the
    // body through the ordinary always-load pin.
    b.project({ space: 'main', path: 'docs', slug: 'docs', displayName: 'Documentation' })

    // A project root WITHOUT one: the bootstrap stays quiet, and only an explicit
    // browse reveals the missing slot.
    b.project({ space: 'main', path: 'notes', slug: 'notes', displayName: 'Notes' })

    // A project whose page carries NO always-load tag: `start_session` still reports the
    // structural marker, and the body stays out of the eager context. The seeder marks
    // projects before it replays notes, so the mark → auto-pin transition never fires
    // here and the tag is declared explicitly where a state needs it (see `docs` above,
    // `pin: true`). Which means this state reads as "never pinned" rather than as
    // "unpinned by hand" — indistinguishable to every surface that consumes it, and the
    // seeder's step order is a recorded tail, not a claim this fixture can make.
    b.project({
      space: 'main',
      path: 'research/2026-08-28_scrollbars',
      slug: 'scrollbars',
      displayName: 'Scrollbars',
    })

    // A research package with source notes and no page — the shape where an agent
    // used to author a duplicate summary note instead of the folder's cover.
    for (const [i, title] of ['Protocol and fixtures', 'Reviewed ledger', 'Decision'].entries()) {
      b.note({
        space: 'main',
        path: `research/2026-08-30_agent-contract/0${i + 1}-${title.toLowerCase().replaceAll(' ', '-')}.md`,
        title,
        content: `# ${title}\n\nOne source note of the research package. The package itself has no page.`,
        tags: ['research'],
        created: daysBefore(now, 11 - i, 9),
        principal: 'user:sergey',
      })
    }

    // A research package WITH a page whose tag the ordinary item filter does not
    // select: the slot must survive filtering, because it is not an item.
    b.note({
      space: 'main',
      path: 'research/2026-08-28_scrollbars/index.md',
      title: 'Scrollbars',
      content: '# Scrollbars\n\nThe cover of a research package. Its own tag is not `source`.',
      tags: ['research'],
      created: daysBefore(now, 10, 9),
      principal: 'user:sergey',
    })
    b.note({
      space: 'main',
      path: 'research/2026-08-28_scrollbars/measurements.md',
      title: 'Measurements',
      content: '# Measurements\n\nA source note carrying the tag a filtered listing asks for.',
      tags: ['research', 'source'],
      created: daysBefore(now, 10, 10),
      principal: 'user:sergey',
    })

    // A task package: artifacts, no page. A missing slot must not read as "these
    // artifacts are incomplete".
    for (const [i, artifact] of ['brief', 'plan', 'log', 'recap'].entries()) {
      b.note({
        space: 'main',
        path: `tasks/212-folder-page/${artifact}.md`,
        title: artifact,
        content: `# ${artifact}\n\nA task artifact — an ordinary note, not a folder page.`,
        tags: ['tasks'],
        created: daysBefore(now, 9, 9 + i),
        principal: 'user:sergey',
      })
    }

    // An ordinary README beside no page: #415 never migrates or promotes it.
    b.note({
      space: 'main',
      path: 'vendor/README.md',
      title: 'README',
      content: '# README\n\nAn ordinary note that happens to be named README. It stays one.',
      tags: ['notes'],
      created: daysBefore(now, 8, 10),
      principal: 'user:sergey',
    })

    return b.build()
  },
}
