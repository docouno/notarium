import { deleteMarkupBackward, insertNewlineContinueMarkupCommand } from '@codemirror/lang-markdown'
import { HighlightStyle } from '@codemirror/language'
import { selectNextOccurrence } from '@codemirror/search'
import { type Command, EditorView, type KeyBinding } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { commands } from '../../../libs/markdown/markdownFormat'
import { codeTokenStyles } from '../codeHighlight'

// Markdown-mode ("source") highlight — full syntax highlighting of the raw markdown,
// like opening an .md in VS Code: the whole source is coloured by the active Code-
// theme preset (#178), so the markdown MARKUP and the fenced code share one themed
// palette instead of the markup using brand `--accent`/`--accent-2` (which read as
// app chrome, not syntax highlighting). Both the markdown-structural roles below and
// the code-content roles (spread from `codeTokenStyles`) route at the same `--hl-*`
// tokens that styles/code-themes.scss defines per preset for the reading view — so a
// preset flip recolours the editor AND the preview. The markdown-token → role mapping
// mirrors how highlight.js paints a ```markdown block (section/link/quote/bullet), so
// the editor's source view matches a rendered markdown code block. No tag overlap:
// markdown structure vs code content.
export const mdHighlight = HighlightStyle.define([
  { tag: t.heading, color: 'var(--hl-keyword)', fontWeight: '600' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: 'var(--hl-symbol)' },
  { tag: t.monospace, color: 'var(--hl-string)' },
  { tag: t.quote, color: 'var(--hl-comment)', fontStyle: 'italic' },
  { tag: t.list, color: 'var(--hl-symbol)' },
  // The literal markdown markers (# ** _ ~~ > ` and list bullets) read as punctuation,
  // so dim them at the comment role (theme-tracked) rather than the app's --text-dim.
  { tag: t.processingInstruction, color: 'var(--hl-comment)' },
  ...codeTokenStyles,
])

export const theme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--text)', height: '100%' },
  '.cm-content': {
    fontFamily: 'var(--font-mono)',
    // Source honours the Reading size knob 1:1 (#27) — same base as the reader and
    // WYSIWYM, so one size governs every surface (the old fixed 14.5px is gone). The
    // font stays --font-mono (Source is raw code). WYSIWYM additionally swaps the
    // family to the reading font (wysiwym-source.scss).
    fontSize: 'var(--reading-size)',
    lineHeight: '1.7',
    // No tall bottom padding here: the scroll-past-end space is owned by the page
    // scroller (.body-col has a large bottom padding), and the editor host has its own
    // min-height. Keeping the caret clear of the floating chrome bars is done by
    // scrolling the ancestor (chromeInsetScroll, #231), not by padding this element.
    padding: '4px 0',
    caretColor: 'var(--text)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-gutters': { display: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--cm-active)' },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
  // drawSelection() ships a baseTheme whose selection color (#d7d4f0) has a more
  // specific selector than a plain class rule, so override with !important — and
  // drive it from the CSS var so it tracks the light/dark theme toggle.
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--cm-selection) !important',
  },
})

// Editor-context action id → the CodeMirror command it runs. The KEYS come from the
// resolved keymap (#30) — this is the single place editor commands bind to keys, fed
// by the user's preset/overrides, so there's no second hardcoded list to drift from.
// Focus/typewriter (#118) are bound the same way but their commands need the host
// toggle handlers, so they're added in-component (see buildToggleKeymap) — not here.
export const EDITOR_COMMANDS: Record<string, Command> = {
  'format.bold': commands.bold,
  'format.italic': commands.italic,
  'format.code': commands.code,
  'format.link': commands.link,
  'format.strike': commands.strike,
  'editor.multicursor': selectNextOccurrence,
}

// #205: Enter continues markdown lists/quotes in BOTH Source and WYSIWYM — one shared
// command, since the mode only decorates the same raw markdown. This is the native
// @codemirror/lang-markdown command; `nonTightLists: false` is the one config that gives
// Notarium's product contract on an EMPTY item. Instead of the CM default (keep the
// marker, open a non-tight blank gap) it:
//   - exits an empty item by deleting its marker — cursor drops to the now-empty line,
//     no blank gap (`- a\n- |` -> `- a\n|`);
//   - ladders an empty NESTED item (one under a parent list item) out one level per
//     Enter: `- a` / `  - |` -> `- a` / `- |` -> exit, renumbering ordered lists on the
//     way. A lone indented item with no parent just exits, it does not de-indent.
// Task items are native too: a checkbox counts as part of the marker, so `- [ ] item`
// continues as an unchecked `- [ ] `, and an empty `- [ ] ` exits like any other item.
// The command returns false outside list/quote context (plain prose, fenced code), so it
// must sit ABOVE defaultKeymap (whose Enter then inserts a normal newline there) and
// never replace it. Installed explicitly — markdown()'s addKeymap is off — so its order
// relative to the slash-menu and defaultKeymap is controlled here, not implicit.
const continueMarkdownMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false })
export const markdownContinuationKeymap: readonly KeyBinding[] = [
  { key: 'Enter', run: continueMarkdownMarkup },
  { key: 'Backspace', run: deleteMarkupBackward },
]
