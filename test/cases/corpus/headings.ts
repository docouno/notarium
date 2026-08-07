import type { Fragment } from './types'

// Headings + in-page anchors (#235). The renderer slugs the VISIBLE text via core
// `slugify` (romanises Cyrillic/Greek, keeps the letters of a script it cannot —
// #296), disambiguates repeats GitHub-style, and falls back to `section` only when
// the text has no letters at all. Grounded in markdown.test.ts (#235 heading ids).
export const headingsFragments: Fragment[] = [
  {
    id: 'heading-levels',
    feature: 'headings',
    exercises: 'all six heading levels — the reader typography scale (#189)',
    md: '# H1 Title\n## H2 Section\n### H3 Subsection\n#### H4 Minor\n##### H5\n###### H6',
    refs: ['#189', 'markdown.scss'],
    expect: { contains: ['<h1 id="h1-title">', '<h2 id="h2-section">', '<h6'] },
  },
  {
    id: 'heading-slug-anchor',
    feature: 'headings',
    exercises: 'a heading gets a stable slug id so [jump](#section) resolves',
    md: '## Hello World\n\nJump target above.',
    refs: ['#235', 'markdown.test.ts'],
    expect: { contains: ['<h2 id="hello-world">'] },
  },
  {
    id: 'heading-cyrillic',
    feature: 'headings',
    exercises: 'Cyrillic heading transliterates to a latin anchor (RU is first-class)',
    md: '# Привет Мир\n\n## Заметки о релизе',
    refs: ['#235', '#71', 'markdown.test.ts'],
    expect: { contains: ['id="privet-mir"'] },
  },
  {
    id: 'heading-duplicate',
    feature: 'headings',
    exercises: 'repeated heading text disambiguates GitHub-style (notes, notes-1, notes-2)',
    md: '# Notes\n\n## Notes\n\n### Notes',
    refs: ['#235', 'markdown.test.ts'],
    expect: { contains: ['id="notes"', 'id="notes-1"', 'id="notes-2"'] },
  },
  {
    id: 'heading-inline-markup',
    feature: 'headings',
    exercises: 'inline markup renders inside a heading; the id slugs the visible text',
    md: '## A **bold** title',
    refs: ['#235', 'markdown.test.ts'],
    expect: { contains: ['<strong>bold</strong>', 'id="a-bold-title"'] },
  },
  {
    id: 'heading-link-anchor',
    feature: 'headings',
    exercises: 'a link in a heading anchors by its visible label, not the href',
    md: '## Install [guide](https://example.com/y) now',
    refs: ['#235', 'markdown.test.ts'],
    expect: { contains: ['id="install-guide-now"'], excludes: ['https-example', 'example-com'] },
  },
  {
    id: 'heading-cjk',
    feature: 'headings',
    exercises: 'a CJK heading anchors on its OWN letters — two of them stay distinct',
    md: '## 你好\n\n## 第三季度规划',
    refs: ['#235', '#296', 'markdown.test.ts'],
    expect: { contains: ['id="你好"', 'id="第三季度规划"'] },
  },
  {
    id: 'heading-emoji-fallback',
    feature: 'headings',
    exercises: 'a heading with no letters at all (emoji) still gets an addressable id',
    md: '## 🎉',
    refs: ['#235', '#296', 'markdown.test.ts'],
    expect: { contains: ['id="section"'] },
  },
]
