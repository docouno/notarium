import { syntaxTree } from '@codemirror/language'
// Markdown formatting commands for the CodeMirror 6 editor.
//
// CM6 has no built-in toggle commands for markdown markup, and there is no
// well-maintained npm package that provides them — mature editors roll their
// own. This is the small, canonical implementation (changeByRange + sliceDoc)
// shared by the toolbar buttons and the keymap, so a click and a shortcut run
// the exact same toggle. Active-state detection reads the syntax tree.
import { EditorSelection, type EditorState, type Line } from '@codemirror/state'
import type { Command } from '@codemirror/view'

const FORMAT_EVENT = 'input.format'

type SyntaxTree = ReturnType<typeof syntaxTree>
type SyntaxNode = ReturnType<SyntaxTree['resolveInner']>
type Span = { from: number; to: number }
type DocChange = { from: number; to?: number; insert?: string }

// --- inline marks (bold/italic/strike/code) ------------------------------- //

// Smallest enclosing markup node of type `nodeName` that fully contains
// [from, to] — used so a toggle can strip a mark from anywhere inside it
// (caret in the middle, partial selection), not only when markers are adjacent.
const enclosingMark = (
  tree: SyntaxTree,
  from: number,
  to: number,
  nodeName: string,
): Span | null => {
  let node: SyntaxNode | null = tree.resolveInner(from, 0)

  while (node) {
    if (node.name === nodeName && node.from <= from && node.to >= to) {
      return { from: node.from, to: node.to }
    }
    node = node.parent
  }

  return null
}

// Toggle an inline mark (`marker` = the delimiter, `nodeName` = its Lezer node):
//   - already wrapped (markers adjacent, in the selection, OR the caret/partial
//     selection sits anywhere inside the mark) → strip the delimiters;
//   - otherwise wrap. An empty cursor inserts the pair and lands between them.
// The syntax-tree check makes toggle-off work from inside the mark and keeps the
// result consistent with the toolbar's active-state highlight (no `**…**` nesting).
const toggleInline = (marker: string, nodeName: string): Command => {
  const len = marker.length

  return (view) => {
    const state = view.state
    const tree = syntaxTree(state)
    const tr = state.changeByRange((range) => {
      const { from, to } = range
      const before = state.sliceDoc(Math.max(0, from - len), from)
      const after = state.sliceDoc(to, Math.min(state.doc.length, to + len))

      // Markers sit just outside the selection → remove them.
      if (before === marker && after === marker) {
        return {
          changes: [
            { from: from - len, to: from },
            { from: to, to: to + len },
          ],
          range: EditorSelection.range(from - len, to - len),
        }
      }

      // Markers are inside the selection (user selected `**bold**`) → strip.
      const sel = state.sliceDoc(from, to)

      if (sel.length >= len * 2 && sel.startsWith(marker) && sel.endsWith(marker)) {
        return {
          changes: { from, to, insert: sel.slice(len, sel.length - len) },
          range: EditorSelection.range(from, to - len * 2),
        }
      }

      // Caret/partial selection inside an existing mark → strip its delimiters.
      const mark = enclosingMark(tree, from, to, nodeName)

      if (mark) {
        return {
          changes: [
            { from: mark.from, to: mark.from + len },
            { from: mark.to - len, to: mark.to },
          ],
          range: EditorSelection.range(
            Math.max(mark.from, from - len),
            Math.max(mark.from, to - len),
          ),
        }
      }

      // Otherwise wrap.
      return {
        changes: [
          { from, insert: marker },
          { from: to, insert: marker },
        ],
        range: EditorSelection.range(from + len, to + len),
      }
    })
    view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: FORMAT_EVENT }))
    view.focus()
    return true
  }
}

// --- link ----------------------------------------------------------------- //

// Toggle a link. Inside an existing link → unwrap `[text](url)` back to `text`
// (consistent with the toolbar's active-state highlight). Otherwise wrap the
// selection and drop the cursor in the URL slot; an empty cursor inserts `[]()`
// with the caret in the text slot.
const toggleLink: Command = (view) => {
  const state = view.state
  const tree = syntaxTree(state)
  const tr = state.changeByRange((range) => {
    const { from, to } = range

    // Caret/selection inside a link → unwrap to the link text.
    const link = enclosingMark(tree, from, to, 'Link')

    if (link) {
      const text = state.sliceDoc(link.from, link.to)
      const m = text.match(/^\[([^\]]*)\]\([^)]*\)$/)
      const inner = m ? m[1] : text
      return {
        changes: { from: link.from, to: link.to, insert: inner },
        range: EditorSelection.range(link.from, link.from + inner.length),
      }
    }

    if (from === to) {
      return { changes: { from, insert: '[]()' }, range: EditorSelection.cursor(from + 1) }
    }
    const sel = state.sliceDoc(from, to)
    return {
      changes: { from, to, insert: `[${sel}]()` },
      range: EditorSelection.cursor(from + sel.length + 3), // inside the ( )
    }
  })
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: FORMAT_EVENT }))
  view.focus()
  return true
}

// --- line-based blocks (quote/list) --------------------------------------- //

// Unique set of lines touched by any selection range.
const selectedLines = (state: EditorState): Line[] => {
  const lines: Line[] = []
  const seen = new Set<number>()

  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number
    const last = state.doc.lineAt(range.to).number

    for (let n = first; n <= last; n++) {
      if (seen.has(n)) {
        continue
      }
      seen.add(n)
      lines.push(state.doc.line(n))
    }
  }

  return lines
}

// Toggle a fixed line prefix (e.g. `> ` or `- `). If every line already has it,
// strip it; otherwise add it to the lines that lack it.
const toggleLinePrefix =
  (detect: RegExp, prefix: string): Command =>
  (view) => {
    const state = view.state
    const lines = selectedLines(state)
    const allHave = lines.every((l) => detect.test(l.text))
    const changes: DocChange[] = []

    for (const line of lines) {
      const m = line.text.match(detect)

      if (allHave) {
        if (m) {
          changes.push({ from: line.from, to: line.from + m[0].length })
        }
      } else if (!m) {
        changes.push({ from: line.from, insert: prefix })
      }
    }
    if (changes.length) {
      view.dispatch(state.update({ changes, scrollIntoView: true, userEvent: FORMAT_EVENT }))
    }
    view.focus()
    return true
  }

// Ordered list needs sequential numbering rather than a fixed prefix.
const toggleOrderedList: Command = (view) => {
  const state = view.state
  const detect = /^\d+\.\s+/
  const lines = selectedLines(state)
  const allHave = lines.every((l) => detect.test(l.text))
  const changes: DocChange[] = []
  let n = 1

  for (const line of lines) {
    const m = line.text.match(detect)

    if (allHave) {
      if (m) {
        changes.push({ from: line.from, to: line.from + m[0].length })
      }
    } else if (!m) {
      changes.push({ from: line.from, insert: `${n++}. ` })
    } else {
      n++
    }
  }
  if (changes.length) {
    view.dispatch(state.update({ changes, scrollIntoView: true, userEvent: FORMAT_EVENT }))
  }
  view.focus()
  return true
}

// --- heading -------------------------------------------------------------- //

// Cycle the selected line(s) through none → H1 → H2 → H3 → none, driven by the
// first line's current level so the whole block stays in sync.
const cycleHeading: Command = (view) => {
  const state = view.state
  const headRe = /^(#{1,6})\s+/
  const lines = selectedLines(state)
  const cur = lines[0].text.match(headRe)
  const next = (cur ? cur[1].length : 0) >= 3 ? 0 : (cur ? cur[1].length : 0) + 1
  const insert = next === 0 ? '' : `${'#'.repeat(next)} `
  const changes: DocChange[] = lines.map((line) => {
    const m = line.text.match(headRe)
    return { from: line.from, to: line.from + (m ? m[0].length : 0), insert }
  })
  view.dispatch(state.update({ changes, scrollIntoView: true, userEvent: FORMAT_EVENT }))
  view.focus()
  return true
}

// --- public command set --------------------------------------------------- //

export const commands: Record<string, Command> = {
  bold: toggleInline('**', 'StrongEmphasis'),
  italic: toggleInline('*', 'Emphasis'),
  strike: toggleInline('~~', 'Strikethrough'),
  code: toggleInline('`', 'InlineCode'),
  link: toggleLink,
  heading: cycleHeading,
  bullet: toggleLinePrefix(/^[-*+]\s+/, '- '),
  ordered: toggleOrderedList,
  quote: toggleLinePrefix(/^>\s?/, '> '),
}

// The formatting keymap is no longer hardcoded here: CodeEditor builds it from the
// resolved hotkey map (#30, libs/hotkeys) over the `commands` above, so the editor's
// shortcuts follow the user's preset/overrides instead of a second fixed list.

// --- active-state detection ----------------------------------------------- //

// Lezer (GFM) node names → toolbar format keys, used to light up active buttons.
const NODE_FORMAT: Record<string, string> = {
  StrongEmphasis: 'bold',
  Emphasis: 'italic',
  Strikethrough: 'strike',
  InlineCode: 'code',
  Link: 'link',
  Blockquote: 'quote',
  BulletList: 'bullet',
  OrderedList: 'ordered',
  ATXHeading1: 'heading',
  ATXHeading2: 'heading',
  ATXHeading3: 'heading',
  ATXHeading4: 'heading',
  ATXHeading5: 'heading',
  ATXHeading6: 'heading',
  SetextHeading1: 'heading',
  SetextHeading2: 'heading',
}

// Which formats apply at the current selection head(s) — walks the syntax tree
// up from each caret collecting enclosing markup nodes.
export const activeFormats = (state: EditorState): Set<string> => {
  const formats = new Set<string>()
  const tree = syntaxTree(state)

  for (const range of state.selection.ranges) {
    let node: SyntaxNode | null = tree.resolveInner(range.head, -1)

    while (node) {
      const f = NODE_FORMAT[node.name]

      if (f) {
        formats.add(f)
      }
      node = node.parent
    }
  }

  return formats
}
