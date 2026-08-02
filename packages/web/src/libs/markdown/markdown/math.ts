// Math (KaTeX) in content (#237) — our own marked extension, rendering LaTeX at the
// HTML-STRING layer, NOT a post-render DOM pass like mermaid (#236). KaTeX is
// SYNCHRONOUS (HTML/CSS + MathML, no async, no runtime reflow — the whole reason the
// issue picks it over MathJax), so it renders inside marked.parse and every `.markdown`
// surface (reader / editor-preview / history / settings sample) gets it for free, with
// zero flicker and no per-surface hook. katex is loaded statically (not lazily like
// mermaid) precisely because the render must be synchronous — the same call the reader's
// highlight.js already makes; the cost is comparable and it is core content typography.
//
// Delimiters (all four are supported): LLM exports (ChatGPT/Claude — the
// issue's main use case) emit math in BACKSLASH form — inline `\(…\)`, block `\[…\]` —
// while Obsidian/Pandoc notes use dollars. marked-katex-extension only speaks dollars,
// so we own the tokenizer to cover both worlds:
//   block:  $$…$$   \[…\]        (displayMode)
//   inline: $…$     \(…\)        (+ $$…$$ / \[…\] that appear mid-flow)
//
// Render-only: the source bytes never change, so a note round-trips byte-for-byte.
import katex from 'katex'
import type { RendererThis, TokenizerAndRendererExtension, TokenizerThis, Tokens } from 'marked'

// Render one TeX string to KaTeX HTML+MathML. `throwOnError:false` is the honest
// fallback the issue requires: invalid TeX renders as its own source (in the error
// colour, restyled to --danger in markdown.scss) with a hover title — never a thrown
// exception or a blanked paragraph. `trust:false` (KaTeX default) keeps \href / \url /
// \includegraphics INERT, so a formula can't inject a link or an image; the
// renderMarkdown DOMPurify pass is the final backstop. `htmlAndMathml` (default) keeps
// the MathML alongside the visual HTML for screen readers.
const renderTex = (tex: string, displayMode: boolean): string =>
  katex.renderToString(tex, { displayMode, throwOnError: false })

// Narrowed to the two token names this one extension emits (block vs inline), mirroring
// callout.ts's `type: 'callout'` — documents the token and keeps the field off the
// `Tokens.Generic` index signature's `any`.
type MathToken = Tokens.Generic & {
  type: 'mathBlock' | 'mathInline'
  tex: string
  display: boolean
}

// ── Block: $$…$$ or \[…\] standing as its own block ──────────────────────────────
// The closing delimiter must sit at end-of-line (`(?=[ \t]*(?:\n|$))`) so a `$$x$$ text`
// or `\[x\] text` mid-sentence is NOT eaten as a block — that case falls through to the
// inline tokenizer below. Non-greedy body so the FIRST closer wins. Two guards keep the
// lazy body from over-reaching:
//   `(?!\n[ \t]*\n)` — it may NOT cross a blank line: a blank line ends a block, so
//     without this a `$$x$$ trailing text` line (whose first closer fails the EOL
//     lookahead) would hunt on across headings/paragraphs for the NEXT end-of-line `$$`,
//     swallowing everything between and stealing a genuine later block's opener.
//   `(?!\$\$)` / `(?!\\])` — the body may NOT contain the closer itself. Without it, a
//     single line `$$x$$ text $$y$$` (or `\[x\] and \[y\]`) skips the first non-EOL closer
//     and matches through to the LAST one, rendering `x$$ text $$y` as one KaTeX error.
//     A real TeX body never contains a literal `$$` / `\]`, so this only blocks the
//     pathological case; the first closer now fails the whole match and the pair falls
//     through to the inline tokenizer, which renders the two mid-flow display formulas.
const BLOCK_DOLLAR = /^ {0,3}\$\$((?:(?!\n[ \t]*\n)(?!\$\$)[\s\S])+?)\$\$(?=[ \t]*(?:\n|$))/
const BLOCK_BRACKET = /^ {0,3}\\\[((?:(?!\n[ \t]*\n)(?!\\\])[\s\S])+?)\\\](?=[ \t]*(?:\n|$))/

const mathBlockExtension: TokenizerAndRendererExtension = {
  name: 'mathBlock',
  level: 'block',
  // Let marked interrupt a paragraph when a block formula starts on a LATER line. marked
  // calls start() on `src.slice(1)`, so a `^` here would anchor one char INTO the source
  // and mis-fire on a mid-line opener (`x $$a$$` → torn paragraph). We therefore only look
  // for a newline-led opener and return the offset of the char AFTER the newline; a true
  // offset-0 opener needs no interrupt — the block tokenizer matches it directly.
  start: (src: string) => {
    const m = /\n {0,3}(?:\$\$|\\\[)/.exec(src)
    return m ? m.index + 1 : undefined
  },
  tokenizer(this: TokenizerThis, src: string): MathToken | undefined {
    const m = BLOCK_DOLLAR.exec(src) ?? BLOCK_BRACKET.exec(src)

    if (!m) {
      return undefined
    }
    const tex = m[1].trim()

    if (!tex) {
      return undefined
    } // empty `$$$$` / `\[\]` — not a formula, leave it literal

    return { type: 'mathBlock', raw: m[0], tex, display: true }
  },
  renderer(this: RendererThis, token: Tokens.Generic) {
    const t = token as MathToken
    // A block wrapper we own: it carries the block margin and the horizontal scroll for a
    // formula wider than the reading column (markdown.scss). Inside is KaTeX's own
    // `.katex-display`.
    return `<div class="md-math">${renderTex(t.tex, true)}</div>\n`
  },
}

// ── Inline: \(…\), $…$, and mid-flow $$…$$ / \[…\] ───────────────────────────────
// Backslash delimiters are unambiguous, so they match plainly (non-greedy, first closer
// wins). The single-dollar rule is the price-safe standard one (Pandoc/marked-katex):
//   - opening `$` not followed by a space or another `$`  →  `(?![\s$])`
//   - body is at least one char, ending on a non-`$`, non-newline char
//   - closing `$` FOLLOWED by whitespace / punctuation / end  →  the lookahead
// So "$5 and $10" / "$5 or $6" never match (a digit sits right after the closing `$`),
// while "$x^2$" or "cost $c$ per unit" do. `$$…$$` and `\[…\]` in mid-sentence render in
// display mode too (KaTeX's convention), so a pasted block formula inside a paragraph
// still renders instead of leaking source.
const INLINE_PAREN = /^\\\(([\s\S]+?)\\\)/
const INLINE_BRACKET = /^\\\[([\s\S]+?)\\\]/
const INLINE_DDOLLAR = /^\$\$(?!\$)([\s\S]+?)\$\$/
const INLINE_DOLLAR =
  /^\$(?![\s$])((?:\\.|[^\\\n$])*?(?:\\.|[^\\\n$]))\$(?=[\s?!.,:;)"'》」』？！。，：]|$)/

const matchInline = (src: string): { tex: string; display: boolean; raw: string } | undefined => {
  let m = INLINE_PAREN.exec(src)

  if (m) {
    return { tex: m[1].trim(), display: false, raw: m[0] }
  }
  m = INLINE_BRACKET.exec(src)
  if (m) {
    return { tex: m[1].trim(), display: true, raw: m[0] }
  }
  m = INLINE_DDOLLAR.exec(src)
  if (m) {
    return { tex: m[1].trim(), display: true, raw: m[0] }
  }
  m = INLINE_DOLLAR.exec(src)
  if (m) {
    return { tex: m[1].trim(), display: false, raw: m[0] }
  }

  return undefined
}

const mathInlineExtension: TokenizerAndRendererExtension = {
  name: 'mathInline',
  level: 'inline',
  // Point marked at the next possible opener so it splits the surrounding text token.
  // `$` covers $…$ and $$…$$; `\` covers \(…\) and \[…\].
  start: (src: string) => {
    const m = /\$|\\[([]/.exec(src)
    return m ? m.index : undefined
  },
  tokenizer(this: TokenizerThis, src: string): MathToken | undefined {
    const hit = matchInline(src)

    if (!hit || !hit.tex) {
      return undefined
    }

    return { type: 'mathInline', raw: hit.raw, tex: hit.tex, display: hit.display }
  },
  renderer(this: RendererThis, token: Tokens.Generic) {
    const t = token as MathToken
    return renderTex(t.tex, t.display)
  },
}

export const mathExtensions = [mathBlockExtension, mathInlineExtension]
