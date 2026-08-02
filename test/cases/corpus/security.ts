import type { Fragment } from './types'

// Security payloads: the render pipeline ends in DOMPurify, so a note carrying
// hostile markup must come out inert. These are asserted through the REAL
// renderMarkdown (DOMPurify runs), not marked.parse alone — raw HTML passes marked
// and only DOMPurify strips it. (Feature-specific payloads live in wikilinks.ts /
// math.ts / mermaid.ts; these are the general HTML/URL vectors.) Grounded in
// callouts-footnotes.spec.ts (XSS) + the DOMPurify pass in markdown.ts.
export const securityFragments: Fragment[] = [
  {
    id: 'security-script-tag',
    feature: 'security',
    exercises: 'a raw <script> in the body is stripped',
    md: 'Before.\n\n<script>alert(1)</script>\n\nAfter.',
    refs: ['markdown.ts', 'callouts-footnotes.spec.ts'],
    expect: { excludes: ['<script'], security: true },
  },
  {
    id: 'security-img-onerror',
    feature: 'security',
    exercises: 'an <img onerror=…> handler is stripped, the tag defanged',
    md: 'Inline payload: <img src=x onerror=alert(1)> in prose.',
    refs: ['markdown.ts', 'callouts-footnotes.spec.ts'],
    expect: { excludes: ['onerror'], security: true },
  },
  {
    id: 'security-js-link',
    feature: 'security',
    exercises: 'a javascript: link URL is neutralised (marked cleanUrl + DOMPurify)',
    md: 'A [dangerous link](javascript:alert(1)) in markdown.',
    refs: ['markdown.ts'],
    expect: { excludes: ['javascript:'], security: true },
  },
  {
    id: 'security-raw-anchor',
    feature: 'security',
    exercises: 'a hand-written raw <a href="javascript:…"> is sanitised',
    md: 'Raw HTML anchor: <a href="javascript:alert(1)">click me</a>.',
    refs: ['markdown.ts'],
    expect: { excludes: ['javascript:'], security: true },
  },
  {
    id: 'security-callout-xss',
    feature: 'security',
    exercises: 'XSS in a callout title, body and footnote is all neutralised',
    md: '> [!note] <img src=x onerror=alert(1)>\n> Body <script>alert(2)</script> here.[^x]\n\n[^x]: def <script>alert(3)</script>',
    refs: ['callouts-footnotes.spec.ts'],
    expect: { excludes: ['<script', 'onerror'], security: true },
  },
  {
    id: 'security-svg-script',
    feature: 'security',
    exercises: 'a <script> embedded in inline SVG is stripped (SVG-namespace vector)',
    md: 'Inline SVG payload: <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>',
    refs: ['markdown.ts', 'harvest-gap'],
    expect: { excludes: ['<script', 'alert(1)'], security: true },
  },
]
