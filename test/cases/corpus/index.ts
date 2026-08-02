// The content corpus (#175): the single, addressable library of markdown edge-case
// fragments. Cases compose fragments into note bodies (composeNote / fragmentsByFeature);
// the web-side honesty test renders every fragment through the real renderMarkdown. Add
// an edge case = add a Fragment to the right feature file and it flows into the reader
// cases, the coverage matrix and the honesty test automatically.

import { blockquotesFragments } from './blockquotes'
import { calloutsFragments } from './callouts'
import { codeFragments } from './code'
import { emphasisFragments } from './emphasis'
import { footnotesFragments } from './footnotes'
import { frontmatterFragments } from './frontmatter'
import { headingsFragments } from './headings'
import { imagesFragments } from './images'
import { importsFragments } from './imports'
import { linksFragments } from './links'
import { listsFragments } from './lists'
import { mathFragments } from './math'
import { mermaidFragments } from './mermaid'
import { pathologicalFragments } from './pathological'
import { securityFragments } from './security'
import { tablesFragments } from './tables'
import { tasklistsFragments } from './tasklists'
import { type Feature, FEATURES, type Fragment } from './types'
import { typographyFragments } from './typography'
import { unicodeFragments } from './unicode'
import { wikilinksFragments } from './wikilinks'

export type { Feature, Fragment, FragmentExpect } from './types'
export { FEATURES } from './types'

/** Every fragment, grouped by feature file in reading order. */
export const CORPUS: readonly Fragment[] = [
  ...headingsFragments,
  ...emphasisFragments,
  ...listsFragments,
  ...tasklistsFragments,
  ...codeFragments,
  ...tablesFragments,
  ...blockquotesFragments,
  ...calloutsFragments,
  ...footnotesFragments,
  ...wikilinksFragments,
  ...imagesFragments,
  ...linksFragments,
  ...mathFragments,
  ...mermaidFragments,
  ...typographyFragments,
  ...unicodeFragments,
  ...securityFragments,
  ...frontmatterFragments,
  ...pathologicalFragments,
  ...importsFragments,
]

// Fail loud at import time on a duplicate id or an off-list feature — a corpus
// invariant both the honesty test and the coverage matrix rely on.
{
  const seen = new Set<string>()
  const features = new Set<Feature>(FEATURES)

  for (const f of CORPUS) {
    if (seen.has(f.id)) {
      throw new Error(`duplicate corpus fragment id: "${f.id}"`)
    }
    if (!features.has(f.feature)) {
      throw new Error(`fragment "${f.id}" has unknown feature "${f.feature}"`)
    }
    seen.add(f.id)
  }
}

const BY_ID = new Map(CORPUS.map((f) => [f.id, f]))

/** All fragments of one feature, in corpus order. */
export const fragmentsByFeature = (feature: Feature): Fragment[] =>
  CORPUS.filter((f) => f.feature === feature)

/** Look up a fragment by id (throws if unknown — a typo in a case is a bug). */
export const fragmentById = (id: string): Fragment => {
  const f = BY_ID.get(id)

  if (!f) {
    throw new Error(`unknown corpus fragment: "${id}"`)
  }

  return f
}

/** Pick specific fragments by id, preserving the requested order. */
export const pickFragments = (...ids: string[]): Fragment[] => ids.map(fragmentById)

/** Compose fragments into one note body under an H1 title — the reader/kitchen-sink
 *  note bodies. Fragments are joined verbatim (each is self-contained markdown), so the
 *  note exercises the exact syntax the reader ships. */
export const composeNote = (title: string, frags: readonly Fragment[]): string =>
  `# ${title}\n\n${frags.map((f) => f.md).join('\n\n')}\n`

/** Count of features actually represented in the corpus (coverage sanity). */
export const coveredFeatures = (): Feature[] =>
  FEATURES.filter((f) => CORPUS.some((frag) => frag.feature === f))
