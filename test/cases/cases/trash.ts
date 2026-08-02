import { cap, daysBefore, TOPICS, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

const liveNotes = (b: WorldBuilder, space: string, n: number, now: Date) => {
  for (let i = 1; i <= n; i++) {
    b.note({
      space,
      path: `notes/live-${String(i).padStart(2, '0')}.md`,
      title: `${cap(TOPICS[i % TOPICS.length])} ${i}`,
      created: daysBefore(now, 30 - i, 10),
      principal: 'user:sergey',
    })
  }
}

/** An empty trash over an otherwise normal, small stand — the zero-state of #79.
 *  Pairs with `trash-mixed` for the empty-vs-full comparison the issue names. */
export const trashEmpty: CaseSpec = {
  name: 'trash-empty',
  description: 'A small live stand with nothing deleted — the empty-trash zero-state (#79).',
  axes: ['trash'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'main', displayName: 'Main' })
    liveNotes(b, 'main', 6, now)
    return b.build()
  },
}

/** A full, mixed trash (#79): standalone deleted notes, a whole deleted folder
 *  (its notes tombstoned together), and a note deleted out of a marked project —
 *  5 deleted notes + a deleted folder + a deleted project, as the issue asks.
 *  Live notes remain so the trash sits over a real tree. */
export const trashMixed: CaseSpec = {
  name: 'trash-mixed',
  description:
    'Live notes + deleted notes, a deleted folder, a note deleted from a project, and a deleted-then-restored note — a full mixed trash (#79/#184).',
  axes: ['trash', 'history'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'main', displayName: 'Main' })
    b.project({ space: 'main', path: 'archive', displayName: 'Archive' })

    liveNotes(b, 'main', 8, now)

    // 5 standalone deleted notes, created earlier and tombstoned across recent days.
    for (let i = 1; i <= 5; i++) {
      b.note({
        space: 'main',
        path: `notes/gone-${String(i).padStart(2, '0')}.md`,
        title: `Dropped idea ${i}`,
        created: daysBefore(now, 40 + i, 9),
        deletedAt: daysBefore(now, i, 12),
        principal: 'user:sergey',
      })
    }

    // A whole deleted folder: three notes under drafts/ all tombstoned the same day.
    for (let i = 1; i <= 3; i++) {
      b.note({
        space: 'main',
        path: `drafts/scratch-${String(i).padStart(2, '0')}.md`,
        title: `Scratch ${i}`,
        created: daysBefore(now, 25, 9),
        deletedAt: daysBefore(now, 6, 15),
        principal: 'user:sergey',
      })
    }

    // A note deleted out of the marked project.
    b.note({
      space: 'main',
      path: 'archive/retired-plan.md',
      title: 'Retired plan',
      created: daysBefore(now, 60, 9),
      deletedAt: daysBefore(now, 3, 11),
      principal: 'user:sergey',
    })

    // A note deleted and then RESTORED — it leaves the trash and the journal carries a
    // `restore` revision, so the feed/history show "restored" (exercises the real
    // applier's restore path, #79/#184).
    b.note({
      space: 'main',
      path: 'notes/recovered-draft.md',
      title: 'Recovered draft',
      content: '# Recovered draft\n\nDeleted by mistake, then restored from the trash.',
      created: daysBefore(now, 30, 9),
      deletedAt: daysBefore(now, 8, 10),
      restoredAt: daysBefore(now, 2, 14),
      principal: 'user:sergey',
    })

    return b.build()
  },
}

/** A BIG, MIXED trash (#79/#110/#247) — every trash surface at once, on one stand:
 *  a long run of deleted notes that overflows the viewport (so the list scrolls and
 *  content sits UNDER the floating footer — the scroll-aware glass state of #185/#247,
 *  where the footer must frost the instant a row is picked and the top chrome's divider
 *  rides the scroll), PLUS two deleted spaces (which turn on the Notes/Spaces/All tab
 *  switcher and fill the Spaces tab), a whole deleted folder, a note deleted out of a
 *  marked project, and a deleted-then-restored note. `scale` multiplies the deleted-notes
 *  run (the default already overflows a normal window; SCALE≈5 pushes it past 100 to
 *  surface "Select all N"): `make seed CASE=trash-long [SCALE=5]`.
 *  NB the "outside Notarium" (external, non-restorable) row is NOT seedable through this
 *  timeline — it needs a principal-less, body-less delete the engine only makes from a
 *  real external file removal — so that one chip stays out of the catalog. */
export const trashLong: CaseSpec = {
  name: 'trash-long',
  description:
    'A big mixed trash: a long deleted-notes list that overflows the viewport (scroll-glass, #185/#247) + deleted spaces (the Notes/Spaces switcher), a deleted folder, a project note, and a restored one — every trash surface at once (#79/#110).',
  axes: ['trash', 'history', 'scale'],
  build: ({ now, scale }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'main', displayName: 'Main' })
    b.project({ space: 'main', path: 'archive', displayName: 'Archive' })

    // Two soft-archived spaces (#110): they land in the Trash → Spaces tab, and having
    // BOTH kinds (notes + spaces) is what turns on the Notes/Spaces/All switcher. Each
    // keeps a couple of notes so restoring the space brings real data back.
    b.space({ slug: 'old-notes', displayName: 'Old Notes', archived: true })
    b.space({ slug: 'sandbox', displayName: 'Sandbox', archived: true })
    for (const slug of ['old-notes', 'sandbox']) {
      for (let i = 1; i <= 2; i++) {
        b.note({
          space: slug,
          path: `notes/kept-${i}.md`,
          title: `${cap(slug)} note ${i}`,
          content: `# Kept ${i}\n\nData inside an archived space.`,
          created: daysBefore(now, 30 - i, 10),
          principal: 'user:sergey',
        })
      }
    }

    // A small live tree so the trash sits over a real space, then a long run of deleted
    // notes — count scales, floored high enough to overflow the viewport on its own.
    liveNotes(b, 'main', 6, now)

    const count = Math.max(24, Math.round(24 * scale))

    for (let i = 1; i <= count; i++) {
      b.note({
        space: 'main',
        path: `notes/purged-${String(i).padStart(3, '0')}.md`,
        title: `${cap(TOPICS[i % TOPICS.length])} draft ${i}`,
        // Created 91–120 days ago — ALWAYS older than any tombstone below (max 40 days),
        // for EVERY i, so a note is never deleted before it exists (the real applier
        // replays op-by-op and would throw on a delete-before-create; that inversion is
        // what a scale-independent gap between these two ranges prevents).
        created: daysBefore(now, 120 - (i % 30), 9),
        // Spread the tombstones across ~40 days so the meta dates read as real,
        // newest first (the trash orders by deletedAt desc).
        deletedAt: daysBefore(now, 1 + (i % 40), 8 + (i % 12)),
        principal: 'user:sergey',
      })
    }

    // A whole deleted folder: three notes under drafts/ tombstoned the same day.
    for (let i = 1; i <= 3; i++) {
      b.note({
        space: 'main',
        path: `drafts/scratch-${String(i).padStart(2, '0')}.md`,
        title: `Scratch ${i}`,
        created: daysBefore(now, 25, 9),
        deletedAt: daysBefore(now, 6, 15),
        principal: 'user:sergey',
      })
    }
    // A note deleted out of the marked project — its row shows the project path.
    b.note({
      space: 'main',
      path: 'archive/retired-plan.md',
      title: 'Retired plan',
      created: daysBefore(now, 60, 9),
      deletedAt: daysBefore(now, 3, 11),
      principal: 'user:sergey',
    })
    // A note deleted and then RESTORED — leaves the trash, journal carries a restore.
    b.note({
      space: 'main',
      path: 'notes/recovered-draft.md',
      title: 'Recovered draft',
      content: '# Recovered draft\n\nDeleted by mistake, then restored from the trash.',
      created: daysBefore(now, 30, 9),
      deletedAt: daysBefore(now, 8, 10),
      restoredAt: daysBefore(now, 2, 14),
      principal: 'user:sergey',
    })

    return b.build()
  },
}
