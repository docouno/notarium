import { fragmentById } from '../corpus'
import { cap, daysBefore, TAGS, TOPICS, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

const FOLDERS = [
  'journal',
  'research',
  'notes',
  'ideas',
  'archive/2025',
  'archive/2026',
  'meetings',
  'reading',
]

// A curated "varied realistic content" subset of the corpus (no ghosts/security/
// pathological, to keep `main`'s hygiene clean) — a fraction of the notes get one of
// these as their body so the active workspace reads as motley real content, not filler.
const VARIED = [
  'code-typescript',
  'code-languages',
  'table-basic',
  'callout-looks',
  'list-nested-mixed',
  'math-inline-dollar',
  'blockquote-basic',
  'tasklist-mixed',
  'emphasis-basic',
  'footnote-basic',
  'unicode-cyrillic',
  'heading-slug-anchor',
  'imports-claude-conversation',
]

/** ≈300 notes spread across a year with backdated dates, ~a third edited on later
 *  days — a feed that actually scrolls (#68 virtualization), a heatmap with real
 *  daily buckets, and a "what changed" log with chained revisions. The workhorse
 *  case for scroll-regression QA and visual snapshots of a populated stand. */
export const feedScroll: CaseSpec = {
  name: 'feed-scroll',
  description:
    '≈300 notes over a year, backdated + partly edited — populated feed, heatmap and virtualized scroll.',
  axes: ['activity', 'scale'],
  build: ({ rng, scale, now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'main', displayName: 'Main' })

    const count = Math.max(1, Math.round(300 * scale))

    for (let i = 1; i <= count; i++) {
      const folder = rng.pick(FOLDERS)
      const createdDays = rng.int(0, 364)
      const created = daysBefore(now, createdDays, rng.int(8, 20), rng.int(0, 59))

      // ~35% of notes get 1–3 later edits — the chained revisions the heatmap
      // counts as `edited` and the feed shows as a sequence, not isolated rows.
      const edits: string[] = []

      if (createdDays > 1 && rng.bool(0.35)) {
        for (let e = 0, n = rng.int(1, 3); e < n; e++) {
          const editDays = rng.int(0, createdDays - 1)
          edits.push(daysBefore(now, editDays, rng.int(8, 20), rng.int(0, 59)))
        }
        edits.sort()
      }

      b.note({
        space: 'main',
        path: `${folder}/note-${String(i).padStart(3, '0')}.md`,
        title: `${cap(rng.pick(TOPICS))} ${i}`,
        // ~40% carry a real, varied corpus fragment; the rest keep the light filler.
        content: rng.bool(0.4) ? fragmentById(rng.pick(VARIED)).md : undefined,
        tags: [rng.pick(TAGS)],
        created,
        edits,
        principal: 'user:sergey',
      })
    }

    return b.build()
  },
}
