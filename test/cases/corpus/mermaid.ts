import type { Fragment } from './types'

// Mermaid (#236) — a ```mermaid fence survives the pipeline as
// `<pre><code class="language-mermaid">` (an unknown highlighter language is returned
// verbatim), and a POST-render DOM pass (useMarkdownEnhance) swaps it for a sanitised
// SVG in the browser. So renderMarkdown output carries the language-mermaid code block;
// the SVG itself is verified live on the stand. Diagram-type breadth, a shape showcase,
// an invalid diagram (honest error card), and an XSS payload (escaped). Grounded in
// mermaid.ts + markdown.test.ts.
export const mermaidFragments: Fragment[] = [
  {
    id: 'mermaid-flowchart',
    feature: 'mermaid',
    exercises: 'a flowchart fence reaches the mermaid post-render shape, source intact',
    md: '```mermaid\ngraph TD\n  A[Case catalog] --> B(caseToFixture)\n  A --> C(scripts/seed.ts)\n  B --> D[fake backend]\n  C --> E[real engine]\n```',
    refs: ['#236', 'markdown.test.ts', 'readerShowcase'],
    expect: { contains: ['language-mermaid', 'A[Case catalog]'] },
  },
  {
    id: 'mermaid-sequence',
    feature: 'mermaid',
    exercises: 'a sequence diagram fence',
    md: '```mermaid\nsequenceDiagram\n  participant U as User\n  participant A as Assistant\n  U->>A: How do I seed a stand?\n  A-->>U: make seed CASE=...\n```',
    refs: ['#236'],
    expect: { contains: ['language-mermaid'] },
  },
  {
    id: 'mermaid-types',
    feature: 'mermaid',
    exercises: 'state / class / pie diagram types (each a distinct mermaid renderer)',
    md: [
      '```mermaid',
      'stateDiagram-v2',
      '  [*] --> Live',
      '  Live --> Trashed: delete',
      '  Trashed --> Live: restore',
      '  Trashed --> [*]: purge',
      '```',
      '',
      '```mermaid',
      'pie title Journal rows',
      '  "created" : 45',
      '  "edited" : 40',
      '  "deleted" : 15',
      '```',
    ].join('\n'),
    refs: ['#236', 'harvest'],
    expect: { contains: ['language-mermaid', 'stateDiagram'] },
  },
  {
    id: 'mermaid-shapes',
    feature: 'mermaid',
    exercises:
      'a flowchart node-shape showcase incl. the [[subroutine]] shape (must not become a wikilink)',
    md: '```mermaid\nflowchart LR\n  A[rect] --> B(rounded)\n  B --> C([stadium])\n  C --> D[[subroutine]]\n  D --> E[(database)]\n  E --> F{diamond}\n  F --> G{{hexagon}}\n```',
    refs: ['#236', 'markdown.test.ts', 'harvest'],
    expect: { contains: ['language-mermaid', 'D[[subroutine]]'], excludes: ['#wiki/'] },
  },
  {
    id: 'mermaid-invalid',
    feature: 'mermaid',
    exercises:
      'an invalid diagram — the reader shows an honest error card + the source (verified live)',
    md: '```mermaid\ngraph TD\n  A -->\n  this is not valid mermaid syntax {{{\n```',
    refs: ['#236', 'mermaid.ts'],
    expect: { contains: ['language-mermaid'] },
  },
  {
    id: 'mermaid-xss',
    feature: 'mermaid',
    exercises: 'an XSS attempt hidden in a mermaid fence is escaped (no live tag survives)',
    md: '```mermaid\n<img src=x onerror=alert(1)>\n```',
    refs: ['#236', 'markdown.test.ts'],
    expect: { contains: ['&lt;img'], excludes: ['<img'], security: true },
  },
]
