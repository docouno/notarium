import { daysBefore, WorldBuilder } from '../generators'
import type { AgentAbilityAvailabilityDecl, CaseSpec } from '../types'

/** A stand where the Abilities surfaces are FULL for the default QA login. The
 * `agent-roles` case proves the boundaries (five principals, one placement each);
 * this one proves the shapes that only appear at volume and that a boundary case
 * cannot show: every group populated at once for a single owner, a Roles AND a
 * Skills inventory past both page sizes, long titles that must truncate, a Space
 * skill fleet whose availability differs project by project, a catalog Add whose
 * supporting package the owner then edits where it actually landed, and the
 * attachment and Enable/Disable states an owner produces rather than the library. */
const ROLE_TITLES = [
  ['release-reviewer', 'Release reviewer', 'Review release evidence before handoff.'],
  ['incident-commander', 'Incident commander', 'Drive an incident to a written resolution.'],
  ['api-designer', 'API designer', 'Shape an endpoint before it is implemented.'],
  ['data-migrator', 'Data migrator', 'Plan and verify a schema migration.'],
  ['doc-editor', 'Doc editor', 'Bring a document to the house style.'],
  ['onboarding-buddy', 'Onboarding buddy', 'Walk a newcomer through the codebase.'],
  ['perf-analyst', 'Perf analyst', 'Find where the time actually goes.'],
  ['security-reviewer', 'Security reviewer', 'Audit a change for exposure.'],
  ['support-triager', 'Support triager', 'Turn a report into a reproducible issue.'],
  ['release-notes-writer', 'Release notes writer', 'Summarise a release for humans.'],
  ['spec-groomer', 'Spec groomer', 'Turn an idea into an executable plan.'],
  ['test-author', 'Test author', 'Cover a behaviour before changing it.'],
] as const

const SKILL_TITLES = [
  ['evidence-check', 'Evidence check', 'Trace every claim back to its source.'],
  ['diff-reader', 'Diff reader', 'Read a diff for intent, not for lines.'],
  ['sql-tuner', 'SQL tuner', 'Rewrite a query around its real plan.'],
  ['api-conventions', 'API conventions', 'Apply the house REST conventions.'],
  ['tone-of-voice', 'Tone of voice', 'Write the way the product speaks.'],
  ['threat-model', 'Threat model', 'Enumerate what an attacker would try first.'],
  ['repro-steps', 'Repro steps', 'Reduce a report to the shortest reproduction.'],
  ['changelog-style', 'Changelog style', 'Phrase a change from the reader’s side.'],
  ['estimation', 'Estimation', 'Size work by its unknowns, not its lines.'],
  ['rollback-plan', 'Rollback plan', 'State how a change is undone before shipping it.'],
  ['flaky-triage', 'Flaky triage', 'Tell a real failure apart from a flaky one.'],
  ['dependency-audit', 'Dependency audit', 'Weigh a dependency by the cost of removing it.'],
  ['migration-rehearsal', 'Migration rehearsal', 'Rehearse a migration before it runs for real.'],
  ['incident-timeline', 'Incident timeline', 'Reconstruct what happened, in order.'],
  ['access-review', 'Access review', 'Check who can reach what, and why.'],
  ['budget-watch', 'Budget watch', 'Notice a cost before the invoice does.'],
] as const

/** Projects nobody placed an ability in — they exist to give the library aside's Project
 *  facet its real LENGTH. The facet has no pagination and no scroller of its own (#393),
 *  so how many rows it has IS a state: at twenty-one, the sections above it scroll out of
 *  the aside, which is what the owner's own instance does and what no other case shows.
 *  They carry no roles on purpose — placement groups are asserted whole. */
const FACET_PROJECTS = [
  ['analytics', 'Analytics'],
  ['billing', 'Billing'],
  ['brand', 'Brand'],
  ['data-platform', 'Data platform'],
  ['design-system', 'Design system'],
  ['docs', 'Docs'],
  ['growth', 'Growth'],
  ['infra', 'Infra'],
  ['integrations', 'Integrations'],
  ['onboarding', 'Onboarding'],
  ['payments', 'Payments'],
  ['pricing', 'Pricing'],
  ['search', 'Search'],
  ['support', 'Support'],
  ['sync', 'Sync'],
] as const

export const agentAbilitiesRich: CaseSpec = {
  name: 'agent-abilities-rich',
  description:
    'A full Abilities inventory on the default login: every placement group populated, explorer/library pagination, long titles and per-project skill availability.',
  axes: ['agent-roles', 'agent-memory', 'structure', 'auth', 'scale'],
  build: ({ now, scale }) => {
    const b = new WorldBuilder(now)
    const take = (count: number) => Math.max(1, Math.round(count * scale))

    b.space({ slug: 'main', displayName: 'Stand owner', personalFor: 'sergey' })
    b.space({ slug: 'product', displayName: 'Product' })
    b.project({ space: 'main', path: '', displayName: 'Main' })
    b.project({ space: 'product', path: '', displayName: 'Product' })
    b.project({ space: 'product', path: 'web', slug: 'web', displayName: 'Web' })
    b.project({ space: 'product', path: 'api', slug: 'api', displayName: 'API' })
    b.project({ space: 'product', path: 'mobile', slug: 'mobile', displayName: 'Mobile' })
    b.project({ space: 'product', path: 'legacy', slug: 'legacy', displayName: 'Legacy' })

    for (const [slug, displayName] of FACET_PROJECTS) {
      b.project({ space: 'product', path: slug, slug, displayName })
    }

    b.user({ username: 'sergey', password: 'sergey', displayName: 'Sergey', admin: true })
    b.user({ username: 'maya', password: 'maya', displayName: 'Maya' })
    b.member({ space: 'main', username: 'sergey', role: 'owner' })
    b.member({ space: 'product', username: 'sergey', role: 'owner' })
    b.member({ space: 'product', username: 'maya', role: 'writer' })
    b.agentSession({
      ref: 'agent-created-ability',
      owner: 'sergey',
      name: 'Agent ability authoring',
      createdDaysAgo: 2,
      lastSeenDaysAgo: 0,
      calls: 4,
    })

    b.note({
      space: 'main',
      path: 'base-profile.md',
      title: 'Stand owner base context',
      pin: true,
      created: daysBefore(now, 6),
    })
    b.note({
      space: 'main',
      path: '.notarium/memory/release-preferences.md',
      title: 'release-preferences',
      content:
        '# release-preferences\n\nRelease notes should name the owner, evidence, rollback, and next action.',
      class: 'agent-memory',
      summary: 'Preferred release handoff structure.',
      created: daysBefore(now, 5),
      principal: 'user:sergey',
    })

    // Personal roles: the cross-space fallback group, deep enough that the explorer
    // must page rather than show one comfortable screenful.
    for (const [name, title, description] of ROLE_TITLES.slice(0, take(12))) {
      b.agentRole({
        source: 'custom',
        name,
        description,
        instructions: `# ${title}\n\n${description}`,
        target: { kind: 'personal', user: 'sergey' },
      })
    }
    // Space roles: the shared team default for the same owner, including one title
    // long enough to prove truncation on every surface that lists it.
    for (const [name, title, description] of ROLE_TITLES.slice(0, take(10))) {
      b.agentRole({
        source: 'custom',
        name: `team-${name}`,
        description,
        instructions: `# Team ${title.toLowerCase()}\n\n${description}`,
        target: { kind: 'space', space: 'product' },
      })
    }
    b.agentRole({
      source: 'custom',
      name: 'release-readiness-and-handoff-review',
      description:
        'A deliberately long title that must truncate in cards, explorer rows and breadcrumbs without pushing the layout around.',
      instructions:
        '# Release readiness and cross-team handoff review for the public API\n\nConfirm scope, owner, evidence, rollback, and the next action.',
      target: { kind: 'space', space: 'product' },
    })
    // Project roles: the override layer, on two different projects so the explorer
    // shows more than one project group at once.
    for (const [name, title, description] of ROLE_TITLES.slice(0, take(6))) {
      b.agentRole({
        source: 'custom',
        name: `web-${name}`,
        description,
        instructions: `# Web ${title.toLowerCase()}\n\n${description}`,
        target: { kind: 'project', space: 'product', path: 'web' },
      })
    }
    for (const [name, title, description] of ROLE_TITLES.slice(0, take(4))) {
      b.agentRole({
        source: 'custom',
        name: `api-${name}`,
        description,
        instructions: `# API ${title.toLowerCase()}\n\n${description}`,
        target: { kind: 'project', space: 'product', path: 'api' },
      })
    }
    // The same display name at two placements: the pair that must stay readable as
    // two distinct placements rather than a duplicated row.
    b.agentRole({
      source: 'custom',
      name: 'shared-reviewer',
      description: 'Personal take on the shared review role.',
      instructions: '# Shared reviewer\n\nReview with the owner’s personal checklist.',
      target: { kind: 'personal', user: 'sergey' },
    })
    b.agentRole({
      source: 'custom',
      name: 'shared-reviewer',
      description: 'Team take on the shared review role.',
      instructions: '# Shared reviewer\n\nReview with the team checklist.',
      target: { kind: 'space', space: 'product' },
    })
    // One role, three V18 states at once (#309): a Space base narrowed to two of the
    // Space's projects, and its own version in one of them. The card must show a single
    // entry with its versions hanging off it — two same-name cards read as a
    // duplicate bug, which is what this state used to look like.
    b.agentRole({
      source: 'custom',
      name: 'launch-review',
      description: 'Review launch readiness where the launch actually happens.',
      instructions: '# Launch review\n\nCheck scope, evidence and rollback before sign-off.',
      target: { kind: 'space', space: 'product' },
      availability: {
        mode: 'selected-projects',
        projects: [
          { space: 'product', path: 'web' },
          { space: 'product', path: 'api' },
        ],
      },
    })
    b.agentRole({
      source: 'custom',
      name: 'launch-review',
      description: 'Review launch readiness where the launch actually happens.',
      instructions:
        '# Launch review\n\nCheck scope, evidence and rollback — and the mobile store review window.',
      target: { kind: 'project', space: 'product', path: 'web' },
    })
    // The other legitimate shape: a version whose base was never created. It stays
    // one entry of its own instead of vanishing into a base that does not exist.
    b.agentRole({
      source: 'custom',
      name: 'legacy-triage',
      description: 'Triage the legacy surface without a shared default behind it.',
      instructions: '# Legacy triage\n\nTriage what the legacy surface still owns.',
      target: { kind: 'project', space: 'product', path: 'legacy' },
    })

    // The two attachment states no other case can reach. A Space role reaching the
    // whole Space depends on a Space skill bound to one project, so the SAME
    // attachment is fine in Mobile and out of reach everywhere else; and a role
    // attached where a skill belongs resolves to a package of the wrong kind.
    b.agentRole({
      source: 'custom',
      name: 'handoff-review',
      description: 'Review a handoff wherever the team works.',
      instructions: '# Handoff review\n\nConfirm the owner, the evidence and the next action.',
      target: { kind: 'space', space: 'product' },
    })
    b.agentRole({
      source: 'custom',
      name: 'evidence-lead',
      description: 'Lead an evidence review from the personal library.',
      instructions: '# Evidence lead\n\nLead the evidence review and name the decision.',
      attachRole: 'release-reviewer',
      target: { kind: 'personal', user: 'sergey' },
    })
    b.agentRole({
      source: 'custom',
      name: 'malformed-attachment-proof',
      description: 'Carry one malformed legacy attachment into runtime health.',
      instructions: '# Malformed attachment proof\n\nKeep the invalid locator observable.',
      invalidAttachment: '[[notarium-id:space:broken|invalid-proof]]',
      target: { kind: 'personal', user: 'sergey' },
    })
    b.agentRole({
      source: 'custom',
      name: 'missing-dependency-proof',
      description: 'Retain an exact link after its package is deleted.',
      instructions: '# Missing dependency proof\n\nThe dependency must remain missing.',
      target: { kind: 'personal', user: 'sergey' },
    })

    // The Skills inventory is sized the way the Roles one is: the Product Space's
    // fleet plus the Personal fallback that always rides along has to clear BOTH
    // page sizes at the default SCALE — the library asks for 24 rows a page
    // (`packageLibraryState.ts`) and the explorer for 30 (`AgentsExplorer.tsx`).
    // Below either number the stand can never show a second page.
    for (const [name, title, description] of SKILL_TITLES.slice(0, take(12))) {
      b.agentSkill({
        name,
        description,
        instructions: `# ${title}\n\n${description}`,
        home: { kind: 'personal', user: 'sergey' },
      })
    }
    // Space skills, each with a DIFFERENT availability shape, so the editor's
    // tri-state tree is exercised at all/one/some rather than only at "all".
    for (const [index, [name, title, description]] of SKILL_TITLES.slice(0, take(16)).entries()) {
      const availability: AgentAbilityAvailabilityDecl =
        index % 3 === 0
          ? { mode: 'all-projects' }
          : index % 3 === 1
            ? { mode: 'selected-projects', projects: [{ space: 'product', path: 'web' }] }
            : {
                mode: 'selected-projects',
                projects: [
                  { space: 'product', path: 'web' },
                  { space: 'product', path: 'api' },
                  { space: 'product', path: 'mobile' },
                ],
              }
      b.agentSkill({
        name: `team-${name}`,
        description,
        instructions: `# Team ${title.toLowerCase()}\n\n${description}`,
        home: { kind: 'space', space: 'product' },
        availability,
      })
    }

    b.agentSkill({
      name: 'store-review',
      description: 'Work the mobile store review window.',
      instructions: '# Store review\n\nPlan around the store review window before shipping.',
      home: { kind: 'space', space: 'product' },
      availability: { mode: 'selected-projects', projects: [{ space: 'product', path: 'mobile' }] },
      linkedRole: 'handoff-review',
    })
    b.agentSkill({
      name: 'evidence-index',
      description: 'Keep the evidence index current while reviewing.',
      instructions: '# Evidence index\n\nKeep every claim addressable while the review runs.',
      home: { kind: 'personal', user: 'sergey' },
      linkedRole: 'evidence-lead',
    })
    b.agentSkill({
      name: 'markdown-package-proof',
      description: 'A Markdown auxiliary that blocks the temporary agent delete contract.',
      instructions:
        '# Markdown package proof\n\nMust fail closed in delete_ability; human package delete remains available.',
      home: { kind: 'personal', user: 'sergey' },
      packageFiles: [
        {
          path: 'references/checklist.md',
          content: '# Checklist\n\nA restorable package member.\n',
        },
      ],
    })
    b.agentSkill({
      name: 'asset-package-proof',
      description: 'A package with bytes Trash cannot restore.',
      instructions: '# Asset package proof\n\nMust fail closed in delete_ability.',
      home: { kind: 'personal', user: 'sergey' },
      packageFiles: [{ path: 'assets/template.bin', content: 'seeded binary-shaped resource' }],
    })
    b.agentSkill({
      name: 'deleted-dependency-proof',
      description: 'A dependency deleted after its exact role link was authored.',
      instructions: '# Deleted dependency proof\n\nThis package is intentionally removed.',
      home: { kind: 'personal', user: 'sergey' },
      linkedRole: 'missing-dependency-proof',
      deleted: true,
    })
    b.agentSkill({
      name: 'agent-created-oversized-proof',
      description: 'An agent-attributed body too large for runtime activation.',
      instructions: `# Agent-created oversized proof\n\n${'Oversized agent-authored evidence block. '.repeat(2_000)}`,
      home: { kind: 'personal', user: 'sergey' },
      agentAudit: {
        principal: 'pat:seed:ability-author',
        owner: 'sergey',
        agent: 'Seed ability author',
        sessionRef: 'agent-created-ability',
        sessionAttach: 'declared',
      },
      pins: [{ kind: 'project', space: 'product', path: 'web' }],
    })
    b.agentSkill({
      name: 'research',
      description: 'A same-name Owned Skill beside the System research Role.',
      instructions: '# Research skill\n\nSAME_KIND_SKILL_SENTINEL.',
      home: { kind: 'personal', user: 'sergey' },
    })

    // A catalog Add on a PROJECT placement — the one operation that installs a
    // role and its supporting package at two DIFFERENT homes: the role lands in
    // Mobile, its dependency in the Space, because a project has no skill home.
    b.agentRole({ name: 'grooming', target: { kind: 'project', space: 'product', path: 'mobile' } })
    // ...and the state that split home reaches: the owner edits the package the Add
    // installed instead of publishing a same-name substitute beside it. The role is
    // addressed by `roleTarget` (Mobile) while the skill is addressed by its own
    // `home` (the Space) — without the two apart, the dependency lookup asks the
    // Space for a role that only exists in the project and finds nothing. The rename
    // is what makes the edit visible: the link stays exact and keeps resolving, so
    // the card reads `grooming-evidence-house` under a role that still links
    // `grooming-evidence`.
    b.agentSkill({
      source: 'role-dependency',
      role: 'grooming',
      name: 'grooming-evidence',
      home: { kind: 'space', space: 'product' },
      roleTarget: { kind: 'project', space: 'product', path: 'mobile' },
      renameTo: 'grooming-evidence-house',
    })
    // The SAME operation one space over, where the space is the owner's PERSONAL one
    // — and that single difference changes the answer: Personal IS the root of that
    // space, so the dependency lands in the personal library and the role's link has
    // to say `personal`, not `space`. Nothing else in the catalog put a role with a
    // dependency in a project of a personal space, so a seeder that answered "no
    // personal space" for such a placement published a role whose only attachment was
    // an address the locator seam refuses — and every stand looked healthy.
    b.agentRole({ name: 'grooming', target: { kind: 'project', space: 'main', path: '' } })
    b.agentSkill({
      source: 'role-dependency',
      role: 'grooming',
      name: 'grooming-evidence',
      home: { kind: 'personal', user: 'sergey' },
      roleTarget: { kind: 'project', space: 'main', path: '' },
      renameTo: 'grooming-evidence-mine',
    })

    // The three Enable/Disable rows this stand exists to show. `shared-reviewer` is
    // disabled at ONE of its two placements, which is what makes the override a
    // property of the package rather than of the name; the two attached packages turn
    // their roles' health into the states an owner produced, not the library.
    b.agentAbilityPreference({
      user: 'sergey',
      ability: {
        source: 'owned',
        kind: 'role',
        name: 'shared-reviewer',
        target: { kind: 'personal', user: 'sergey' },
      },
      enabled: false,
    })
    b.agentAbilityPreference({
      user: 'sergey',
      ability: {
        source: 'owned',
        kind: 'skill',
        name: 'evidence-index',
        home: { kind: 'personal', user: 'sergey' },
      },
      enabled: false,
    })
    b.agentAbilityPreference({
      user: 'sergey',
      ability: { source: 'system', kind: 'skill', name: 'research-evidence' },
      enabled: false,
    })

    return b.build()
  },
}
