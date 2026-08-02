import { composeNote, CORPUS, fragmentById } from '../corpus'
import { cap, daysBefore, paragraph, TAGS, TOPICS, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

// #176 — the scrollbar showcase. One stand that overflows EVERY load-bearing scroll
// surface at once, so the auto-hide fade + glass-inset can be eyeballed everywhere
// without reseeding per surface:
//   • rail tree      — 14 folders × 11 notes (deep, virtualized) → the rail scrolls
//   • reader/editor  — one long note (the whole corpus: dozens of headings, every
//                      render feature) → the content scroll AND the editor's dual glass
//   • feed           — 150+ notes backdated across a year → the virtualized feed scrolls
//   • graph + asides — a dense wiki web (every note links siblings + the long-read hub)
//                      and many folders/tags → the graph, its search and its filter aside
//   • trash          — 28 deletions → the Trash page scrolls
// Uses the seeded rng for content variety (deterministic per SEED); volume is fixed
// (not scale-driven) so the showcase is stable across reseeds.
const FOLDERS = [
  'journal',
  'research',
  'notes',
  'ideas',
  'meetings',
  'reading',
  'projects/alpha',
  'projects/bravo',
  'archive/2025',
  'archive/2026',
  'specs',
  'runbooks',
  'retros',
  'drafts',
] as const
const PER_FOLDER = 11

// A curated corpus subset for a fraction of the notes (motley real content, clean
// hygiene — no ghosts/security/pathological, so `main` stays tidy). Same idea as feed-scroll.
const VARIED = [
  'code-typescript',
  'table-basic',
  'callout-looks',
  'list-nested-mixed',
  'blockquote-basic',
  'tasklist-mixed',
  'emphasis-basic',
  'heading-slug-anchor',
]

export const scrollbars: CaseSpec = {
  name: 'scrollbars',
  description:
    'One stand that overflows every scroll surface at once (#176): a deep rail tree, a long reader/editor note, a populated feed, a dense graph + its search/filter asides, and a full trash — the auto-hide + glass-inset showcase.',
  axes: ['scale', 'structure', 'content', 'graph', 'activity', 'trash'],
  build: ({ rng, now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'main', displayName: 'Main' })

    // The long note — overflows the reader, the editor (topbar + status-bar glass) and
    // its outline. It's also the graph's high-degree hub (everything links back to it).
    const LONG = 'The long read'
    b.note({
      space: 'main',
      path: 'reading/the-long-read.md',
      title: LONG,
      content: composeNote(LONG, CORPUS),
      tags: ['reading', 'long'],
      created: daysBefore(now, 45, 9),
      edits: [daysBefore(now, 22, 11), daysBefore(now, 6, 15)],
      principal: 'user:sergey',
    })

    // The deep, wide tree — feeds the rail, the feed and the graph. EVERY note wikilinks
    // the long-read hub + one prior sibling, so the graph and its search have a genuine
    // dense web with the hub at high inbound degree (a real spread to scroll through).
    const titles: string[] = [LONG]
    let seq = 0

    for (const folder of FOLDERS) {
      for (let i = 0; i < PER_FOLDER; i++) {
        seq += 1
        const title = `${cap(rng.pick(TOPICS))} ${seq}`
        // Siblings = prior TREE notes (titles[0] is the hub, linked explicitly below).
        const priorSiblings = titles.slice(1)
        titles.push(title)
        const sibling = priorSiblings.length ? ` and [[${rng.pick(priorSiblings)}]]` : ''
        // Appended to EVERY body (corpus-fragment notes included) so no note is an
        // orphan and the hub really is high-degree — matching the header claim.
        const seeAlso = `\n\nSee also [[${LONG}]]${sibling}.`
        const base = rng.bool(0.35)
          ? fragmentById(rng.pick(VARIED)).md
          : `# ${title}\n\n${paragraph(rng)}`
        const body = base + seeAlso
        const createdDays = rng.int(2, 360)
        // ~30% get one later edit (a chained revision for the feed/heatmap), always
        // strictly after create and before now — never after a delete (this note is live).
        const edits = rng.bool(0.3)
          ? [daysBefore(now, rng.int(1, createdDays - 1), rng.int(8, 20))]
          : []
        b.note({
          space: 'main',
          path: `${folder}/note-${String(seq).padStart(3, '0')}.md`,
          title,
          content: body,
          tags: [rng.pick(TAGS)],
          created: daysBefore(now, createdDays, rng.int(8, 20), rng.int(0, 59)),
          edits,
          principal: 'user:sergey',
        })
      }
    }

    // A full trash — 28 deletions across folders so the Trash page itself scrolls.
    // Each is created (30–58 days ago) then deleted (0–29 days ago): the delete is the
    // terminal event, always after create, no edit after — replay-safe.
    for (let d = 1; d <= 28; d++) {
      b.note({
        space: 'main',
        path: `${rng.pick(FOLDERS)}/deleted-${String(d).padStart(2, '0')}.md`,
        title: `Deleted ${d}`,
        content: `# Deleted ${d}\n\n${paragraph(rng)}`,
        created: daysBefore(now, 30 + d, 10),
        deletedAt: daysBefore(now, rng.int(0, 29), 12),
        principal: 'user:sergey',
      })
    }

    return b.build()
  },
}
