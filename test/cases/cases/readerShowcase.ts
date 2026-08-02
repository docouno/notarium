import { composeNote, type Feature, FEATURES, fragmentsByFeature } from '../corpus'
import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

// The reader kitchen-sink in a DEDICATED "Reader Cases" space (so the reader fixtures
// are easy to review/extend, separate from the active `main` workspace): ONE note per
// markdown feature (composed FROM the content corpus, so it grows automatically), a
// folder page, and ONE "Complex example" note that NESTS and combines features to show
// maximally complex interaction. Every per-feature fragment is honesty-tested
// (corpus.honesty.test.ts); the complex note is verified live on the stand.

const SPACE = 'reader-cases'

const TITLES: Record<Feature, string> = {
  headings: 'Headings & anchors',
  emphasis: 'Emphasis',
  lists: 'Lists',
  tasklists: 'Task lists',
  code: 'Code blocks',
  tables: 'Tables',
  blockquotes: 'Blockquotes',
  callouts: 'Callouts',
  footnotes: 'Footnotes',
  wikilinks: 'Wikilinks',
  images: 'Images',
  links: 'Links',
  math: 'Math (KaTeX)',
  mermaid: 'Mermaid diagrams',
  typography: 'Reading typography',
  unicode: 'International text',
  security: 'Security & sanitising',
  frontmatter: 'Frontmatter',
  pathological: 'Edge cases',
  imports: 'Imported content',
}

// A single note that NESTS and combines features — the "maximally complex interaction"
// stress note. It cross-links the per-feature notes (resolved wikilinks in this space).
const COMPLEX = `# Complex example — everything at once

A single note that COMBINES and NESTS features, to stress the reader on realistic,
complex-interaction content — not one feature at a time.

## A callout wrapping a table, code and a checklist

> [!warning] Deployment checklist
> Before shipping, verify the matrix:
>
> | Check | Owner | Status |
> |---|---|:--:|
> | Migrations applied | \`alex\` | ✅ |
> | Backups verified | \`admin\` | ✅ |
>
> Then run:
>
> \`\`\`bash
> make seed CASE=reader-showcase && make seed-coverage
> \`\`\`
>
> - [x] Tests green
> - [ ] Reviewed by a human

## A table whose cells carry code, math and wikilinks

| Concept | Expression | See |
|---|---|---|
| Energy | $E = mc^2$ | [[Math (KaTeX)]] |
| Escape | \`a \\| b\` | [[Tables]] |
| Diagram | a flowchart | [[Mermaid diagrams]] |

## A list with nested blocks

1. First, the setup.
   > [!tip] A callout nested inside a list item
   > Callouts, code and math all nest under a list item.
2. Then the code:
   \`\`\`typescript
   const answer: number = 6 * 7
   \`\`\`
3. Then the math — inline $a^2 + b^2 = c^2$ and a display block:
   $$ \\int_0^1 x^2\\,dx = \\frac{1}{3} $$

## A diagram beside a formula, with a footnote

\`\`\`mermaid
flowchart LR
  A[Case] --> B{fake or real?}
  B -->|fake| C[caseToFixture]
  B -->|real| D[scripts/seed.ts]
\`\`\`

The heatmap intensity is the sum of a day's journal rows[^intensity]:

$$ I(d) = created(d) + edited(d) + deleted(d) $$

## Multilingual, emphasis and a ghost link

Русский **жирный**, Ελληνικά _курсив_, 中文 \`код\`, RTL: مرحبا بالعالم. And a link to a
note that isn't written yet: [[An Unwritten Note]].

[^intensity]: Derived from the #12 revision journal — the single source of the heatmap.
`

export const readerShowcase: CaseSpec = {
  name: 'reader-showcase',
  description:
    'A dedicated "Reader Cases" space: one note per markdown feature (from the corpus) + a folder page + a "Complex example" note nesting features — the reader review/extend surface.',
  axes: ['content'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: SPACE, displayName: 'Reader Cases' })

    // The FOLDER PAGE of reader/ (index.md, #212): the folder's own description + a
    // children summary of the feature notes (#213).
    b.note({
      space: SPACE,
      path: 'reader/index.md',
      title: 'Reader showcase',
      content: `# Reader showcase\n\nThe folder page for \`reader/\` — one note per markdown feature, built from the seed content corpus (#175) and verified against the real reader. The feature notes are listed as this folder's children below. See also [[Complex example]] for nested, combined content.\n`,
      tags: ['reader'],
      created: daysBefore(now, FEATURES.length + 2, 9),
      principal: 'user:sergey',
    })

    FEATURES.forEach((feature, i) => {
      const frags = fragmentsByFeature(feature)
      b.note({
        space: SPACE,
        path: `reader/${feature}.md`,
        title: TITLES[feature],
        content: composeNote(TITLES[feature], frags),
        tags: ['reader', feature],
        created: daysBefore(now, FEATURES.length - i, 10, i),
        edits: i === 0 ? [daysBefore(now, 1, 12)] : [],
        principal: 'user:sergey',
      })
    })

    // The complex combined note — nested/interacting features, at the space root so it's
    // prominent. Its [[…]] links resolve to the feature notes in this space.
    b.note({
      space: SPACE,
      path: 'complex-example.md',
      title: 'Complex example',
      content: COMPLEX,
      tags: ['reader', 'complex'],
      created: daysBefore(now, 1, 16),
      principal: 'user:sergey',
    })

    return b.build()
  },
}
