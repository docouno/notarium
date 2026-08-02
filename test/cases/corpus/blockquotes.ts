import type { Fragment } from './types'

// Plain blockquotes (a callout is a styled quote — see callouts.ts). Nested quotes
// and a quote containing a list/code had no repo fixture (harvest gap). A non-
// callout blockquote must fall through the callout extension untouched.
export const blockquotesFragments: Fragment[] = [
  {
    id: 'blockquote-basic',
    feature: 'blockquotes',
    exercises: 'a classic single-level blockquote (not a callout)',
    md: '> A blockquote — the classic one, not a callout.',
    refs: ['readerShowcase', 'callout.ts'],
    expect: { contains: ['<blockquote>'] },
  },
  {
    id: 'blockquote-nested',
    feature: 'blockquotes',
    exercises: 'a blockquote nested inside a blockquote',
    md: '> Outer quote.\n>\n> > Inner nested quote.\n> >\n> > — attribution',
    refs: ['harvest-gap'],
    // TWO blockquotes prove the nesting (a flat quote gives one).
    expect: { containsCount: { '<blockquote>': 2 } },
  },
  {
    id: 'blockquote-rich',
    feature: 'blockquotes',
    exercises: 'a blockquote containing a list and inline code',
    md: '> Steps to reproduce:\n>\n> 1. Open the note\n> 2. Run `make seed`\n>\n> Expect a backdated heatmap.',
    refs: ['harvest-gap'],
    expect: { contains: ['<blockquote>', '<code>make seed</code>'] },
  },
]
