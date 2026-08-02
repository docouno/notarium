import { type EditorState, RangeSetBuilder, type Text } from '@codemirror/state'
// Focus mode (#118) — distraction-free writing: dim everything EXCEPT the active
// unit (the sentence / line / paragraph the caret sits in), like iA Writer's focus
// mode. Orthogonal to the Source/WYSIWYM surface (#116/#180) and to Edit/Preview —
// it's a personal writing aid that layers over ANY editing mode, toggled in
// Settings or by hotkey (state lives in ChromeProvider, persisted).
//
// Implementation is one idea reused across all three granularities: compute the
// active document RANGE, then dim everything outside it. The only thing that varies
// per granularity is how the active range is computed — the dimming is identical.
// Dimming is `opacity` on inline mark decorations (NOT colour): opacity dims the
// richly-highlighted tokens too (headings, links, code), where a colour override
// would leave their own `--hl-*` colours bright. Decorations only paint, never touch
// the bytes, so the round-trip stays byte-exact like every other editor layer.
//
// The decorations are VIEWPORT-scoped (a ViewPlugin, not a whole-doc StateField):
// opacity changes no geometry, so a line's height never flips as it crosses the
// viewport edge — off-screen lines need no dimming (they aren't visible). Rebuilt on
// selection moves, edits and scroll. Two mark ranges at most per visible range
// (before / after the active span), so it's cheap even on a long note.
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'

/** The unit the active zone snaps to. 'off' (no focus) lives in ChromeProvider as a
 *  separate boolean — this type is only the three real granularities. */
export type FocusGranularity = 'sentence' | 'line' | 'paragraph'

type Range = { from: number; to: number }

// A blank line (only whitespace) separates paragraphs.
const isBlank = (text: string) => text.trim() === ''

// The logical source line containing `pos`. With line-wrapping on, a long prose
// paragraph is usually ONE logical line (so 'line' ≈ 'paragraph' for soft-wrappers);
// for authors who hard-wrap one sentence per line (semantic line breaks), the
// logical line ≈ a sentence. Both are deliberate, meaningful behaviours.
const lineAt = (doc: Text, pos: number): Range => {
  const line = doc.lineAt(pos)
  return { from: line.from, to: line.to }
}

// The paragraph containing `pos`: the run of consecutive non-blank lines around it,
// bounded by blank lines (or the document edges). A caret on a blank line has no
// paragraph — the unit is just that line (everything else dims), which reads as
// "between paragraphs".
const paragraphAt = (doc: Text, pos: number): Range => {
  const line = doc.lineAt(pos)

  if (isBlank(line.text)) {
    return { from: line.from, to: line.to }
  }
  let top = line.number
  let bot = line.number

  while (top > 1 && !isBlank(doc.line(top - 1).text)) {
    top--
  }
  while (bot < doc.lines && !isBlank(doc.line(bot + 1).text)) {
    bot++
  }

  return { from: doc.line(top).from, to: doc.line(bot).to }
}

// Sentence terminator run + any trailing closing quotes/brackets. A boundary only
// counts when it's followed by whitespace or end-of-text, so a decimal ("3.14") or a
// mid-token dot doesn't split. Abbreviations ("e.g. ") are an accepted approximation
// — true sentence segmentation is locale-hard and not worth a parser here; this is
// punctuation-driven, so it degrades gracefully across languages.
const TERMINATOR = /[.!?…。！？]+["'”’»)\]]*/g
// CJK full-stops (。！？) end a sentence WITHOUT a trailing space — idiomatic CJK runs
// glyphs together (「句子一。句子二。」), so they'd otherwise never split (the whitespace
// rule below would treat the whole run as one unit). They're also unambiguous sentence
// enders that don't appear mid-token, so honouring them regardless of the next char is
// safe — unlike `…`, which DOES appear mid-sentence ("wait…really"), so it stays under
// the whitespace rule.
const CJK_STOP = /[。！？]/

const firstNonWs = (text: string, from: number) => {
  let i = from

  while (i < text.length && /\s/.test(text[i])) {
    i++
  }

  return i
}

// The sentence containing `pos`, found WITHIN its paragraph (sentences never cross a
// paragraph break). Returns the active sentence's document range. Falls back to the
// whole paragraph when there are no terminators (a heading, a list item, a fragment).
const sentenceAt = (doc: Text, pos: number): Range => {
  const para = paragraphAt(doc, pos)
  const text = doc.sliceString(para.from, para.to) // includes the \n between lines
  const rel = pos - para.from
  // Collect sentence spans [start, end) within the paragraph text. `matchAll` clones
  // the global regex internally, so there's no shared `lastIndex` to reset/leak.
  const spans: Array<[number, number]> = []
  let start = firstNonWs(text, 0)

  for (const m of text.matchAll(TERMINATOR)) {
    const end = m.index + m[0].length

    if (end >= text.length || /\s/.test(text[end]) || CJK_STOP.test(m[0])) {
      if (end > start) {
        spans.push([start, end])
      }
      start = firstNonWs(text, end)
    }
  }
  if (start < text.length) {
    spans.push([start, text.length])
  }
  if (!spans.length) {
    return para
  }
  // The first span whose end is at/after the caret contains it (spans are ordered and
  // gap-free except skipped whitespace; a caret in a gap snaps to the next sentence).
  const span = spans.find(([, e]) => rel <= e) ?? spans[spans.length - 1]
  return { from: para.from + span[0], to: para.from + span[1] }
}

const unitAt = (doc: Text, pos: number, granularity: FocusGranularity): Range => {
  if (granularity === 'line') {
    return lineAt(doc, pos)
  }
  if (granularity === 'paragraph') {
    return paragraphAt(doc, pos)
  }

  return sentenceAt(doc, pos)
}

// Resolve a caret position to a non-blank one so focus stays STABLE on a blank line
// instead of flashing. When you finish a paragraph and press Enter, the caret sits on
// a fresh blank line for a beat before you type — if focus "let go" there (un-dimming
// the whole doc), fast typing would strobe dimmed→bright→dimmed every paragraph break
// (iA Writer / Typora keep the focus put; the bright flash is the bug). So a blank
// line borrows the nearest non-blank line — PREFERRING the one ABOVE (the paragraph
// you were just writing), falling back to the one below. Returns -1 only when the
// whole document is blank (nothing to focus → caller dims nothing, no flash to cause).
const nearestNonBlank = (doc: Text, pos: number): number => {
  const line = doc.lineAt(pos)

  if (!isBlank(line.text)) {
    return pos
  }
  for (let n = line.number - 1; n >= 1; n--) {
    if (!isBlank(doc.line(n).text)) {
      return doc.line(n).to
    }
  }
  for (let n = line.number + 1; n <= doc.lines; n++) {
    if (!isBlank(doc.line(n).text)) {
      return doc.line(n).from
    }
  }

  return -1
}

/** The active focus range for the current selection, or null when there is nothing to
 *  focus (a fully blank document). Pure (only reads state) → unit-tested directly.
 *  A blank-line caret borrows the nearest non-blank unit (see nearestNonBlank) so
 *  focus never flashes off between paragraphs. To avoid vertical jitter when a
 *  selection is dragged across units (the iA caveat), the active zone spans from the
 *  unit at the selection START to the unit at its END — extending a selection lights
 *  up every unit it touches rather than making one "active" unit jump. */
export const activeFocusRange = (
  state: EditorState,
  granularity: FocusGranularity,
): Range | null => {
  const doc = state.doc
  const sel = state.selection.main
  const pa = nearestNonBlank(doc, sel.from)

  if (pa < 0) {
    return null
  }
  const pb = sel.empty ? pa : nearestNonBlank(doc, sel.to)
  const a = unitAt(doc, pa, granularity)
  const b = pb < 0 ? a : unitAt(doc, pb, granularity)
  return { from: Math.min(a.from, b.from), to: Math.max(a.to, b.to) }
}

const dimMark = Decoration.mark({ class: 'cm-focus-dim' })

// Dim every visible position OUTSIDE the active range. At most two mark ranges per
// visible range: [visibleStart, activeStart) and [activeEnd, visibleEnd). When the
// active range is entirely off-screen the whole visible range dims (correct — the
// active unit isn't on screen to keep bright).
const buildDecorations = (view: EditorView, granularity: FocusGranularity): DecorationSet => {
  const active = activeFocusRange(view.state, granularity)

  // Only a fully blank document yields no active unit — then dim nothing (there's no
  // text to focus, and nothing to flash). Every non-empty doc keeps a unit lit, even
  // when the caret rests on a blank line (it borrows the nearest paragraph).
  if (!active) {
    return Decoration.none
  }
  const { from: af, to: at } = active
  const b = new RangeSetBuilder<Decoration>()

  for (const { from, to } of view.visibleRanges) {
    const beforeTo = Math.min(to, af)

    if (from < beforeTo) {
      b.add(from, beforeTo, dimMark)
    }
    const afterFrom = Math.max(from, at)

    if (afterFrom < to) {
      b.add(afterFrom, to, dimMark)
    }
  }

  return b.finish()
}

// The dim opacity is theme-tracked via the var so it can differ light/dark if needed;
// a short transition lets the active unit fade in as the caret moves rather than snap.
const focusTheme = EditorView.theme({
  '.cm-focus-dim': {
    opacity: 'var(--focus-dim, 0.32)',
    transition: 'opacity 0.12s ease-out',
  },
})

/** The focus-mode extension for a given granularity. Plugged into a Compartment in
 *  CodeEditor so toggling on/off or switching granularity reconfigures it live, with
 *  no editor remount (caret/undo survive). */
export const focusModeExtension = (granularity: FocusGranularity) => {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, granularity)
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged) {
          this.decorations = buildDecorations(u.view, granularity)
        }
      }
    },
    { decorations: (v) => v.decorations },
  )
  return [plugin, focusTheme]
}
