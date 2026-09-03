# Hotkeys (#30)

Notarium provides a single, customizable set of hotkeys: one source of truth (the action registry + the active layout map) that feeds BOTH the handlers, AND the cheatsheet, AND the code editor — so they cannot drift apart by construction. The layout can be switched via a preset (Notarium / VS Code / Obsidian / Vim / JetBrains) and any key can be overridden in **Settings → Keyboard**.

## Model: actions → bindings → presets → overrides

Three orthogonal entities (`packages/web/src/libs/hotkeys/`, pure TS, unit tests in `test/unit/hotkeys.test.ts`):

- **Action** (`actions.ts`) — the stable thing a key is attached to: `id` (permanent — overrides are stored by it), section, context, and label. There is no behavior here — this is pure data.
- **Chord / binding** (`chord.ts`) — a chord = one physical key + modifiers; a binding = a sequence of chords (length 1 — an ordinary shortcut, >1 — a sequence like `g h`). An action can have **multiple bindings** (Save = `Cmd/Ctrl+Enter` AND `Cmd/Ctrl+S`). Identity everywhere is by the **physical `code`** (`KeyP`), not by the symbol (`e.key`) — so the OS layout (RU/EN) has no effect; symbols appear only at the display edge.
- **Preset** (`presets.ts`) — a named `action → binding` map. The default `notarium` is a full web-native map; the other presets are thin overrides on top of it (a preset = a starting point, not an exhaustive spec).
- **Overrides** — user edits on top of the preset (`localStorage`, server sync — groundwork in #28 step 2). `null` = explicitly removed.

`resolve.ts` collapses (preset + overrides) into the **active map**: the binding per action, reverse indexes for the dispatcher, and the list of conflicts. This is the single structure read by the dispatcher, the cheatsheet, the Settings editor, and the CodeMirror keymap.

## Contexts and priorities

An action fires only in its own context — this lets one chord mean different things (in the VS Code preset `Cmd/Ctrl+B` = toggle the panel globally AND bold in the editor; this is NOT a conflict, cross-context matches are intentional):

- **`global`** — navigation and chrome. The dispatcher listens on `window` in the **capture phase** (focus-in-editor won't swallow the key). A single key fires only when focus is NOT in an input/`textarea`/CodeMirror/contenteditable; a chord with a modifier (`Cmd/Ctrl+P`) fires everywhere (safe to type through it).
- **`editing`** — only while a draft is open (Save / Cancel). Listened for in the **bubble phase** so editor popovers get the key first (the slash menu owns Escape, the snippet field owns Tab). Save is skipped inside a dialog; Cancel (Esc) is skipped over a modal/autocomplete.
- **`editor`** — markdown formatting. **Executed by CodeMirror** (its keymap is built from the same active map — `editorKeys` is threaded through by the layout). The dispatcher does not run them. **Undo/redo is a deliberate exception:** these are CodeMirror history primitives, NOT registry actions from #30, so they are not rebound in Settings (and do not land in `modifierBoundKeys` — otherwise `Ctrl+Z` would be suppressed app-wide, breaking native undo in ordinary inputs). They are bound directly in `core/CodeEditor` cross-platform (#187): `Mod+Z` — undo, `Mod+Shift+Z` and `Mod+Y` — redo, on ALL operating systems (CM6's stock `historyKeymap` left redo on `Mod+Shift+Z` — a hole on Windows).

**Suppressing browser defaults.** Any **modifier** chord bound to ANY action is "owned" by the app — its browser default (save-page `Cmd/Ctrl+S`, bookmark `Cmd/Ctrl+D`, print `Cmd/Ctrl+P`…) is suppressed **app-wide**, including outside the surface that uses it (`Cmd+S` never saves the page, even when not editing — there it is simply a no-op). The only exception: an editor chord while focus is inside CodeMirror — there the chord is owned by CM, which calls `preventDefault` itself; if the dispatcher did this (capture phase, before CM), CM's keymap would not run (it backs off on an already-`defaultPrevented` event). Combos the browser won't allow to be blocked (`Cmd+T/W/N/Q/L`) cannot be suppressed at all — that is a browser guarantee (PWA/desktop only).

Sequences (`g`, then a key) hold the prefix for ~1.2 s; single keys and sequences do not fire over a modal / in an input.

**Zonal priority (like `editorTextFocus` in VS Code).** The same chord can mean different things in different zones — and the focused zone wins. While focus is **in the editor**, its chords (the `editor` context) take priority: the global dispatcher fully yields them to CodeMirror, even if the same chord is bound to a global action. Example: `Cmd/Ctrl+D` = multi-cursor when you are typing in the editor, and "new note" anywhere else. This lets the user reuse a chord the editor has "taken" for a global action without losing the editor behavior.

**Save is an action, not a chord (#299).** Every binding resolved to `editing.save` — the two defaults, a preset, or a custom override — runs the same decision after event-time field/list input has settled:

| Current editing session | Save action |
| --- | --- |
| saveable (including a valid new draft) | run the existing save/create/publish path exactly once |
| existing and clean, even if the external target became unavailable | finish through common cleanup; no write and no toast |
| new/virtual and not saveable | remain open |
| dirty and not saveable/read-only | remain open; preserve authored state |
| already saving | ignore the repeat |

The branch checks `canSave`, `isNew`, and `dirty` independently; `canSave=false` alone never means clean. Button enablement is unchanged. Dialog ownership and the action-map browser-default suppression above still win before this decision.

## Default layout (the Notarium preset, web-native)

A web app must not intercept critical browser `Cmd/Ctrl` combos (`Cmd+T/N/W/L/R/S/F`), so the default is single keys + `g` sequences (Linear/GitHub style).

| Action | Key |
| --- | --- |
| Quick switcher (Spotlight) | `Cmd/Ctrl+P` |
| Search (Spotlight) | `/` |
| Hotkey cheatsheet | `?` |
| New note | `c` |
| Edit note | `e` |
| Light/dark theme | `t` |
| Left / right panel | `[` / `]` |
| Home / Feed / Graph | `g h` / `g f` / `g g` |
| Files / Agents / Trash / Settings | `g i` / `g a` / `g t` / `g s` |
| Save draft / Cancel | `Cmd/Ctrl+Enter` or `Cmd/Ctrl+S` / `Esc` |
| Bold / italic / code / link / strikethrough | `Cmd/Ctrl+B` / `Cmd/Ctrl+I` / `Cmd/Ctrl+E` / `Cmd/Ctrl+K` / `Cmd/Ctrl+Shift+X` |
| Multi-cursor (next occurrence) | `Cmd/Ctrl+D` |

Other presets overlay their signature combos on top of this base (e.g. VS Code: `Cmd/Ctrl+B` panel, `Cmd/Ctrl+S` save, `Cmd/Ctrl+Shift+F` search). A few desktop combos are intercepted by the browser in the tab (`Cmd+N`, etc.) — the user chooses such a preset deliberately.

## Opening the cheatsheet and customization

- **`?`** opens the cheatsheet (a modal on `core/Modal`), grouped by sections; the list is read from the active map, so it always matches what actually fires and reflects user edits. There is also a "Keyboard shortcuts" item in the profile menu.
- **Settings → Keyboard** — preset selection + per-row rebind: each action has one or more binding chips (each removed by its own ×), the **+** button adds another (the recorder captures the next keypress; while it records the dispatcher steps aside; Tab/Esc cancels), reset a row / all to the preset. A conflict names the other action ("Conflicts with …"). A chord that the **browser reserves** (`Cmd/Ctrl+W/N/T…`) is marked ⚠ — it won't fire in the tab. For **editor and editing** actions the recorder requires a modifier (a single key there would break input / fire on every keypress) — the same rule is duplicated in the resolver/dispatcher, so a manual edit of the store cannot smuggle in an unsafe binding. The recorder captures a single chord (sequences come from presets), and only one recorder is armed at a time. `Esc`/`Tab` serve as recording cancel, so they cannot be recorded as a binding (the default `Esc` for cancel comes from the preset; to restore it use the reset button).

## Key files

- `packages/web/src/libs/hotkeys/` — registry, chords, presets, resolver, matcher, persistence (pure, testable).
- `packages/web/src/composers/HotkeysProvider/` — the dispatcher (one capture + one bubble listener), preset/overrides/cheatsheet state, `Cheatsheet`.
- `packages/web/src/pages/SettingsPage/KeyboardTab.tsx` — the layout editor.
- `core/CodeEditor` builds its keymap from the active map (`editorKeys` from `DocumentLayout`); `markdownFormat` provides the commands, the keys are taken from the registry — with no second hardcoded list.
