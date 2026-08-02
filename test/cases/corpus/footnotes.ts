import type { Fragment } from './types'

// Footnotes (#117) via marked-footnote: `[^id]` refs render as superscript anchors,
// definitions collect into a `<section class="footnotes">` with back-references. A
// reused ref, a footnote inside a heading (id must stay clean — markdown.test.ts),
// and a multi-paragraph definition (harvest gap).
export const footnotesFragments: Fragment[] = [
  {
    id: 'footnote-basic',
    feature: 'footnotes',
    exercises: 'a footnote ref becomes a superscript anchor + a definitions section',
    md: 'A claim with a footnote.[^1]\n\n[^1]: The supporting note, collected at the end.',
    refs: ['#117', 'callouts-footnotes.spec.ts'],
    expect: { contains: ['class="footnotes"', '<sup'] },
  },
  {
    id: 'footnote-reused',
    feature: 'footnotes',
    exercises: 'the same footnote referenced twice resolves to one numbered note',
    md: 'Footnotes work[^why] and can be referenced twice[^why].\n\n[^why]: A footnote resolves to a numbered reference and back-links here.',
    refs: ['#117', 'readerShowcase'],
    // TWO superscript refs prove the reuse (a single ref gives one).
    expect: { contains: ['class="footnotes"'], containsCount: { '<sup': 2 } },
  },
  {
    id: 'footnote-in-heading',
    feature: 'footnotes',
    exercises: 'a footnote inside a heading does not leak <sup><a> markup into the id',
    md: '## Overview[^1]\n\nBody.\n\n[^1]: A note attached to the heading.',
    refs: ['#235', 'markdown.test.ts'],
    expect: { contains: ['id="overview1"'], excludes: ['id="overview-1-a'] },
  },
  {
    id: 'footnote-multi-paragraph',
    feature: 'footnotes',
    exercises: 'a multi-paragraph footnote definition (harvest gap)',
    md: 'A nuanced claim.[^long]\n\n[^long]: First paragraph of the note.\n\n    Second indented paragraph, still part of the footnote.',
    refs: ['harvest-gap'],
    // The SECOND paragraph (the whole point) must render inside the footnote.
    expect: { contains: ['class="footnotes"', 'Second indented paragraph'] },
  },
]
