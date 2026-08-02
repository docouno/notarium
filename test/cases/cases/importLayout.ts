import { fragmentById } from '../corpus'
import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

// The import LAYOUT (#11/#113/#223): converted AI exports laid out in the canonical
// folders (conversations/claude, conversations/chatgpt, memory/<type>, projects/<slug>)
// with provenance tags and BACKDATED dates-as-data — so the Feed spreads the history
// across real YEARS (2022–2024), the "backdated import looks real" proof (#11). Bodies
// come from the imports corpus. Distinct from import-thread (one rich thread) — this is
// the multi-format layout + the Feed year-spread. Grounded in import.md.
export const importLayout: CaseSpec = {
  name: 'import',
  description:
    'A converted multi-format import in canonical folders with backdated dates-as-data — Claude/ChatGPT conversations, memory entities, a project; the Feed year-spread (#11/#223).',
  axes: ['import', 'content', 'activity'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'main', displayName: 'Main' })

    const claude = fragmentById('imports-claude-conversation').md

    // Claude conversations across ~three years (dates-as-data → Feed year-spread).
    ;[1400, 980, 620, 300, 90].forEach((days, i) => {
      b.note({
        space: 'main',
        path: `conversations/claude/planning-session-${i + 1}.md`,
        title: `Planning session ${i + 1}`,
        content: `# Planning session ${i + 1}\n\n${claude}`,
        tags: ['import', 'claude'],
        noteType: 'conversation',
        created: daysBefore(now, days, 14),
        principal: 'user:sergey',
      })
    })

    // A ChatGPT thread (modern export shape).
    b.note({
      space: 'main',
      path: 'conversations/chatgpt/heatmap-formula.md',
      title: 'Heatmap formula',
      content: `# Heatmap formula\n\n${fragmentById('imports-chatgpt-thread').md}`,
      tags: ['import', 'chatgpt'],
      noteType: 'conversation',
      created: daysBefore(now, 500, 11),
      principal: 'user:sergey',
    })

    // memory-json entities — observations + relations that become [[wikilink]] edges.
    b.note({
      space: 'main',
      path: 'memory/person/alice.md',
      title: 'Alice',
      content: fragmentById('imports-memory-json').md,
      tags: ['import', 'memory'],
      created: daysBefore(now, 200, 9),
      principal: 'user:sergey',
    })
    b.note({
      space: 'main',
      path: 'memory/org/acme.md',
      title: 'Acme',
      content: '# Acme\n\n- Founded 2010\n- Employs [[Alice]]',
      tags: ['import', 'memory'],
      created: daysBefore(now, 200, 9),
      principal: 'user:sergey',
    })

    // A Claude project — a prompt-template + a doc under projects/<slug>/.
    b.note({
      space: 'main',
      path: 'projects/acme-redesign/prompt-template.md',
      title: 'Acme Redesign',
      content: '# Acme Redesign\n\nCustom project instructions for the redesign.',
      tags: ['import', 'claude'],
      created: daysBefore(now, 350, 10),
      principal: 'user:sergey',
    })
    b.note({
      space: 'main',
      path: 'projects/acme-redesign/docs/brief.md',
      title: 'Brief',
      content: '# Brief\n\nRedesign the marketing site; keep the mascot.',
      tags: ['import', 'claude'],
      created: daysBefore(now, 349, 10),
      principal: 'user:sergey',
    })

    return b.build()
  },
}
