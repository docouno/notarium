import type { HotkeyPreset } from './types'

// Keymap presets (#30). The Notarium base is the full, web-native default: single
// keys + `g`-sequences that never fight a browser Cmd-combo. Every other preset is
// that base with its editor's signature chords overlaid — a preset is a STARTING
// POINT the user customises, not an exhaustive spec, so anything left unspecified
// keeps the sensible web-native default rather than being unbound.
//
// Web caveat: a few authentic desktop combos (Cmd+N new note, Cmd+W…) can't be
// intercepted in a browser tab — the Settings editor flags those at runtime. We keep
// them authentic in the preset anyway; the user picked the desktop feel knowingly.

// The base, web-native map. Single keys fire only when focus is outside a text field;
// `g x` sequences keep the single-key namespace free; Cmd+P is the one Cmd-combo
// (overrides the rarely-wanted print dialog, VS Code Quick Open-style).
const NOTARIUM_BINDINGS: Record<string, string | string[]> = {
  // General
  'palette.notes': 'Mod+P',
  'search.focus': '/',
  'help.keys': '?',
  'view.theme': 't',
  'view.leftPanel': '[',
  'view.rightPanel': ']',
  // Go to (press g, then the letter)
  'go.home': 'g h',
  'go.feed': 'g f',
  'go.graph': 'g g',
  'go.files': 'g i',
  'go.agents': 'g a',
  'go.trash': 'g t',
  'go.settings': 'g s',
  // Note
  'note.new': 'c',
  'note.edit': 'e',
  // While editing. Save takes BOTH Cmd/Ctrl+Enter (the established submit reflex) and
  // Cmd/Ctrl+S (the document-editor reflex) — binding Cmd+S also stops the browser's
  // "save page" dialog from firing on a stray press while editing.
  'editing.save': ['Mod+Enter', 'Mod+S'],
  'editing.cancel': 'Escape',
  // Editor formatting
  'format.bold': 'Mod+B',
  'format.italic': 'Mod+I',
  'format.code': 'Mod+E',
  'format.link': 'Mod+K',
  'format.strike': 'Mod+Shift+X',
  'editor.multicursor': 'Mod+D',
  // Writing aids (#118) — fire only while the editor is focused.
  'editor.focusMode': 'Mod+Shift+F',
  'editor.typewriter': 'Mod+Shift+Y',
}

/** Build a preset's full map from the base + its overrides. */
const withBase = (
  overrides: Record<string, string | string[]>,
): Record<string, string | string[]> => ({ ...NOTARIUM_BINDINGS, ...overrides })

export const PRESETS: HotkeyPreset[] = [
  {
    id: 'notarium',
    label: 'Notarium (web)',
    blurb:
      'Web-native default — single keys and g-sequences that never clash with browser shortcuts.',
    bindings: NOTARIUM_BINDINGS,
  },
  {
    id: 'vscode',
    label: 'VS Code',
    blurb:
      'Familiar VS Code chords. Cmd/Ctrl+B toggles the panel outside the editor; inside it still bolds.',
    bindings: withBase({
      'palette.notes': 'Mod+P',
      'view.leftPanel': 'Mod+B',
      'view.rightPanel': 'Mod+J',
      'search.focus': 'Mod+Shift+F',
      'go.files': 'Mod+Shift+E',
      'view.theme': 'Mod+K Mod+T',
      'help.keys': 'Mod+K Mod+S',
      'editing.save': 'Mod+S',
    }),
  },
  {
    id: 'obsidian',
    label: 'Obsidian',
    blurb:
      'Obsidian feel — Cmd/Ctrl+O quick switcher, Cmd/Ctrl+G graph. (Cmd+N may be caught by the browser.)',
    bindings: withBase({
      'palette.notes': 'Mod+O',
      'go.graph': 'Mod+G',
      'search.focus': 'Mod+Shift+F',
      'note.new': 'Mod+N',
    }),
  },
  {
    id: 'vim',
    label: 'Vim-style',
    blurb:
      'Modal flavour — / to search, i to edit, o for a new note, Space-leader for panels and the switcher.',
    bindings: withBase({
      'search.focus': '/',
      'note.edit': 'i',
      'note.new': 'o',
      'palette.notes': 'Space f',
      'view.leftPanel': 'Space e',
      'help.keys': 'Space ?',
    }),
  },
  {
    id: 'jetbrains',
    label: 'JetBrains',
    blurb:
      'IntelliJ/WebStorm chords — Cmd/Ctrl+Shift+O go to file, Cmd/Ctrl+Shift+F find, Cmd/Ctrl+, settings.',
    bindings: withBase({
      'palette.notes': 'Mod+Shift+O',
      'search.focus': 'Mod+Shift+F',
      'go.settings': 'Mod+,',
      'go.files': 'Mod+1',
    }),
  },
]

export const PRESET_BY_ID: Record<string, HotkeyPreset> = Object.fromEntries(
  PRESETS.map((p) => [p.id, p]),
)

export const DEFAULT_PRESET_ID = 'notarium'
