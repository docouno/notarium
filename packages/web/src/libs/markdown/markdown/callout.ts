// Callouts / admonitions (#117) — our own marked extension, NOT marked-alert.
//
// Syntax is Obsidian's (a superset of GitHub's alerts): a blockquote whose first
// line is `[!type]`, optionally foldable (`+`/`-`) and with a custom title:
//
//   > [!note]                 a static callout, default title "Note"
//   > [!warning] Be careful   a custom title on the type line
//   > [!tip]- Collapsed       foldable, starts collapsed (`+` = starts open)
//   > body across
//   > as many lines as you like, with **markdown** inside
//
// Why our own and not marked-alert: that lib is strict GitHub (5 UPPERCASE types,
// no custom title, no fold) and injects inline octicon SVGs. We want the Obsidian
// breadth, case-insensitive types, foldable via a native <details> (no JS), our
// own theme icons (CSS mask, see styles/callouts.scss) and class-only output that
// passes the existing DOMPurify config untouched. The body bytes are never
// rewritten — this is render-only, so the source round-trips byte-for-byte.
import type { RendererThis, TokenizerAndRendererExtension, TokenizerThis, Tokens } from 'marked'

// A "look" = a visual family (colour + icon), defined once in styles/callouts.scss
// and shared by the reading view and the WYSIWYM editor's rail. A type word resolves
// to a look; its default title is just the word, capitalised (so `[!tldr]` reads
// "Tldr" over the abstract look). Unknown words fall back to the note look but keep
// their own title — an unrecognised `[!xyz]` still renders as a tidy callout.
const LOOKS = new Set([
  'note',
  'info',
  'abstract',
  'tip',
  'success',
  'question',
  'warning',
  'danger',
  'bug',
  'example',
  'quote',
  'important',
])
const ALIASES: Record<string, string> = {
  summary: 'abstract',
  tldr: 'abstract',
  todo: 'info',
  hint: 'tip',
  check: 'success',
  done: 'success',
  help: 'question',
  faq: 'question',
  attention: 'warning',
  caution: 'danger',
  error: 'danger',
  failure: 'danger',
  fail: 'danger',
  missing: 'danger',
  cite: 'quote',
}

/** Resolve a `[!type]` word to its look class (colour + icon family). */
export const calloutLook = (type: string): string => {
  const t = type.toLowerCase()

  if (LOOKS.has(t)) {
    return t
  }

  return ALIASES[t] ?? 'note'
}

// The first inner line of a callout: `[!type]`, an optional fold flag, then an
// optional custom title. Case-insensitive (Obsidian); GitHub's UPPERCASE is a subset.
const HEAD = /^\[!(\w+)\]([+-]?)[ \t]*(.*)$/

// A callout is a run of consecutive blockquote lines whose first inner line is a
// `[!type]` head. We capture the `>` run ourselves (rather than post-processing the
// core blockquote token) so we can read the fold flag and custom title and parse a
// clean body — returning undefined for a non-callout blockquote so the core
// tokenizer handles it normally.
type CalloutToken = Tokens.Generic & {
  type: 'callout'
  look: string
  foldable: boolean
  open: boolean
  titleTokens: Tokens.Generic[]
  tokens: Tokens.Generic[]
}

export const calloutExtension: TokenizerAndRendererExtension = {
  name: 'callout',
  level: 'block',
  // Let marked interrupt a paragraph when a callout starts on a later line.
  start: (src: string) => {
    const m = /^ {0,3}> *\[!/m.exec(src)
    return m ? m.index : undefined
  },
  tokenizer(this: TokenizerThis, src: string) {
    if (!/^ {0,3}>/.test(src)) {
      return undefined
    } // not a blockquote at all
    // Capture the leading run of blockquote lines. A non-`>` line (incl. a blank
    // separator) ends the run; the trailing newline left in `src` is consumed by
    // marked's newline tokenizer, so `raw` is exactly the captured lines.
    const lines = src.split('\n')
    let i = 0

    while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
      i++
    }
    const block = lines.slice(0, i)
    const raw = block.join('\n')
    // Strip the `>` marker (and one optional following space) from every line.
    const inner = block.map((l) => l.replace(/^ {0,3}> ?/, '')).join('\n')
    const nl = inner.indexOf('\n')
    const firstLine = (nl === -1 ? inner : inner.slice(0, nl)).trim()
    const head = HEAD.exec(firstLine)

    if (!head) {
      return undefined
    } // a normal blockquote — hand back to the core tokenizer
    const [, type, fold, rest] = head
    const body = nl === -1 ? '' : inner.slice(nl + 1)
    const title = rest.trim() || type.charAt(0).toUpperCase() + type.slice(1).toLowerCase()
    const token: CalloutToken = {
      type: 'callout',
      raw,
      look: calloutLook(type),
      foldable: fold !== '',
      open: fold !== '-', // `+` or bare-foldable → open, `-` → collapsed
      titleTokens: [],
      tokens: [],
    }
    // Inline-parse the title (so `**bold**` works and html is escaped) and
    // block-parse the body (lists, code, nested markdown all just work).
    token.titleTokens = this.lexer.inlineTokens(title)
    this.lexer.blockTokens(body, token.tokens)
    return token
  },
  renderer(this: RendererThis, token: Tokens.Generic) {
    const t = token as CalloutToken
    const cls = `callout callout-${t.look}`
    const title = this.parser.parseInline(t.titleTokens)
    const body = t.tokens.length
      ? `<div class="callout-body">\n${this.parser.parse(t.tokens)}</div>\n`
      : ''

    if (t.foldable) {
      // Native <details> — foldable with zero JS, passes DOMPurify (details/summary
      // and `open` are all in its default allow-list).
      return (
        `<details class="${cls} callout-foldable"${t.open ? ' open' : ''}>\n` +
        `<summary class="callout-title">${title}</summary>\n${body}</details>\n`
      )
    }

    return `<div class="${cls}">\n<div class="callout-title">${title}</div>\n${body}</div>\n`
  },
}
