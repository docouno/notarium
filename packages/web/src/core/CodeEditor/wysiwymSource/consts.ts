import { HighlightStyle } from '@codemirror/language'
import { Decoration } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { codeTokenStyles } from '../codeHighlight'

// Sizes/weights mirror styles/markdown.scss (the reading view) against the
// reading base (var(--reading-size), the reading font) set on
// `.cm-host--wysiwym .cm-content`, so it ≈ the rendered note and scales with it.
// Heading colour is forced to --text/--text-dim here: WYSIWYM wants headings to read
// like the rendered note (sized, in the body ink), not coloured like the Source
// mode's themed markdown highlighting (where headings take --hl-keyword).
export const richHighlight = HighlightStyle.define([
  {
    tag: t.heading1,
    fontSize: '1.6em',
    fontWeight: '650',
    color: 'var(--text)',
    lineHeight: '1.3',
  },
  {
    tag: t.heading2,
    fontSize: '1.3em',
    fontWeight: '650',
    color: 'var(--text)',
    lineHeight: '1.3',
  },
  { tag: t.heading3, fontSize: '1.1em', fontWeight: '650', color: 'var(--text)' },
  { tag: t.heading4, fontSize: '1em', fontWeight: '650', color: 'var(--text-dim)' },
  { tag: t.heading5, fontSize: '0.95em', fontWeight: '600', color: 'var(--text-dim)' },
  { tag: t.heading6, fontSize: '0.92em', fontWeight: '600', color: 'var(--text-dim)' },
  { tag: t.strong, fontWeight: '700', color: 'var(--text)' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--text-dim)' },
  // Mono font + colour only — NO background, NO font-size here. (1) A token background
  // lived in the content (above CM's selection layer) and tinted a selection over
  // `code` — the fill is drawn in the backdrop layer below the selection instead.
  // (2) This tag applies to BOTH inline `InlineCode` and fenced `CodeText`; a
  // `0.86em` here double-shrank fenced code (0.86em × the .cm-md-code line's own
  // 0.8125em ≈ 0.7em, smaller than its fence markers). So fenced code inherits its
  // line size (0.8125em, uniform); inline code gets 0.86em via a per-node mark.
  { tag: t.monospace, fontFamily: 'var(--font-mono)', color: 'var(--text)' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.url, color: 'var(--text-dim)' },
  // The literal markdown markers (# ** _ ~~ > ` and list bullets): kept visible
  // but dimmed so they read as scaffolding, not content.
  { tag: t.processingInstruction, color: 'var(--text-faint)' },
  // Fenced-code token colours (#177), routed at the same `--hl-*` palette as the
  // reading view via the shared bridge — so the WYSIWYM editor and the Preview paint
  // code identically per Code-theme preset. The code FILL stays in the backdrop layer
  // (below the selection) and only the line-level `.cm-md-code` sets the mono font,
  // so these `color`-only spans combine cleanly with both. No overlap with the
  // markdown tags above (code content vs markdown structure).
  ...codeTokenStyles,
])

// Block rhythm + backdrops, as whole-line decorations. The reading view spaces
// blocks with MARGINS that COLLAPSE (one blank line and ten blank lines render the
// same); CM6's per-line model has neither, so we recreate that rhythm on the source:
//   - A blank source line stays caret-safe (taller than the caret) — collapsing it
//     below the caret height made the caret spill into the next line and flash a
//     scrollbar (the reported "jump on a new line" bug).
//   - The inter-block gap is supplied EITHER by that blank line OR, when blocks sit
//     tight with no blank between them (valid markdown: `# h`\n`text`), by a
//     top padding on the block's first line — never both (the margin-collapse
//     analog), so the spacing is even whether or not the author left blank lines.
//   - Headings always get a little extra top air for hierarchy.
//   - Blockquote / code runs get a translucent backdrop with SYMMETRIC internal
//     padding (top on the run's first line, bottom on its last) so the box is
//     balanced — top-only padding glued the text to the bottom edge.
// Classification is by line TEXT, in one pass, tracking the fenced-code state so a
// `#`/`>` inside a code block isn't mistaken for a heading/quote.
export const FENCE = /^\s{0,3}(```|~~~)/
export const ATX = /^(#{1,6})\s/
export const QUOTE = /^\s{0,3}>/
export const HR = /^ {0,3}([-*_])( *\1){2,} *$/
export const LIST = /^\s{0,3}([-*+]|\d{1,9}[.)])\s/
// First line of a callout (#117): a blockquote opening with `[!type]`. The reader
// renders these as rich boxes; in WYSIWYM mode we keep the source but tint the rail
// by the callout's look — a light parity nod, not a full render (the markers stay
// visible, which is the whole point of styled-source).
// `>\s*` (not `>\s?`) so `>  [!note]` with extra spaces is recognised in the editor
// too — the reader (callout.ts) strips `> ?` then trims, accepting any gap, so this
// keeps the two surfaces in parity on whitespace after the marker.
export const CALLOUT_HEAD = /^\s{0,3}>\s*\[!(\w+)\]([+-]?)/

// Inline semantics that need the syntax tree (one viewport-scoped walk). Prec.highest
// so each mark is the OUTER span — a `.cls *` rule can then repaint inner highlight
// tokens (a parent's colour alone wouldn't, since a child token carries its own).
//
//  1. Bare brackets `[x]`/`[*]`/`[foo]` — markdown parses ANY `[…]` as a Link node
//     even with no destination, so `t.link` paints the inside accent (looks
//     clickable). Repaint a destination-less Link (no URL/reference child) as plain.
//  2. GFM task markers — `- [x]`/`- [ ]` parse to a Task with a 3-char TaskMarker.
//     A CHECKED task (`[x]`/`[X]`) gets a highlighted marker + struck-through dim
//     text, so it reads as "done"; unchecked stays neutral. (A `[*]` is NOT a task —
//     it falls under case 1, plain — so done/undone is unambiguous.)
//  3. Inline code `\`x\`` — sized 0.86em here (per node) rather than on the shared
//     monospace tag, which would also shrink fenced code (see richHighlight note).
export const plainLink = Decoration.mark({ class: 'cm-md-plainlink' })
export const taskDoneMark = Decoration.mark({ class: 'cm-md-task-done-mark' })
export const taskDoneText = Decoration.mark({ class: 'cm-md-task-done-text' })
export const inlineCodeSize = Decoration.mark({ class: 'cm-md-ic' })
//  4. Callout head `[!type]` — coloured by the callout's look (the line carries
//     --callout-color). markdown parses `[!type]` as a destination-less Link, so
//     case 1 would repaint it plain; we mark the head AND skip the plain-link there
//     (one mark, no !important fight). wysiwym-source.scss does the colour.
export const calloutHead = Decoration.mark({ class: 'cm-md-callout-head' })
//  5. A real link INSIDE a callout takes the callout's type colour (not the global
//     accent), matching the reading view. Membership comes from the shared calloutRuns
//     field, so a link works even when the head is off-screen.
export const calloutLink = Decoration.mark({ class: 'cm-md-callout-link' })
