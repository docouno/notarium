import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

/** Five intentionally separate principals keep the state boundary observable:
 * Fresh has only bundled abilities and no personal space, proving that a rejected Add
 * remains side-effect free. Bob owns an idle personal fork, and Maya owns same-name
 * Personal + Space(team) + Project(team/other and maya-home/work) forks. The Project
 * fork wins in a project context. Robin can inspect the Team placement but cannot
 * mutate it. Sergey is the browsable stand owner and owns one Personal role with
 * distinct context, so the default QA login can compare Base and Role context. */
export const agentRoles: CaseSpec = {
  name: 'agent-roles',
  description:
    'System/Catalog inventory, Owned role precedence, independent Personal/Space/Project presets, and a role-first shared-budget trim edge.',
  axes: ['agent-roles', 'agent-sessions', 'agent-memory', 'auth', 'structure', 'scale'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'main', displayName: 'Stand owner', personalFor: 'sergey' })
    b.space({ slug: 'bob-home', displayName: 'Bob personal', personalFor: 'bob' })
    b.space({ slug: 'maya-home', displayName: 'Maya personal', personalFor: 'maya' })
    b.space({ slug: 'team', displayName: 'Team' })
    b.project({ space: 'main', path: '', displayName: 'Main' })
    b.project({ space: 'main', path: 'other', slug: 'other', displayName: 'Main' })
    b.project({ space: 'team', path: '', displayName: 'Team' })
    b.project({ space: 'team', path: 'other', slug: 'other', displayName: 'Team' })
    b.project({ space: 'team', path: 'alpha', slug: 'alpha', displayName: 'Alpha' })
    b.project({ space: 'team', path: 'beta', slug: 'beta', displayName: 'Beta' })
    b.project({ space: 'team', path: 'gamma', slug: 'gamma', displayName: 'Gamma' })
    b.project({ space: 'maya-home', path: 'work', slug: 'work', displayName: 'Maya work' })

    b.user({ username: 'sergey', password: 'sergey', displayName: 'Sergey', admin: true })
    b.user({ username: 'bob', password: 'bob', displayName: 'Bob' })
    b.user({ username: 'maya', password: 'maya', displayName: 'Maya' })
    b.user({ username: 'robin', password: 'robin', displayName: 'Robin' })
    b.user({ username: 'fresh', password: 'fresh', displayName: 'Fresh' })
    b.member({ space: 'main', username: 'sergey', role: 'owner' })
    b.member({ space: 'bob-home', username: 'bob', role: 'owner' })
    b.member({ space: 'maya-home', username: 'maya', role: 'owner' })
    b.member({ space: 'team', username: 'maya', role: 'writer' })
    b.member({ space: 'team', username: 'robin', role: 'reader' })

    b.note({
      space: 'main',
      path: 'base-profile.md',
      title: 'Stand owner base context',
      pin: true,
      created: daysBefore(now, 4),
    })
    const ownerRoleContext = b.note({
      space: 'main',
      path: 'personal-release-review-role.md',
      title: 'Release review role context',
      created: daysBefore(now, 3),
    })
    b.note({
      space: 'main',
      path: '.notarium/memory/release-preferences.md',
      title: 'release-preferences',
      content:
        '# release-preferences\n\nRelease notes should name the owner, evidence, rollback, and next action.',
      class: 'agent-memory',
      summary: 'Preferred release handoff structure.',
      created: daysBefore(now, 2.5),
      principal: 'user:sergey',
    })
    b.note({
      space: 'main',
      path: '.notarium/memory/release-handoff.md',
      title: 'release-handoff',
      content:
        '# release-handoff\n\nThe Main project requires explicit release evidence before handoff.',
      class: 'agent-memory',
      summary: 'Main project release handoff rule.',
      projectMemory: { space: 'main', path: 'other' },
      created: daysBefore(now, 2),
      principal: 'user:sergey',
    })

    b.note({
      space: 'maya-home',
      path: 'base-profile.md',
      title: 'Base personal context',
      pin: true,
      created: daysBefore(now, 4),
    })
    const personalResearch = b.note({
      space: 'maya-home',
      path: 'personal-research-role.md',
      title: 'Personal research method',
      created: daysBefore(now, 3),
    })
    const personalGrooming = b.note({
      space: 'maya-home',
      path: 'personal-grooming-role.md',
      title: 'Personal grooming checklist',
      created: daysBefore(now, 3),
    })
    const spaceResearch = b.note({
      space: 'team',
      path: 'space-research-role.md',
      title: 'Team research conventions',
      created: daysBefore(now, 3),
    })
    b.note({
      space: 'team',
      path: 'other/base-project.md',
      title: 'Base project context',
      pin: true,
      created: daysBefore(now, 3),
    })
    const projectResearch = b.note({
      space: 'team',
      path: 'other/project-research-role.md',
      title: 'Project research brief',
      created: daysBefore(now, 2),
    })
    const projectReference = b.note({
      space: 'team',
      path: 'other/reference.md',
      title: 'Research source map',
      created: daysBefore(now, 2),
    })
    const largeResearchPrelude = b.note({
      space: 'team',
      path: 'other/large-research-prelude.md',
      title: 'Large research prelude',
      content: ['# Large research prelude', '', 'evidence '.repeat(9_000)].join('\n'),
      created: daysBefore(now, 1.5),
    })
    const oversizedResearch = b.note({
      space: 'team',
      path: 'other/oversized-research-role.md',
      title: 'Oversized research corpus',
      content: ['# Oversized research corpus', '', 'evidence '.repeat(9_000)].join('\n'),
      created: daysBefore(now, 1),
    })
    const workResearch = b.note({
      space: 'maya-home',
      path: 'work/project-research-role.md',
      title: 'Maya work research brief',
      created: daysBefore(now, 2),
    })

    b.agentRole({ name: 'grooming', target: { kind: 'personal', user: 'bob' } })
    const customResearch = {
      source: 'custom' as const,
      name: 'research',
      description: 'Investigate an uncertain question with owned instructions.',
      instructions: '# Research\n\nInspect evidence and report the decision.',
    }

    b.agentRole({
      source: 'custom',
      name: 'release-reviewer',
      description: 'Review release evidence on the default QA account.',
      instructions: '# Release reviewer\n\nReview release evidence before handoff.',
      target: { kind: 'personal', user: 'sergey' },
    })
    b.agentRole({ ...customResearch, target: { kind: 'personal', user: 'maya' } })
    b.agentRole({ name: 'grooming', target: { kind: 'personal', user: 'maya' } })
    b.agentRole({ ...customResearch, target: { kind: 'space', space: 'team' } })
    b.agentRole({
      ...customResearch,
      target: { kind: 'project', space: 'team', path: 'other' },
    })
    // A version whose base was never created — the other legitimate shape of the
    // same model, and the only role a promotion can land without a name collision.
    // It lives in the project that SHARES the Space's display name on purpose: a
    // project group exists only for base-less roles now, and that pair is what keeps
    // "same words, different scope" observable in the explorer.
    b.agentRole({
      source: 'custom',
      name: 'field-guide',
      description: 'Work this project surface without a shared default behind it.',
      instructions: '# Field guide\n\nWork the project surface from what it actually owns.',
      target: { kind: 'project', space: 'team', path: 'other' },
    })
    // The V18 state a copy used to stand in for: one role, needed in two of the five
    // Team projects. Its reach is narrowed, so it is the only Space role a
    // `availability=selected` filter can find.
    b.agentRole({
      source: 'custom',
      name: 'launch-review',
      description: 'Review launch readiness where the launch actually happens.',
      instructions: '# Launch review\n\nCheck scope, evidence and rollback before sign-off.',
      target: { kind: 'space', space: 'team' },
      availability: {
        mode: 'selected-projects',
        projects: [
          { space: 'team', path: 'alpha' },
          { space: 'team', path: 'beta' },
        ],
      },
    })
    b.agentRole({
      ...customResearch,
      target: { kind: 'project', space: 'maya-home', path: 'work' },
    })
    b.agentRole({
      source: 'custom',
      name: 'release-captain',
      description: 'Coordinate a release without losing authored operating context.',
      instructions: [
        '# Release captain',
        '',
        'Preserve the full release brief and keep decisions tied to evidence.',
        '',
        '## Operating checklist',
        '',
        '- Confirm scope, owner, evidence, rollback, and next action.',
        '- Keep the authored prompt intact through create and immediate open.',
        '',
        'Long-form rehearsal paragraph. '.repeat(180),
      ].join('\n'),
      invalidAttachment: '[[notarium-id:space:legacy-broken|retired-helper]]',
      target: { kind: 'personal', user: 'maya' },
    })
    b.agentRole({
      source: 'custom',
      name: 'retired-captain',
      description: 'A deleted owned role retained in Trash.',
      instructions: '# Retired captain\n\nThis role must be visible only in Trash after seeding.',
      deleted: true,
      target: { kind: 'personal', user: 'maya' },
    })
    b.agentSkill({
      name: 'meeting-brief',
      description: 'Turn a meeting transcript into decisions, owners, and next steps.',
      instructions:
        '# Meeting brief\n\nTurn a meeting transcript into decisions, owners, and next steps.',
      home: { kind: 'personal', user: 'maya' },
    })
    b.agentSkill({
      name: 'team-tone',
      description: 'Apply the Team writing voice and terminology.',
      instructions: '# Team tone\n\nApply the Team writing voice and terminology.',
      home: { kind: 'space', space: 'team' },
      availability: { mode: 'all-projects' },
    })
    b.agentSkill({
      name: 'coder',
      description: 'Apply the shared coding workflow only in Alpha and Beta.',
      instructions:
        '# Coder\n\nInspect the code, preserve project patterns, and verify the painful path.',
      home: { kind: 'space', space: 'team' },
      availability: {
        mode: 'selected-projects',
        projects: [
          { space: 'team', path: 'alpha' },
          { space: 'team', path: 'beta' },
        ],
      },
    })
    b.agentSkill({
      name: 'release-check',
      description: 'Check the Other project release evidence before handoff.',
      instructions: '# Release check\n\nCheck the Other project release evidence before handoff.',
      home: { kind: 'space', space: 'team' },
      availability: {
        mode: 'selected-projects',
        projects: [{ space: 'team', path: 'other' }],
      },
    })
    b.agentSkill({
      name: 'research-evidence',
      description: 'Audit source quality for the shared owned research role.',
      instructions: '# Research evidence\n\nTrace claims to source evidence before reporting.',
      linkedRole: 'research',
      renameTo: 'source-audit',
      home: { kind: 'space', space: 'team' },
      availability: { mode: 'all-projects' },
    })
    b.agentSkill({
      source: 'catalog',
      name: 'grooming-evidence',
      home: { kind: 'space', space: 'team' },
      availability: { mode: 'all-projects' },
    })
    b.agentSkill({
      name: 'handoff-check',
      description: 'Audit ownership handoffs before work changes hands.',
      instructions: '# Handoff check\n\nConfirm the owner, acceptance evidence, and next action.',
      linkedRole: 'grooming',
      home: { kind: 'personal', user: 'maya' },
    })
    b.agentSkill({
      name: 'retired-check',
      description: 'A retired check retained as a broken role reference.',
      instructions: '# Retired check\n\nThis package must not load after deletion.',
      linkedRole: 'grooming',
      deleted: true,
      home: { kind: 'personal', user: 'maya' },
    })
    b.agentSkill({
      name: 'shared-review',
      description: 'Personal review instructions with a deliberately repeated name.',
      instructions:
        '# Shared review\n\nPersonal review instructions with a deliberately repeated name.',
      home: { kind: 'personal', user: 'maya' },
    })
    b.agentSkill({
      name: 'shared-review',
      description: 'Project review instructions with a deliberately repeated name.',
      instructions:
        '# Shared review\n\nProject review instructions with a deliberately repeated name.',
      home: { kind: 'space', space: 'team' },
      availability: {
        mode: 'selected-projects',
        projects: [{ space: 'team', path: 'other' }],
      },
    })
    b.scopePin({
      note: ownerRoleContext,
      attach: {
        kind: 'role',
        name: 'release-reviewer',
        target: { kind: 'personal', user: 'sergey' },
      },
    })
    b.scopePin({
      note: personalResearch,
      attach: { kind: 'role', name: 'research', target: { kind: 'personal', user: 'maya' } },
    })
    b.scopePin({
      note: personalGrooming,
      attach: { kind: 'role', name: 'grooming', target: { kind: 'personal', user: 'maya' } },
    })
    b.scopePin({
      note: spaceResearch,
      attach: { kind: 'role', name: 'research', target: { kind: 'space', space: 'team' } },
    })
    const teamProjectRole = {
      kind: 'role' as const,
      name: 'research',
      target: { kind: 'project' as const, space: 'team', path: 'other' },
    }
    b.scopePin({ note: projectResearch, attach: teamProjectRole })
    b.scopePin({ note: largeResearchPrelude, attach: teamProjectRole })
    b.scopePin({ note: oversizedResearch, attach: teamProjectRole })
    b.contextSet({
      homeSpace: 'team',
      name: 'Research source set',
      items: [projectReference],
      attach: [teamProjectRole],
    })
    b.contextOrderFor({
      scope: teamProjectRole,
      entries: [
        { kind: 'pin', note: projectResearch },
        { kind: 'set', name: 'Research source set' },
        { kind: 'pin', note: largeResearchPrelude },
        { kind: 'pin', note: oversizedResearch },
      ],
    })
    b.scopePin({
      note: workResearch,
      attach: {
        kind: 'role',
        name: 'research',
        target: { kind: 'project', space: 'maya-home', path: 'work' },
      },
    })
    // The one lever an owner has over a PACKAGED ability, seeded rather than clicked.
    // The stand had none: the browser gate could only reach "disabled" by pressing the
    // toggle itself, which proves the toggle and never the state a stand was seeded
    // INTO — while the docs, the tool descriptions and a dedicated error text all
    // already told an agent this state exists. Maya is the principal every System spec
    // logs in as, and her own `research` fork shadows the packaged role in resolution,
    // so the seed shows the disabled row without moving any effective answer.
    b.agentAbilityPreference({
      user: 'maya',
      ability: { source: 'system', kind: 'role', name: 'research' },
      enabled: false,
    })
    b.agentSession({
      ref: 'maya-research',
      owner: 'maya',
      name: 'role research session',
      createdDaysAgo: 0.1,
      lastSeenDaysAgo: 0.01,
      calls: 4,
      role: 'research',
    })

    return b.build()
  },
}
