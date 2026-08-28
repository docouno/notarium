import DOMPurify from 'dompurify'
import { marked, Renderer } from 'marked'
import markedFootnote from 'marked-footnote'
import { markedHighlight } from 'marked-highlight'
import { parseBodyFrontmatterBlock } from '@notarium/core/markdown'
import { slugify } from '@notarium/core/slug'
import { calloutExtension } from './callout'
import { highlightCode } from './highlight'
import { mathExtensions } from './math'
import { wikiLinkExtension } from './wikilink'

// Syntax-highlight fenced code (#115). marked-highlight feeds each fence's raw
// body + declared language to hljs and wraps the class-based result; the output
// is `class`-only HTML, so the DOMPurify pass below keeps it verbatim and a
// strict CSP is fine (no inline styles). Colours come from CSS themes
// (styles/code-themes.scss), switched by a `data-code-theme` attribute. Sync
// (hljs is synchronous), so `marked.parse` still returns a string below.
marked.use(
  markedHighlight({
    emptyLangClass: 'hljs',
    langPrefix: 'hljs language-',
    highlight: (code, lang) => highlightCode(code, lang),
  }),
)

// Callouts/admonitions `> [!note]` (#117) — our own extension (see callout.ts).
// A blockquote-level block, so it must be registered before the body is parsed;
// a non-callout blockquote falls through to the core tokenizer untouched.
marked.use({ extensions: [calloutExtension] })

// [[WikiLinks]] (#236 review) — an inline extension (see wikilink.ts). Registered as
// an extension (not a pre-parse string replace) so it only ever fires on prose, never
// inside a code span/block — a `[[subroutine]]` mermaid shape or a `[[x]]` in a code
// sample survives byte-for-byte, and a wikilink label may contain inline markdown.
marked.use({ extensions: [wikiLinkExtension] })

// Footnotes `[^1]` + their `[^1]:` definitions (#117) via marked-footnote. Refs
// render as superscript anchors and the definitions collect into a `<section
// class="footnotes">` at the end, with back-references. The output is class- and
// fragment-anchor based (`#footnote-1`), so the DOMPurify pass keeps it (it allows
// id / data-* / aria-*); NoteReader makes those in-page anchors scroll instead of
// opening a new tab. Defs are global-id'd, fine for our one-note-per-page reader.
marked.use(markedFootnote())

// Math (KaTeX) `$…$` / `$$…$$` / `\(…\)` / `\[…\]` (#237) — our own extension (see
// math.ts). Synchronous KaTeX renders at THIS string layer (unlike async mermaid, which
// is a post-render DOM pass), so every `.markdown` surface gets formulas for free with no
// flicker. A block tokenizer catches `$$`/`\[` standing as their own block; an inline one
// catches the rest — including mid-flow `$$`/`\[`. Registered after footnote so a `$…$`
// never competes with `[^1]` ref syntax. Output is `span.katex` (HTML) + inline MathML;
// the renderMarkdown DOMPurify pass keeps both (see its MathML allow-list additions).
marked.use({ extensions: mathExtensions })

// Renderer overrides for the reader polish (#235). These sit at the HTML-string
// layer, so every `.markdown` surface (reader / editor-preview / history /
// settings sample) gets them for free — no per-surface DOM pass. `base` is a
// stock renderer we delegate to for the parts we only WRAP or decorate, so
// marked's own escaping / cleanUrl / inline parsing stays authoritative and the
// DOMPurify pass in renderMarkdown remains the final backstop.
const base = new Renderer()

// Heading ids for in-page anchors (#235): `[jump](#section)` / permalinks need a
// stable `id` on each heading — before this only footnote anchors resolved. The
// slug uses the SAME core `slugify` as note URLs and the MCP outline, so a
// heading's anchor matches what an author would guess from its URL slug. Repeated
// headings disambiguate GitHub-style (`foo`, `foo-1`, `foo-2`). The live Set of
// ids already emitted this document makes disambiguation collision-safe — a plain
// counter would hand `foo`, `foo`, `foo 1` the ids `foo`, `foo-1`, `foo-1` (a dup),
// whereas probing the Set skips an id another heading already took. Reset per
// document in the hooks.preprocess below (renderMarkdown is the one parse entry,
// but resetting in the hook survives any future call site).
let headingSlugs = new Set<string>()
let headingDepthOffset = 0

const headingSlug = (visibleText: string): string => {
  const slugBase = slugify(visibleText) || 'section'
  let candidate = slugBase

  for (let i = 1; headingSlugs.has(candidate); i++) {
    candidate = `${slugBase}-${i}`
  }
  headingSlugs.add(candidate)
  return candidate
}

marked.use({
  // Opt into marked 13's token-based renderer API. Without this, marked wraps
  // `marked.use({renderer})` overrides in the LEGACY positional signature
  // (`image(href,title,text)` etc.) for back-compat — which would strip the
  // token access and marked's own cleanUrl/escaping we delegate to via `base`.
  useNewRenderer: true,
  hooks: {
    // Runs at the start of every marked.parse — the natural per-document reset for
    // the heading-slug set (returns the source untouched).
    preprocess: (md: string): string => {
      headingSlugs = new Set()
      return md
    },
  },
  renderer: {
    // Wide tables scroll instead of overflowing the --doc-width column (#235).
    // Two wrappers: `.md-table` is a non-scrolling positioning context that carries
    // the edge-fade overlays (they must stay pinned to the visible edges, so they
    // can't live in the scroll box), and `.md-table-wrap` is the horizontal-scroll
    // container. The post-render hook toggles data-* on `.md-table` by scroll offset
    // so a fade shows only on a side that has more content off-screen.
    table(token) {
      return `<div class="md-table"><div class="md-table-wrap">\n${base.table.call(this, token)}</div></div>\n`
    },
    // Stable heading id for anchors/permalinks (#235). Inline content is parsed by
    // marked (so `**bold**` in a heading renders). The id slugs the VISIBLE text —
    // token.tokens flattened through marked's textRenderer, NOT the raw markdown —
    // so `## Install [guide](url)` anchors as `install-guide` (what an author would
    // reference) rather than leaking the link href, and a `[[wikilink]]` heading
    // doesn't carry its `#wiki/` sentinel into the id. textRenderer flattens core
    // inline tokens to text, but an inline EXTENSION token (marked-footnote's ref)
    // still renders its HTML, so strip tags before slugging — else `## Overview[^1]`
    // would slug the whole `<sup><a …>1</a></sup>` blob; stripped, it's `overview-1`.
    // The id alphabet is letters/digits/marks/underscore/dash since #296 — wider than
    // ASCII, but still safe as a bare attribute value: a quote, `<` and `&` are none of
    // those, so the slug class collapses them to a dash. Widen that class and this
    // interpolation needs escaping.
    heading(token) {
      const inner = this.parser.parseInline(token.tokens)
      const plain = this.parser
        .parseInline(token.tokens, this.parser.textRenderer)
        .replace(/<[^>]*>/g, '')
      const depth = Math.min(6, token.depth + headingDepthOffset)
      return `<h${depth} id="${headingSlug(plain)}">${inner}</h${depth}>\n`
    },
    // Images (#235): lazy-load below the fold and decode off the main thread. We
    // decorate marked's own <img> (which already escaped src/alt/title and ran
    // cleanUrl) rather than rebuild it, so nothing about URL safety changes.
    image(token) {
      return base.image.call(this, token).replace(/^<img /, '<img loading="lazy" decoding="async" ')
    },
  },
})

// breaks:true (#115) — a single newline becomes <br>, GitHub/Obsidian-style,
// instead of CommonMark's "soft-wrap collapses to a space". Real imports (Claude/
// ChatGPT exports, pasted prose) lean on single newlines as intentional line
// breaks; collapsing them mangles the text. Body bytes are untouched — this is a
// render-time choice only. Paragraph/line spacing is tuned in styles/markdown.scss.
marked.setOptions({ gfm: true, breaks: true })

// Defensive strip for draft/raw body surfaces. The shared body reader distinguishes
// incoming metadata from prose fenced between thematic rules, so rendering cannot hide
// bytes the write path keeps as content.
export const stripLeadingFrontmatter = (md: string): string => {
  try {
    const block = parseBodyFrontmatterBlock(md)
    return block ? md.slice(block.bodyStart) : md
  } catch {
    return md // an oversized block is not something a reader should throw over
  }
}

export type RenderMarkdownOptions = {
  /** Embed a document below existing page headings without introducing a new h1. */
  headingOffset?: number
  /** Keep heading/footnote fragments unique when several documents share one DOM. */
  idPrefix?: string
}

export const prefixDocumentFragments = (html: string, rawPrefix: string | undefined): string => {
  const prefix = (rawPrefix ?? '').replace(/[^a-zA-Z0-9_-]/g, '-')

  if (!prefix) {
    return html
  }
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]))

  return html
    .replace(/\sid="([^"]+)"/g, (_match, id: string) => ` id="${prefix}${id}"`)
    .replace(/\shref="#([^"]+)"/g, (match, id: string) =>
      ids.has(id) ? ` href="#${prefix}${id}"` : match,
    )
    .replace(
      /\s(aria-describedby|aria-labelledby)="([^"]+)"/g,
      (_match, attribute: string, value: string) =>
        ` ${attribute}="${value
          .split(/\s+/)
          .map((id) => (ids.has(id) ? `${prefix}${id}` : id))
          .join(' ')}"`,
    )
}

export const renderMarkdown = (md = '', options: RenderMarkdownOptions = {}): string => {
  const body = stripLeadingFrontmatter(md)
  const previousOffset = headingDepthOffset
  headingDepthOffset = Math.max(0, Math.min(5, Math.trunc(options.headingOffset ?? 0)))

  try {
    // gfm options are synchronous, so parse returns a string here (not a Promise).
    // Wikilinks are handled by the inline extension registered above (not a pre-parse
    // pass), so no string preprocessing wraps parse anymore.
    const html = marked.parse(body) as string
    // KaTeX (#237) emits `span.katex` (class + inline style) plus inline MathML for
    // accessibility. DOMPurify's default allow-list already covers span/class/style and
    // the core MathML tags, but NOT `<semantics>`/`<annotation>` (the TeX-source wrapper
    // KaTeX nests in `.katex-mathml`). Allow-list those two so the MathML stays valid and
    // the raw TeX doesn't surface as stray text via KEEP_CONTENT — the same targeted add
    // mermaid does for foreignObject, not a loosening (both are inert container tags; JS /
    // on*-handlers / javascript: are still stripped, and KaTeX runs with trust:false so no
    // \href link is ever produced in the first place).
    const sanitized = DOMPurify.sanitize(html, {
      ADD_ATTR: ['target', 'rel'],
      ADD_TAGS: ['semantics', 'annotation'],
    })
    return prefixDocumentFragments(sanitized, options.idPrefix)
  } finally {
    headingDepthOffset = previousOffset
  }
}

// Pull the identifier out of a #wiki/ hash anchor click, or null if not a wikilink.
export const wikiLinkTarget = (href: string | null | undefined): string | null => {
  if (!href) {
    return null
  }
  const marker = '#wiki/'

  if (!href.startsWith(marker)) {
    return null
  }
  const raw = href.slice(marker.length)

  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}
