import type { Fragment } from './types'

// Callouts / admonitions (#117) — Obsidian syntax `> [!type]`. Twelve canonical
// looks + case-insensitive aliases (caution→danger, tldr→abstract, …); foldable via
// native <details> (`+` open, `-` collapsed); custom title; markdown inside the body;
// an unknown `[!xyz]` falls back to the note look but keeps its own title. Grounded
// in callout.ts + callouts.scss.
export const calloutsFragments: Fragment[] = [
  {
    id: 'callout-looks',
    feature: 'callouts',
    exercises: 'several distinct looks (colour + icon) render',
    md: [
      '> [!note]',
      '> The default callout. Body can hold **markdown**, `code` and links.',
      '',
      '> [!tip] A custom title',
      '> Tips get their own colour and icon.',
      '',
      '> [!warning] Be careful',
      '> Warnings stand out.',
      '',
      '> [!danger] Destructive',
      '> Danger / error / failure share the red look.',
      '',
      '> [!success] Done',
      '> A green success callout.',
      '',
      '> [!important] Key point',
      '> Important uses the accent look.',
    ].join('\n'),
    refs: ['#117', 'readerShowcase', 'callout.ts'],
    expect: {
      contains: [
        'callout callout-note',
        'callout-tip',
        'callout-warning',
        'callout-danger',
        'callout-success',
        'callout-important',
      ],
    },
  },
  {
    id: 'callout-foldable',
    feature: 'callouts',
    exercises: 'foldable callouts — `-` starts collapsed, `+` starts open (native <details>)',
    md: '> [!example]- Collapsed by default\n> Foldable via a native `<details>`, no JS. Click to expand.\n\n> [!tip]+ Open by default\n> Starts expanded.',
    refs: ['#117', 'callout.ts'],
    expect: {
      contains: [
        '<details class="callout callout-example callout-foldable"',
        'callout-tip callout-foldable',
      ],
    },
  },
  {
    id: 'callout-aliases',
    feature: 'callouts',
    exercises: 'aliases resolve to a look — caution→danger, tldr→abstract, hint→tip',
    md: '> [!caution] Watch out\n> Caution maps to the danger look.\n\n> [!tldr] In short\n> Tldr maps to the abstract look.\n\n> [!hint] Pro tip\n> Hint maps to the tip look.',
    refs: ['#117', 'callout.ts'],
    expect: { contains: ['callout-danger', 'callout-abstract', 'callout-tip'] },
  },
  {
    id: 'callout-rich-body',
    feature: 'callouts',
    exercises: 'a callout body carries a list, inline code and a link',
    md: '> [!info] Seeding\n> The catalog applies to two stands:\n>\n> - fake backend (`caseToFixture`)\n> - real engine (`scripts/seed.ts`)\n>\n> See [seeds.md](https://example.com/seeds).',
    refs: ['#117', 'callout.ts'],
    expect: { contains: ['callout-info', 'callout-body', '<code>caseToFixture</code>'] },
  },
  {
    id: 'callout-unknown-type',
    feature: 'callouts',
    exercises: 'an unrecognised type falls back to the note look but keeps its title',
    md: '> [!heisenbug] Rare\n> An unknown type still renders as a tidy callout titled "Heisenbug".',
    refs: ['#117', 'callout.ts'],
    expect: { contains: ['callout callout-note', 'Heisenbug'] },
  },
  {
    id: 'callout-with-blocks',
    feature: 'callouts',
    exercises: 'a callout body wrapping a table, a code block and a task list (nested blocks)',
    md: '> [!warning] Deployment checklist\n> Verify the matrix:\n>\n> | Check | Status |\n> |---|:--:|\n> | Migrations | ✅ |\n> | Backups | ✅ |\n>\n> ```bash\n> make seed CASE=reader-showcase\n> ```\n>\n> - [x] Tests green\n> - [ ] Reviewed',
    refs: ['#117', 'feedback'],
    expect: { contains: ['callout-warning', 'md-table-wrap', 'language-bash', 'type="checkbox"'] },
  },
]
