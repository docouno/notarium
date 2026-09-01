import { cap, daysBefore, TOPICS, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

const PRINCIPALS = ['user:sergey', 'user:alex']

/** Dashboard Activity's deterministic hot-note/folder hierarchy plus a broader
 * multi-week background corpus for Projects and Hygiene. */
export const dashboardActivity: CaseSpec = {
  name: 'dashboard-activity',
  description:
    'Hot-note grouping, folder/root/unavailable states, shared/solo authors, projects and broken links.',
  axes: ['activity', 'history', 'graph'],
  build: ({ rng, scale, now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'main', displayName: 'Main' })
    b.space({ slug: 'solo', displayName: 'Solo' })
    b.project({ space: 'main', path: 'alpha', displayName: 'Project Alpha' })
    b.project({ space: 'main', path: 'beta', displayName: 'Project Beta' })

    // Two authors so the #218 "mine vs all" heatmap toggle and the feed's author
    // resolution both have real principals to split on.
    b.user({ username: 'sergey', password: 'seed-pass', displayName: 'Sergey', admin: true })
    b.user({ username: 'alex', password: 'seed-pass', displayName: 'Alex' })
    b.member({ space: 'main', username: 'sergey', role: 'owner' })
    b.member({ space: 'main', username: 'alex', role: 'writer' })
    b.member({ space: 'solo', username: 'sergey', role: 'owner' })

    b.note({
      space: 'main',
      path: 'alpha/hot-note.md',
      title: 'Hot note',
      content: '# Hot note\n\nRepeated edits must collapse into one group.',
      created: daysBefore(now, 14, 10),
      edits: Array.from({ length: 50 }, (_, index) => daysBefore(now, 2, 10, index)),
      principal: 'user:sergey',
    })
    b.note({
      space: 'main',
      path: 'alpha/peer-note.md',
      title: 'Peer note',
      created: daysBefore(now, 4, 11),
      edits: [daysBefore(now, 1, 9)],
      principal: 'user:alex',
    })
    b.note({
      space: 'main',
      path: 'workspace-root.md',
      title: 'Workspace root note',
      created: daysBefore(now, 5, 12),
      principal: 'user:sergey',
    })
    b.note({
      space: 'main',
      path: 'Workspace root/literal-folder.md',
      title: 'Literal Workspace root folder',
      created: daysBefore(now, 6, 12),
      principal: 'user:sergey',
    })
    b.note({
      space: 'main',
      path: 'No current folder/literal-folder.md',
      title: 'Literal No current folder',
      created: daysBefore(now, 7, 12),
      principal: 'user:alex',
    })
    b.note({
      space: 'main',
      path: 'retired/no-current-folder.md',
      title: 'No current folder note',
      created: daysBefore(now, 8, 10),
      deletedAt: daysBefore(now, 1, 12),
      principal: 'user:alex',
    })
    const moved = b.note({
      space: 'main',
      path: 'alpha/moved-from.md',
      title: 'Moved without activity',
      created: daysBefore(now, 9, 10),
      principal: 'user:sergey',
    })
    b.event({
      op: 'edit',
      date: daysBefore(now, 1, 13),
      space: 'main',
      noteId: moved,
      path: 'beta/moved-to.md',
      principal: 'user:sergey',
    })
    b.note({
      space: 'solo',
      path: 'only-mine.md',
      title: 'Only mine',
      created: daysBefore(now, 3, 10),
      principal: 'user:sergey',
    })

    const weeks = 8
    const perWeek = Math.max(1, Math.round(6 * scale))
    let idx = 0

    for (let w = weeks; w >= 1; w--) {
      for (let k = 0; k < perWeek; k++) {
        idx++
        const project = rng.pick(['alpha', 'beta'])
        const createdDays = w * 7 - rng.int(0, 6)
        const created = daysBefore(now, createdDays, rng.int(9, 18), rng.int(0, 59))
        const principal = rng.pick(PRINCIPALS)

        // A note is EITHER edited (staying live) OR tombstoned — never both, so a delete
        // is always the note's TERMINAL event. (An edit dated after a delete would crash
        // the real applier's replay — `store.write` on a removed note → "note not found"
        // — and silently resurrect the note in the fake. Delete-XOR-edit rules it out.)
        const willDelete = rng.bool(0.08)
        const edits: string[] = []

        if (!willDelete) {
          for (let e = 0, n = rng.int(0, 3); e < n; e++) {
            edits.push(daysBefore(now, rng.int(0, Math.max(0, createdDays - 1)), rng.int(9, 18)))
          }
          edits.sort()
        }

        // Some notes link to a not-yet-written note → a ghost (broken link) for Hygiene.
        const broken = rng.bool(0.25) ? `\n\nSee [[Missing ${idx}]] (not written yet).` : ''
        b.note({
          space: 'main',
          path: `${project}/item-${String(idx).padStart(3, '0')}.md`,
          title: `${cap(TOPICS[idx % TOPICS.length])} ${idx}`,
          content: `# ${cap(TOPICS[idx % TOPICS.length])} ${idx}\n\nDated activity for the dashboard.${broken}`,
          tags: [project],
          created,
          edits,
          principal,
          // A few tombstones (terminal) so the heatmap/feed show deletes too.
          deletedAt: willDelete
            ? daysBefore(now, rng.int(0, Math.max(0, createdDays - 1)), 16)
            : undefined,
        })
      }
    }

    // A couple of deliberate orphans (no links in or out) for the Hygiene tab.
    for (let i = 1; i <= 3; i++) {
      b.note({
        space: 'main',
        path: `orphans/loose-${i}.md`,
        title: `Loose note ${i}`,
        content: `# Loose note ${i}\n\nNo links here.`,
        created: daysBefore(now, 5 * i, 10),
        principal: 'user:sergey',
      })
    }

    return b.build()
  },
}
