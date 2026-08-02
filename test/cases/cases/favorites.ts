import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

// The merged Files + Feed section (#245) with a favorites lens (#42). One
// browsable space with enough content for a real feed overview AND a tree with
// several folders + a project, then a spread of STARRED entities: notes in
// DIFFERENT folders, a starred FOLDER, and a starred PROJECT. This is the case to
// seed when checking the rail Files↔Favorites invariant by hand — the favorites
// lens filters the tree while the feed stays the section's default view, and the
// single Files icon lights across feed / folder page / note. Grounded in #42 (the
// rail-highlight bug) and #245.
//
// Favorites are REAL-applier only (see FavoriteDecl / docs/seeds.md): `make seed
// CASE=favorites` stars them on the live stand; e2e/visual seed favorites through
// the API instead, so the fake projection just serves the notes/tree/feed here.
const body = (title: string, lead: string): string =>
  `# ${title}\n\n${lead}\n\n- A line of content so the feed card shows a snippet.\n- And another, to give the reader something to render.\n`

export const favorites: CaseSpec = {
  name: 'favorites',
  description:
    'The merged Files+Feed section (#245) with a favorites lens (#42): a browsable space (feed + tree), starred notes across folders, a starred folder and a starred project — exercises the rail Files↔Favorites invariant.',
  axes: ['favorites', 'structure', 'activity'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'main', displayName: 'Main' })
    // A marked project (its own row in the tree, favouritable as a project entity).
    b.project({ space: 'main', path: 'Roadmap', slug: 'roadmap', displayName: 'Roadmap' })

    // research/ — the folder we'll star (a whole favourited subtree).
    const finding = b.note({
      space: 'main',
      path: 'research/finding-01.md',
      title: 'Finding: cold-cache latency',
      content: body(
        'Finding: cold-cache latency',
        'Cold previews take ~60ms via files vs ~18s over a remote round-trip.',
      ),
      tags: ['research'],
      created: daysBefore(now, 34, 9),
      edits: [daysBefore(now, 8, 14)],
      principal: 'user:sergey',
    })
    b.note({
      space: 'main',
      path: 'research/finding-02.md',
      title: 'Finding: virtualization budget',
      content: body(
        'Finding: virtualization budget',
        'Every regime virtualizes; the DOM holds a viewport window, not the dataset.',
      ),
      tags: ['research'],
      created: daysBefore(now, 30, 10),
      principal: 'user:sergey',
    })
    b.note({
      space: 'main',
      path: 'research/finding-03.md',
      title: 'Finding: journal honesty',
      content: body(
        'Finding: journal honesty',
        'The heatmap shows activity that passed through Notarium, not file mtimes.',
      ),
      tags: ['research'],
      created: daysBefore(now, 22, 11),
      edits: [daysBefore(now, 5, 9)],
      principal: 'user:sergey',
    })
    b.note({
      space: 'main',
      path: 'research/finding-04.md',
      title: 'Finding: preview aborts',
      content: body(
        'Finding: preview aborts',
        'A batch whose ids all lost their claimants is aborted mid-flight.',
      ),
      tags: ['research'],
      created: daysBefore(now, 12, 16),
      principal: 'user:sergey',
    })

    // drafts/ — holds the OTHER starred note (a favourite in a different folder,
    // so the favorites lens has to reveal two separate ancestor chains).
    const draft = b.note({
      space: 'main',
      path: 'drafts/proposal.md',
      title: 'Proposal: merge Files and Feed',
      content: body(
        'Proposal: merge Files and Feed',
        'One section, feed as the default view, tree as persistent navigation.',
      ),
      tags: ['draft'],
      created: daysBefore(now, 26, 12),
      edits: [daysBefore(now, 3, 15)],
      principal: 'user:sergey',
    })
    b.note({
      space: 'main',
      path: 'drafts/outline.md',
      title: 'Outline: rail invariants',
      content: body(
        'Outline: rail invariants',
        'Files and Favorites are mutually exclusive; exactly one lights.',
      ),
      tags: ['draft'],
      created: daysBefore(now, 18, 13),
      principal: 'user:sergey',
    })

    // archive/ — a quieter folder, so Projects/Files views differ visibly.
    b.note({
      space: 'main',
      path: 'archive/old-plan.md',
      title: 'Old plan (superseded)',
      content: body(
        'Old plan (superseded)',
        'Kept for history; superseded by the current roadmap.',
      ),
      tags: ['archive'],
      created: daysBefore(now, 40, 9),
      principal: 'user:sergey',
    })
    b.note({
      space: 'main',
      path: 'archive/notes.md',
      title: 'Scratch notes',
      content: body('Scratch notes', 'Loose notes that never became anything.'),
      tags: ['archive'],
      created: daysBefore(now, 38, 10),
      principal: 'user:sergey',
    })

    // Roadmap/ (the project) — its own notes; the project itself is starred.
    b.note({
      space: 'main',
      path: 'Roadmap/q3.md',
      title: 'Q3 roadmap',
      content: body('Q3 roadmap', 'The plan for the quarter: SHELL epic, folders, search.'),
      tags: ['roadmap'],
      created: daysBefore(now, 28, 9),
      edits: [daysBefore(now, 6, 11)],
      principal: 'user:sergey',
    })
    b.note({
      space: 'main',
      path: 'Roadmap/shell.md',
      title: 'SHELL epic',
      content: body('SHELL epic', 'Files+Feed merge (A), then the document tab system (B).'),
      tags: ['roadmap'],
      created: daysBefore(now, 20, 10),
      principal: 'user:sergey',
    })
    b.note({
      space: 'main',
      path: 'Roadmap/backlog.md',
      title: 'Backlog',
      content: body('Backlog', 'Everything not yet scheduled.'),
      tags: ['roadmap'],
      created: daysBefore(now, 10, 14),
      principal: 'user:sergey',
    })

    // Root-level notes so the Files view has content the Projects view hides.
    b.note({
      space: 'main',
      path: 'welcome.md',
      title: 'Welcome',
      content: body('Welcome', 'Start here — the space overview.'),
      tags: [],
      created: daysBefore(now, 42, 8),
      principal: 'user:sergey',
    })
    b.note({
      space: 'main',
      path: 'inbox.md',
      title: 'Inbox',
      content: body('Inbox', 'Unfiled captures land here first.'),
      tags: [],
      created: daysBefore(now, 2, 17),
      principal: 'user:sergey',
    })

    // The stars: two notes in DIFFERENT folders, a whole FOLDER, and a PROJECT.
    b.favorite({ space: 'main', kind: 'note', ref: finding })
    b.favorite({ space: 'main', kind: 'note', ref: draft })
    b.favorite({ space: 'main', kind: 'folder', ref: 'research' })
    b.favorite({ space: 'main', kind: 'project', ref: 'Roadmap' })

    return b.build()
  },
}
