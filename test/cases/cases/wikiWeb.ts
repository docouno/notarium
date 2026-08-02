import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

// A dense wiki-link graph — the surface for the graph view, backlinks (aside
// Links panel), broken-link hygiene (#202: ghosts ranked by inbound refs),
// orphans and resolved-via-former-name (#100 alias). Titles ARE the link targets
// (the `[[Title]]` preprocessor resolves by title/slug), so the web actually
// connects on the stand.

const link = (t: string) => `[[${t}]]`

/** ~16 interlinked notes: 2 hubs, topic notes, orphans, ghosts of varying inbound
 *  degree, and a renamed note whose old title still resolves. */
export const wikiWeb: CaseSpec = {
  name: 'wiki-web',
  description:
    'A dense wikilink graph — hubs, backlinks, orphans and ghost/broken links of varying inbound degree (#202).',
  axes: ['graph', 'identity', 'content'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'main', displayName: 'Main' })

    const note = (title: string, body: string, day: number) =>
      b.note({
        space: 'main',
        path: `wiki/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`,
        title,
        content: `# ${title}\n\n${body}`,
        tags: ['wiki'],
        created: daysBefore(now, day, 10),
        principal: 'user:sergey',
      })

    // Two hubs — high inbound degree.
    note(
      'Hub Index',
      `The map of everything. Jump to ${link('Roadmap')}, ${link('Search v2')} or any topic below.`,
      40,
    )
    note(
      'Roadmap',
      `Depends on ${link('Search v1')} (renamed) and the still-unwritten ${link('Unwritten Spec')}.`,
      39,
    )

    // Topic notes — each links the hubs + a sibling, some link ghosts.
    const topics = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel']
    topics.forEach((t, i) => {
      const sibling = topics[(i + 1) % topics.length]
      const ghost = i % 3 === 0 ? ` It blocks on ${link('Unwritten Spec')}.` : ''
      const draftGhost = i === 2 ? ` See also ${link('Draft Idea')}.` : ''
      note(
        t,
        `Topic ${t}. Part of ${link('Hub Index')}, feeds ${link('Roadmap')}, relates to ${link(sibling)}.${ghost}${draftGhost}`,
        30 - i,
      )
    })

    // A renamed note: created as "Search v1", retitled to "Search v2" — the old
    // title stays a resolvable alias (#100), so Roadmap's [[Search v1]] still lands.
    const searchId = b.note({
      space: 'main',
      path: 'wiki/search-v2.md',
      title: 'Search v1',
      content: `# Search v1\n\nThe search subsystem. Linked from ${link('Hub Index')}.`,
      tags: ['wiki'],
      created: daysBefore(now, 35, 9),
      principal: 'user:sergey',
    })
    b.event({
      op: 'edit',
      date: daysBefore(now, 4, 12),
      space: 'main',
      noteId: searchId,
      title: 'Search v2',
      content: `# Search v2\n\nThe search subsystem (v2). Linked from ${link('Hub Index')}.`,
      principal: 'user:sergey',
    })

    // Orphans — no links in or out.
    note('Loose Note One', 'A note nobody links to and that links nowhere.', 12)
    note('Loose Note Two', 'Another island in the graph.', 8)

    return b.build()
  },
}
