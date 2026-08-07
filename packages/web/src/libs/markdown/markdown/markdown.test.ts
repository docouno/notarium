import { marked } from 'marked'
import { describe, expect, it } from 'vitest'
// Importing the module registers the renderer overrides (#235 table wrap, heading ids,
// lazy images) and the wikilink inline extension (#236) on the shared `marked`
// singleton as a side effect. We assert against `marked.parse` directly — the HTML
// BEFORE renderMarkdown's DOMPurify pass — because DOMPurify needs a DOM/window that
// the node test env doesn't provide, and the overrides are class/attr-only (DOMPurify
// keeps them verbatim). The frontmatter strip that wraps parse lives in renderMarkdown
// and is exercised live.
import './markdown'
import { errText } from '../mermaid'
import { prefixDocumentFragments, wikiLinkTarget } from './markdown'

const render = (src: string): string => marked.parse(src) as string

describe('#235 table wrap', () => {
  it('wraps a table in the figure + horizontal-scroll container', () => {
    const html = render('| a | b |\n|---|---|\n| 1 | 2 |\n')
    expect(html).toContain('<div class="md-table">')
    expect(html).toContain('<div class="md-table-wrap">')
    expect(html).toContain('<table>')
    // Nesting order: .md-table (fade host) → .md-table-wrap (scroll) → <table>.
    expect(html.indexOf('<div class="md-table">')).toBeLessThan(
      html.indexOf('<div class="md-table-wrap">'),
    )
    expect(html.indexOf('<div class="md-table-wrap">')).toBeLessThan(html.indexOf('<table>'))
  })
})

describe('#235 heading ids', () => {
  it('slugifies the heading text into a stable id', () => {
    expect(render('## Hello World')).toContain('<h2 id="hello-world">')
  })

  it('uses the core slug (transliterates non-latin) so anchors match note URLs', () => {
    expect(render('# Привет Мир')).toContain('<h1 id="privet-mir">')
  })

  it('disambiguates repeated headings GitHub-style', () => {
    const html = render('# Notes\n\n## Notes\n\n### Notes\n')
    expect(html).toContain('id="notes"')
    expect(html).toContain('id="notes-1"')
    expect(html).toContain('id="notes-2"')
  })

  it('resets the disambiguation counter per document', () => {
    expect(render('# Intro')).toContain('id="intro"')
    // A second parse must not carry the counter over into `intro-1`.
    expect(render('# Intro')).toContain('id="intro"')
    expect(render('# Intro')).not.toContain('id="intro-1"')
  })

  it('keeps inline markup inside the heading', () => {
    const html = render('## A **bold** title')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('id="a-bold-title"')
  })

  it('slugs the VISIBLE text, not the raw link markdown', () => {
    // A link in a heading must anchor by its visible label, not leak the href into
    // the id (which would break a `[jump](#install-guide-now)` an author writes).
    const html = render('## Install [guide](http://x/y) now')
    expect(html).toContain('id="install-guide-now"')
    expect(html).not.toContain('http-x-y')
  })

  it('disambiguates collision-safe (a later heading never dups an id already taken)', () => {
    // Plain counting would give "Notes", "Notes", "Notes 1" the ids notes/notes-1/
    // notes-1 (a dup — the third's own slug is `notes-1`). The live-Set probe sees
    // `notes-1` is taken and bumps it to `notes-1-1`, so every id stays unique.
    const html = render('# Notes\n\n## Notes\n\n### Notes 1\n')
    const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1])
    expect(ids).toEqual(['notes', 'notes-1', 'notes-1-1'])
    expect(new Set(ids).size).toBe(ids.length) // no duplicate ids
  })

  it('does not leak a footnote ref extension into the id', () => {
    // textRenderer flattens core tokens but renders an inline extension (footnote
    // ref) as HTML; tags are stripped before slugging, so a footnote in a heading
    // gives a clean id, not a `<sup><a…>` blob.
    const html = render('## Overview[^1]\n\n[^1]: a note\n')
    const headingId = /<h2 id="([^"]+)"/.exec(html)?.[1]
    // The visible footnote label `1` survives as text (Overview + 1 → overview1),
    // but the `<sup><a…>` markup does not leak into the id.
    expect(headingId).toBe('overview1')
    expect(headingId).not.toContain('footnote')
  })

  it('anchors a CJK heading on its own letters, keeping two of them distinct', () => {
    // Before #296 both collapsed to the `section` fallback, so the second heading
    // silently became `section-1` and neither anchor said what it pointed at.
    expect(render('## 你好')).toContain('id="你好"')
    expect(render('## 第三季度规划')).toContain('id="第三季度规划"')
  })

  it('falls back to a "section" id when the text has no letters at all', () => {
    // An emoji is not a letter — the fallback is what keeps the heading addressable.
    expect(render('## 🎉')).toContain('id="section"')
  })
})

describe('document fragment prefixes', () => {
  it('keeps a footnote ARIA IDREF bound to its prefixed label', () => {
    const html = prefixDocumentFragments(render('Claim[^1]\n\n[^1]: Evidence.\n'), 'role-')
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]))
    const describedBy = /\saria-describedby="([^"]+)"/.exec(html)?.[1].split(/\s+/) ?? []

    expect(describedBy.length).toBeGreaterThan(0)
    expect(describedBy.every((id) => ids.has(id))).toBe(true)
    expect(describedBy).toContain('role-footnote-label')
  })
})

describe('#235 lazy images', () => {
  it('adds loading=lazy and decoding=async to images', () => {
    const html = render('![alt](pic.png)')
    expect(html).toContain('loading="lazy"')
    expect(html).toContain('decoding="async"')
    expect(html).toContain('src="pic.png"')
    expect(html).toContain('alt="alt"')
  })
})

describe('#236 mermaid fence', () => {
  // The mermaid post-render hook (renderMermaid) keys off `pre > code.language-mermaid`
  // and reads the fence source back from the <code>'s textContent. Lock that contract
  // at the pipeline layer: a ```mermaid fence must survive to exactly that shape with
  // the source intact (highlight.ts returns an unknown language verbatim, then
  // marked-highlight escapes it and tags the class). The SVG rendering itself needs a
  // browser DOM + the lazy mermaid chunk, so it is verified live on the stand.
  it('emits <pre><code class="language-mermaid"> — pins pre>code adjacency + class on <code>', () => {
    const html = render('```mermaid\ngraph TD; A-->B\n```')
    // Pin the load-bearing shape (renderMermaid selects `pre > code.language-mermaid`):
    // a class-bearing <code> DIRECT-child of <pre>, not just the substrings anywhere.
    expect(html).toMatch(/<pre><code class="[^"]*\blanguage-mermaid\b[^"]*">/)
    // Source round-trips (escaped) so textContent recovers it for mermaid.render.
    expect(html).toContain('graph TD')
    expect(html).toContain('A--&gt;B')
  })

  it('escapes an XSS attempt hidden in a mermaid fence (no live tag survives parse)', () => {
    const html = render('```mermaid\n<img src=x onerror=alert(1)>\n```')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('keeps every mermaid fence taggable when a note has more than one', () => {
    const html = render(
      '```mermaid\ngraph TD; A-->B\n```\n\ntext\n\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```',
    )
    expect((html.match(/language-mermaid/g) || []).length).toBe(2)
  })

  it('keeps a mermaid [[subroutine]] shape intact (wikilink extension skips code)', () => {
    // The subroutine node `X[[text]]` collides with [[WikiLink]] syntax; inside a fenced
    // block the wikilink extension never fires, so the source reaches mermaid.render
    // byte-for-byte and never becomes a `#wiki/` anchor.
    const html = render('```mermaid\nflowchart LR\n  A[[Cache]] --> B\n```')
    expect(html).toContain('language-mermaid')
    expect(html).toContain('A[[Cache]]')
    expect(html).not.toContain('#wiki/')
  })
})

describe('#236 wikilink extension', () => {
  it('rewrites a prose [[WikiLink]] to a #wiki/ anchor', () => {
    expect(render('see [[Alpha]] now')).toContain('<a href="#wiki/Alpha">Alpha</a>')
  })

  it('uses the label of a [[target|Label]] link and percent-encodes the target', () => {
    expect(render('[[home/index|Home]]')).toContain('<a href="#wiki/home%2Findex">Home</a>')
  })

  it('consumes the escaped alias separator inside a GFM table cell', () => {
    const html = render('| Link |\n| --- |\n| [[Target\\|Label]] |')

    expect(html).toContain('<a href="#wiki/Target">Label</a>')
    expect(html).not.toContain('#wiki/Target%2F')
  })

  it('trims whitespace in target and label', () => {
    expect(render('[[ a b | Label ]]')).toContain('<a href="#wiki/a%20b">Label</a>')
  })

  it('renders inline markdown inside the label (the old regex split could not)', () => {
    // A code span inside the label used to bisect the wikilink; the extension inline-
    // parses the label, so `code` renders AND the link survives.
    expect(render('[[api|the `fetch()` API]]')).toContain(
      '<a href="#wiki/api">the <code>fetch()</code> API</a>',
    )
  })

  it('converts several links on one line', () => {
    const html = render('[[A]] and [[B]]')
    expect(html).toContain('#wiki/A')
    expect(html).toContain('#wiki/B')
  })

  it('never fires inside an inline code span', () => {
    const html = render('use `[[Alpha]]` verbatim')
    expect(html).not.toContain('#wiki/')
    expect(html).toContain('[[Alpha]]')
  })

  // An untagged fenced / indented code block is auto-highlighted, so the [[Alpha]]
  // text is broken across hljs <span>s — strip tags before asserting the text survived.
  const textOf = (html: string) => html.replace(/<[^>]+>/g, '')

  it('never fires inside a fenced (``` or ~~~) code block', () => {
    for (const src of ['```\n[[Alpha]]\n```', '~~~\n[[Alpha]]\n~~~']) {
      const html = render(src)
      expect(html).not.toContain('#wiki/')
      expect(textOf(html)).toContain('[[Alpha]]')
    }
  })

  it('never fires inside an INDENTED code block (the split-regex regression)', () => {
    const html = render('    [[Alpha]]')
    expect(html).not.toContain('#wiki/')
    expect(textOf(html)).toContain('[[Alpha]]')
  })

  it('links the prose but not the code between it', () => {
    const html = render('[[A]] `[[B]]` [[C]]')
    expect(html).toContain('#wiki/A')
    expect(html).toContain('#wiki/C')
    expect(html).toContain('<code>[[B]]</code>')
    expect(html).not.toContain('#wiki/B')
  })

  it('never nests an <a>/raw tag from the label (bare + angle autolink + raw HTML anchor)', () => {
    // Every reachable inner-<a>/tag source in a label — a bare URL/email/www, an angle-
    // bracket autolink <…>, or a hand-written raw <a …> — must be neutralised so the
    // wiki anchor stays the ONLY anchor. Otherwise the browser un-nests the illegal
    // nested <a>, empties the wikilink and leaks an external link. (A real [text](url)
    // can't occur: its `]` closes the label, so the wikilink just won't match.)
    const cases = [
      '[[Home|https://example.com]]',
      '[[See www.example.com]]',
      '[[Contact|a@b.com]]',
      '[[Home|<https://example.com>]]',
      '[[Contact|<a@b.com>]]',
      '[[Page|<a href="https://evil.com">click</a>]]',
    ]

    for (const src of cases) {
      const html = render(src)
      expect((html.match(/<a\b/g) || []).length).toBe(1) // exactly one anchor, no nesting
      expect(html).toContain('href="#wiki/')
      expect(html).not.toMatch(/href="(?:https?:|mailto:)/) // no external/mailto leak
    }
  })

  it('leaves a whitespace-only [[ ]] literal (no empty dead anchor)', () => {
    const html = render('a [[ ]] b')
    expect(html).not.toContain('#wiki/')
    expect(html).toContain('[[ ]]')
  })

  it('renders a fragment-only wikilink as a local anchor, never a note action', () => {
    const html = render('jump [[#Section Name]]')
    expect(html).toContain('href="#section-name"')
    expect(html).not.toContain('#wiki/')
  })

  it('leaves a suffix-only target literal instead of creating an empty note action', () => {
    const html = render('broken [[.md]] target')
    expect(html).toContain('[[.md]]')
    expect(html).not.toContain('#wiki/')
  })

  it('does not leak lexer state (unbalanced tag in a label) to the rest of the note', () => {
    // An unbalanced <a>/<code> in a label toggles the shared lexer's inLink/inRawBlock;
    // without a snapshot/restore it would corrupt inline parsing AFTER the wikilink.
    // A trailing bare URL must still autolink (inLink not leaked)…
    expect(render('[[Home|<a href="x">]] then https://example.com')).toContain(
      '<a href="https://example.com">',
    )
    // …and text after an unbalanced <code> label must still escape (inRawBlock not leaked).
    expect(render('[[Guide|see <code> now]]\n\n5 < 6')).toContain('5 &lt; 6')
  })
})

describe('wikiLinkTarget (reader-side decode of a #wiki/ href)', () => {
  it('returns null for a nullish or non-wiki href', () => {
    expect(wikiLinkTarget(null)).toBeNull()
    expect(wikiLinkTarget(undefined)).toBeNull()
    expect(wikiLinkTarget('https://example.com')).toBeNull()
    expect(wikiLinkTarget('https://example.com/#wiki/Foo')).toBeNull()
  })

  it('round-trips the extension encoding (spaces, slashes, unicode)', () => {
    for (const target of ['a/b c', 'Привет Мир', 'x&y?z']) {
      expect(wikiLinkTarget('#wiki/' + encodeURIComponent(target))).toBe(target)
    }
  })

  it('returns the raw segment (no throw) for a malformed percent-encoding', () => {
    expect(wikiLinkTarget('#wiki/%zz')).toBe('%zz')
  })
})

describe('#237 math (KaTeX)', () => {
  // The math extension renders KaTeX synchronously at the string layer, so marked.parse
  // already contains the `span.katex` HTML (no DOMPurify / DOM needed here). We assert on
  // the class markers KaTeX emits; the visual glyphs are verified live on the stand.
  const textOf = (html: string) => html.replace(/<[^>]+>/g, '')

  it('renders inline $…$ as a KaTeX span', () => {
    const html = render('mass–energy $E=mc^2$ holds')
    expect(html).toContain('class="katex"')
    expect(html).not.toContain('$E=mc^2$') // the source delimiters are consumed
  })

  it('renders inline \\(…\\) (the ChatGPT/Claude export form)', () => {
    const html = render('inline \\(a+b\\) here')
    expect(html).toContain('class="katex"')
    expect(html).not.toContain('\\(')
  })

  it('renders block $$…$$ wrapped in .md-math with a display formula', () => {
    const html = render('$$\\int_0^1 x^2\\,dx$$')
    expect(html).toContain('<div class="md-math">')
    expect(html).toContain('katex-display')
  })

  it('renders block \\[…\\] (the ChatGPT/Claude display form)', () => {
    const html = render('\\[\n\\frac{a}{b}\n\\]')
    expect(html).toContain('<div class="md-math">')
    expect(html).toContain('katex-display')
  })

  it('renders a mid-flow $$…$$ inline (display mode, no block wrapper)', () => {
    const html = render('see $$x^2$$ inline')
    expect(html).toContain('katex-display')
    expect(html).not.toContain('<div class="md-math">') // inline, not a standalone block
    expect(textOf(html)).toContain('inline')
  })

  // Price protection: the single-dollar rule needs whitespace/punctuation AFTER the
  // closing `$`, and a digit right after (a price) fails it — so neither dollar amount is
  // eaten as math and the literal text survives.
  it('does NOT treat prices as math ($5 and $10)', () => {
    const html = render('it costs $5 and $10 today')
    expect(html).not.toContain('class="katex"')
    expect(textOf(html)).toContain('$5 and $10')
  })

  it('does NOT treat "$5 or $6" as math', () => {
    const html = render('pick $5 or $6')
    expect(html).not.toContain('class="katex"')
    expect(textOf(html)).toContain('$5 or $6')
  })

  it('never fires inside an inline code span', () => {
    const html = render('literal `$x^2$` here')
    expect(html).not.toContain('class="katex"')
    expect(html).toContain('<code>$x^2$</code>')
  })

  it('never fires inside a fenced code block', () => {
    const html = render('```\n$$x^2$$\n```')
    expect(html).not.toContain('class="katex"')
    expect(textOf(html)).toContain('$$x^2$$')
  })

  it('falls back honestly on invalid TeX (no throw, error span, source kept)', () => {
    // throwOnError:false → KaTeX renders the source in an error span rather than throwing.
    let html = ''
    expect(() => {
      html = render('$\\frac{1}{$')
    }).not.toThrow()
    expect(html).toContain('katex-error')
    expect(textOf(html)).toContain('\\frac{1}{')
  })

  it('keeps \\href inert (trust:false) — no active link is produced from a formula', () => {
    // trust:false (KaTeX default) refuses to honour \href: it renders `\href` as an error
    // token, never an anchor. The raw TeX still appears as text inside the hidden MathML
    // `<annotation>` (source for screen readers, clipped from view) — that is inert text,
    // not a URL. What matters is that NO clickable/executable link is emitted.
    const html = render('$\\href{javascript:alert(1)}{x}$')
    expect(html).not.toContain('<a ') // no anchor at all
    expect(html).not.toMatch(/href\s*=\s*["']?javascript:/i) // no javascript: URL attribute
  })

  it('handles several formulas on one line', () => {
    const html = render('$a$ and $b$ and \\(c\\)')
    expect((html.match(/class="katex"/g) || []).length).toBe(3)
  })

  it('renders inline \\[…\\] mid-flow as display (no block wrapper), prose intact', () => {
    const html = render('see \\[x^2\\] here')
    expect(html).toContain('katex-display')
    expect(html).not.toContain('<div class="md-math">') // inline branch, not a block
    expect(textOf(html)).toContain('see')
    expect(textOf(html)).toContain('here')
  })

  it('renders a multi-line block $$\\n…\\n$$ as a display block', () => {
    const html = render('$$\n\\frac{a}{b}\n$$')
    expect(html).toContain('<div class="md-math">')
    expect(html).toContain('katex-display')
  })

  it('lets a block $$…$$ on its own line interrupt a preceding paragraph', () => {
    const html = render('text before\n$$x^2$$\nmore text')
    expect(html).toContain('<div class="md-math">')
    expect(textOf(html)).toContain('text before')
    expect(textOf(html)).toContain('more text')
  })

  // Regression: the block start() used a `^` anchor, but marked calls start() on
  // src.slice(1), so a mid-line `$$`/`\[` one char into a paragraph was mis-promoted to a
  // standalone block (tearing the paragraph). A short prefix must stay an inline formula.
  it('does NOT tear a paragraph when a formula is the 2nd token (short prefix)', () => {
    for (const src of ['x $$a$$', 'I \\[y\\]', 'a $$E=mc^2$$']) {
      const html = render(src)
      expect(html).not.toContain('<div class="md-math">') // stays inline, no block promotion
      expect(html).toContain('katex') // still rendered as math
    }
  })

  // Regression: the block body `[\s\S]+?` could cross blank lines — a column-0
  // `$$x$$ trailing text` line whose first closer failed the EOL lookahead would hunt on
  // for the next end-of-line `$$`, swallowing everything (headings included) in between.
  it('does NOT let a block formula swallow content across a blank line', () => {
    const html = render('$$a$$ is the cost formula\n\n## Section Two\n\n$$\nb = 2\n$$')
    expect(html).toContain('id="section-two"') // the heading survives, not swallowed
    expect(textOf(html)).toContain('is the cost formula') // trailing prose survives
    // The genuine second block still renders (its opener was not consumed as a closer).
    expect((html.match(/katex-display/g) || []).length).toBe(2)
  })

  it('does NOT treat "$ 5 + 3 $" as math (space after opening $)', () => {
    const html = render('cost $ 5 + 3 $ dollars')
    expect(html).not.toContain('class="katex"')
    expect(textOf(html)).toContain('$ 5 + 3 $')
  })

  it('does NOT fire on an escaped \\$ dollar', () => {
    const html = render('price is \\$5 today')
    expect(html).not.toContain('class="katex"')
    expect(textOf(html)).toContain('$5 today')
  })

  // Regression (round 2): two block-delimited formulas on ONE line must not collapse into
  // a single block whose body spans the intervening prose. The block body forbids its own
  // closer, so the first non-EOL closer fails the block match and both fall through to the
  // inline tokenizer → two mid-flow display formulas with the prose between them.
  it('renders two same-line block formulas as two inline display formulas, prose intact', () => {
    for (const src of ['$$x$$ equals $$y$$', '\\[x\\] and \\[y\\]']) {
      const html = render(src)
      expect((html.match(/katex-display/g) || []).length).toBe(2)
      expect(html).not.toContain('katex-error') // not one garbled block
      expect(html).not.toContain('<div class="md-math">') // inline, not a standalone block
    }
    expect(textOf(render('$$x$$ equals $$y$$'))).toContain('equals')
  })
})

describe('errText (mermaid error caption)', () => {
  it('keeps only the first line of a multi-line message', () => {
    expect(errText(new Error('Parse error on line 3:\n…dump…\n^'))).toBe('Parse error on line 3:')
  })

  it('falls back to a generic message for an empty message', () => {
    expect(errText(new Error(''))).toBe('invalid diagram')
  })

  it('caps the caption at 200 chars', () => {
    expect(errText(new Error('x'.repeat(500))).length).toBe(200)
  })

  it('stringifies a non-Error throw', () => {
    expect(errText('boom')).toBe('boom')
  })
})
