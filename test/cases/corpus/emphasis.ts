import type { Fragment } from './types'

// Inline emphasis: bold / italic / strikethrough / inline code, nesting, and the
// escaped-literal edge (no fixture existed for `\*not bold\*` — harvest gap). GFM
// strikethrough renders as <del>; the reading-typography canon pins strong+code to
// full --text while em/strike soften (reading-typography.md #189).
export const emphasisFragments: Fragment[] = [
  {
    id: 'emphasis-basic',
    feature: 'emphasis',
    exercises: 'bold, italic, strikethrough and inline code in one line',
    md: 'A paragraph with **bold**, _italic_, ~~strikethrough~~ and `inline code`.',
    refs: ['#235', 'base.json'],
    expect: {
      contains: [
        '<strong>bold</strong>',
        '<em>italic</em>',
        '<del>strikethrough</del>',
        '<code>inline code</code>',
      ],
    },
  },
  {
    id: 'emphasis-nested',
    feature: 'emphasis',
    exercises: 'nested emphasis — bold wrapping italic',
    md: 'This is **bold with _nested italic_ inside**.',
    expect: { contains: ['<strong>bold with <em>nested italic</em> inside</strong>'] },
  },
  {
    id: 'emphasis-escaped',
    feature: 'emphasis',
    exercises: 'backslash-escaped markers render as literal text, not emphasis',
    md: 'Literally \\*not bold\\* and \\`not code\\` here.',
    refs: ['harvest-gap'],
    expect: { contains: ['*not bold*'], excludes: ['<em>not bold', '<strong>not bold'] },
  },
  {
    id: 'emphasis-entities',
    feature: 'emphasis',
    exercises: 'bare < and & in prose are escaped to entities (not injected as tags)',
    md: 'Compare a & b, and a bare 5 < 6 in prose.',
    refs: ['harvest-gap', 'markdown.test.ts'],
    // Assert the BARE `&`/`<` were escaped (a pre-escaped `&lt;` would round-trip trivially).
    expect: { contains: ['a &amp; b', '5 &lt; 6'] },
  },
]
