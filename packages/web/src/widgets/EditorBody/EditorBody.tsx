import { type EditorView } from '@codemirror/view'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CodeEditor, type EditorStatsReport } from '../../core/CodeEditor'
import { ContextMenu, type MenuItem } from '../../core/ContextMenu'
import { IconCrosshair, IconTypewriter } from '../../core/Icons'
import { IconToggle } from '../../core/IconToggle'
import { cx } from '../../libs/cx/cx'
import { textStats, type TextStats } from '../../libs/editorStats'
import { type EditorBinding } from '../../libs/hotkeys'
import { renderMarkdown } from '../../libs/markdown/markdown'
import { useMarkdownEnhance } from '../../libs/markdown/useMarkdownEnhance'
import styles from './EditorBody.module.scss'

// CM6 editing surface: raw markdown ('source') or styled WYSIWYM ('wysiwym').
// Driven by the global Source/WYSIWYM setting (mapped in DocumentLayout) — there
// is no in-editor toggle. Mirrors CodeEditor's mode without crossing the composer
// boundary from this widget.
export type EditorSurface = 'source' | 'wysiwym'
// Focus mode (#118), mirrored locally (not imported from ChromeProvider) to keep the
// widget decoupled from the composer layer, like EditorSurface above.
export type EditorFocus = 'off' | 'sentence' | 'line' | 'paragraph'

// Cmd on macOS, Ctrl elsewhere — toggle tooltips only.
const MOD =
  typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform) ? '⌘' : 'Ctrl'

// The editor's main column. Rendered as siblings of the page scroll area (not one
// `.doc`) so the status bar can span the full page width while the document stays in
// a centered 740px column:  body-col (centered) · status-bar (floats at the window
// bottom, full-bleed, absolute — see EditorBody.module.scss). Formatting is
// contextual (#119): a floating bar over the selection + the `/` slash menu, no top
// toolbar strip. There is NO separate title field since #156: the note's title is the
// document's leading `# H1`, authored inline in the body (styled large in WYSIWYM,
// literal in source) — one editing surface, which makes a future true-WYSIWYG (#120)
// possible. The bars show ONLY while editing; Preview is a clean rendered view with
// no editor chrome (the Edit/Preview toggle lives in the page topbar). Save/Cancel
// also live in the topbar. The binding is declared structurally (not imported from
// the EditingProvider composer) so this widget stays decoupled from above.
type EditorBodyBinding = {
  isNew: boolean
  content: string
  registerContent: (getValue: (() => string) | null) => void
  onContentChange: () => void
}

const fmt = (n: number) => n.toLocaleString()

// Order strongest→weakest with 'Off' last: the menu opens UPWARD from the status bar,
// so 'Off' lands at the bottom, nearest the trigger.
const FOCUS_OPTIONS: { value: EditorFocus; label: string }[] = [
  { value: 'paragraph', label: 'Paragraph' },
  { value: 'line', label: 'Line' },
  { value: 'sentence', label: 'Sentence' },
  { value: 'off', label: 'Off' },
]

// Focus control: a status-bar toggle that opens a granularity dropdown (#118 control
// moved out of Settings). Clicking picks Off / Sentence / Line / Paragraph; the chord
// (Mod+Shift+F) still quick-toggles on/off via CodeEditor. The menu opens UPWARD since
// the status bar floats at the window bottom.
const FocusControl = ({
  focus,
  onSetFocus,
}: {
  focus: EditorFocus
  onSetFocus: (m: EditorFocus) => void
}) => {
  const btnRef = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const toggleMenu = () =>
    setMenu((m) => {
      if (m) {
        return null
      }
      const r = btnRef.current!.getBoundingClientRect()
      return { x: r.left, y: r.top }
    })
  const items: MenuItem[] = FOCUS_OPTIONS.map((o) => ({
    label: o.label,
    radioGroup: 'Editor focus',
    active: focus === o.value,
    onClick: () => onSetFocus(o.value),
  }))
  return (
    <>
      <IconToggle
        ref={btnRef}
        className={styles.statToggle}
        icon={<IconCrosshair size={14} />}
        active={focus !== 'off'}
        onClick={toggleMenu}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        data-testid="toggle-focus"
        aria-label={focus !== 'off' ? `Focus mode: ${focus}` : 'Focus mode'}
        title={focus !== 'off' ? `Focus: ${focus}` : 'Focus mode'}
      />
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          placement="up"
          ignoreRef={btnRef}
          items={items}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  )
}

export const EditorBody = ({
  editor,
  preview,
  mode,
  focus,
  typewriter,
  onSetFocus,
  onToggleFocus,
  onToggleTypewriter,
  editorKeys,
}: {
  editor: EditorBodyBinding
  preview: boolean
  mode: EditorSurface
  focus: EditorFocus
  typewriter: boolean
  /** Pick a focus granularity (or 'off') — the status-bar Focus dropdown. */
  onSetFocus: (m: EditorFocus) => void
  /** Quick on/off toggles for the hotkeys (Mod+Shift+F/Y), passed to CodeEditor. */
  onToggleFocus: () => void
  onToggleTypewriter: () => void
  /** Active editor keymap (#30), passed down from the layout so editor shortcuts —
   *  formatting + the focus/typewriter toggles — follow the user's preset/overrides. */
  editorKeys?: EditorBinding[]
}) => {
  const viewRef = useRef<EditorView | null>(null)
  const [stats, setStats] = useState<EditorStatsReport>(() => ({
    doc: textStats(editor.content),
    selection: null,
  }))

  // Capture the live document getter alongside handing it to the draft state, so
  // Preview can read the IN-MEMORY body (not the start-of-edit snapshot) without
  // a save. The editor stays mounted while previewing (hidden), so this getter
  // remains valid — preview is a read of live state, never a remount.
  const liveGet = useRef<(() => string) | null>(null)
  // Stable identity (CodeEditor captures onReady once on mount; a fresh closure on
  // every per-caret re-render would just be churn). The draft's registerContent is
  // re-created each render, so reach it through a ref rather than a dep.
  const editorRegister = useRef(editor.registerContent)
  editorRegister.current = editor.registerContent
  const registerContent = useCallback((fn: (() => string) | null) => {
    liveGet.current = fn
    editorRegister.current(fn)
  }, [])

  // Snapshot the live body when Preview turns on. The editor is hidden (not
  // unmounted) so the body can't change while previewing — a snapshot is enough.
  // useLayoutEffect (not useEffect) so the freeze lands before paint: no flash of
  // a stale render between the toggle and the snapshot.
  const [previewSrc, setPreviewSrc] = useState('')
  useLayoutEffect(() => {
    if (preview) {
      setPreviewSrc(liveGet.current?.() ?? editor.content)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview])
  // Only render when previewing — avoids a wasted marked+DOMPurify pass on every
  // edit-session open (previewSrc starts '').
  const previewHtml = useMemo(
    () => (preview ? renderMarkdown(previewSrc) : ''),
    [preview, previewSrc],
  )
  // Preview is the same rendered view as the reader (editor.md invariant), so it gets
  // the same post-render enhancements: copy buttons, table fades, mermaid diagrams
  // (#236). The ref is on the conditionally-mounted preview div — null while editing,
  // so the hook no-ops until Preview is on.
  const previewRef = useRef<HTMLDivElement>(null)
  useMarkdownEnhance(previewRef, previewHtml)

  // Returning Preview→Edit: the editor was display:none (CM6 skipped layout and
  // focus sat on the topbar toggle), so re-measure and refocus it. Guarded to the
  // transition so it only fires on Preview→Edit, not on a fresh edit-session open
  // (mount already focuses the editor, with the caret placed by `cursor`).
  const wasPreview = useRef(preview)
  useEffect(() => {
    if (wasPreview.current && !preview) {
      viewRef.current?.requestMeasure()
      viewRef.current?.focus()
    }
    wasPreview.current = preview
  }, [preview])

  // The status bar is selection-aware: count the selection when one exists, the
  // whole doc otherwise (iA Writer / Obsidian pattern).
  const selectionActive = !!stats.selection
  const shown: TextStats = stats.selection ?? stats.doc

  return (
    <>
      <div className={styles.bodyCol} data-testid="editor-body-column">
        <div className={styles.editorBody}>
          {/* The editor stays mounted in Preview (display:none), so its text, undo
              history and cursor all survive the round-trip — only the live getter
              it registered is read to render the preview. */}
          <div style={preview ? { display: 'none' } : undefined}>
            <CodeEditor
              value={editor.content}
              mode={mode}
              focus={focus}
              typewriter={typewriter}
              // A new note opens on its title line ('# '); land the caret after it
              // so the first keystroke types the title (#156).
              cursor={editor.isNew ? 'end' : 'start'}
              onReady={registerContent}
              onChange={editor.onContentChange}
              onView={(view) => (viewRef.current = view)}
              onStats={setStats}
              onToggleFocus={onToggleFocus}
              onToggleTypewriter={onToggleTypewriter}
              editorKeys={editorKeys}
            />
          </div>
          {preview && (
            <div
              ref={previewRef}
              className="markdown"
              data-testid="editor-preview"
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          )}
        </div>
      </div>

      {!preview && (
        <div
          className={cx(styles.statusBar, 'glass', 'glass-edge-top')}
          data-testid="editor-statusbar"
        >
          <div className={styles.barInner}>
            {/* Writing-aid toggles (#118) — discoverable companions to the hotkeys.
                Focus's active title names the granularity (set in Settings); the
                toggle itself just flips on/off. */}
            <div className={styles.barControls}>
              <FocusControl focus={focus} onSetFocus={onSetFocus} />
              <IconToggle
                className={styles.statToggle}
                icon={<IconTypewriter size={14} />}
                active={typewriter}
                onClick={onToggleTypewriter}
                data-testid="toggle-typewriter"
                aria-label="Typewriter mode"
                title={`Typewriter mode (${MOD}+Shift+Y)`}
              />
            </div>
            <div className={styles.stats}>
              {selectionActive && <span className={styles.statTag}>Selection</span>}
              <span>
                {fmt(shown.words)} {shown.words === 1 ? 'word' : 'words'}
              </span>
              <span className={styles.dot} aria-hidden="true">
                ·
              </span>
              <span>
                {fmt(shown.chars)} {shown.chars === 1 ? 'char' : 'chars'}
              </span>
              {/* Reading time is a whole-document figure — drop it for a selection
                  (a stray minute-count for a few words) and for an empty body (no
                  "0 min read" noise). */}
              {!selectionActive && shown.words > 0 && (
                <>
                  <span className={styles.dot} aria-hidden="true">
                    ·
                  </span>
                  <span>{shown.minutes} min read</span>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
