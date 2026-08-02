import type { Binding, Chord } from './types'

// Chord plumbing: the conversions between the four shapes a key takes —
//   author notation ('Mod+Shift+X', 'g h')  ⇄  structured Chord[]
//   a live KeyboardEvent                      →  Chord
//   a Chord                                   →  canonical key (Map lookups)
//   a Chord                                   →  display string ('⌘⇧X') / CM keyspec
// Physical `code` is the canonical identity everywhere, so matching is layout-agnostic
// (the P key fires Cmd+P whether the OS produces 'p' or 'з'); characters appear only
// at the display edge.

// --- notation → Chord[] (author-facing, used only in presets.ts) ----------- //

// Single-character tokens that map to a physical `code`. Letters/digits are derived.
const SYMBOL_CODES: Record<string, string> = {
  '/': 'Slash',
  '?': 'Slash', // '?' = Shift+Slash; the Shift is added by the parser below
  '.': 'Period',
  ',': 'Comma',
  ';': 'Semicolon',
  "'": 'Quote',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  '`': 'Backquote',
  '-': 'Minus',
  '=': 'Equal',
}

const NAMED_CODES: Record<string, string> = {
  enter: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  space: 'Space',
  tab: 'Tab',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  backspace: 'Backspace',
  delete: 'Delete',
  home: 'Home',
  end: 'End',
}

/** Parse one step ('Mod+Shift+X', 'g', '/') into a Chord. Modifiers join with '+';
 *  the final token is the key. Throws on an unknown key so a typo'd preset is caught
 *  at module-load, not silently dropped. */
const parseChord = (step: string): Chord => {
  const parts = step.split('+')
  const chord: Chord = { code: '' }
  const keyTok = parts.pop() as string

  for (const p of parts) {
    const m = p.toLowerCase()

    if (m === 'mod' || m === 'cmd' || m === 'ctrl' || m === 'meta') {
      chord.mod = true
    } else if (m === 'shift') {
      chord.shift = true
    } else if (m === 'alt' || m === 'opt' || m === 'option') {
      chord.alt = true
    } else {
      throw new Error(`hotkeys: unknown modifier "${p}" in "${step}"`)
    }
  }
  if (SYMBOL_CODES[keyTok]) {
    chord.code = SYMBOL_CODES[keyTok]
    if (keyTok === '?') {
      chord.shift = true
    }
  } else if (NAMED_CODES[keyTok.toLowerCase()]) {
    chord.code = NAMED_CODES[keyTok.toLowerCase()]
  } else if (/^[a-zA-Z]$/.test(keyTok)) {
    chord.code = `Key${keyTok.toUpperCase()}`
  } else if (/^[0-9]$/.test(keyTok)) {
    chord.code = `Digit${keyTok}`
  } else {
    throw new Error(`hotkeys: unknown key "${keyTok}" in "${step}"`)
  }

  return chord
}

/** Parse a binding ('g h' → two steps, 'Mod+Enter' → one). Steps split on spaces. */
export const parseBinding = (notation: string): Binding =>
  notation.trim().split(/\s+/).filter(Boolean).map(parseChord)

/** Parse one OR several bindings (an action can carry more than one — Save = Cmd+Enter
 *  AND Cmd+S). A bare string is a single binding; an array is several. */
export const parseBindings = (notation: string | string[]): Binding[] =>
  (Array.isArray(notation) ? notation : [notation]).map(parseBinding)

// --- KeyboardEvent → Chord ------------------------------------------------- //

const MODIFIER_CODES = new Set([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
])

/** A live press → a Chord, or null for a bare modifier press (which is never a
 *  shortcut on its own — it's the lead-in to one). */
export const chordFromEvent = (e: KeyboardEvent): Chord | null => {
  if (!e.code || MODIFIER_CODES.has(e.code)) {
    return null
  }

  return {
    code: e.code,
    mod: e.metaKey || e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
  }
}

// --- Chord → canonical key (Map identity) ---------------------------------- //

/** Stable string identity of a chord, for reverse-index lookups. Order-fixed so two
 *  chords with the same meaning always hash equal. */
export const chordKey = (c: Chord): string =>
  `${c.mod ? 'M' : ''}${c.shift ? 'S' : ''}${c.alt ? 'A' : ''}:${c.code}`

/** Identity of a whole binding (sequence-aware). */
export const bindingKey = (b: Binding): string => b.map(chordKey).join(' ')

/** True when the chord carries a non-shift modifier — such chords are safe to fire
 *  even while a text field is focused (Cmd+P), whereas a plain key (or Shift+key,
 *  which is just typing) must be suppressed inside inputs. */
export const firesInInput = (c: Chord): boolean => !!(c.mod || c.alt)

// Chords a browser tab can NOT intercept (preventDefault is ignored) — new tab/window,
// close, quit, address bar. Bound to an app action, these simply won't work in a tab
// (only an installed PWA / desktop build could claim them). The Settings editor warns.
const BROWSER_RESERVED = new Set<string>([
  ...['KeyT', 'KeyN', 'KeyW', 'KeyQ'].map((code) => chordKey({ code, mod: true })),
  ...['KeyT', 'KeyN', 'KeyW'].map((code) => chordKey({ code, mod: true, shift: true })),
])

/** True if any chord in the binding is one the browser reserves (un-suppressable in a
 *  tab) — used to flag a binding that the browser will likely swallow. */
export const isBrowserReserved = (binding: Binding): boolean =>
  binding.some((c) => BROWSER_RESERVED.has(chordKey(c)))

// --- Chord → display ------------------------------------------------------- //

const MAC =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')

// code → the glyph we SHOW. Letters/digits derive; symbols and named keys map here.
// `?`/`/` share a code, disambiguated by Shift at format time.
const CODE_GLYPH: Record<string, string> = {
  Slash: '/',
  Period: '.',
  Comma: ',',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  Enter: '↵',
  Escape: 'Esc',
  Space: 'Space',
  Tab: 'Tab',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Backspace: '⌫',
  Delete: 'Del',
  Home: 'Home',
  End: 'End',
}

// Shift+Slash reads as '?' — but ONLY when Shift is the sole modifier. With Cmd/Alt
// also held the chord is a distinct binding, so show '/' and a separate ⇧ ('⌘⇧/', not
// the ambiguous '⌘?').
const isBareQuestion = (c: Chord): boolean => c.code === 'Slash' && !!c.shift && !c.mod && !c.alt

const glyph = (c: Chord): string => {
  if (c.code.startsWith('Key')) {
    return c.code.slice(3)
  }
  if (c.code.startsWith('Digit')) {
    return c.code.slice(5)
  }
  if (isBareQuestion(c)) {
    return '?'
  }

  return CODE_GLYPH[c.code] ?? c.code
}

/** One chord as a human label, e.g. '⌘⇧X' on mac or 'Ctrl+Shift+X' elsewhere. The
 *  bare '?' glyph already implies Shift, so the modifier isn't doubled up. */
export const formatChord = (c: Chord, mac = MAC): string => {
  const g = glyph(c)
  const showShift = c.shift && !isBareQuestion(c) // '?' alone bakes Shift into the glyph

  if (mac) {
    return `${c.mod ? '⌘' : ''}${c.alt ? '⌥' : ''}${showShift ? '⇧' : ''}${g}`
  }
  const mods = [c.mod && 'Ctrl', c.alt && 'Alt', showShift && 'Shift'].filter(Boolean)
  return [...mods, g].join('+')
}

/** A whole binding for display; sequence steps joined with a thin space. */
export const formatBinding = (b: Binding, mac = MAC): string =>
  b.map((c) => formatChord(c, mac)).join(' ')

export const IS_MAC = MAC

// --- Chord → CodeMirror keyspec (editor-context bindings only) ------------- //

/** A single editor chord as a CodeMirror key string ('Mod-Shift-x'). CM matches by
 *  character with a built-in QWERTY base-layer fallback, so a letter chord stays
 *  layout-robust there too. Only ever called for editor-context bindings (letter +
 *  modifiers), so the key is always a plain character. */
export const chordToCodeMirror = (c: Chord): string => {
  const parts: string[] = []

  if (c.mod) {
    parts.push('Mod')
  }
  if (c.shift) {
    parts.push('Shift')
  }
  if (c.alt) {
    parts.push('Alt')
  }
  parts.push(glyph(c).toLowerCase())
  return parts.join('-')
}
