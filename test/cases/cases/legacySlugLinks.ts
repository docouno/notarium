import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

/** Compatibility state left by pre-#296 ASCII filenames after notes move onto
 * their Unicode names. Both a unique survivor and a two-identity collision are
 * present; the old basename is never a current filename in the final snapshot. */
export const legacySlugLinks: CaseSpec = {
  name: 'legacy-slug-links',
  description:
    'Moved pre-#296 Unicode filenames: one durable legacy link survives, while a two-identity old-name collision stays a ghost.',
  axes: ['identity', 'graph', 'search', 'history', 'trash', 'structure'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)

    b.space({ slug: 'main', displayName: 'Main' })
    const unique = b.note({
      space: 'main',
      path: 'old/aza-stan-zhospary.md',
      title: 'Қазақстан жоспары',
      content: '# Қазақстан жоспары\n\nThe unique compatibility target.',
      created: daysBefore(now, 30),
      principal: 'user:sergey',
    })
    b.event({
      op: 'edit',
      date: daysBefore(now, 29),
      space: 'main',
      noteId: unique,
      path: 'current/қazaқstan-zhospary.md',
      content: '# Қазақстан жоспары\n\nMoved onto the current Unicode filename.',
      principal: 'user:sergey',
    })
    b.event({
      op: 'delete',
      date: daysBefore(now, 10),
      space: 'main',
      noteId: unique,
      principal: 'user:sergey',
    })
    b.event({
      op: 'restore',
      date: daysBefore(now, 9),
      space: 'main',
      noteId: unique,
      principal: 'user:sergey',
    })

    const firstCollision = b.note({
      space: 'main',
      path: 'old-a/a-b.md',
      title: 'AҚB',
      content: '# AҚB\n\nFirst collision claimant.',
      created: daysBefore(now, 28),
      principal: 'user:sergey',
    })
    b.event({
      op: 'edit',
      date: daysBefore(now, 26),
      space: 'main',
      noteId: firstCollision,
      path: 'current/aқb.md',
      principal: 'user:sergey',
    })
    const secondCollision = b.note({
      space: 'main',
      path: 'old-b/a-b.md',
      title: 'AҒB',
      content: '# AҒB\n\nSecond collision claimant.',
      created: daysBefore(now, 27),
      principal: 'user:sergey',
    })
    b.event({
      op: 'edit',
      date: daysBefore(now, 25),
      space: 'main',
      noteId: secondCollision,
      path: 'current/aғb.md',
      principal: 'user:sergey',
    })

    b.note({
      space: 'main',
      path: 'current/legacy-link-source.md',
      title: 'Legacy link source',
      content:
        '# Legacy link source\n\nUnique: [[aza-stan-zhospary]].\n\nAmbiguous on purpose: [[a-b]].',
      created: daysBefore(now, 8),
      principal: 'user:sergey',
    })

    return b.build()
  },
}
