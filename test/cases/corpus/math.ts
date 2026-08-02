import type { Fragment } from './types'

// Math / KaTeX (#237) — rendered synchronously at the string layer, so renderMarkdown
// already contains `span.katex` (+ inline MathML). Four delimiters: `$…$` / `\(…\)`
// inline, `$$…$$` / `\[…\]` block (the backslash forms are how ChatGPT/Claude exports
// emit math — the issue's main case). Price-safe single-dollar, invalid TeX → an error
// span (never a thrown/blanked paragraph), and `\href` stays inert (trust:false).
// Grounded in math.ts + markdown.test.ts.
export const mathFragments: Fragment[] = [
  {
    id: 'math-inline-dollar',
    feature: 'math',
    exercises: 'inline $…$ renders a KaTeX span; the delimiters are consumed',
    md: 'Mass–energy $E = mc^2$ holds, and $a^2 + b^2 = c^2$ too.',
    refs: ['#237', 'markdown.test.ts'],
    expect: { contains: ['class="katex"'], excludes: ['$E = mc^2$'] },
  },
  {
    id: 'math-block-dollar',
    feature: 'math',
    exercises: 'block $$…$$ wraps a display formula in .md-math',
    md: '$$\n\\int_0^\\infty e^{-x}\\,dx = 1\n$$',
    refs: ['#237', 'markdown.test.ts', 'readerShowcase'],
    expect: { contains: ['<div class="md-math">', 'katex-display'] },
  },
  {
    id: 'math-chatgpt-forms',
    feature: 'math',
    exercises: 'the LLM-export backslash forms \\(…\\) inline and \\[…\\] block render',
    md: 'Inline \\(a + b = c\\) and a display block:\n\n\\[\n\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}\n\\]',
    refs: ['#237', 'markdown.test.ts', 'import.md'],
    // TWO katex spans (inline \(…\) + block \[…\]) — a single one would pass a bare
    // `contains` even if the inline backslash form silently leaked as text.
    expect: { contains: ['katex-display'], containsCount: { 'class="katex"': 2 } },
  },
  {
    id: 'math-price-safe',
    feature: 'math',
    exercises: 'prices are not eaten as math — "$5 and $10" stays literal',
    md: 'It costs $5 and $10 today, or pick $5 or $6.',
    refs: ['#237', 'markdown.test.ts'],
    expect: { contains: ['$5 and $10'], excludes: ['class="katex"'] },
  },
  {
    id: 'math-invalid',
    feature: 'math',
    exercises: 'invalid TeX falls back to an error span with the source, never a throw',
    md: 'Broken: $\\frac{1}{$ still renders a note, not a blank.',
    refs: ['#237', 'markdown.test.ts'],
    expect: { contains: ['katex-error'] },
  },
  {
    id: 'math-multiple',
    feature: 'math',
    exercises: 'several formulas on one line each render',
    md: 'Compare $a$ and $b$ and \\(c\\) in one sentence.',
    refs: ['#237', 'markdown.test.ts'],
    // All THREE must render — a single `class="katex"` can't tell 1 from 3.
    expect: { containsCount: { 'class="katex"': 3 } },
  },
  {
    id: 'math-href-inert',
    feature: 'math',
    exercises: 'a \\href in a formula is inert — no clickable/executable link is produced',
    md: 'Guard $\\href{javascript:alert(1)}{x}$ in a formula.',
    refs: ['#237', 'markdown.test.ts'],
    expect: { excludes: ['<a '], security: true },
  },
]
