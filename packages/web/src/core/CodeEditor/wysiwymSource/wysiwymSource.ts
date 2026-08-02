// "WYSIWYM" editing surface (#116, named #180) — styled source with VISIBLE
// markup, NOT hide/reveal WYSIWYG. "What you see is what you mean": you edit the
// markdown meaning while it renders in place, but the markers stay on screen. True
// hide-the-markers WYSIWYG is the separate third mode (#120).
//
// Owner feedback: the Obsidian-style approach (hide markers, reveal the active
// line) makes text jump as the caret moves — a link expands from "Notarium" to
// `[Notarium](https://…)` the moment you enter it. So here we DON'T hide anything:
// the raw markdown markers stay visible at all times (so the line length never
// changes → zero caret-jump), but the text is richly styled — headings sized,
// emphasis rendered, code tinted, and the markers themselves dimmed so they
// recede without disappearing. The body bytes are untouched (decorations only),
// so the round-trip stays byte-exact like every other mode.
//
// Two pieces, both additive (nothing replaced/hidden):
//   1. richHighlight — a HighlightStyle over the lezer-markdown tags (heading1..6,
//      strong/emphasis/strikethrough/monospace, processingInstruction = the
//      `# ** > \`` markers, link/url). Inline + per-token styling, viewport-scoped
//      (colour doesn't affect line height, so culling it is safe).
//   2. blockLayout — a StateField that tags whole lines for block rhythm and the
//      blockquote/code backdrops. It runs over the WHOLE document (not just the
//      viewport) so a line's height never flips as you scroll a long note — that
//      flipping was the "a scrollbar appears and crops content when the caret moves
//      to a new line" bug. It classifies lines by their TEXT (not the syntax tree)
//      so there's no parse-horizon gap off-screen.
import { syntaxHighlighting } from '@codemirror/language'
import { richHighlight } from './consts'
import { backdropLayer } from './helpers/backdrops'
import { blockLayout } from './helpers/blockLayout'
import { inlineMarkPlugin } from './helpers/inlineMarks'
import { calloutRuns, lineKinds } from './helpers/lineClassification'

/** The "WYSIWYM" (styled-source) extension bundle for the mode compartment.
 *  Field order matters: `lineKinds` first (classify by text), then `calloutRuns`
 *  (reads lineKinds), then `blockLayout` (reads both) — each StateField's create()
 *  must see its dependencies already installed. */
export const wysiwymSourceExtension = [
  lineKinds,
  calloutRuns,
  syntaxHighlighting(richHighlight),
  blockLayout,
  backdropLayer,
  inlineMarkPlugin,
]
