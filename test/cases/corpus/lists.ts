import type { Fragment } from './types'

// Lists: nested mixed ordered/unordered, loose vs tight, deep nesting, and a
// custom ordinal start — the last three had no repo fixture (harvest gap). Task
// lists live in tasklists.ts (their own feature/coverage grain).
export const listsFragments: Fragment[] = [
  {
    id: 'list-nested-mixed',
    feature: 'lists',
    exercises: 'unordered list with a nested ordered sublist',
    md: '- Fruit\n  - Apple\n  - Pear\n- Vegetables\n  1. Carrot\n  2. Potato',
    refs: ['#235', 'readerShowcase'],
    expect: { contains: ['<ul>', '<ol>', '<li>Carrot'] },
  },
  {
    id: 'list-deep',
    feature: 'lists',
    exercises: 'list nested more than two levels deep',
    md: '- L1\n  - L2\n    - L3\n      - L4 leaf',
    refs: ['harvest-gap'],
    expect: { contains: ['L4 leaf'] },
  },
  {
    id: 'list-loose',
    feature: 'lists',
    exercises: 'a loose list (blank lines between items) wraps each item in a paragraph',
    md: '- First item, loose.\n\n- Second item, loose.\n\n- Third item, loose.',
    refs: ['harvest-gap'],
    expect: { contains: ['<p>First item'] },
  },
  {
    id: 'list-tight',
    feature: 'lists',
    exercises: 'a tight list (no blank lines) has no inner paragraphs',
    md: '- one\n- two\n- three',
    refs: ['harvest-gap'],
    expect: { contains: ['<li>one</li>'] },
  },
  {
    id: 'list-ordered-start',
    feature: 'lists',
    exercises: 'an ordered list starting at a custom ordinal keeps the offset',
    md: '3. three\n4. four\n5. five',
    refs: ['harvest-gap'],
    expect: { contains: ['start="3"'] },
  },
]
