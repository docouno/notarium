import { cap, daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

// #242 — the explorer scroll-position invariant. Expanding or collapsing a folder
// ABOVE the open note (or any reflow above the viewport) must NOT move the scroll;
// the tree only navigates to the active row on a real reveal (open a note / sync).
// Reproducing it needs a DEEP tree: a note buried near the bottom with many
// foldable folders above it, so a reflow up top is actually felt below the fold.
//
// Deterministic (no rng-driven volume) so `make seed CASE=explorer-scroll` reproduces
// byte-for-byte — the manual-QA companion (same CLASS of deep tree, its own shape) to
// test/e2e/explorer-scroll-position.spec.ts, which posts its own inline fixture.
const FOLDERS = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
  'hotel',
  'india',
  'juliet',
  'kilo',
  'lima',
] as const
const PER_FOLDER = 8

export const explorerScroll: CaseSpec = {
  name: 'explorer-scroll',
  description:
    'A deep tree — a note buried near the bottom with many foldable folders above it — for the explorer scroll-position invariant (#242): a reflow above the open note must not move the scroll.',
  axes: ['structure', 'scale'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'main', displayName: 'Main' })

    // Each folder carries a handful of notes — enough that toggling one above the
    // open note is a visible reflow (8 rows ≈ 232px at the fixed row height).
    FOLDERS.forEach((folder, fi) => {
      for (let i = 1; i <= PER_FOLDER; i++) {
        b.note({
          space: 'main',
          path: `${folder}/${folder}-${String(i).padStart(2, '0')}.md`,
          title: `${cap(folder)} ${i}`,
          content: `# ${cap(folder)} ${i}\n\nA row in the ${folder} folder — filler that makes the tree tall enough to scroll deep.`,
          // Older toward the top of the alphabet so the timeline is chronological.
          created: daysBefore(now, fi * PER_FOLDER + i + 1, 10, i),
          principal: 'user:sergey',
        })
      }
    })

    // The buried note the QA/e2e opens: in the LAST folder, well below the fold, and
    // the newest note so it reads as "where you were working".
    b.note({
      space: 'main',
      path: `${FOLDERS[FOLDERS.length - 1]}/buried-note.md`,
      title: 'Buried Note',
      content:
        '# Buried Note\n\nOpen me, scroll up to a folder above, then expand or collapse it — the scroll must stay exactly where you left it (#242). The tree only jumps to me when you actually open me or hit Refresh (reveal-on-sync, #161).',
      created: daysBefore(now, 1, 12),
      principal: 'user:sergey',
    })

    return b.build()
  },
}
