import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

// Port of the retired scripts/seed-agent-context.mjs (#165): a stand that
// stress-tests the agent-context UI — pinned always-load notes, heavy personal +
// project agent-memory (with muted categories), and projects of varied density.
// Unlike the old HTTP seeder (one "today" journal spike), this rides the shared
// catalog + the in-process backdated applier, so its Activity surfaces are honest.

const pad = (n: number) => String(n).padStart(2, '0')

// ~`tokens` ASCII tokens of filler prose under a heading (estimateTokens ≈ 4 chars/
// token) — sizes a pin against the #208 token budgets so the scale, the personal-
// embeds-into-Q squeeze, and the per-item weight meters have GENUINELY heavy pins to
// render and trim, not tiny stubs.
const fatBody = (title: string, tokens: number): string => {
  const line =
    'This paragraph deliberately weighs the note so the token budget, the context scale, and the per-item weight meters have a genuinely heavy pin to render and to trim. '
  return `# ${title}\n\n${line.repeat(Math.max(1, Math.ceil((tokens * 4) / line.length)))}`
}

/** The #165/#208 agent-context demo world: a personal domain with pins (incl. HEAVY
 *  ones that overflow the personal budget) + memory, a heavy "Atlas" team space with a
 *  pinned product project + project memory, a note-heavy archive, and a dedicated
 *  "Budget Lab" space isolating each #208 token-budget case (fits / squeeze / no-pins)
 *  so the personal-embeds-into-project-budget nesting is reproducible. */
export const agentContext: CaseSpec = {
  name: 'agent-context',
  description:
    'The #165/#208/#209 agent-context demo: personal pins + memory (with heavy over-budget pins), a heavy team project, a cross-space CONTEXT SET (Frontend Canon) attached to a project + personal, an archive, and a Budget Lab isolating each token-budget case.',
  axes: ['agent-memory', 'agent-audit', 'structure', 'note-classes', 'scale'],
  build: ({ scale, now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'home', displayName: 'Home', personalFor: 'sergey' })
    b.space({ slug: 'atlas', displayName: 'Atlas Team' })
    b.space({ slug: 'archive', displayName: 'Archive Lab' })

    b.user({
      username: 'sergey',
      password: 'seed-pass',
      displayName: 'Sergey',
      admin: true,
      personalSpace: 'home',
    })
    b.connectedApp({
      owner: 'sergey',
      appName: 'Claude',
      scope: 'read',
      spaces: null,
      connectedDaysAgo: 4,
      lastUsedDaysAgo: 0.5,
    })
    b.member({ space: 'atlas', username: 'sergey', role: 'owner' })
    b.member({ space: 'archive', username: 'sergey', role: 'owner' })

    // A SECOND reader for the #209 honest-degradation demo: alex is a member of `atlas` (so
    // they see the Product OS project and its attached Frontend Canon set + Security Baseline
    // pin) but NOT of `conventions` (the set/pin's home space). Logging in as alex and opening
    // the Product OS pult shows the set + pin with their conventions-homed items silently
    // DROPPED — the cross-space safety guarantee, observable live (mirrors the mallory fixture).
    b.space({ slug: 'alex-home', displayName: 'Alex Home', personalFor: 'alex' })
    b.user({
      username: 'alex',
      password: 'seed-pass',
      displayName: 'Alex',
      personalSpace: 'alex-home',
    })
    b.member({ space: 'atlas', username: 'alex', role: 'writer' })

    b.project({ space: 'atlas', path: 'product', displayName: 'Product OS' })
    b.project({ space: 'atlas', path: 'research', displayName: 'Research Inbox' })
    b.project({ space: 'archive', path: '2025', displayName: 'Archive 2025' })
    b.project({ space: 'archive', path: '2026', displayName: 'Archive 2026' })

    const s = (n: number) => Math.max(1, Math.round(n * scale))

    // Personal: 12 pinned profile-notes (always-load overflow past ~10).
    for (let i = 1; i <= s(12); i++) {
      b.note({
        space: 'home',
        path: `agent-context/personal-pins/pin-${pad(i)}.md`,
        title: `Personal Context Pin ${pad(i)}`,
        noteType: 'profile-note',
        tags: ['personal', i <= 10 ? 'daily' : 'overflow'],
        pin: true,
        created: daysBefore(now, 30 - i, 9),
        principal: 'user:sergey',
      })
    }
    // Heavy personal pins (#208): sized so the WHOLE personal scope (these + the 12 small
    // pins + the loose Security Baseline scope-pin + the Frontend Canon set + memory) fits
    // UNDER the personal budget P — home stays a clean full load, no personal-route trim —
    // yet the fattest still dominates the weight meters (~32% of P) so "spot the fat pin" is
    // obvious. NB: since these carry the `always-load` tag they DO count against P, so the
    // sum is kept to ~15k (well under P) — the over-budget TRIM is demonstrated ONLY by the
    // Budget Lab "squeeze" project below (personal embedded into a project's remaining Q),
    // avoiding the "budget still free, yet trimming" strict-prefix confusion the owner
    // flagged. Fixed (not scaled) so the budget case is stable.
    const heavyHome: Array<[string, number]> = [
      ['Раздутый гайд по деплою', 7_000],
      ['Тяжёлые заметки по релизу', 5_000],
      ['Длинный разбор инцидентов', 3_000],
    ]
    const heavyId: string[] = []
    heavyHome.forEach(([title, tokens], i) => {
      heavyId.push(
        b.note({
          space: 'home',
          path: `agent-context/heavy-pins/heavy-${pad(i + 1)}.md`,
          title,
          noteType: 'runbook',
          tags: ['personal', 'heavy'],
          pin: true,
          content: fatBody(title, tokens),
          created: daysBefore(now, 5 - i, 11),
          principal: 'user:sergey',
        }),
      )
    })
    const [deployGuide, releaseNotes, incidentReview] = heavyId

    // Personal scratch (unpinned) notes.
    for (let i = 1; i <= s(6); i++) {
      b.note({
        space: 'home',
        path: `${i <= 3 ? 'journal' : 'reading'}/scratch-${pad(i)}.md`,
        title: `Personal Scratch ${pad(i)}`,
        tags: ['personal', 'scratch'],
        created: daysBefore(now, 20 - i, 8),
        principal: 'user:sergey',
      })
    }
    // Personal agent-memory: 20 categories, 3 muted (audit-only).
    for (let i = 1; i <= s(20); i++) {
      const cat = `preference-${pad(i)}`
      b.note({
        space: 'home',
        path: `.notarium/memory/${cat}.md`,
        title: cat,
        content: `# ${cat}\n\nPersonal preference ${i}: demo observation for loaded-count and muted-state scanning.`,
        class: 'agent-memory',
        summary: `Preference ${i}.`,
        muted: i >= 18,
        created: daysBefore(now, 45 - i, 7),
        principal: 'user:sergey',
      })
    }

    // The project's folder page is an ordinary same-space pin (#311). It makes the
    // exact boundary visible in the reader action, picker and Context row: unpin it
    // in the reader, then find it again as "Folder overview · product" in the picker.
    b.note({
      space: 'atlas',
      path: 'product/index.md',
      title: 'Product OS overview',
      noteType: 'project-overview',
      tags: ['product', 'overview'],
      pin: true,
      content: '# Product OS overview\n\nThe operating context for the Product OS project.',
      created: daysBefore(now, 32, 9),
      principal: 'user:sergey',
    })

    // Atlas / Product OS: its pinned overview + 12 pinned runbooks, working notes
    // and project memory.
    for (let i = 1; i <= s(12); i++) {
      b.note({
        space: 'atlas',
        path: `product/context/pin-${pad(i)}.md`,
        title: `Product OS Context Pin ${pad(i)}`,
        noteType: 'runbook',
        tags: ['product', i > 10 ? 'overflow' : 'core'],
        pin: true,
        created: daysBefore(now, 28 - i, 10),
        principal: 'user:sergey',
      })
    }
    const folders = ['design', 'runbooks', 'decisions', 'metrics']

    for (let i = 1; i <= s(24); i++) {
      // created lives in a BOUNDED window [12..39] days ago so it's always OLDER than the
      // day-4 edit (a decreasing `40 - i` would, at SCALE≳1.7, put created more recent
      // than the fixed edit → edit-before-create → real-applier crash).
      b.note({
        space: 'atlas',
        path: `product/${folders[i % folders.length]}/note-${pad(i)}.md`,
        title: `Product OS Working Note ${pad(i)}`,
        tags: ['product'],
        created: daysBefore(now, 12 + (i % 28), 9 + (i % 6)),
        edits: i % 3 === 0 ? [daysBefore(now, 4, 12)] : [],
        principal: 'user:sergey',
      })
    }
    for (let i = 1; i <= s(6); i++) {
      b.note({
        space: 'atlas',
        path: `research/finding-${pad(i)}.md`,
        title: `Research Inbox Finding ${pad(i)}`,
        tags: ['research'],
        created: daysBefore(now, 50 - i * 2, 9),
        principal: 'user:sergey',
      })
    }
    // Project memory (agent-memory in the atlas space), a couple muted.
    for (let i = 1; i <= s(10); i++) {
      const cat = `product-context-${pad(i)}`
      b.note({
        space: 'atlas',
        path: `.notarium/memory/${cat}.md`,
        title: cat,
        content: `# ${cat}\n\nProduct OS project memory ${i}: durable agent note for heavy project-memory UX.`,
        class: 'agent-memory',
        summary: `Product context ${i}.`,
        muted: i >= 9,
        created: daysBefore(now, 35 - i, 8),
        principal: 'user:sergey',
      })
    }

    // ── Context sets (#209): a shared "Conventions" space + a reusable cross-space set
    // "Frontend Canon" attached to the Product OS project AND to personal — exactly the
    // issue's story (a set assembled from a shared space, attached to a project AND to
    // personal, its notes resolving cross-space). Under Product OS the set loads after the
    // project's own pins; under Personal it loads after the personal pins.
    b.space({ slug: 'conventions', displayName: 'Conventions' })
    b.member({ space: 'conventions', username: 'sergey', role: 'owner' })
    const convFront = b.note({
      space: 'conventions',
      path: 'frontend.md',
      title: 'Frontend Conventions',
      noteType: 'runbook',
      tags: ['conventions', 'frontend'],
      content: fatBody('Frontend Conventions', 1_400),
      created: daysBefore(now, 22, 9),
      principal: 'user:sergey',
    })
    const convApi = b.note({
      space: 'conventions',
      path: 'api.md',
      title: 'API Conventions',
      noteType: 'runbook',
      tags: ['conventions', 'api'],
      content: fatBody('API Conventions', 1_100),
      created: daysBefore(now, 19, 9),
      principal: 'user:sergey',
    })
    const convNaming = b.note({
      space: 'conventions',
      path: 'naming.md',
      title: 'Naming & Structure',
      noteType: 'runbook',
      tags: ['conventions'],
      content: fatBody('Naming & Structure', 900),
      created: daysBefore(now, 16, 9),
      principal: 'user:sergey',
    })

    // A few plain notes so the space isn't just the set (browsable).
    for (let i = 1; i <= s(4); i++) {
      b.note({
        space: 'conventions',
        path: `guides/guide-${pad(i)}.md`,
        title: `Team Guide ${pad(i)}`,
        tags: ['conventions'],
        created: daysBefore(now, 30 - i, 8),
        principal: 'user:sergey',
      })
    }
    b.contextSet({
      homeSpace: 'conventions',
      name: 'Frontend Canon',
      items: [convFront, convApi, convNaming],
      attach: [
        { kind: 'project', space: 'atlas', path: 'product' },
        { kind: 'personal', user: 'sergey' },
      ],
    })

    // ── Loose cross-space PIN (#209): a single Conventions note pinned DIRECTLY into a
    // scope (no named set) — the sibling of the set. "Security Baseline" lives in
    // `conventions` but is pinned into the Product OS project AND personal, so it shows
    // as a normal pin row carrying a `conventions` home chip (resolved cross-space).
    const convSecurity = b.note({
      space: 'conventions',
      path: 'security.md',
      title: 'Security Baseline',
      noteType: 'runbook',
      tags: ['conventions', 'security'],
      content: fatBody('Security Baseline', 800),
      created: daysBefore(now, 14, 9),
      principal: 'user:sergey',
    })
    b.scopePin({ note: convSecurity, attach: { kind: 'project', space: 'atlas', path: 'product' } })
    b.scopePin({ note: convSecurity, attach: { kind: 'personal', user: 'sergey' } })

    // ── Context ORDER (#210): a user-defined pin+set order = load priority. The exact issue
    // story — the "Frontend Canon" SET dragged to the TOP of the Pinned list, ABOVE the tag
    // pins (pins and sets share one rank space), then the heavy home pins prioritized. Partial
    // on purpose (the small pin-NN + memory fall back to the default order behind these), so
    // the seed also exercises the self-healing merge. The PROJECT order likewise floats the
    // set + the Security Baseline cross-space pin to the top of Product OS.
    b.contextOrderFor({
      scope: { kind: 'personal', user: 'sergey' },
      entries: [
        { kind: 'set', name: 'Frontend Canon' },
        { kind: 'pin', note: deployGuide },
        { kind: 'pin', note: releaseNotes },
        { kind: 'pin', note: convSecurity },
        { kind: 'pin', note: incidentReview },
      ],
    })
    b.contextOrderFor({
      scope: { kind: 'project', space: 'atlas', path: 'product' },
      entries: [
        { kind: 'set', name: 'Frontend Canon' },
        { kind: 'pin', note: convSecurity },
      ],
    })

    // Archive: note-heavy, memory-light.
    for (const [year, days] of [
      ['2025', 300],
      ['2026', 120],
    ] as const) {
      for (let i = 1; i <= s(12); i++) {
        b.note({
          space: 'archive',
          path: `${year}/${i % 3 === 0 ? 'deep' : 'logs'}/note-${pad(i)}.md`,
          title: `Archive ${year} Note ${pad(i)}`,
          tags: ['archive'],
          created: daysBefore(now, days + i, 9),
          principal: 'user:sergey',
        })
      }
    }

    // ── Budget Lab (#208): a dedicated space isolating each token-budget case, so the
    // personal (P) and project (Q) scales — and the personal-embeds-into-Q nesting —
    // are reproducible at a glance. Personal (home, shared background) embeds into each
    // project's Q after the project's own pins load first. Fixed sizes (not scaled).
    b.space({ slug: 'budget-lab', displayName: 'Budget Lab' })
    b.member({ space: 'budget-lab', username: 'sergey', role: 'owner' })
    b.project({ space: 'budget-lab', path: 'fits', displayName: 'Fits — personal embeds fully' })
    b.project({
      space: 'budget-lab',
      path: 'squeeze',
      displayName: 'Squeeze — personal partly trimmed by Q',
    })
    b.project({
      space: 'budget-lab',
      path: 'no-pins',
      displayName: 'No pins — full personal, zero project',
    })

    // fits: small project pins → the project loads cheap, the whole personal background
    // embeds under Q with headroom (in a rich project MORE personal fits than under P).
    for (let i = 1; i <= 3; i++) {
      b.note({
        space: 'budget-lab',
        path: `fits/pin-${pad(i)}.md`,
        title: `Fits Pin ${pad(i)}`,
        noteType: 'runbook',
        tags: ['budget', 'fits'],
        pin: true,
        created: daysBefore(now, 9 - i, 10),
        principal: 'user:sergey',
      })
    }
    // squeeze: two fat project pins (≈25k) eat the front of Q=38k → the personal background
    // embeds only PARTIALLY into the ≈13k remainder (the crux — project outranks the general
    // scope, but personal is squeezed, not zeroed). The real engine lists pins ORDER BY path,
    // so the personal side leads with the heavy home pins (7k+5k+3k=15k); the remainder admits
    // the first two (≈12k) and TRIMS the third — a heavy home pin visibly squeezed out (with
    // the small pins + set + memory behind it), distinct from both "fits" (full embed) and a
    // fully-trimmed project. Sized so the boundary falls ON a heavy pin (not just set items).
    const squeeze: Array<[string, number]> = [
      ['Squeeze Runbook A', 15_000],
      ['Squeeze Runbook B', 10_000],
    ]
    squeeze.forEach(([title, tokens], i) => {
      b.note({
        space: 'budget-lab',
        path: `squeeze/pin-${pad(i + 1)}.md`,
        title,
        noteType: 'runbook',
        tags: ['budget', 'squeeze'],
        pin: true,
        content: fatBody(title, tokens),
        created: daysBefore(now, 8 - i, 10),
        principal: 'user:sergey',
      })
    })
    // no-pins: notes but no always-load pins → project contributes zero, the full personal
    // background embeds under Q.
    for (let i = 1; i <= 3; i++) {
      b.note({
        space: 'budget-lab',
        path: `no-pins/note-${pad(i)}.md`,
        title: `No-pins Note ${pad(i)}`,
        tags: ['budget', 'plain'],
        created: daysBefore(now, 6 - i, 10),
        principal: 'user:sergey',
      })
    }

    // ── Agent retrieval audit (#243): the runtime twin of the constructor above. A mix of
    // HITS (the query surfaced a real note) and MISSES (zero results — the blind-spot
    // signal). The headline is the vocabulary-mismatch demo the issue names: a deploy note
    // EXISTS ("Раздутый гайд по деплою"), but the agent that phrases it "deploy prod
    // checklist" keeps coming back empty — a fact that is effectively dead, invisible
    // without this surface. Repeated queries build the "Frequent" + "Blind spots" ranks.
    // Two agents (a CLI PAT + a connected Claude app) show the "which agent" lens.
    // Two agents with friendly names — a CLI PAT + a connected Claude app (the "which
    // agent" lens; captured at runtime from the live token, supplied directly in the seed).
    const cli = { principal: 'pat:sergey:cli', agent: 'CLI' }
    const claude = { principal: 'oauth:claude', agent: 'Claude' }
    // Hits — the agent found what it looked for.
    b.retrieval({
      ...cli,
      tool: 'search',
      query: 'гайд по деплою',
      hits: [{ note: deployGuide, score: 8.4 }],
      daysAgo: 0.2,
    })
    b.retrieval({
      ...cli,
      tool: 'search',
      query: 'release notes',
      hits: [{ note: releaseNotes, score: 6.1 }],
      daysAgo: 0.32,
    })
    b.retrieval({
      ...cli,
      tool: 'get_note',
      query: releaseNotes,
      hits: [{ note: releaseNotes }],
      daysAgo: 0.31,
    })
    b.retrieval({
      ...claude,
      tool: 'search',
      query: 'разбор инцидента',
      hits: [{ note: incidentReview, score: 7.0 }],
      daysAgo: 0.5,
    })
    b.retrieval({
      ...claude,
      tool: 'recall',
      query: 'release process',
      hits: [{ note: releaseNotes }, { note: deployGuide }],
      daysAgo: 1.0,
    })
    b.retrieval({
      ...cli,
      tool: 'recall',
      query: 'how we deploy',
      hits: [{ note: deployGuide }],
      daysAgo: 2.1,
    })
    // The vocabulary-mismatch blind spot — the killer case (empty, and it RECURS).
    b.retrieval({
      ...claude,
      tool: 'search',
      query: 'deploy prod checklist',
      hits: [],
      daysAgo: 0.6,
    })
    b.retrieval({ ...cli, tool: 'search', query: 'deploy prod checklist', hits: [], daysAgo: 1.25 })
    b.retrieval({
      ...claude,
      tool: 'search',
      query: 'deploy prod checklist',
      hits: [],
      daysAgo: 3.4,
    })
    // Other recurring blind spots — genuine gaps in memory.
    b.retrieval({
      ...cli,
      tool: 'search',
      query: 'on-call rotation',
      classFilter: 'agent-memory',
      hits: [],
      daysAgo: 1.5,
    })
    b.retrieval({
      ...cli,
      tool: 'search',
      query: 'on-call rotation',
      classFilter: 'agent-memory',
      hits: [],
      daysAgo: 2.6,
    })
    b.retrieval({
      ...claude,
      tool: 'recall',
      query: 'kubernetes secret rotation',
      hits: [],
      daysAgo: 3.1,
    })
    // Frequent, still-answered queries (build the "Frequent" rank).
    b.retrieval({
      ...cli,
      tool: 'search',
      query: 'release notes',
      hits: [{ note: releaseNotes, score: 5.8 }],
      daysAgo: 3.6,
    })
    b.retrieval({
      ...claude,
      tool: 'search',
      query: 'release notes',
      hits: [{ note: releaseNotes, score: 6.0 }],
      daysAgo: 4.2,
    })

    // Bulk history (older) so the Audit list PAGINATES — the server windows offset/limit and
    // the UI infinite-scrolls, so a large log never loads at once. Deterministic (index-driven),
    // mostly hits (kept OUT of the curated blind-spots story), spread 5–38 days back — all older
    // than the curated set above, which stays on top (newest-first).
    const bulkQueries = [
      'onboarding checklist',
      'sprint retro',
      'db migration plan',
      'api rate limits',
      'auth flow',
      'staging env',
      'incident postmortem',
      'roadmap Q3',
      'design tokens',
      'metrics dashboard',
      'feature flags',
      'backup policy',
      'oauth scopes',
      'search ranking',
    ]
    const bulkTools = ['search', 'recall', 'get_note'] as const
    const bulkTargets = [deployGuide, releaseNotes, incidentReview]

    for (let i = 0; i < 56; i++) {
      const tool = bulkTools[i % 3]
      const who = i % 2 === 0 ? cli : claude
      const daysAgo = 5 + i * 0.6
      const target = bulkTargets[i % 3]

      if (tool === 'get_note') {
        b.retrieval({ ...who, tool, query: target, hits: [{ note: target }], daysAgo })
      } else {
        const hit = i % 5 !== 4 // ~4/5 land — bulk misses stay rare + single, not blind spots
        b.retrieval({
          ...who,
          tool,
          query: bulkQueries[i % bulkQueries.length],
          hits: hit ? [{ note: target, ...(tool === 'search' ? { score: 3 + (i % 5) } : {}) }] : [],
          daysAgo,
        })
      }
    }

    return b.build()
  },
}
