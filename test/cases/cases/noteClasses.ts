import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

// The class × visibility matrix (#78/#74): ONE space carrying a note of each seedable
// class, so every surface's include/exclude can be checked against one world:
//  - user-doc     → tree ✓ feed ✓ search ✓ graph ✓
//  - agent-memory → hidden from tree/feed/search/graph (mount .notarium/memory), recall-only
//  - profile      → hidden but human-editable (the always-load identity)
// A personal domain owns them (agent-memory/profile live in a personal space).
export const noteClasses: CaseSpec = {
  name: 'note-classes',
  description:
    'One personal space with a note of each class (user-doc / agent-memory / profile) — the visibility matrix: what the tree/feed/search/graph must and must not show (#78/#74).',
  axes: ['note-classes', 'agent-memory', 'structure'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'home', displayName: 'Home', personalFor: 'sergey' })
    b.user({
      username: 'sergey',
      password: 'seed-pass',
      displayName: 'Sergey',
      admin: true,
      personalSpace: 'home',
    })

    // Visible user-doc notes — must show on every surface.
    b.note({
      space: 'home',
      path: 'notes/visible-one.md',
      title: 'Visible note',
      content:
        '# Visible note\n\nA normal user-doc note — shows in the tree, feed, search and graph.',
      tags: ['visible'],
      created: daysBefore(now, 10, 10),
      principal: 'user:sergey',
    })
    b.note({
      space: 'home',
      path: 'notes/visible-two.md',
      title: 'Another visible note',
      content: '# Another visible note\n\nAlso user-doc; links [[Visible note]].',
      created: daysBefore(now, 9, 10),
      principal: 'user:sergey',
    })

    // Agent-memory — hidden from tree/feed/search/graph (the visibility invariant #78),
    // reachable by the agent via recall. Two categories + one muted.
    const memories: Array<[string, string]> = [
      ['workflow', 'Fundamental investigation before code; verify on a live stand.'],
      ['language', 'Russian for working sessions; concise engineering summaries.'],
    ]

    for (const [cat, obs] of memories) {
      b.note({
        space: 'home',
        path: `.notarium/memory/${cat}.md`,
        title: cat,
        content: `# ${cat}\n\n${obs}`,
        class: 'agent-memory',
        summary: obs.slice(0, 60),
        created: daysBefore(now, 12, 8),
        principal: 'user:sergey',
      })
    }
    b.note({
      space: 'home',
      path: '.notarium/memory/stale-fact.md',
      title: 'stale-fact',
      content: '# stale-fact\n\nAudit-only context; kept but not eagerly loaded (#165 muted).',
      class: 'agent-memory',
      summary: 'Stale context.',
      muted: true,
      created: daysBefore(now, 30, 8),
      principal: 'user:sergey',
    })

    // Profile — the always-load identity: hidden from the tree, human-editable.
    b.note({
      space: 'home',
      path: '.notarium/profile/profile.md',
      title: 'Profile',
      noteType: 'person',
      class: 'profile',
      content:
        '# Profile\n\n- [identity] Alex — backend engineer working on data tooling\n- [preference] short summaries, explicit trade-offs',
      tags: ['user', 'always-load'],
      created: daysBefore(now, 40, 8),
      principal: 'user:sergey',
    })

    return b.build()
  },
}
