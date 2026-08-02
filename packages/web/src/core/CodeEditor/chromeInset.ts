// Chrome-inset scroll (#231) — keep the caret line clear of the floating chrome bars.
//
// THE SEAM (same as typewriter): CodeMirror does NOT own the scroll container here. The
// page scroller (`.content-scroll` in PageFrame, `overflow-y:auto`) is an ANCESTOR, and
// two frosted-glass bars overlap its edges — the topbar (`--chrome-h`) at the top and the
// editor status bar (`--editor-statusbar-h`) at the bottom. CM's caret-into-view only
// scrolls the caret to the RAW scroller edges, so it tucks behind whichever bar it
// reaches: typing at the very end slides under the status bar (the reported bug), and
// Ctrl+Home / arrow-up to the first line slides under the topbar (the symmetric one).
//
// WHY NOT `EditorView.scrollMargins`: that facet would reserve both bands in one clean
// pass — but CM ALSO uses it to shrink the box it checks a tooltip's anchor against
// (`visible = scrollDOM.rect − scrollMargins`), and `.cm-scroller` ends at the last text
// line (the scroll-past-end space lives on `.body-col`, outside it). A margin taller than
// a line then drops that box past the caret on the first/last line and CM hides the
// slash / autocomplete / floating-format tooltip off-screen (`top:-10000`). So we scroll
// the ancestor DIRECTLY instead — exactly like typewriter — which leaves tooltip geometry
// untouched, and fixes BOTH bands with no per-surface padding tricks.
//
// Orthogonal to typewriter (a centered caret already sits between the bands, so this
// no-ops) and to focus. Movement-agnostic: edits, arrows (including between wrapped rows
// of one paragraph), paste and clicks all re-check via the same caret-move path.
import { type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

const px = (v: string) => parseFloat(v) || 0
const readVar = (name: string) =>
  px(getComputedStyle(document.documentElement).getPropertyValue(name))

// A little breathing room so the caret line rests just off the glass, not flush against
// its edge (matches the small default air CM leaves around a scrolled caret).
const GAP = 6

// The nearest scrollable ancestor — the page scroller. Matched by a scrollable overflow-y
// (not scrollHeight>clientHeight, which is false before the content grows). Same walk as
// typewriter's; cheap enough (a short climb up the DOM).
const scrollParent = (el: HTMLElement | null): HTMLElement | null => {
  for (let n = el?.parentElement; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY

    if (oy === 'auto' || oy === 'scroll') {
      return n
    }
  }

  return null
}

// If the caret sits inside the top or bottom chrome band of the page scroller, nudge the
// scroller so it clears the bar. The two bands can't both catch the caret (it's one line),
// so at most one branch fires; a 1px deadzone keeps a settled caret from churning. Reads
// layout then writes scrollTop in one go, inside a rAF so rapid edits coalesce.
const clearChrome = (view: EditorView): void => {
  const coords = view.coordsAtPos(view.state.selection.main.head)

  if (!coords) {
    return
  } // editor hidden (Preview) or position not laid out yet
  const scroller = scrollParent(view.dom)

  if (!scroller) {
    return
  }
  const sRect = scroller.getBoundingClientRect()
  const bandTop = sRect.top + readVar('--chrome-h') + GAP
  const bandBottom = sRect.bottom - readVar('--editor-statusbar-h') - GAP

  if (bandBottom <= bandTop) {
    return
  } // viewport too short for both bands to fit — don't fight
  if (coords.top < bandTop - 1) {
    scroller.scrollTop += coords.top - bandTop
  } else if (coords.bottom > bandBottom + 1) {
    scroller.scrollTop += coords.bottom - bandBottom
  }
}

/** Always-on writing aid (#231): after an EDIT or a CARET MOVE, scroll the ancestor to
 *  keep the caret clear of the chrome bars. Deliberately reacts ONLY to docChanged /
 *  selectionSet — never to geometry or scroll. This plugin's contract is "keep the caret
 *  YOU just moved visible," not "always pin the caret into the band": re-asserting on a
 *  geometry/scroll change would fight the user, because CM emits geometryChanged during a
 *  plain wheel/trackpad scroll of a wrapped note (height-map corrections as new rows are
 *  measured) — the plugin would then rubber-band the page back, refusing to let the caret
 *  line scroll away while reading. So geometry-only shifts (resize, aside open/close,
 *  Source↔WYSIWYM) re-clear on the next caret move, not instantly — a conscious trade to
 *  never hijack the user's own scroll. */
export const chromeInsetScroll = ViewPlugin.fromClass(
  class {
    raf = 0
    view: EditorView
    constructor(view: EditorView) {
      this.view = view
      this.schedule() // clear once on mount (a note may open with the caret at the edge)
    }
    update(u: ViewUpdate) {
      // Every caret move re-checks the band — NOT gated on the logical-line number the way
      // typewriter is: with lineWrapping on, a paragraph is one logical line spanning many
      // visual rows, so gating on the line number would miss an Arrow-down/up between
      // wrapped rows and leave the caret behind a bar. Reacting to every selectionSet is
      // safe here because clearChrome no-ops when the caret is already inside the band (a
      // horizontal / same-row sweep just re-reads the same coords → no scroll), so there's
      // no churn to dedupe against — unlike typewriter, which re-centers on every move.
      if (!u.docChanged && !u.selectionSet) {
        return
      }
      this.schedule()
    }
    schedule() {
      if (this.raf) {
        return
      }
      this.raf = requestAnimationFrame(() => {
        this.raf = 0
        clearChrome(this.view)
      })
    }
    destroy() {
      if (this.raf) {
        cancelAnimationFrame(this.raf)
      }
    }
  },
)
