import { hasNextSnippetField, hasPrevSnippetField } from '@codemirror/autocomplete'
import { type EditorState, StateField } from '@codemirror/state'
// Floating format bar (#119) — a Notion/Medium-style popover that appears ABOVE a
// non-empty selection with the inline + block format toggles, replacing the old
// top toolbar (`widgets/EditorToolbar`, removed) in both modes. It shares the
// editor's floating-UI foundation with the slash menu: both are positioned by CM6's
// native tooltip machinery (the slash menu via @codemirror/autocomplete, which is
// built on it; this bar via `showTooltip` directly), so there's ONE positioning
// mechanism, not a second ad-hoc one.
//
// Buttons reuse the SAME syntax-tree-aware commands as the keymap
// (`libs/markdown/markdownFormat`), so a click and a shortcut run the exact same
// toggle, and the active-state highlight reads the same `activeFormats`.
import { type EditorView, showTooltip, type Tooltip, type TooltipView } from '@codemirror/view'
import { activeFormats, commands } from '../../libs/markdown/markdownFormat'

// Cmd on macOS, Ctrl elsewhere — tooltip hint text only.
const MOD =
  typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform) ? '⌘' : 'Ctrl'

// Icon SVGs mirror core/Icons (the format glyphs) — inlined here as raw markup so
// the DOM-built bar stays in the CM layer without a React/CM lifecycle bridge. Keep
// in sync with core/Icons if those paths change (9 small glyphs, a conscious bit of
// duplication for a clean layer boundary).
const ICON: Record<string, string> = {
  bold: '<path d="M14 12a4 4 0 0 0 0-8H6v8" /><path d="M15 20a4 4 0 0 0 0-8H6v8z" />',
  italic: '<path d="M19 4h-9M14 20H5M15 4 9 20" />',
  strike:
    '<path d="M16 4H9a3 3 0 0 0-2.83 4" /><path d="M14 12a4 4 0 0 1 0 8H6" /><path d="M4 12h16" />',
  code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />',
  link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />',
  heading: '<path d="M6 12h12M6 20V4M18 20V4" />',
  bullet: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />',
  ordered: '<path d="M10 6h11M10 12h11M10 18h11" /><path d="M4 4h1v4M4 8h2" />',
  quote: '<path d="M6 5v14" /><path d="M11 7h7M11 12h7M11 17h7" />',
}

type Btn = { key: string; label: string; hint?: string }
// Groups in display order, split by a separator — same set/order as the old toolbar.
const GROUPS: Btn[][] = [
  [
    { key: 'bold', label: 'Bold', hint: `${MOD}+B` },
    { key: 'italic', label: 'Italic', hint: `${MOD}+I` },
    { key: 'strike', label: 'Strikethrough', hint: `${MOD}+Shift+X` },
    { key: 'code', label: 'Inline code', hint: `${MOD}+E` },
    { key: 'link', label: 'Link', hint: `${MOD}+K` },
  ],
  [
    { key: 'heading', label: 'Heading (cycle)' },
    { key: 'bullet', label: 'Bullet list' },
    { key: 'ordered', label: 'Numbered list' },
    { key: 'quote', label: 'Quote' },
  ],
]

const svg = (inner: string): string =>
  `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`

const buildBar = (view: EditorView): TooltipView => {
  const dom = document.createElement('div')
  // `cm-pop glass` = the app's shared glass-menu surface (CM also adds `cm-tooltip`);
  // styled in styles/editor-popovers.scss alongside the slash menu, so both popovers
  // match core/ContextMenu. `cm-md-formatbar` adds the button-row layout.
  dom.className = 'cm-md-formatbar cm-pop glass'
  dom.setAttribute('role', 'toolbar')
  dom.setAttribute('aria-label', 'Text formatting')
  const buttons: { key: string; el: HTMLButtonElement }[] = []
  GROUPS.forEach((group, gi) => {
    if (gi > 0) {
      const sep = document.createElement('span')
      sep.className = 'cm-md-formatbar-sep'
      sep.setAttribute('aria-hidden', 'true')
      dom.appendChild(sep)
    }
    for (const b of group) {
      const el = document.createElement('button')
      el.type = 'button'
      el.className = 'cm-md-formatbar-btn'
      el.title = b.hint ? `${b.label} (${b.hint})` : b.label
      el.setAttribute('aria-label', b.label)
      el.innerHTML = svg(ICON[b.key])
      // Don't let the button steal the selection (so the toggle has something to act
      // on); run on click.
      el.addEventListener('mousedown', (e) => e.preventDefault())
      el.addEventListener('click', () => commands[b.key]?.(view))
      dom.appendChild(el)
      buttons.push({ key: b.key, el })
    }
  })

  const refresh = (state: EditorState) => {
    const active = activeFormats(state)

    for (const b of buttons) {
      const on = active.has(b.key)
      b.el.classList.toggle('is-active', on)
      b.el.setAttribute('aria-pressed', String(on))
    }
  }
  refresh(view.state)

  return {
    dom,
    // Nudge clear of the line's text.
    offset: { x: 0, y: 6 },
    // Keep the active-state highlight live without rebuilding the bar (the field
    // below reuses this view while the selection start is unchanged).
    update: (u) => {
      if (u.docChanged || u.selectionSet) {
        refresh(u.state)
      }
    },
  }
}

// Anchor the bar at the selection START so it sits over the beginning of the marked
// text. `above: true` renders it above the line; CM flips it below at the top edge.
const makeTooltip = (pos: number): Tooltip => ({ pos, above: true, arrow: false, create: buildBar })

// The bar shows on a non-empty selection — UNLESS that selection is a snippet
// placeholder field (a `/`-command just inserted a snippet and pre-selected, say, a
// table header cell). Popping the format bar over a placeholder is noise: the user
// is about to type the field's value, not bold it. A snippet is active exactly when
// there's a prev/next field to Tab to.
const barVisible = (state: EditorState): boolean => {
  if (state.selection.main.empty) {
    return false
  }
  if (hasPrevSnippetField(state) || hasNextSnippetField(state)) {
    return false
  }

  return true
}

// A StateField → showTooltip: the bar shows iff the main selection is non-empty.
// It REUSES the existing tooltip object while the selection start is unchanged
// (covers drag-extend and shift-arrow, where the anchor stays put) so the popover
// doesn't flicker/rebuild on every selection tick — only a moved start rebuilds it.
const formatBarField = StateField.define<readonly Tooltip[]>({
  create: (state) => (barVisible(state) ? [makeTooltip(state.selection.main.from)] : []),
  update: (value, tr) => {
    if (!tr.docChanged && !tr.selection) {
      return value
    }
    if (!barVisible(tr.state)) {
      return value.length ? [] : value
    }
    const from = tr.state.selection.main.from

    if (value.length && value[0].pos === from) {
      return value
    } // reuse → no flicker

    return [makeTooltip(from)]
  },
  provide: (f) => showTooltip.computeN([f], (state) => state.field(f)),
})

/** The floating format bar extension for the editor. */
export const floatingFormatBar = formatBarField
