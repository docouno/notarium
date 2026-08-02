import { cap, daysBefore, TOPICS, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

/** Three spaces, two marked projects, and a personal domain carrying agent memory
 *  (#16 spaces / #13 projects / #78 classes) — the "more than files" axis: the
 *  space switcher, per-space trees, projects, and the personal layer all have
 *  something to show. Boots in password mode with `sergey` as owner of all three.
 */
export const multiSpace: CaseSpec = {
  name: 'multi-space',
  description:
    '3 spaces, 2 projects and a personal domain with agent memory — the multi-space / projects axis (#16/#13/#78).',
  axes: ['structure', 'agent-memory', 'auth', 'note-classes', 'trash'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'work', displayName: 'Work' })
    b.space({ slug: 'research', displayName: 'Research' })
    b.space({ slug: 'home', displayName: 'Home', personalFor: 'sergey' })
    // A soft-archived space (#110) — lives in the Trash (Spaces tab), data intact.
    b.space({ slug: 'scratch', displayName: 'Scratch', archived: true })

    b.project({ space: 'work', path: 'product', displayName: 'Product' })
    b.project({ space: 'research', path: 'papers', displayName: 'Papers' })

    b.user({
      username: 'sergey',
      password: 'seed-pass',
      displayName: 'Sergey',
      admin: true,
      personalSpace: 'home',
    })
    b.member({ space: 'work', username: 'sergey', role: 'owner' })
    b.member({ space: 'research', username: 'sergey', role: 'owner' })

    // Connected OAuth apps (#181) — so Settings → Connected apps shows real data with
    // per-space narrowing: Claude reaches everything, ChatGPT is narrowed to ONLY
    // Research (the issue's target example "give ChatGPT access to just Research").
    b.connectedApp({
      appName: 'Claude',
      scope: 'write',
      spaces: null,
      connectedDaysAgo: 12,
      lastUsedDaysAgo: 1,
    })
    b.connectedApp({
      appName: 'ChatGPT',
      scope: 'read',
      spaces: ['research'],
      connectedDaysAgo: 5,
      lastUsedDaysAgo: 2,
    })
    // A connector registered but not yet approved: this row consumes the
    // pending public-registry budget and never appears in Connected apps.
    b.pendingOAuthClient({
      kind: 'dcr',
      clientName: 'Pending MCP Inspector',
      redirectUris: ['http://127.0.0.1:6274/oauth/callback'],
      registeredHoursAgo: 2,
    })

    // Work: a couple of top-level notes + the product project's notes.
    for (let i = 1; i <= 4; i++) {
      b.note({
        space: 'work',
        path: `notes/${TOPICS[i].toLowerCase()}-${i}.md`,
        title: `${cap(TOPICS[i])} ${i}`,
        created: daysBefore(now, 20 - i, 10),
        principal: 'user:sergey',
      })
    }
    for (let i = 1; i <= 6; i++) {
      b.note({
        space: 'work',
        path: `product/spec-${String(i).padStart(2, '0')}.md`,
        title: `Product spec ${i}`,
        tags: ['product'],
        created: daysBefore(now, 15 - i, 11),
        edits: i % 2 === 0 ? [daysBefore(now, 3, 12)] : [],
        principal: 'user:sergey',
      })
    }

    // Research: the papers project.
    for (let i = 1; i <= 5; i++) {
      b.note({
        space: 'research',
        path: `papers/finding-${String(i).padStart(2, '0')}.md`,
        title: `Finding ${i}`,
        tags: ['research'],
        created: daysBefore(now, 25 - i * 2, 9),
        principal: 'user:sergey',
      })
    }

    // Personal domain: a couple pinned profile-ish notes + agent-memory categories.
    for (let i = 1; i <= 3; i++) {
      b.note({
        space: 'home',
        path: `journal/day-${i}.md`,
        title: `Journal ${i}`,
        created: daysBefore(now, 10 - i, 8),
        principal: 'user:sergey',
      })
    }
    const memories: Array<[string, string]> = [
      ['language', 'Prefers English for working sessions and concise summaries.'],
      ['workflow', 'Investigate before coding; verify against a running instance.'],
      ['review-style', 'Findings first, with file references.'],
    ]

    for (const [cat, obs] of memories) {
      b.note({
        space: 'home',
        path: `.notarium/memory/${cat}.md`,
        title: cat,
        content: `# ${cat}\n\n${obs}`,
        class: 'agent-memory',
        summary: obs.slice(0, 60),
        created: daysBefore(now, 12, 7),
        principal: 'user:sergey',
      })
    }
    // A muted category — kept in the audit, dropped from the eager profile (#165).
    b.note({
      space: 'home',
      path: `.notarium/memory/stale-fact.md`,
      title: 'stale-fact',
      content: '# stale-fact\n\nOutdated context that should stay auditable but not load eagerly.',
      class: 'agent-memory',
      summary: 'Outdated context.',
      muted: true,
      created: daysBefore(now, 40, 7),
      principal: 'user:sergey',
    })

    // The archived scratch space carries a couple of notes so restoring it (#110)
    // brings back real data.
    for (let i = 1; i <= 2; i++) {
      b.note({
        space: 'scratch',
        path: `notes/scratch-${i}.md`,
        title: `Scratch note ${i}`,
        content: `# Scratch note ${i}\n\nData inside an archived space.`,
        created: daysBefore(now, 30 - i, 10),
        principal: 'user:sergey',
      })
    }

    return b.build()
  },
}
