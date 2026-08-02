import { type Completion, pickedCompletion, snippet } from '@codemirror/autocomplete'
import { type EditorView } from '@codemirror/view'
import { FOOTNOTE_DEF, LINE_MARKERS } from '../../consts'

// Block snippets are LINE-anchored markdown — headings, lists, quotes, callouts, code
// fences, tables, dividers, footnotes own a WHOLE line and need blank-line separation
// to render. A naive in-place insert at the caret corrupts the invoking line: typing
// `/callout` on an auto-continued `3. ` list item produced `3. > [!note]` (the marker
// bled into the block). So place the block by line context instead:
//   - empty slot (blank line, or a bare `>`/`-`/`3.` marker with no text) → the block
//     REPLACES that line, dropping the marker so it can't bleed in;
//   - otherwise → the block goes on its OWN new line just below, keeping the line's
//     text untouched;
//   - either way it's blank-line separated from non-empty neighbours (required for
//     tables and empty-item lists, which can't interrupt a paragraph).
// The `${field}` tab-stops and final caret are handled by the snippet runner, over the
// full (separator-padded) template — so the caret still lands in the block.
//
// Indentation gotcha: CM's `snippet()` indents every CONTINUATION line by the leading
// whitespace of the ANCHOR line (read from the pre-change doc). On an indented invoking
// line (e.g. a nested list item) that inherited indent corrupts a multi-line block — the
// callout/code/table body mis-parses, and the empty-slot branch even produces an
// INCONSISTENT block (first line at column 0, the rest indented). Blocks belong at column
// 0. There's no single-transaction way around it (instantiate reads the anchor line
// BEFORE the change), so when the invoking line is indented we lay the leading separator
// down in a prep change FIRST — leaving an EMPTY column-0 anchor line — then run the
// snippet there (`baseIndent` becomes ''). Unindented lines stay a single clean call.
// Residual (rare, accepted): an indented line whose slash has TRAILING text starting with
// whitespace leaves that text as the anchor line, so the block can inherit one space —
// still renders (CommonMark tolerates ≤3), and it's strictly better than the full inherit.
//
// `from` points just AFTER the `/` (the query filters on the word, not `/word`), so
// `from - 1` is the slash itself.
export const blockApply =
  (template: string): Completion['apply'] =>
  (view, completion, from, to) => {
    const state = view.state
    const slashFrom = from - 1
    const line = state.doc.lineAt(slashFrom)
    const before = state.sliceDoc(line.from, slashFrom)
    const after = state.sliceDoc(to, line.to)
    const bareBefore = before.replace(LINE_MARKERS, '')
    const nextEmpty =
      line.number >= state.doc.lines || state.doc.line(line.number + 1).text.trim() === ''
    const post = nextEmpty ? '' : '\n' // blank line below if real content follows

    // Where the block goes: empty slot → it REPLACES the (marker/blank) line; content on
    // the line → its OWN new line below (`\n\n`), blank-separated.
    let pre: string
    let anchorFrom: number
    let anchorTo: number

    if (bareBefore.trim() === '' && after.trim() === '') {
      const prevEmpty = line.number <= 1 || state.doc.line(line.number - 1).text.trim() === ''
      pre = prevEmpty ? '' : '\n'
      anchorFrom = line.from
      anchorTo = line.to
    } else {
      pre = '\n\n'
      anchorFrom = slashFrom
      anchorTo = to
    }

    if (/^\s/.test(line.text)) {
      // Indented invoking line → drop the separator first so the snippet anchors on an
      // empty column-0 line (no inherited indent), then insert the block there.
      view.dispatch({ changes: { from: anchorFrom, to: anchorTo, insert: pre } })
      const at = anchorFrom + pre.length
      return snippet(template + post)(view, completion, at, at)
    }

    // Unindented → a single clean snippet call (anchor's `baseIndent` is already '').
    return snippet(pre + template + post)(view, completion, anchorFrom, anchorTo)
  }

// Inline snippets (image, links, wiki-links) are inline-level markdown — they belong
// AT the caret, not on their own line like the block snippets. So this just runs the
// snippet over the slash..to range (`from - 1` drops the `/`); the `${field}` tab-stops
// land the caret inside, e.g. between `[[` and `]]`.
export const inlineApply =
  (template: string): Completion['apply'] =>
  (view, completion, from, to) =>
    snippet(template)(view, completion, from - 1, to)

// Today's date as a local ISO `YYYY-MM-DD` (not toISOString, which is UTC and can
// land on the wrong day near midnight). Recomputed at insert time so an editor left
// open across midnight still inserts the right date.
const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`)

const todayISO = (): string => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export const dateApply = (view: EditorView, completion: Completion, from: number, to: number) => {
  const text = todayISO()
  view.dispatch({
    changes: { from: from - 1, to, insert: text }, // from-1 = the `/`
    selection: { anchor: from - 1 + text.length },
    annotations: pickedCompletion.of(completion),
    userEvent: 'input.complete',
    scrollIntoView: true,
  })
  view.focus()
}

// Footnote (#117) is a SPLIT construct, not a single block: an INLINE reference
// `[^n]` that belongs in the text where you are, and a DEFINITION `[^n]: …` that
// lives elsewhere (conventionally a footnote section at the bottom of the doc). So
// unlike the block snippets, the ref is inserted in place at the caret — `blockApply`
// would (wrongly) push the whole thing to a new line.
//
// Where the DEFINITION goes is what makes this feel reliable vs "random": it ALWAYS
// joins the existing footnote definitions as a consecutive line (so they never
// scatter), and only when there are none does it start its own block at the very end
// of the document. Parking unconditionally at the doc end (the old behaviour) looked
// random because, the moment any definition already sat above the end — a hand-placed
// one, or prose typed below the footnote section — the new definition landed far away
// from its siblings. Grouping makes the placement one predictable rule: "with the
// other footnotes, else at the bottom."
//
// `n` is the next free NUMBER (scanning existing refs+defs so two footnotes never
// collide on `[^1]`). The caret JUMPS to the definition stub (`[^n]: ‸`) so you type
// the footnote text there immediately — the Typora/Obsidian convention. The ref and
// the definition are two tokens of ONE footnote (markdown footnotes are inherently
// split); landing the caret on the definition is what makes that obvious instead of
// looking like a stray duplicate at the bottom.
export const footnoteApply = (
  view: EditorView,
  completion: Completion,
  from: number,
  to: number,
) => {
  const state = view.state
  const doc = state.doc
  const slashFrom = from - 1

  // Next free footnote number — scan refs AND defs so two footnotes never collide.
  const used = new Set<number>()

  for (const m of doc.toString().matchAll(/\[\^(\d+)\]/g)) {
    used.add(Number(m[1]))
  }
  let n = 1

  while (used.has(n)) {
    n++
  }
  const ref = `[^${n}]`

  // Find the LAST footnote-definition line; the new def joins it as the next line.
  let lastDef = 0

  for (let i = doc.lines; i >= 1; i--) {
    if (FOOTNOTE_DEF.test(doc.line(i).text)) {
      lastDef = i
      break
    }
  }
  let defChange: { from: number; insert: string }

  if (lastDef) {
    // Skip past any indented continuation lines belonging to that definition, then
    // append the new def as a consecutive line (single `\n`, no blank — that's how a
    // footnote block reads, and non-indented `[^n]:` lines parse as separate defs).
    let end = lastDef

    while (end < doc.lines) {
      const next = doc.line(end + 1).text

      if (next === '' || !/^\s/.test(next)) {
        break
      }
      end += 1
    }
    defChange = { from: doc.line(end).to, insert: `\n[^${n}]: ` }
  } else {
    // No footnotes yet → start the block at the doc end, blank-line separated.
    const tail = doc.sliceString(Math.max(0, doc.length - 2))
    const sep =
      doc.length === 0 ? '' : tail.endsWith('\n\n') ? '' : tail.endsWith('\n') ? '\n' : '\n\n'
    defChange = { from: doc.length, insert: `${sep}[^${n}]: ` }
  }

  const refChange = { from: slashFrom, to, insert: ref } // inline ref where the slash was
  // Changes must be in ascending order; the footnote block can sit above or below the caret.
  const defBeforeRef = defChange.from <= slashFrom
  const changes = state.changes(defBeforeRef ? [defChange, refChange] : [refChange, defChange])
  // Caret lands right AFTER the inserted `[^n]: ` definition (mapPos with assoc=1 = end
  // of the insertion in the new doc), wherever that block ended up — type the note now.
  view.dispatch(
    state.update({
      changes,
      selection: { anchor: changes.mapPos(defChange.from, 1) },
      annotations: pickedCompletion.of(completion),
      userEvent: 'input.complete',
      scrollIntoView: true,
    }),
  )
  view.focus()
}
