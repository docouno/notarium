import type { Fragment } from './types'

// Wikilinks (#236 review) — an INLINE marked extension, so it fires only on prose,
// never inside code. `[[Target]]` → `#wiki/Target`; `[[target|Label]]` percent-
// encodes the target and keeps the label (inline markdown allowed); a nested
// anchor/autolink/raw-HTML in a label is neutralised so the wiki anchor stays the
// only one (security). The resolved / ghost / alias visual states are a reader
// concern — the reader completes only a known stable id locally
// (`NoteReader/resolveKnownWiki`) and asks the server for a human reference, and the
// graph/identity cases exercise those; here we pin the render contract. Grounded in
// wikilink.ts + markdown.test.ts.
export const wikilinksFragments: Fragment[] = [
  {
    id: 'wikilink-basic',
    feature: 'wikilinks',
    exercises: 'a prose [[WikiLink]] becomes a #wiki/ anchor',
    md: 'See [[Titanium]] and [[Carbon]] for the alloy.',
    refs: ['#236', 'markdown.test.ts', 'base.json'],
    expect: { contains: ['<a href="#wiki/Titanium">Titanium</a>', '#wiki/Carbon'] },
  },
  {
    id: 'wikilink-aliased',
    feature: 'wikilinks',
    exercises: 'a [[target|Label]] link keeps the label and percent-encodes the target',
    md: 'Jump [[home/index|Home]] or [[Tables & Task Lists|the tables note]].',
    refs: ['#236', 'markdown.test.ts', 'readerShowcase'],
    expect: { contains: ['href="#wiki/home%2Findex"', '>Home</a>'] },
  },
  {
    id: 'wikilink-inline-label',
    feature: 'wikilinks',
    exercises: 'a wikilink label carries inline markdown (a code span)',
    md: 'Read [[api|the `fetch()` API]] docs.',
    refs: ['#236', 'markdown.test.ts'],
    expect: { contains: ['href="#wiki/api"', '<code>fetch()</code>'] },
  },
  {
    id: 'wikilink-ghost',
    feature: 'wikilinks',
    exercises: 'a link to a not-yet-written note renders an anchor (reader styles it as a ghost)',
    md: 'This points at [[A Note Not Written Yet]] — a ghost until created.',
    refs: ['#236', 'NoteReader.tsx', '#202'],
    expect: { contains: ['href="#wiki/A%20Note%20Not%20Written%20Yet"'] },
  },
  {
    id: 'wikilink-in-code',
    feature: 'wikilinks',
    exercises: 'a wikilink inside inline code or a fence is NOT converted',
    md: 'Type `[[Alpha]]` verbatim.\n\n```\n[[Bravo]] stays literal\n```',
    refs: ['#236', 'markdown.test.ts'],
    expect: { excludes: ['#wiki/'] },
  },
  {
    id: 'wikilink-security',
    feature: 'wikilinks',
    exercises: 'a raw <a>/autolink/URL in a label is neutralised — one anchor, no external leak',
    md: 'Guard [[Page|<a href="https://evil.example">click</a>]] and [[See www.evil.example]].',
    refs: ['#236', 'markdown.test.ts'],
    expect: {
      contains: ['href="#wiki/Page"'],
      excludes: ['href="https://evil.example"'],
      security: true,
    },
  },
]
