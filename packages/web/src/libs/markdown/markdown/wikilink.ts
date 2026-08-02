// [[WikiLinks]] (optionally [[target|label]]) as a marked INLINE extension (#236
// review). Notes reference each other with `[[Title]]`; we turn them into real
// anchors with a `#wiki/<target>` hash href so DOMPurify keeps them and the reader
// can intercept the click to open the target (or offer to create it). The `#wiki/`
// sentinel is engine-neutral — a client-only marker, never sent anywhere.
//
// Why an extension, not a pre-parse string replace: a raw-source regex has no model
// of markdown code, so it either rewrites `[[…]]` INSIDE code (corrupting a code
// sample or a mermaid `[[subroutine]]` shape) or, if it tries to skip code by
// splitting, mis-detects fences/inline spans and can bisect a `[[target|label with
// `code`]]`. marked's inline tokenizer already knows what is code: an inline
// extension only ever sees text OUTSIDE code spans and code blocks, so `[[…]]` in any
// code context is preserved for free, and the label is inline-parsed so `**bold**` /
// `` `code` `` inside it still render. Render-only: the source bytes never change.
import type { RendererThis, TokenizerAndRendererExtension, TokenizerThis, Tokens } from 'marked'

// Non-greedy so the FIRST `]]` closes. Target = up to `|` or `]` (no pipe/bracket);
// optional label = up to `]`. `[^\]]` in the label can't contain `]`, so a label can
// never itself hold a complete `[[x]]` — no pathological nesting.
//
// Known limitation: the `|` separator is also GFM's table-cell delimiter, and this
// extension runs AFTER the block-level table tokenizer has split a row on unescaped
// `|`. So `| [[t|label]] |` bisects at the pipe. That is spec-correct (an unescaped
// `|` in a cell IS a delimiter — GitHub/Obsidian split the same way); the canonical
// fix is to escape it — `[[t\|label]]` — which stays in one cell and resolves here.
const WIKI_LINK = /^\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/

type WikiLinkToken = Tokens.Generic & {
  type: 'wikiLink'
  target: string
  tokens: Tokens.Generic[]
}

// A wiki anchor's label is display text with light inline formatting only — it must
// never introduce another anchor or a raw tag. A nested <a> is illegal HTML: the browser
// un-nests it, emptying the wikilink AND leaking the inner link as an external sibling.
// Given the label capture forbids `]`, the ONLY inline tokens that can render an <a>/tag
// without a `]` are: a `link` token (a bare or angle-bracket autolink — a real
// [text](url)/reflink/footnote/image can't occur, their `]` closes the label) and a raw
// `html` token (a literal `<a …>`/`<script>`/etc.). So unwrap every `link` to its inner
// content (keeping the visible text, as the old rewrite did) and DROP every `html` tag
// (its text siblings remain). Everything else a label can hold — emphasis, strong, del,
// code, text — is safe. Recurse so a link/tag nested inside emphasis is caught too.
type LabelToken = Tokens.Generic & { tokens?: Tokens.Generic[] }
const sanitizeLabel = (tokens: Tokens.Generic[]): Tokens.Generic[] =>
  tokens.flatMap((tok) => {
    const t = tok as LabelToken

    if (t.type === 'link') {
      return sanitizeLabel(t.tokens ?? [])
    }
    if (t.type === 'html') {
      return []
    } // strip a raw tag (e.g. a hand-written <a>)
    if (t.tokens) {
      t.tokens = sanitizeLabel(t.tokens)
    }

    return t
  })

export const wikiLinkExtension: TokenizerAndRendererExtension = {
  name: 'wikiLink',
  level: 'inline',
  // Point marked at the next possible `[[` so it splits the surrounding text token.
  start: (src: string) => {
    const i = src.indexOf('[[')
    return i === -1 ? undefined : i
  },
  tokenizer(this: TokenizerThis, src: string) {
    const m = WIKI_LINK.exec(src)

    if (!m) {
      return undefined
    }
    const target = m[1].trim()

    if (!target) {
      return undefined
    } // `[[ ]]` — no target; leave it literal, not a dead anchor
    const label = (m[2] ?? m[1]).trim()
    // Inline-parse the visible label (so emphasis / inline code inside it render), then
    // strip anything that would nest an anchor or a raw tag inside the wiki anchor.
    //
    // SNAPSHOT/RESTORE the shared lexer's sticky inline state around the parse: marked's
    // raw-tag tokenizer sets state.inLink (on `<a…>`) / state.inRawBlock (on
    // `<pre|code|kbd|script…>`) and reverts them only on the matching close tag. An
    // UNbalanced such tag inside a label (e.g. `[[Guide|see <code> usage]]`) would leave
    // the flag stuck true on the document lexer and corrupt inline parsing for the REST
    // of the note (bare URLs stop autolinking, text stops escaping). We restore in a
    // `finally` so a self-contained label can never leak state (also exception-safe).
    const { inLink, inRawBlock } = this.lexer.state
    let tokens: Tokens.Generic[]

    try {
      tokens = sanitizeLabel(this.lexer.inlineTokens(label))
    } finally {
      this.lexer.state.inLink = inLink
      this.lexer.state.inRawBlock = inRawBlock
    }
    const token: WikiLinkToken = { type: 'wikiLink', raw: m[0], target, tokens }
    return token
  },
  renderer(this: RendererThis, token: Tokens.Generic) {
    const t = token as WikiLinkToken
    return `<a href="#wiki/${encodeURIComponent(t.target)}">${this.parser.parseInline(t.tokens)}</a>`
  },
}
