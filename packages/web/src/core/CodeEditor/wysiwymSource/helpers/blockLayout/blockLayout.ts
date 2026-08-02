import { type EditorState, RangeSetBuilder, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'
import { calloutRuns, lineKinds } from '../lineClassification'

export const buildBlockLayout = (state: EditorState): DecorationSet => {
  const doc = state.doc
  const kinds = state.field(lineKinds)
  const calloutLooks = state.field(calloutRuns)
  // Accumulate classes per line number first: a tight backdrop block puts its
  // external gap on the PREVIOUS line (see below), which is behind the cursor of a
  // forward builder — so collect, then emit in line order.
  const byLine = new Map<number, Set<string>>()

  const add = (ln: number, c: string) => {
    let s = byLine.get(ln)

    if (!s) {
      byLine.set(ln, (s = new Set()))
    }
    s.add(c)
  }

  for (let i = 1; i <= doc.lines; i++) {
    const k = kinds[i]
    const prev = kinds[i - 1]
    // A tight inter-block gap is needed only when a block starts WITHOUT a blank
    // line above it (a blank already separates). The doc's first line never needs
    // a gap (it sits under the title / control bar).
    const tightGap = i > 1 && prev !== 'blank'

    if (k === 'blank') {
      add(i, 'cm-md-blank')
    } else if (k === 'quote' || k === 'code') {
      const tag = k === 'quote' ? 'cm-md-blockquote' : 'cm-md-code'
      add(i, tag)
      if (calloutLooks[i]) {
        // Tint the quote rail by the callout's look. `callout-<look>` carries the
        // --callout-color var (styles/callouts.scss, shared with the reader);
        // `cm-md-callout` is the hook the rail-colour rule targets.
        add(i, 'cm-md-callout')
        add(i, `callout-${calloutLooks[i]}`)
      }
      if (prev !== k) {
        add(i, `${tag}-top`) // internal top padding (balanced box)
        // The gap ABOVE a backdrop block can't be the block's own top padding —
        // the tint fills it, re-creating the "gap on top, none below" look. So when
        // it sits tight, hang the external gap on the previous (un-tinted) line.
        if (tightGap) {
          add(i - 1, 'cm-md-gap-below')
        }
      }
      if (kinds[i + 1] !== k) {
        add(i, `${tag}-bottom`)
      } // internal bottom padding
    } else if (k === 'hr') {
      add(i, 'cm-md-hr') // a drawn rule behind the dimmed `---`
      if (tightGap) {
        add(i, 'cm-md-gap')
      }
    } else if (k && k[0] === 'h') {
      // Headings carry their gap as top padding (un-tinted, so it reads external).
      // Two variants: tight (no blank above → padding is the whole gap, ≈ the
      // reader's big heading margin) vs after-blank (the blank already gave ~22px,
      // so add only the remainder). The very first line gets none.
      if (i > 1) {
        add(i, `cm-md-h${k[1]}${tightGap ? 't' : 'b'}`)
      }
    } else if (k === 'list') {
      // First item of a list (prev isn't another list line) opens a block.
      if (prev !== 'list' && tightGap) {
        add(i, 'cm-md-gap')
      }
    } else {
      // Plain paragraph line. It opens a block only when the previous line isn't
      // plaintext too (consecutive plain lines are one soft-wrapped paragraph).
      if (prev !== '' && tightGap) {
        add(i, 'cm-md-gap')
      }
    }
  }
  const builder = new RangeSetBuilder<Decoration>()

  for (const ln of [...byLine.keys()].sort((a, b) => a - b)) {
    const from = doc.line(ln).from
    builder.add(from, from, Decoration.line({ class: [...byLine.get(ln)!].join(' ') }))
  }

  return builder.finish()
}

// A StateField (not a ViewPlugin): its decorations cover the whole document, so a
// line's height never changes as it crosses the viewport edge — that's what keeps
// the scroll position honest on long notes. Rebuilt only when the doc changes
// (a caret move alone reuses the set).
export const blockLayout = StateField.define<DecorationSet>({
  create: (state) => buildBlockLayout(state),
  update: (value, tr) => (tr.docChanged ? buildBlockLayout(tr.state) : value),
  provide: (f) => EditorView.decorations.from(f),
})
