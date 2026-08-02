import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

// The graph view + graph-health dashboard (#38/#202/#25): a HUB (high in-degree),
// ORPHANS (degree 0), GHOST links RANKED by inbound ref-count (#202: Roadmap 3 > Todo
// 2 > Random typo 1), a RESOLVED-VIA-FORMER-NAME row (a rename alias still resolving),
// and two dense COMMUNITIES that span different folders — the emergent clusters Louvain
// surfaces ("these notes belong together though they live in 4 folders"). Distinct from
// wiki-web (link RESOLUTION); this drives the Hygiene surface + graph clustering.
const link = (t: string) => `[[${t}]]`

export const graph: CaseSpec = {
  name: 'graph',
  description:
    'Hub + orphans + ghost links ranked by inbound refs + a resolved-via-former-name row + two cross-folder communities — the graph view & Hygiene dashboard (#38/#202).',
  axes: ['graph', 'identity'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'main', displayName: 'Main' })
    const note = (path: string, title: string, body: string, day: number): string =>
      b.note({
        space: 'main',
        path,
        title,
        content: `# ${title}\n\n${body}`,
        tags: ['graph'],
        created: daysBefore(now, day, 10),
        principal: 'user:sergey',
      })

    // A hub — many notes point at it (high in-degree).
    note('hub/index-map.md', 'Index Map', 'The map of everything — most notes link here.', 40)

    // Ghost/broken links ranked by inbound ref-count (#202): Roadmap 3 > Todo 2 > Random typo 1.
    note(
      'links/source-a.md',
      'Source A',
      `Links ${link('Index Map')}, the unwritten ${link('Roadmap')} and ${link('Todo')}.`,
      30,
    )
    note(
      'links/source-b.md',
      'Source B',
      `Links ${link('Index Map')}, ${link('Roadmap')} and ${link('Todo')}.`,
      29,
    )
    note(
      'links/source-c.md',
      'Source C',
      `Links ${link('Index Map')}, ${link('Roadmap')} and a ${link('Random typo')}.`,
      28,
    )

    // Community 1 — "auth", spanning three folders but densely interlinked.
    note(
      'security/login.md',
      'Login flow',
      `Feeds ${link('Session')} and ${link('Token exchange')}.`,
      26,
    )
    note(
      'ui/session-panel.md',
      'Session',
      `Depends on ${link('Login flow')} and ${link('Token exchange')}.`,
      25,
    )
    note(
      'api/token.md',
      'Token exchange',
      `Used by ${link('Login flow')} and ${link('Session')}.`,
      24,
    )

    // Community 2 — "editor", also spanning folders.
    note(
      'editor/caret.md',
      'Caret',
      `Interacts with ${link('Selection')} and ${link('Undo stack')}.`,
      22,
    )
    note(
      'editor/selection.md',
      'Selection',
      `Interacts with ${link('Caret')} and ${link('Undo stack')}.`,
      21,
    )
    note(
      'docs/undo-guide.md',
      'Undo stack',
      `Coordinates ${link('Caret')} and ${link('Selection')}.`,
      20,
    )

    // Orphans — no links in or out (degree 0).
    note('orphans/charlie.md', 'Charlie', 'An island — nobody links here and it links nowhere.', 12)
    note('orphans/delta.md', 'Delta', 'Another orphan.', 11)

    // Resolved-via-former-name: created "Legacy Name", renamed to "Renamed Note"; an old
    // [[Legacy Name]] link still resolves → a "resolved via former name" health row.
    const renamed = note(
      'rename/renamed.md',
      'Legacy Name',
      `Linked from ${link('Index Map')}.`,
      35,
    )
    b.event({
      op: 'edit',
      date: daysBefore(now, 5, 12),
      space: 'main',
      noteId: renamed,
      title: 'Renamed Note',
      content: `# Renamed Note\n\nRenamed; the old title stays a resolvable alias. Linked from ${link('Index Map')}.`,
      principal: 'user:sergey',
    })
    note(
      'rename/referrer.md',
      'Referrer',
      `Still points at ${link('Legacy Name')} by its OLD title — resolves via the alias.`,
      6,
    )

    return b.build()
  },
}
