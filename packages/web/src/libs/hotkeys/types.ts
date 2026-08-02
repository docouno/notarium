// Hotkeys (#30) — the shared vocabulary. Three orthogonal pieces:
//   - an ACTION is the stable thing a user binds to (id + where it may fire);
//   - a CHORD is one physical key + modifiers; a BINDING is a sequence of chords
//     (length 1 for a plain shortcut, >1 for a `g h`-style prefix sequence);
//   - a PRESET maps actions → bindings; the user layers per-action overrides on top.
// Everything downstream (the dispatcher, the cheatsheet, the Settings editor and the
// browser-default suppression) reads ONLY from a resolved keymap built out of these —
// there is no second hand-maintained list, so handlers and docs can't drift (#30 §2).

/** Where an action is allowed to fire. The dispatcher and the editor split on this:
 *  - 'global'  — app navigation / chrome; fired by the window dispatcher, but only
 *                when focus is NOT in a text field (unless the chord carries a
 *                modifier, which is safe to type-through, e.g. Cmd+P).
 *  - 'editing' — only while a draft is open (Save / Cancel); fired in the bubble
 *                phase so the editor's own popups (slash menu) get the key first.
 *  - 'editor'  — markdown formatting; EXECUTED by CodeMirror's keymap (built from the
 *                same resolved map). The dispatcher never runs these, it only
 *                preventDefaults their chords app-wide so a stray press outside the
 *                editor doesn't trigger a browser default (bookmark / search bar). */
export type HotkeyContext = 'global' | 'editing' | 'editor'

/** Display grouping in the cheatsheet and the Settings editor. */
export type HotkeySection = 'navigation' | 'general' | 'note' | 'editing' | 'editor'

/** A single key press: a physical key `code` (layout-agnostic — 'KeyP' is the P
 *  position whatever the OS layout produces, so RU/EN behave identically) plus the
 *  modifier state. `mod` is the platform-agnostic Cmd-or-Ctrl. */
export type Chord = {
  code: string
  mod?: boolean
  shift?: boolean
  alt?: boolean
}

/** A binding is an ordered list of chords. One chord = a plain shortcut; several =
 *  a sequence you type in order (`g` then `h`). An empty array means "unbound". */
export type Binding = Chord[]

/** Action metadata. The `run` is supplied at dispatch time by the provider (it needs
 *  live React deps — navigate, the editing draft, …), so this registry is pure data
 *  and carries no behaviour — which is what lets it live in `libs/` and be unit-tested. */
export type HotkeyAction = {
  id: string
  section: HotkeySection
  context: HotkeyContext
  /** Imperative label, e.g. "New note". */
  label: string
  /** One-liner shown in the Settings editor row. */
  hint?: string
}

/** A named keymap. Non-default presets are authored as a thin override over the
 *  Notarium base so every action is always bound to *something* (a preset is a
 *  starting point the user then customises, not an exhaustive spec). An action may
 *  carry SEVERAL bindings (e.g. Save = Cmd+Enter AND Cmd+S) — a string is one, an
 *  array is several. */
export type HotkeyPreset = {
  id: string
  label: string
  /** Short note shown under the preset picker. */
  blurb: string
  /** actionId → binding(s). Authored in the compact string notation (see `chord.ts`). */
  bindings: Record<string, string | string[]>
}

/** Per-action user override layered on the active preset — the FULL replacement set
 *  of bindings for that action. `[]` = explicitly unbound; an absent key = inherit the
 *  preset. Persisted as JSON, so the structured `Chord[][]` is stored directly — no
 *  notation round-trip to get wrong. */
export type HotkeyOverrides = Record<string, Binding[]>

/** Two actions in the SAME context bound to the same chord/sequence — the Settings
 *  editor flags these so the user can resolve them. Cross-context collisions (Cmd+B =
 *  bold in the editor AND toggle-panel globally) are intentional and NOT conflicts. */
export type HotkeyConflict = {
  /** Canonical key of the colliding binding. */
  key: string
  context: HotkeyContext
  actionIds: string[]
}
