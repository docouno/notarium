// Typewriter mode (#118) — keep the caret line vertically centered, the document
// scrolling under a fixed caret (iA Writer / Typora). Orthogonal to focus mode and
// to the Source/WYSIWYM surface; a personal writing aid toggled in Settings / by
// hotkey, layered over any editing mode.
//
// THE SEAM: in this app CodeMirror does NOT own the scroll container. `.cm-host` has
// `min-height` but no max-height and `.cm-editor` is `height:100%`, so the editor
// grows to fit its content and the PAGE scroller (`.content-scroll` in PageFrame,
// `overflow-y:auto`) is what actually scrolls. So typewriter centering can't lean on
// `view.scrollDOM` (it never overflows) — it must scroll the nearest scrollable
// ANCESTOR. We find it once per centering and set its `scrollTop` directly, which is
// also more reliable than CM's `scrollIntoView({y:'center'})` heuristic across the
// floating topbar + status bar that overlap the band.
//
// Edge lines need room to reach the center: a tall top/bottom padding on `.cm-content`
// (added only while typewriter is on) gives the first/last lines somewhere to scroll.
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

// Padding that lets the first and last lines scroll to the vertical center. ~42vh
// each side ≈ half the viewport, so even line 1 / the last line can sit mid-screen.
const EDGE_PAD = '42vh'

const typewriterTheme = EditorView.theme({
  '.cm-content': { paddingTop: EDGE_PAD, paddingBottom: EDGE_PAD },
})

// The nearest scrollable ancestor of the editor — the page scroller. Matched by a
// scrollable overflow-y (not by scrollHeight>clientHeight, which is false before the
// content grows). Cached per call; cheap enough (a short walk up the DOM).
const scrollParent = (el: HTMLElement | null): HTMLElement | null => {
  for (let n = el?.parentElement; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY

    if (oy === 'auto' || oy === 'scroll') {
      return n
    }
  }

  return null
}

const px = (v: string) => parseFloat(v) || 0

// Scroll the page so the caret line sits at the center of the VISIBLE writing band —
// the area between the floating topbar (--chrome-h, which overlaps the top of the
// scroller) and the floating status bar (measured live). Reads layout then writes
// scrollTop in one go; called inside a rAF so rapid updates coalesce.
const center = (view: EditorView): void => {
  const head = view.state.selection.main.head
  const coords = view.coordsAtPos(head)

  if (!coords) {
    return
  } // editor hidden (Preview) or position not laid out yet
  const scroller = scrollParent(view.dom)

  if (!scroller) {
    return
  }
  const sRect = scroller.getBoundingClientRect()
  const topInset = px(getComputedStyle(document.documentElement).getPropertyValue('--chrome-h'))
  const statusBar = scroller.querySelector<HTMLElement>('[data-testid="editor-statusbar"]')
  const bottomInset = statusBar ? statusBar.offsetHeight : 0
  const bandCenter = sRect.top + topInset + (sRect.height - topInset - bottomInset) / 2
  const caretCenter = (coords.top + coords.bottom) / 2
  const delta = caretCenter - bandCenter

  if (Math.abs(delta) > 1) {
    scroller.scrollTop += delta
  }
}

/** Typewriter extension: recenters the caret on edits, caret-line changes and
 *  geometry changes. Plugged into a Compartment in CodeEditor for live on/off. */
export const typewriterExtension = [
  typewriterTheme,
  ViewPlugin.fromClass(
    class {
      // Recenter only when the caret moves to a DIFFERENT line (or on an edit), not on
      // every horizontal move or selection tick — that's what keeps a drag-select or
      // a left/right sweep from juddering the page (the iA jitter caveat). A same-line
      // edit still recenters but its delta is ~0, so it's a no-op scroll.
      lastLine = -1
      raf = 0
      view: EditorView
      constructor(view: EditorView) {
        this.view = view
        this.schedule() // center once on enable (the compartment just installed us)
      }
      update(u: ViewUpdate) {
        // Recenter on edits, caret-LINE changes, AND geometry changes. The last one
        // matters because the caret's PIXEL position can move with no doc/selection
        // change: a window resize, the right aside opening/closing (editor width →
        // prose re-wraps), or a Source↔WYSIWYM switch (mono↔sans + heading sizes shift
        // every line height). Deliberately NOT `viewportChanged` — our own scrollTop
        // write fires that, so re-centering on it would be a feedback loop.
        if (!u.docChanged && !u.selectionSet && !u.geometryChanged) {
          return
        }
        const line = u.state.doc.lineAt(u.state.selection.main.head).number

        if (u.docChanged || u.geometryChanged || line !== this.lastLine) {
          this.lastLine = line
          this.schedule()
        }
      }
      schedule() {
        if (this.raf) {
          return
        }
        this.raf = requestAnimationFrame(() => {
          this.raf = 0
          center(this.view)
        })
      }
      destroy() {
        if (this.raf) {
          cancelAnimationFrame(this.raf)
        }
      }
    },
  ),
]
