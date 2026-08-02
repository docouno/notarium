import type { Fragment } from './types'

// Leading YAML frontmatter (#235): the normal content path is body-only (the engine
// peels the YAML), but a raw paste / legacy note / draft preview can still open with a
// `---…---` block that marked would otherwise render as a stray table/hr. The defensive
// strip cuts ONLY a genuine frontmatter block (first inner line looks like `key:`); a
// body that opens with a `---` thematic break is left intact. Grounded in
// stripLeadingFrontmatter (markdown.ts).
export const frontmatterFragments: Fragment[] = [
  {
    id: 'frontmatter-stripped',
    feature: 'frontmatter',
    exercises: 'a genuine leading frontmatter block is stripped from the rendered body',
    md: '---\ntype: note\ntags: [alpha, beta]\naliases: [Old Name]\n---\n# Real Heading\n\nBody after the frontmatter.',
    refs: ['#235', 'markdown.ts', 'markdownFrontmatter.test.ts'],
    expect: { contains: ['id="real-heading"'], excludes: ['aliases: [Old Name]'] },
  },
  {
    id: 'frontmatter-thematic-break',
    feature: 'frontmatter',
    exercises: 'a body opening with a `---` thematic break (not YAML) is NOT stripped',
    md: '---\n\nJust prose after a rule, not a YAML key.\n\n---\n\nMore prose below a second rule.',
    refs: ['#235', 'markdown.ts'],
    expect: { contains: ['<hr>'] },
  },
]
