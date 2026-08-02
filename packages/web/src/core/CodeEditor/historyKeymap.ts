import { redo, undo } from '@codemirror/commands'
import type { KeyBinding } from '@codemirror/view'

// Cross-platform undo/redo (#187). CM6's stock `historyKeymap` binds redo to
// `Mod-Shift-z` only on mac + linux, and to `Mod-y` everywhere EXCEPT mac — so on
// Windows `Ctrl+Shift+Z` does nothing (redo is reachable there only via `Ctrl+Y`),
// breaking the universal redo reflex. We bind undo/redo on EVERY platform with plain
// `key:` specs (no per-platform `mac`/`win`/`linux` field), so the muscle-memory combos
// resolve identically regardless of CM's internal platform table:
//   Mod-z        → undo
//   Mod-Shift-z  → redo   (the cross-platform redo reflex — the Windows gap this closes)
//   Mod-y        → redo   (Windows/Linux memory; also bound on mac, where it's harmless)
// Installed BEFORE CM's stock `historyKeymap` in CodeEditor so these win; the stock map
// still supplies selection history (undoSelection / redoSelection: Mod-u / Alt-u).
//
// undo/redo stay CodeMirror-owned, deliberately NOT registered as #30 editor actions:
// were they app actions, their chords would land in `modifierBoundKeys` and the global
// dispatcher would preventDefault `Ctrl+Z` app-wide, killing native undo in plain inputs
// (search, etc.). Keeping them at the CM layer scopes them to the editor only.
export const crossPlatformHistoryKeymap: readonly KeyBinding[] = [
  { key: 'Mod-z', run: undo, preventDefault: true },
  { key: 'Mod-Shift-z', run: redo, preventDefault: true },
  { key: 'Mod-y', run: redo, preventDefault: true },
]
