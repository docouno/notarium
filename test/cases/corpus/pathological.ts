import type { Fragment } from './types'

// Degenerate / pathological BODIES — a renderer must survive these without a throw
// or a blanked page. (Note-PROPERTY edge cases — a title with quotes/backslashes, a
// very long title — belong to the cases that set them, not to a body fragment.)
// Empty/whitespace/only-frontmatter live notes and a duplicate-h1 body (#156) had no
// seeded fixture (harvest gap).
export const pathologicalFragments: Fragment[] = [
  {
    id: 'pathological-empty',
    feature: 'pathological',
    exercises: 'an empty / whitespace-only body renders to nothing, without error',
    md: '   \n\n  \n',
    refs: ['harvest-gap'],
  },
  {
    id: 'pathological-only-frontmatter',
    feature: 'pathological',
    exercises: 'a note that is only frontmatter, no body — strips to empty',
    md: '---\ntype: note\ntags: [meta]\n---\n',
    refs: ['harvest-gap', 'markdown.ts'],
  },
  {
    id: 'pathological-duplicate-h1',
    feature: 'pathological',
    exercises: 'a body starting with the same # H1 as the title (#156 MCP dup-h1)',
    md: '# Duplicate Title\n\n# Duplicate Title\n\nThe first heading duplicates the note title.',
    refs: ['#156'],
    expect: { containsCount: { '<h1': 2 } },
  },
  {
    id: 'pathological-html-comment',
    feature: 'pathological',
    exercises: 'an HTML comment in the body is dropped, surrounding prose intact',
    md: 'Before the comment.\n\n<!-- a hidden note to self -->\n\nAfter the comment.',
    refs: ['harvest-gap'],
    expect: { contains: ['After the comment'], excludes: ['hidden note to self'] },
  },
  {
    id: 'pathological-unterminated-fence',
    feature: 'pathological',
    exercises: 'an unterminated code fence treats the rest of the note as code',
    md: '# Heading\n\n```js\nconst x = 1\n// ...and the fence is never closed',
    refs: ['harvest-gap'],
    expect: { contains: ['<pre>'] },
  },
]
