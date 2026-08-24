import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

/** The exact #327 failure shape: two spaces whose files claim ONE `notarium-id`
 *  — what a copied vault folder produces. The real seed writes both notes through
 *  the production store, then plants the owner's id in the claimant's frontmatter
 *  behind the store's back, leaving the collision on disk. On the next boot the
 *  arbiter must settle a single owner, converge the claimant's file onto its own
 *  id, and keep that answer across restarts and polls — where it used to swing
 *  with whichever space swept last. */
export const identityCollision: CaseSpec = {
  name: 'identity-collision',
  description:
    'Two spaces whose files claim one notarium-id: the cross-space collision the global arbiter settles (#327).',
  axes: ['identity', 'structure', 'history'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'main', displayName: 'Main' })
    b.space({ slug: 'archive', displayName: 'Archive' })
    const owner = b.note({
      space: 'main',
      path: 'notes/shared-origin.md',
      title: 'Shared origin',
      content: '# Shared origin\n\nThe note whose id was copied into another space.',
      created: daysBefore(now, 20),
      principal: 'user:sergey',
      // A second state, so the collision lands on a note with real history to
      // contaminate rather than a single row.
      edits: [daysBefore(now, 5)],
    })
    const claimant = b.note({
      space: 'archive',
      path: 'notes/copied-folder.md',
      title: 'Copied folder',
      content: '# Copied folder\n\nA vault folder copied wholesale into a second space.',
      created: daysBefore(now, 4),
      principal: 'user:sergey',
    })
    b.externalIdentityClaim({ note: claimant, claimFrom: owner })
    // What the settlement LEAVES: the claimant's contaminated revision, served as a
    // gap, and the ordinary edit that follows it. The pair is the whole point — the
    // gap must show as `unavailable` and the edit after it must stay an edit, which
    // is only decidable from the entry role the writer stored.
    b.event({
      op: 'edit',
      date: daysBefore(now, 3),
      space: 'archive',
      noteId: claimant,
      content: '# Copied folder\n\nEdited while the two spaces still shared one id.',
      principal: 'user:sergey',
      unavailable: true,
    })
    b.event({
      op: 'edit',
      date: daysBefore(now, 2),
      space: 'archive',
      noteId: claimant,
      content: '# Copied folder\n\nEdited after the arbiter settled the collision.',
      principal: 'user:sergey',
    })

    return b.build()
  },
}
