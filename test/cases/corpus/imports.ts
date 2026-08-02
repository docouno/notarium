import type { Fragment } from './types'

// Imported-content BODY shapes (#11/#223) — Notarium "lives on ChatGPT/Claude
// exports". The import parsers emit these note bodies: a Claude conversation
// (`### Human/Assistant (ts)`), a ChatGPT thread, and a memory-json entity note
// (observations + relations that become [[wikilinks]] → real graph edges). The
// import CASE arranges these into the canonical folder layout with backdated dates;
// here they are the reusable body fragments. Grounded in import.md + import.test.ts.
export const importsFragments: Fragment[] = [
  {
    id: 'imports-claude-conversation',
    feature: 'imports',
    exercises: 'a Claude-conversation note — Human/Assistant turns with a timestamp',
    md: [
      '### Human (2024-03-15 14:02)',
      '',
      'Where should we go for the trip?',
      '',
      '### Assistant (2024-03-15 14:02)',
      '',
      'How about Lisbon? Great food, mild weather, and:',
      '',
      '```python',
      'budget = 1200  # EUR',
      '```',
    ].join('\n'),
    refs: ['#11', 'import.md', 'import.test.ts'],
    expect: { contains: ['Human', 'language-python'] },
  },
  {
    id: 'imports-chatgpt-thread',
    feature: 'imports',
    exercises: 'a ChatGPT thread with alternating turns, a table and block math',
    md: [
      '## You',
      '',
      'Give me the heatmap intensity formula.',
      '',
      '## Assistant',
      '',
      'The intensity of a day is the sum of its journal rows:',
      '',
      '$$ I(d) = created(d) + edited(d) + deleted(d) $$',
      '',
      '| kind | weight |',
      '|---|---|',
      '| created | 1 |',
      '| edited | 1 |',
    ].join('\n'),
    refs: ['#11', '#113', 'importThread'],
    expect: { contains: ['katex-display', 'md-table-wrap'] },
  },
  {
    id: 'imports-memory-json',
    feature: 'imports',
    exercises: 'a memory-json entity note — observations + a relation that becomes a wikilink edge',
    md: '# Alice\n\n- Likes tea\n- Prefers async communication\n- works at [[Acme]]',
    refs: ['#11', 'import.md', 'import.test.ts'],
    expect: { contains: ['href="#wiki/Acme"'] },
  },
  {
    id: 'imports-thread-banner',
    feature: 'imports',
    exercises: 'the imported-from banner callout that heads a converted thread',
    md: '> [!tip] Imported from a Claude export\n> Long dialogue with code, a table and diagram/math fences below.',
    refs: ['#223', 'importThread'],
    expect: { contains: ['callout-tip'] },
  },
]
