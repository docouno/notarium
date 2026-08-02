// The content corpus (#175): a dependency-light, addressable library of markdown
// EDGE CASES. One Fragment = one thing the reader must render, grounded in a real
// source (an issue, a renderer unit test, or an existing fixture). Cases COMPOSE
// fragments into note bodies instead of inlining ad-hoc content, so the reader
// surface is exercised on the exact syntax the app ships — and the base grows by
// adding a Fragment, not by editing a case. The honesty test (packages/web) renders
// every fragment through the REAL renderMarkdown and checks `expect`, so a fragment
// can never claim a rendering the reader doesn't actually produce ("not for show").

/** A markdown feature family — the finest coverage grain (feature × fragment). */
export type Feature =
  | 'headings'
  | 'emphasis'
  | 'lists'
  | 'tasklists'
  | 'code'
  | 'tables'
  | 'blockquotes'
  | 'callouts'
  | 'footnotes'
  | 'wikilinks'
  | 'images'
  | 'links'
  | 'math'
  | 'mermaid'
  | 'typography'
  | 'unicode'
  | 'security'
  | 'frontmatter'
  | 'pathological'
  | 'imports'

/** Every feature, in reading order — the coverage matrix's rows. */
export const FEATURES: readonly Feature[] = [
  'headings',
  'emphasis',
  'lists',
  'tasklists',
  'code',
  'tables',
  'blockquotes',
  'callouts',
  'footnotes',
  'wikilinks',
  'images',
  'links',
  'math',
  'mermaid',
  'typography',
  'unicode',
  'security',
  'frontmatter',
  'pathological',
  'imports',
]

/** Honesty markers checked by the web-side test against the REAL renderer. All
 *  optional: a fragment with no `expect` is still asserted to render WITHOUT THROWING
 *  (some fragments — e.g. an empty or only-frontmatter note — correctly render to
 *  nothing, so no non-empty guarantee is claimed). */
export type FragmentExpect = {
  /** Substrings the rendered HTML MUST contain, each present at least once (e.g.
   *  `class="katex"`, `language-mermaid`, `class="callout callout-warning"`). */
  contains?: string[]
  /** Substrings it must NOT contain (escaped XSS, a leaked delimiter/source). */
  excludes?: string[]
  /** Substrings that must appear AT LEAST N times — pins a "several X, each renders" or
   *  "nested" claim that a bare `contains` can't (one match already satisfies `contains`,
   *  so it can't tell one rendered formula from three, or a flat list from a nested one). */
  containsCount?: Record<string, number>
  /** Marks a security payload: the test additionally parses the sanitised HTML into a
   *  live DOM and asserts no `<script>` element, no `on*=` handler, and no dangerous URL
   *  (`javascript:` / `vbscript:` / `data:text/html`) survives in any href/src. */
  security?: boolean
}

export type Fragment = {
  /** Stable, corpus-unique kebab id (e.g. `callout-foldable`, `math-inline-dollar`). */
  id: string
  feature: Feature
  /** One line: the edge case this fragment exercises. */
  exercises: string
  /** The markdown snippet — self-contained and demonstrable on its own. */
  md: string
  /** Grounding: issue #, renderer test, or fixture path this is lifted from. */
  refs?: string[]
  /** Optional honesty markers (see FragmentExpect). */
  expect?: FragmentExpect
}
