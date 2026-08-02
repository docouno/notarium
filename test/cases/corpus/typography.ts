import type { Fragment } from './types'

// Reading typography (#27/#189): the `.markdown` surface is a stepped S/M/L/XL size
// over one --reading-size, the whole em-scale (headings/code/lists/quotes) riding it,
// and `breaks:true` so a single newline is a hard <br> (GitHub/Obsidian-style — real
// imports lean on it). These fragments exercise the reading RHYTHM and the hard-break;
// the size/font itself is a live setting, verified on the stand.
export const typographyFragments: Fragment[] = [
  {
    id: 'typography-hard-breaks',
    feature: 'typography',
    exercises: 'a single newline is a hard <br> (breaks:true), not a collapsed space',
    md: 'Roses are red\nViolets are blue\nA single newline\nBecomes a line break.',
    refs: ['#115', 'markdown.ts'],
    expect: { contains: ['<br>'] },
  },
  {
    id: 'typography-reading-rhythm',
    feature: 'typography',
    exercises:
      'a mixed passage (heading + prose + quote + list + code) to read the em-scale ripple',
    md: [
      '## A section to read',
      '',
      'A paragraph of prose long enough to show the measure and line-height at the current reading size. The scale below rides the same --reading-size, so one step resizes the whole rhythm.',
      '',
      '> A pull quote softens to --text-dim while the body stays --reading-text.',
      '',
      '- A list item',
      '- Another item with `inline code`',
      '',
      'Closing line.',
    ].join('\n'),
    refs: ['#27', '#189', 'reading-typography.md'],
    expect: { contains: ['<h2', '<blockquote>'] },
  },
]
