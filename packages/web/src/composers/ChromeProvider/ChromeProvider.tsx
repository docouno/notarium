import { createContext, type ReactNode, useContext, useEffect, useState } from 'react'

import { themeColor } from '../../libs/pwa'
import { STORAGE_KEYS } from '../../libs/storageKeys'

// App chrome: cross-cutting UI state that isn't domain data — theme, the two
// collapsible panels, and the one-shot graph focus handoff. Persisted bits keep
// their historical localStorage keys so existing users don't lose preferences.

export type Theme = 'light' | 'dark'

// Code syntax-highlighting preset (#115). Orthogonal to `theme`: each preset
// ships a light AND a dark variant (styles/code-themes.scss), the active one
// picked by `data-theme`. Stored like the theme — localStorage cache now, the
// user_preferences server sync later (#28 step 2).
export type CodeTheme =
  | 'github'
  | 'atom-one'
  | 'nord'
  | 'solarized'
  | 'dracula'
  | 'monokai'
  | 'gruvbox'
  | 'tokyo-night'
  | 'catppuccin'
export const CODE_THEMES: { value: CodeTheme; label: string }[] = [
  { value: 'github', label: 'GitHub' },
  { value: 'atom-one', label: 'Atom One' },
  { value: 'nord', label: 'Nord' },
  { value: 'solarized', label: 'Solarized' },
  { value: 'dracula', label: 'Dracula' },
  { value: 'monokai', label: 'Monokai' },
  { value: 'gruvbox', label: 'Gruvbox' },
  { value: 'tokyo-night', label: 'Tokyo Night' },
  { value: 'catppuccin', label: 'Catppuccin' },
]
const CODE_THEME_VALUES = CODE_THEMES.map((t) => t.value)

// How the editor surfaces the markdown body (#116, renamed #180) — a single
// personal choice in Settings, not an in-editor toggle. Both modes edit the SAME
// raw md string (the bytes are never rewritten → round-trip clean by
// construction, P1/P5/P9). The names form the triad Source / WYSIWYM / WYSIWYG:
//   'source'  — plain raw markdown (CM6 highlight); the Edit/Preview button flips
//                raw ↔ rendered HTML.
//   'wysiwym' — "what you see is what you mean": the markdown markers stay VISIBLE
//                (just dimmed) so nothing jumps as the caret moves, but the text is
//                richly styled (headings sized, emphasis rendered, blocks tinted).
// 'wysiwyg' (true render, markers hidden) is the planned third value — #120; not
// built yet, so it is deliberately NOT in the union (it has no mapping anywhere).
// Default 'source' so the plainest surface is the baseline. Persisted like the
// theme (localStorage cache now, user_preferences server sync later, #28 step 2).
export type EditorMode = 'source' | 'wysiwym'

// Reading typography (#27) — two orthogonal knobs for the RENDERED markdown body
// (`.markdown`: reader, the editor's Preview, history, the Settings sample). Both
// apply as `data-reading-*` on <html>; reading.scss maps them to --reading-font /
// --reading-size. Persisted like the theme (localStorage cache now, the
// user_preferences server sync later, #28 step 2).
//
// Font is a FIXED preset list (not free choice): two system stacks (System sans,
// Georgia serif) plus self-hosted web fonts grouped sans / serif / mono, chosen
// from research on real popularity + reading quality + multilingual coverage
// (#27). All cover Latin + Cyrillic; bundled subsets reach Greek/Latin-ext/
// Vietnamese too. 'system' carries no data-attr override (it IS the token
// default). The two extra mono presets reuse --font-mono (JetBrains Mono is the
// default code font); Fira Code ships roman-only (italic browser-synthesised).
export type ReadingFont =
  | 'system'
  | 'inter'
  | 'open-sans'
  | 'roboto'
  | 'source-sans'
  | 'noto-sans'
  | 'serif'
  | 'lora'
  | 'literata'
  | 'merriweather'
  | 'source-serif'
  | 'noto-serif'
  | 'mono'
  | 'fira-code'
  | 'cascadia'
export const READING_FONTS: { value: ReadingFont; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'inter', label: 'Inter' },
  { value: 'open-sans', label: 'Open Sans' },
  { value: 'roboto', label: 'Roboto' },
  { value: 'source-sans', label: 'Source Sans 3' },
  { value: 'noto-sans', label: 'Noto Sans' },
  { value: 'serif', label: 'Georgia' },
  { value: 'lora', label: 'Lora' },
  { value: 'literata', label: 'Literata' },
  { value: 'merriweather', label: 'Merriweather' },
  { value: 'source-serif', label: 'Source Serif 4' },
  { value: 'noto-serif', label: 'Noto Serif' },
  { value: 'mono', label: 'JetBrains Mono' },
  { value: 'fira-code', label: 'Fira Code' },
  { value: 'cascadia', label: 'Cascadia Code' },
]
const READING_FONT_VALUES = READING_FONTS.map((f) => f.value)

// Reading size — S/M/L/XL maps (reading.scss) to ~15.5/17/19/21px base; the
// markdown type scale is em-relative to it, so one step grows the whole rhythm.
// Default 'm' (17px) — the comfortable long-form baseline.
export type ReadingSize = 's' | 'm' | 'l' | 'xl'
export const READING_SIZES: { value: ReadingSize; label: string }[] = [
  { value: 's', label: 'S' },
  { value: 'm', label: 'M' },
  { value: 'l', label: 'L' },
  { value: 'xl', label: 'XL' },
]
const READING_SIZE_VALUES = READING_SIZES.map((s) => s.value)

// Distraction-free writing aids (#118), ORTHOGONAL to the editor mode above and to
// Edit/Preview — personal layers over any editing surface. Both persist like the
// theme (localStorage now, user_preferences server sync later, #28).
//   - Focus: dim everything but the active unit. `focusMode` is the EFFECTIVE value
//     (incl. 'off'); internally it's a boolean (on/off) × a remembered granularity,
//     so toggling off and back restores the user's chosen granularity rather than
//     resetting it. The hotkey flips on/off; Settings picks the granularity.
//   - Typewriter: keep the caret line vertically centered.
export type FocusGranularity = 'sentence' | 'line' | 'paragraph'
export type FocusMode = 'off' | FocusGranularity

export type ChromeContextValue = {
  theme: Theme
  setTheme: (t: Theme) => void
  /** Code highlighting preset, applied as `data-code-theme` on <html>. */
  codeTheme: CodeTheme
  setCodeTheme: (t: CodeTheme) => void
  /** Editing surface for the markdown body — raw Source or styled WYSIWYM. */
  editorMode: EditorMode
  setEditorMode: (m: EditorMode) => void
  /** Reading font preset for the rendered markdown body, as `data-reading-font`. */
  readingFont: ReadingFont
  setReadingFont: (f: ReadingFont) => void
  /** Reading size step (S/M/L/XL) for the rendered body, as `data-reading-size`. */
  readingSize: ReadingSize
  setReadingSize: (s: ReadingSize) => void
  /** Focus mode (#118): effective value incl. 'off'. `setFocusMode` picks the
   *  granularity (and turns it on); `toggleFocus` flips on/off keeping the grain. */
  focusMode: FocusMode
  setFocusMode: (m: FocusMode) => void
  toggleFocus: () => void
  /** Typewriter mode (#118): keep the caret line vertically centered. */
  typewriter: boolean
  setTypewriter: (on: boolean) => void
  toggleTypewriter: () => void
  /** Right aside (local graph / note meta / feed facets). */
  asideOpen: boolean
  toggleAside: () => void
  /** Whether the left rail's WIDE PANEL (space switcher + search + file tree) is
   *  shown (#103). The slim activity strip beside it is permanent — this toggles
   *  only the panel, VS Code-style. Persisted to `bm-rail-open` (default shown).
   *  Naming/key kept for continuity (the value's meaning narrowed, not its type). */
  railOpen: boolean
  setRailOpen: (open: boolean) => void
  toggleRail: () => void
  // One-shot focus target carried into the graph when "open in graph" is used
  // from a note's local graph: GraphView pins it (focusId) on entry then clears
  // it, so a later plain visit to the graph doesn't re-focus a stale note.
  graphFocus: string | null
  setGraphFocus: (id: string | null) => void
}

const ChromeContext = createContext<ChromeContextValue | null>(null)

export const useChrome = (): ChromeContextValue => {
  const ctx = useContext(ChromeContext)

  if (!ctx) {
    throw new Error('useChrome must be used within ChromeProvider')
  }

  return ctx
}

export const ChromeProvider = ({ children }: { children: ReactNode }) => {
  const [theme, setTheme] = useState<Theme>(() =>
    localStorage.getItem(STORAGE_KEYS.theme) === 'light' ? 'light' : 'dark',
  )
  const [codeTheme, setCodeTheme] = useState<CodeTheme>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.codeTheme)
    return (CODE_THEME_VALUES as string[]).includes(saved || '') ? (saved as CodeTheme) : 'github'
  })
  const [editorMode, setEditorMode] = useState<EditorMode>(() => {
    // Second rename of this value (#180). The styled-source mode has been called,
    // in order: 'wysiwyg' (#116 first cut), then 'styled' (#116 final), now
    // 'wysiwym' (#180) — all the SAME mode, so any of the old labels migrates to
    // 'wysiwym' (never flip a user's mode out from under them). The plain-source
    // mode was 'markdown' (#116) → 'source' (#180). Everything else → 'source'.
    const saved = localStorage.getItem(STORAGE_KEYS.editorMode)
    return saved === 'wysiwym' || saved === 'styled' || saved === 'wysiwyg' ? 'wysiwym' : 'source'
  })
  const [readingFont, setReadingFont] = useState<ReadingFont>(() => {
    // Default to Inter (the app UI font, already preloaded in index.html) rather than
    // 'system': it loads regardless, so the reading body matches the chrome out of the
    // box instead of falling to the OS sans (a lottery on Linux). 'System' stays a
    // preset for anyone who prefers their OS font.
    const saved = localStorage.getItem(STORAGE_KEYS.readingFont)
    return (READING_FONT_VALUES as string[]).includes(saved || '')
      ? (saved as ReadingFont)
      : 'inter'
  })
  const [readingSize, setReadingSize] = useState<ReadingSize>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.readingSize)
    return (READING_SIZE_VALUES as string[]).includes(saved || '') ? (saved as ReadingSize) : 'm'
  })
  const [asideOpen, setAsideOpen] = useState(
    () => localStorage.getItem(STORAGE_KEYS.asideOpen) === '1',
  )
  const [railOpen, setRailOpen] = useState(
    () => localStorage.getItem(STORAGE_KEYS.railOpen) !== '0',
  )
  const [graphFocus, setGraphFocus] = useState<string | null>(null)
  // Focus mode (#118), stored as two pieces so the chosen granularity survives an
  // off/on toggle: `focusOn` (bm-focus) × `focusGranularity` (bm-focus-grain, default
  // 'paragraph' — the gentlest unit). Effective focusMode = on ? granularity : 'off'.
  const [focusOn, setFocusOn] = useState(() => localStorage.getItem(STORAGE_KEYS.focus) === '1')
  const [focusGranularity, setFocusGranularity] = useState<FocusGranularity>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.focusGrain)
    return saved === 'sentence' || saved === 'line' || saved === 'paragraph' ? saved : 'paragraph'
  })
  const [typewriter, setTypewriter] = useState(
    () => localStorage.getItem(STORAGE_KEYS.typewriter) === '1',
  )

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem(STORAGE_KEYS.theme, theme)
    // Keep the browser chrome (mobile address bar, installed-app title bar, #40)
    // in step with the page background instead of the static index.html default.
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColor(theme))
  }, [theme])

  useEffect(() => {
    document.documentElement.dataset.codeTheme = codeTheme
    localStorage.setItem(STORAGE_KEYS.codeTheme, codeTheme)
  }, [codeTheme])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.editorMode, editorMode)
  }, [editorMode])

  useEffect(() => {
    document.documentElement.dataset.readingFont = readingFont
    localStorage.setItem(STORAGE_KEYS.readingFont, readingFont)
  }, [readingFont])

  useEffect(() => {
    document.documentElement.dataset.readingSize = readingSize
    localStorage.setItem(STORAGE_KEYS.readingSize, readingSize)
  }, [readingSize])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.focus, focusOn ? '1' : '0')
  }, [focusOn])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.focusGrain, focusGranularity)
  }, [focusGranularity])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.typewriter, typewriter ? '1' : '0')
  }, [typewriter])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.asideOpen, asideOpen ? '1' : '0')
  }, [asideOpen])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.railOpen, railOpen ? '1' : '0')
  }, [railOpen])

  const value: ChromeContextValue = {
    theme,
    setTheme,
    codeTheme,
    setCodeTheme,
    editorMode,
    setEditorMode,
    readingFont,
    setReadingFont,
    readingSize,
    setReadingSize,
    focusMode: focusOn ? focusGranularity : 'off',
    // Picking a granularity in Settings turns focus on; picking 'Off' turns it off
    // but leaves the remembered granularity intact for the next enable.
    setFocusMode: (m: FocusMode) => {
      if (m === 'off') {
        setFocusOn(false)
      } else {
        setFocusGranularity(m)
        setFocusOn(true)
      }
    },
    toggleFocus: () => setFocusOn((o) => !o),
    typewriter,
    setTypewriter,
    toggleTypewriter: () => setTypewriter((o) => !o),
    asideOpen,
    toggleAside: () => setAsideOpen((o) => !o),
    railOpen,
    setRailOpen,
    toggleRail: () => setRailOpen((o) => !o),
    graphFocus,
    setGraphFocus,
  }

  return <ChromeContext.Provider value={value}>{children}</ChromeContext.Provider>
}
