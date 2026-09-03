import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { Compartment, EditorState, Prec } from '@codemirror/state'
import {
  crosshairCursor,
  drawSelection,
  EditorView,
  highlightActiveLine,
  type KeyBinding,
  keymap,
  rectangularSelection,
  type ViewUpdate,
} from '@codemirror/view'
import { useEffect, useRef } from 'react'
import { cx } from '../../../libs/cx/cx'
import { textStats, type TextStats } from '../../../libs/editorStats'
import { type EditorBinding } from '../../../libs/hotkeys'
import { chromeInsetScroll } from '../chromeInset'
import { floatingFormatBar } from '../floatingFormatBar'
import { crossPlatformHistoryKeymap } from '../historyKeymap'
import { slashCommands, slashKeymap } from '../slashCommands'
import { markdownContinuationKeymap, theme } from './consts'
import { focusExtension, modeExtension, typewriterExt } from './helpers/extensions'
import { buildFormatKeymap, buildToggleKeymap, DEFAULT_FORMAT_KEYMAP } from './helpers/keymap'
import { type EditorStatsReport, type Focus } from './types'

export type { EditorStatsReport } from './types'

type CodeEditorProps = {
  value?: string
  /** Editing surface: raw markdown ('source') or styled WYSIWYM ('wysiwym'). */
  mode?: 'source' | 'wysiwym'
  /** Focus mode (#118): dim everything but the active sentence/line/paragraph, or
   *  'off'. Orthogonal to `mode`. */
  focus?: Focus
  /** Typewriter mode (#118): keep the caret line vertically centered. */
  typewriter?: boolean
  /** Live document getter: registered on mount, revoked (null) on unmount so
   *  a consumer never reads a destroyed editor's state. */
  onReady?: (getValue: (() => string) | null) => void
  onChange?: () => void
  onView?: (view: EditorView | null) => void
  /** Geometry/source observer for the owning document bridge. It never moves
   * scroll itself and is notified only from CodeMirror's existing update seam. */
  onUpdate?: (view: EditorView, update: ViewUpdate) => void
  /** Word/char/reading-time metrics for the status bar, recomputed on edits and
   *  selection changes. */
  onStats?: (stats: EditorStatsReport) => void
  /** Hotkey hooks: the in-editor keymap flips these global writing-aid toggles
   *  (focus / typewriter, #118). Reached through a ref so the mount-built keymap always
   *  calls the latest handler. The chords come from the resolved keymap (#30). */
  onToggleFocus?: () => void
  onToggleTypewriter?: () => void
  /** Where to drop the caret on mount. 'start' (default) sits at the top of the
   *  document; 'end' lands after the seeded text — used for a NEW note (#156), whose
   *  document opens on its title line (`# `), so the user types the title straight
   *  away instead of clicking past the heading marker. */
  cursor?: 'start' | 'end' | number
  /** Resolved editor-context bindings (#30) — the host passes the active keymap so
   *  formatting + writing-aid toggles follow the user's preset/overrides. Read once at
   *  mount (the editor remounts per draft); omit to use the web-native defaults. */
  editorKeys?: EditorBinding[]
  /** Focus the editing surface on mount. Forms that have earlier required fields
   *  can opt out and let their own initial control keep focus. */
  autoFocus?: boolean
}

export const CodeEditor = ({
  value,
  mode = 'source',
  focus = 'off',
  typewriter = false,
  onReady,
  onChange,
  onView,
  onUpdate,
  onStats,
  onToggleFocus,
  onToggleTypewriter,
  cursor = 'start',
  editorKeys,
  autoFocus = true,
}: CodeEditorProps) => {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Keep the latest callbacks without re-creating the editor on every render.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onStatsRef = useRef(onStats)
  onStatsRef.current = onStats
  const onUpdateRef = useRef(onUpdate)
  onUpdateRef.current = onUpdate
  // Latest hotkey handlers, read by the mount-built keymap (which captures once).
  const toggleRef = useRef({ onToggleFocus, onToggleTypewriter })
  toggleRef.current = { onToggleFocus, onToggleTypewriter }
  // Compartment for the mode-specific extension — stable across renders so the
  // [mode] effect can reconfigure it without rebuilding the editor.
  const liveCompartment = useRef(new Compartment()).current
  // Focus/typewriter (#118) each get a compartment too — toggled live, independent
  // of the mode, so undo/cursor survive an on/off.
  const focusCompartment = useRef(new Compartment()).current
  const typewriterCompartment = useRef(new Compartment()).current
  const modeRef = useRef(mode)
  modeRef.current = mode
  const focusRef = useRef(focus)
  focusRef.current = focus
  const typewriterRef = useRef(typewriter)
  typewriterRef.current = typewriter
  // Read once at mount (the view is built once); a binding change applies on the next
  // editor open. The editor remounts per draft, and editor bindings are only changed
  // from Settings (not while editing), so this is always fresh in practice. Formatting +
  // multi-cursor (static commands) + the focus/typewriter toggles (host handlers) — all
  // keyed from the resolved map (#30), so there's no hardcoded chord here.
  const formatKeymapRef = useRef<KeyBinding[]>([
    ...(editorKeys ? buildFormatKeymap(editorKeys) : DEFAULT_FORMAT_KEYMAP),
    ...buildToggleKeymap(editorKeys ?? [], toggleRef),
  ])

  useEffect(() => {
    // Document metrics are O(n) over the body, so recompute them only when the
    // text actually changes (cached here) and refresh just the cheap selection
    // slice on a plain caret/selection move — a cursor sweep over a long note
    // must not re-scan the whole document each tick.
    // Seeded cheaply: the mount call below is emitStats(_, docChanged=true), which
    // recomputes lastDoc before any consumer reads it — so a textStats() here would
    // just be a discarded second O(n) scan of the same body.
    let lastDoc: TextStats = { words: 0, chars: 0, minutes: 0 }

    const emitStats = (state: EditorView['state'], docChanged: boolean) => {
      if (!onStatsRef.current) {
        return
      }
      if (docChanged) {
        lastDoc = textStats(state.doc.toString())
      }
      // Join multiple ranges (Alt-drag column / Mod-D multi-cursor) with a newline
      // so boundary tokens aren't fused into one word by the count.
      const parts: string[] = []

      for (const r of state.selection.ranges) {
        if (!r.empty) {
          parts.push(state.sliceDoc(r.from, r.to))
        }
      }
      const selected = parts.join('\n')
      onStatsRef.current({ doc: lastDoc, selection: selected ? textStats(selected) : null })
    }

    const view = new EditorView({
      parent: host.current ?? undefined,
      state: EditorState.create({
        doc: value || '',
        selection:
          cursor === 'end'
            ? { anchor: (value || '').length }
            : typeof cursor === 'number'
              ? { anchor: Math.max(0, Math.min((value || '').length, cursor)) }
              : undefined,
        extensions: [
          history(),
          // Multiple selections: allow the state to hold them, draw the extra
          // carets (the native caret only renders one), and enable Alt-drag
          // column selection. Mod-D selects the word / next occurrence (VSCode-
          // style). The formatting commands already operate over every range.
          EditorState.allowMultipleSelections.of(true),
          drawSelection(),
          rectangularSelection(),
          crosshairCursor(),
          // Slash-menu navigation and markdown Enter/Backspace must run in the high
          // precedence bucket so neither defaultKeymap nor any language keymap steals
          // Enter first. Order within the bucket matters: slash-menu bindings come before
          // the markdown ones, so an open completion popup owns Enter; when it's closed
          // they no-op and markdown list continuation gets its turn.
          Prec.high(keymap.of([...slashKeymap, ...markdownContinuationKeymap])),
          // Format shortcuts (Mod-b etc.) before the defaults so they win. Snippet
          // field nav (Tab) self-installs on first use.
          keymap.of([
            // Formatting + multi-cursor, built from the resolved keymap (#30) so they
            // follow the user's preset/overrides. Before the defaults so they win.
            // formatKeymapRef holds multi-cursor (#30) and the focus/typewriter toggles
            // (#118) too — all keyed from the resolved map, so no hardcoded chord here.
            ...formatKeymapRef.current,
            // Cross-platform undo/redo (#187) BEFORE the stock historyKeymap so the
            // redo reflex (Mod-Shift-z / Mod-y) wins on every platform, not just the
            // ones CM happens to bind it on. The stock map still adds selection history.
            ...crossPlatformHistoryKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          // markdownLanguage = GFM (strikethrough, task lists, tables). The keymap is
          // installed above with Notarium's empty-list-item behavior; this extension
          // still owns parsing, fenced-code languages and paste-URL-as-link.
          // codeLanguages (#178): nested-parse fenced code by its info-string
          // language so the body tokenizes (keyword/string/comment/…) instead of
          // staying one flat blob. `languages` is the curated @codemirror/language-
          // data index — each parser is loaded lazily (a code-split chunk) the first
          // time a fence of that language appears, so the initial bundle is unchanged.
          // This single config feeds BOTH modes (it sits outside the mode compartment);
          // each mode's HighlightStyle then paints the tokens via the `--hl-*` bridge.
          markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false }),
          // Mode-specific highlight/decorations (#116), swapped via the compartment.
          // Seeded with the mount-time mode; the [mode] effect below swaps it live.
          liveCompartment.of(modeExtension(modeRef.current)),
          // Focus + typewriter writing aids (#118), each in its own compartment so a
          // toggle reconfigures live. Seeded at mount; the effects below swap them.
          focusCompartment.of(focusExtension(focusRef.current)),
          typewriterCompartment.of(typewriterExt(typewriterRef.current)),
          // Slash-command menu + floating format bar (#119) — both sit OUTSIDE the
          // mode compartment so they work in source AND wysiwym. CM renders them as
          // `position:fixed` tooltips inside the editor; no `tooltips({parent})` —
          // the editor has no transform/filter/contain ancestor, so fixed already
          // escapes the scroll container's clipping, and a custom parent would add a
          // full-viewport-tall host element to <body> (a phantom empty page below).
          slashCommands,
          floatingFormatBar,
          highlightActiveLine(),
          EditorView.lineWrapping,
          // Keep the caret line clear of the floating topbar + status bar by nudging the
          // ancestor page scroller (#231) — not via scrollMargins, which would clip the
          // slash/format tooltips at the first/last line (see chromeInset.ts).
          chromeInsetScroll,
          EditorView.updateListener.of((u) => {
            onUpdateRef.current?.(u.view, u)
            if (u.docChanged) {
              onChangeRef.current?.()
            }
            // Refresh the status-bar metrics (selection-aware) on edits and selection
            // moves. (Active-format highlighting now lives in the floating bar, which
            // reads activeFormats itself — no React round-trip.)
            if (u.docChanged || u.selectionSet) {
              emitStats(u.state, u.docChanged)
            }
          }),
          theme,
        ],
      }),
    })
    viewRef.current = view
    onReady?.(() => view.state.doc.toString())
    onView?.(view)
    emitStats(view.state, true)
    if (autoFocus) {
      view.focus()
    }

    return () => {
      onReady?.(null)
      onView?.(null)
      view.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Swap the mode extension when the mode prop changes — reconfigure the
  // compartment in place rather than remounting, so undo/cursor/selection live on
  // through the toggle. Skips the first run (the mount already seeded the right
  // extension); only real mode changes dispatch.
  const seededMode = useRef(mode)
  useEffect(() => {
    if (seededMode.current === mode) {
      return
    }
    seededMode.current = mode
    const view = viewRef.current

    if (!view) {
      return
    }
    view.dispatch({ effects: liveCompartment.reconfigure(modeExtension(mode)) })
    // The `--wysiwym` class also swaps the content font (mono ↔ sans) and the
    // highlight changes heading sizes; CM6 caches line geometry, so force a
    // re-measure or the first post-switch layout reads stale character metrics.
    view.requestMeasure()
  }, [mode, liveCompartment])

  // Focus mode: reconfigure live when it toggles or changes granularity. No remount,
  // so caret/undo survive — turning focus on mid-edit just dims around the caret.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: focusCompartment.reconfigure(focusExtension(focus)) })
  }, [focus, focusCompartment])

  // Typewriter mode: reconfigure live. Enabling installs the plugin, whose
  // constructor centers the caret at once; disabling drops the edge padding back.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: typewriterCompartment.reconfigure(typewriterExt(typewriter)),
    })
  }, [typewriter, typewriterCompartment])

  // The `--wysiwym` class switches the editor's base typography to a prose feel and
  // scopes the block-backdrop styles (styles/wysiwym-source.scss).
  return <div className={cx('cm-host', mode === 'wysiwym' && 'cm-host--wysiwym')} ref={host} />
}
