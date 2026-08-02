import { type CompletionSection } from '@codemirror/autocomplete'

// Leading list / ordered / task / quote markers + whitespace. Used to tell whether
// the line the slash was typed on is just an empty "slot" (a blank line, or an auto-
// continued `3. ` / `> ` / `- ` marker with no text) or already carries content.
export const LINE_MARKERS = /^(?:\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?|\s*>+\s?)*\s*/

export const FOOTNOTE_DEF = /^\[\^[^\]]+\]:/ // a line that is a footnote DEFINITION (`[^id]: …`)

// Sections group the menu (rendered as `<completion-section>` headers). `rank`
// fixes the order so they stay grouped even while fuzzy-filtering.
export const SEC: Record<string, CompletionSection> = {
  headings: { name: 'Headings', rank: 1 },
  lists: { name: 'Lists', rank: 2 },
  blocks: { name: 'Blocks', rank: 3 },
  insert: { name: 'Insert', rank: 4 },
}
