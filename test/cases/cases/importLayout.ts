import { fragmentById } from '../corpus'
import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

// The import LAYOUT (#11/#113/#223/#280): converted AI exports laid out in the canonical
// folders (conversations/claude, conversations/chatgpt, memory/<type>, projects/<slug>)
// with provenance tags and BACKDATED dates-as-data — so the Feed spreads the history
// across real YEARS (2021–2025), the "backdated import looks real" proof (#11). Bodies
// come from the imports corpus. Distinct from import-thread (one rich thread) — this is
// the multi-format layout + the Feed year-spread. `dropped/` carries the #280 states of a
// dragged-in .md archive: the file's OWN frontmatter lifted into tags/date/title and the
// author's other keys kept. Grounded in import.md.
export const importLayout: CaseSpec = {
  name: 'import',
  description:
    'A converted multi-format import in canonical folders with backdated dates-as-data — Claude/ChatGPT conversations, memory entities, a project — plus dropped .md files whose own frontmatter was lifted (#11/#223/#280); the Feed year-spread.',
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

    // ── Dropped .md files whose OWN frontmatter was lifted (#280) ──
    // The states a dragged-in archive produces. Each note here is what the import
    // writes: authored tags/date in typed channels, the author's other keys kept.

    // The issue's own example: an authored title, tags and date — the note is NOT
    // "dogovor.md, no tags, today".
    b.note({
      space: 'main',
      path: 'dropped/dogovor.md',
      title: 'Договор',
      content: '# Договор\n\nПредмет договора и условия оплаты.',
      tags: ['работа', '2025'],
      created: '2025-03-14T00:00:00.000Z',
      principal: 'user:sergey',
    })

    // An Obsidian vault note: the file NAME is the title (no H1), `aliases:` make
    // inbound [[Weekly Review]] resolve, and the plugin keys nobody models survive.
    b.note({
      space: 'main',
      path: 'dropped/retro-2024-q4.md',
      title: 'retro 2024 q4',
      content: 'Shipped the importer. [[Договор]] signed.\n\nNext: durable jobs.',
      tags: ['retro'],
      frontmatter: [
        'aliases: [Weekly Review]',
        'author: Sergey',
        'cssclasses: [wide]',
        'obsidian:',
        '  plugin: periodic-notes',
        '  interval: quarterly',
      ].join('\n'),
      created: daysBefore(now, 240, 16),
      principal: 'user:sergey',
    })

    // A Jekyll/Hugo post: `date:` is the creation date, and the draft `# H1` in the
    // body differs from the authored title — so the title wins and the H1 STAYS.
    b.note({
      space: 'main',
      path: 'dropped/hello-world.md',
      title: 'Hello, world',
      content: '# Draft heading kept in the body\n\nThe first post of the blog.',
      tags: ['blog'],
      frontmatter: ['layout: post', 'categories: [meta]', 'permalink: /hello/'].join('\n'),
      created: '2021-11-08T00:00:00.000Z',
      principal: 'user:sergey',
    })

    // No frontmatter at all: dated by the FILE's mtime, not by the import moment —
    // the difference between a readable archive and one heap on today's Feed.
    b.note({
      space: 'main',
      path: 'dropped/scratch.md',
      title: 'scratch',
      content: 'ideas:\n\n- graph zoom\n- token scale',
      created: daysBefore(now, 620, 9),
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
