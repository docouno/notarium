import type { Fragment } from './types'

// Links (non-wiki — wikilinks are their own feature). External links open in a new
// tab (reader adds target/rel); an in-page fragment anchor smooth-scrolls within
// the reader (footnote/heading jump); autolinks and a bare URL (GFM) that must
// wrap, not overflow the column.
export const linksFragments: Fragment[] = [
  {
    id: 'link-external',
    feature: 'links',
    exercises: 'an external link (the reader opens it in a new tab)',
    md: 'See the [project site](https://example.com) for details.',
    refs: ['NoteReader.tsx'],
    expect: { contains: ['href="https://example.com"'] },
  },
  {
    id: 'link-fragment',
    feature: 'links',
    exercises: 'an in-page fragment link smooth-scrolls to a heading anchor',
    md: '## Setup\n\nText.\n\n## Usage\n\nJump back to [Setup](#setup).',
    refs: ['NoteReader.tsx', '#235'],
    expect: { contains: ['href="#setup"', 'id="setup"'] },
  },
  {
    id: 'link-autolink',
    feature: 'links',
    exercises: 'an angle-bracket autolink and a GFM bare URL both linkify',
    md: 'Angle autolink <https://example.com/a> and bare https://example.com/b here.',
    refs: ['markdown.test.ts'],
    expect: { contains: ['href="https://example.com/a"', 'href="https://example.com/b"'] },
  },
  {
    id: 'link-bare-long',
    feature: 'links',
    exercises: 'a very long bare URL must wrap inside the column, not overflow',
    md: 'Reference: https://example.com/a/very/long/path/that/keeps/going/and/going/and/going/until/it/would/overflow/the/reading/column/if/not/wrapped',
    refs: ['harvest-gap', '#235', 'readerShowcase'],
    expect: { contains: ['<a href="https://example.com/a/very/long'] },
  },
  {
    id: 'link-reference-style',
    feature: 'links',
    exercises: 'a reference-style link resolves its definition',
    md: 'A [reference link][site] resolved below.\n\n[site]: https://example.com/ref',
    refs: ['harvest-gap'],
    expect: { contains: ['href="https://example.com/ref"'] },
  },
]
