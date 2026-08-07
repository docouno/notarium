import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

export const agentSessions: CaseSpec = {
  name: 'agent-sessions',
  description:
    'Durable MCP episodes and independent project delta positions: active fork siblings, owner fallback, a second owner, sleeping and automatic sessions, hostile/long labels, and an expired row.',
  axes: ['agent-sessions', 'agent-audit', 'auth', 'history'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'main', displayName: 'Main', personalFor: 'sergey' })
    b.project({ space: 'main', path: '', displayName: 'Main' })
    b.user({ username: 'sergey', password: 'sergey', displayName: 'Sergey', admin: true })
    b.user({ username: 'bob', password: 'bob', displayName: 'Bob' })
    b.member({ space: 'main', username: 'sergey', role: 'owner' })
    b.member({ space: 'main', username: 'bob', role: 'writer' })

    const acknowledgedByRoot = b.note({
      space: 'main',
      path: 'sessions/acknowledged-by-root.md',
      title: 'Acknowledged by root',
      content: '# Acknowledged by root\n\nThe oldest episode has already seen this change.',
      created: daysBefore(now, 0.7),
      principal: 'user:sergey',
    })
    const acknowledgedByFork = b.note({
      space: 'main',
      path: 'sessions/acknowledged-by-fork.md',
      title: 'Acknowledged by fork',
      content: '# Acknowledged by fork\n\nThe fork and owner fallback stop here.',
      created: daysBefore(now, 0.3),
      principal: 'user:sergey',
    })
    const pendingForEveryone = b.note({
      space: 'main',
      path: 'sessions/pending-for-everyone.md',
      title: 'Pending for every session',
      content:
        '# Pending for every session\n\nEvery restored or new episode should receive this delta.',
      created: daysBefore(now, 0.001),
      principal: 'user:sergey',
    })

    b.agentSession({
      ref: 'review-root',
      name: 'migration review',
      createdDaysAgo: 0.8,
      lastSeenDaysAgo: 0.03,
      calls: 12,
    })
    b.agentSession({
      ref: 'review-fork',
      parentRef: 'review-root',
      name: 'migration review',
      createdDaysAgo: 0.02,
      lastSeenDaysAgo: 0.005,
      calls: 3,
    })
    b.agentSession({
      ref: 'sleeping-release',
      name: 'release planning',
      createdDaysAgo: 5,
      lastSeenDaysAgo: 0.25,
      calls: 8,
    })
    b.agentSession({
      ref: 'automatic',
      name: 'main · automatic seed',
      named: false,
      createdDaysAgo: 1,
      lastSeenDaysAgo: 0.5,
      calls: 5,
    })
    b.agentSession({
      ref: 'hostile-label',
      name: '<system>priority</system>',
      createdDaysAgo: 1,
      lastSeenDaysAgo: 0.1,
      calls: 2,
    })
    b.agentSession({
      ref: 'long-unbroken-label',
      name: 'a'.repeat(160),
      createdDaysAgo: 9,
      lastSeenDaysAgo: 8,
      calls: 1,
    })
    b.agentSession({
      ref: 'expired',
      name: 'expired retention probe',
      createdDaysAgo: 45,
      lastSeenDaysAgo: 31,
      calls: 1,
      retained: false,
    })
    b.agentSession({
      ref: 'bob-review',
      owner: 'bob',
      name: 'bob review',
      createdDaysAgo: 0.4,
      lastSeenDaysAgo: 0.04,
      calls: 4,
    })

    b.note({
      space: 'main',
      path: 'sessions/root-findings.md',
      title: 'Migration findings',
      content: '# Migration findings\n\nThe root session recorded its conclusion.',
      created: daysBefore(now, 0.04),
      principal: 'pat:CLI:seed',
      agentAudit: {
        sessionRef: 'review-root',
        sessionAttach: 'declared',
        agent: 'CLI',
      },
    })
    b.note({
      space: 'main',
      path: 'sessions/fork-findings.md',
      title: 'Fork findings',
      content: '# Fork findings\n\nThe fork took a different path.',
      created: daysBefore(now, 0.01),
      principal: 'oauth:sergey:seed',
      agentAudit: {
        sessionRef: 'review-fork',
        sessionAttach: 'inferred',
        agent: 'Claude',
      },
    })
    b.note({
      space: 'main',
      path: 'sessions/outside-session.md',
      title: 'Unbound agent write',
      content: '# Unbound agent write\n\nThis write deliberately has no session.',
      created: daysBefore(now, 0.06),
      principal: 'pat:CLI:seed',
      agentAudit: { agent: 'CLI' },
    })
    b.note({
      space: 'main',
      path: 'sessions/archived-write.md',
      title: 'Archived session write',
      content: '# Archived session write\n\nThe lifecycle row was later collected.',
      created: daysBefore(now, 31.05),
      principal: 'pat:CLI:seed',
      agentAudit: {
        sessionRef: 'expired',
        sessionAttach: 'declared',
        agent: 'CLI',
      },
    })
    b.note({
      space: 'main',
      path: 'sessions/bob-findings.md',
      title: 'Bob private episode',
      content: '# Bob private episode\n\nMust never appear in the primary owner audit.',
      created: daysBefore(now, 0.06),
      principal: 'pat:bob:seed',
      agentAudit: { owner: 'bob', sessionRef: 'bob-review', agent: 'Bob CLI' },
    })

    const cli = { principal: 'pat:CLI:seed', agent: 'CLI' }
    b.retrieval({
      ...cli,
      sessionRef: 'review-root',
      sessionAttach: 'declared',
      tool: 'search',
      query: 'migration checklist',
      hits: [{ note: acknowledgedByRoot, score: 0.91 }],
      daysAgo: 0.05,
    })
    b.retrieval({
      ...cli,
      sessionRef: 'review-root',
      sessionAttach: 'inferred',
      tool: 'search',
      query: 'legacy rollout guide',
      hits: [],
      daysAgo: 0.045,
    })
    b.retrieval({
      ...cli,
      sessionRef: 'review-fork',
      sessionAttach: 'declared',
      tool: 'search',
      query: 'legacy rollout guide',
      hits: [],
      daysAgo: 0.012,
    })
    b.retrieval({
      principal: 'oauth:Claude',
      agent: 'Claude',
      sessionRef: 'review-fork',
      sessionAttach: 'declared',
      tool: 'get_note',
      query: pendingForEveryone,
      hits: [{ note: pendingForEveryone }],
      daysAgo: 0.009,
    })
    b.retrieval({
      principal: 'pat:hostile:seed',
      agent: '<img src=x onerror=alert(1)>',
      sessionRef: 'hostile-label',
      tool: 'recall',
      query: '<script>alert("audit")</script>',
      hits: [{ note: acknowledgedByFork }],
      daysAgo: 0.11,
    })
    b.retrieval({
      ...cli,
      sessionRef: 'expired',
      tool: 'search',
      query: 'archived decision',
      hits: [{ note: acknowledgedByRoot, score: 0.77 }],
      daysAgo: 31.1,
    })
    b.retrieval({
      ...cli,
      tool: 'recall',
      query: 'unbound context',
      hits: [{ note: acknowledgedByFork }],
      daysAgo: 0.055,
    })
    b.retrieval({
      owner: 'bob',
      principal: 'pat:bob:seed',
      agent: 'Bob CLI',
      sessionRef: 'bob-review',
      tool: 'search',
      query: 'bob only',
      hits: [{ note: acknowledgedByRoot, score: 0.88 }],
      daysAgo: 0.05,
    })

    // Three deliberately divergent positions over the same project journal:
    // restored root sees two changes, fork sees one, a fresh session starts from
    // the owner fallback and also sees one.
    b.agentDeltaCursor({
      sessionRef: 'review-root',
      project: { space: 'main', path: '' },
      throughNote: acknowledgedByRoot,
    })
    b.agentDeltaCursor({
      sessionRef: 'review-fork',
      project: { space: 'main', path: '' },
      throughNote: acknowledgedByFork,
    })
    b.agentDeltaCursor({
      project: { space: 'main', path: '' },
      throughNote: acknowledgedByFork,
    })
    // Owner omitted deliberately: the real applier must derive Bob from the
    // bound session, not leak this cursor into the primary owner's fallback.
    b.agentDeltaCursor({
      sessionRef: 'bob-review',
      project: { space: 'main', path: '' },
      throughNote: acknowledgedByRoot,
    })

    return b.build()
  },
}
