// Backdrops (quote/code fill, the HR rule) drawn as a LAYER, not as a `.cm-line`
// background. The reason is the selection: CM6 draws the selection in a layer
// BEHIND `.cm-content`, so any background painted on the line (which lives inside
// the content) sits ON TOP of the selection and tints the translucent highlight
// showing through — a selected quote looked darker than selected plain text.
// Moving the fill into its own below-content layer, pinned with Prec.lowest so it
// sorts UNDER the selection layer (CM gives below-layers `z = -1 - order`; lowest
// precedence ⇒ highest order ⇒ furthest back), puts the selection ON TOP of the
// fill instead. Paired with an opaque selection in WYSIWYM mode (wysiwym-source.scss)
// the selection then reads the same colour over a backdrop as over bare text.
// Heights are untouched (the per-line padding still comes from `blockLayout`); this
// layer only paints, so the round-trip stays byte-exact.
import { syntaxTree } from '@codemirror/language'
import { EditorSelection, type EditorState, Prec } from '@codemirror/state'
import { type EditorView, layer, RectangleMarker } from '@codemirror/view'
import type { Run } from '../../types'
import { calloutRuns, lineKinds } from '../lineClassification'

// Every decorative background lives HERE (one layer below the selection), never as
// a content style — that's the single rule that keeps a selection uniform over them
// (CM draws the selection below the content, so any content background would tint
// it). Two shape families: full-line FILLS (quote/code — one generic path, new block
// types join it for free) and 1px RULES (the HR divider, the h2 underline).
export const backdropRuns = (state: EditorState): Run[] => {
  const kinds = state.field(lineKinds)
  const looks = state.field(calloutRuns)
  const doc = state.doc
  const runs: Run[] = []

  for (let i = 1; i <= doc.lines;) {
    const k = kinds[i]

    if (k === 'quote' || k === 'code') {
      let j = i // a same-kind run = one box

      while (j + 1 <= doc.lines && kinds[j + 1] === k) {
        j++
      }
      // A callout quote run gets the per-type FILL too (not just the rail): give the
      // marker the shared `callout-<look>` class (it carries --callout-color) so the
      // fill tints by type, exactly like the reading view. The look comes from the
      // shared calloutRuns field — no re-detection here. The fill still lives in this
      // below-selection layer, so the opaque selection stays uniform over it.
      let cls = k === 'quote' ? 'cm-md-quote-fill' : 'cm-md-code-fill'

      if (k === 'quote' && looks[i]) {
        cls = `cm-md-callout-fill callout-${looks[i]}`
      }
      // `to` is the last line's END (not start): the viewport guard/clip below uses
      // it, so a long run scrolled to where only its tail is visible isn't dropped.
      runs.push({ cls, from: doc.line(i).from, to: doc.line(j).to })
      i = j + 1
    } else if (k === 'hr') {
      runs.push({ cls: 'cm-md-hr-rule', from: doc.line(i).from, to: doc.line(i).to })
      i++
    } else if (k === 'h2') {
      // The reader's h2 underline — a rule at the line's bottom, in the layer (a
      // box-shadow on the line would sit above the selection and tint it).
      runs.push({ cls: 'cm-md-h2-underline', from: doc.line(i).from, to: doc.line(i).to })
      i++
    } else {
      i++
    }
  }

  return runs
}

// The HR rule must sit on the dim `---` GLYPHS, not the line-box centre — the dash
// ink rides above the box centre (and by a font-dependent amount, so a fixed offset
// is wrong on a different font/OS). Measure the actual font: the offset from a line's
// text-box centre down to a hyphen's ink centre is `(fontBox − inkBox)/2`. Computed
// ONCE per markers pass (getComputedStyle + measureText force layout — don't repeat
// per HR line); coordsAtPos gives the box centre to add it to.
let measureCtx: CanvasRenderingContext2D | null = null

const dashInkOffset = (view: EditorView): number => {
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d')
  }
  if (!measureCtx) {
    return 0
  }
  const cs = getComputedStyle(view.contentDOM)
  measureCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  const m = measureCtx.measureText('-')
  return (
    (m.fontBoundingBoxAscent -
      m.fontBoundingBoxDescent -
      (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent)) /
    2
  )
}

// Layer coordinates are document-relative (scrollDOM origin minus scroll), matching
// how CM positions its own selection markers — so our rects line up with it.
const layerBase = (view: EditorView) => {
  const rect = view.scrollDOM.getBoundingClientRect()
  return {
    left: rect.left - view.scrollDOM.scrollLeft * view.scaleX,
    top: rect.top - view.scrollDOM.scrollTop * view.scaleY,
  }
}

const backdropMarkers = (view: EditorView): RectangleMarker[] => {
  const vp = view.viewport
  const base = layerBase(view)
  const content = view.contentDOM.getBoundingClientRect()
  const left = content.left - base.left
  const width = content.width
  const markers: RectangleMarker[] = []
  let dashOff: number | null = null // measured lazily, once, on the first HR

  for (const r of backdropRuns(view.state)) {
    if (r.to < vp.from || r.from > vp.to) {
      continue
    } // off-screen — clipped anyway
    if (r.cls === 'cm-md-hr-rule') {
      // On the dim `---` glyph ink centre (font-measured), not the line-box centre.
      const c = view.coordsAtPos(r.from)

      if (c) {
        if (dashOff === null) {
          dashOff = dashInkOffset(view)
        }
        markers.push(
          new RectangleMarker(r.cls, left, (c.top + c.bottom) / 2 + dashOff - base.top, width, 1),
        )
      }
      continue
    }
    if (r.cls === 'cm-md-h2-underline') {
      const blk = view.lineBlockAt(r.from)
      markers.push(
        new RectangleMarker(r.cls, left, view.documentTop + blk.bottom - base.top - 1, width, 1),
      )
      continue
    }
    // Full-line fill (quote/code). Clamp to the viewport so every measured line is
    // real (off-screen line blocks can be estimated); the overflow hides the edge.
    const a = view.lineBlockAt(Math.max(r.from, vp.from))
    const b = view.lineBlockAt(Math.min(r.to, vp.to))
    const top = view.documentTop + a.top - base.top
    markers.push(new RectangleMarker(r.cls, left, top, width, b.bottom - a.top))
  }
  // Inline code `pills`, drawn in this same below-selection layer (forRange hugs the
  // code text) — the bg used to be a token background in the content, above the
  // selection, so a selection over `code` was tinted by it.
  const tree = syntaxTree(view.state)

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (n) => {
        if (n.name === 'InlineCode') {
          for (const m of RectangleMarker.forRange(
            view,
            'cm-md-inlinecode',
            EditorSelection.range(n.from, n.to),
          )) {
            markers.push(m)
          }
        }
      },
    })
  }

  return markers
}

export const backdropLayer = Prec.lowest(
  layer({
    above: false, // below the content text…
    class: 'cm-md-backdrops',
    // Re-measure on doc/viewport/geometry changes AND when the syntax tree changes —
    // the inline-code pills read the tree, and lezer parses long notes off the main
    // thread, so a freshly-parsed `InlineCode` must repaint (matches inlineMarks).
    update: (u) =>
      u.docChanged ||
      u.viewportChanged ||
      u.geometryChanged ||
      syntaxTree(u.startState) !== syntaxTree(u.state),
    markers: backdropMarkers,
  }),
) // …and Prec.lowest sorts it below the selection layer too (see note above).
