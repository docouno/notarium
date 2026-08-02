import { syntaxTree } from '@codemirror/language'
import { Prec, type Range } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
import {
  CALLOUT_HEAD,
  calloutHead,
  calloutLink,
  inlineCodeSize,
  plainLink,
  taskDoneMark,
  taskDoneText,
} from '../../consts'
import { calloutRuns } from '../lineClassification'

export const inlineMarks = (view: EditorView): DecorationSet => {
  const decos: Range<Decoration>[] = []
  const tree = syntaxTree(view.state)
  const doc = view.state.doc
  const looks = view.state.field(calloutRuns) // shared "line → callout look" (or null)
  // Callout heads: a run's first line (look set, line above isn't part of it). Colour
  // `[!type]` and remember its start so the plain-link repaint below skips the same
  // Link node. The regex here finds the `[` COLUMN only — membership already came from
  // calloutRuns, so there's no independent re-detection.
  const headStarts = new Set<number>()

  for (const { from, to } of view.visibleRanges) {
    let pos = from

    while (pos <= to) {
      const line = doc.lineAt(pos)

      if (looks[line.number] && !looks[line.number - 1]) {
        const m = CALLOUT_HEAD.exec(line.text)

        if (m) {
          const start = line.from + m[0].indexOf('[')
          decos.push(calloutHead.range(start, line.from + m[0].length))
          headStarts.add(start)
        }
      }
      pos = line.to + 1
    }
  }
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name === 'Link') {
          if (headStarts.has(node.from)) {
            return
          } // the callout head colours it
          let real = false
          const c = node.node.cursor()

          if (c.firstChild()) {
            do {
              if (c.name === 'URL' || c.name === 'LinkLabel') {
                real = true
                break
              }
            } while (c.nextSibling())
          }
          if (!real) {
            decos.push(plainLink.range(node.from, node.to))
          } else if (looks[doc.lineAt(node.from).number]) {
            decos.push(calloutLink.range(node.from, node.to))
          }
        } else if (node.name === 'Task') {
          const ch = doc.sliceString(node.from + 1, node.from + 2) // the marker state in `[x]`

          if (ch === 'x' || ch === 'X') {
            decos.push(taskDoneMark.range(node.from, node.from + 3)) // the `[x]` marker
            if (node.to > node.from + 3) {
              decos.push(taskDoneText.range(node.from + 3, node.to))
            } // the done text
          }
        } else if (node.name === 'InlineCode') {
          decos.push(inlineCodeSize.range(node.from, node.to)) // 0.86em, inherits to the mono token
        }
      },
    })
  }

  return Decoration.set(decos, true) // true = sort (decos are collected, not pre-ordered)
}

export const inlineMarkPlugin = Prec.highest(
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = inlineMarks(view)
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
          this.decorations = inlineMarks(u.view)
        }
      }
    },
    { decorations: (v) => v.decorations },
  ),
)
