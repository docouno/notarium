import type { HotkeyAction, HotkeySection } from './types'

// The action registry (#30) — the single, stable list of everything a key can be
// bound to. IDs are permanent (overrides are stored against them); presets and the
// dispatcher's handler map both key off these. Pure data: no behaviour here, so the
// list is host-agnostic and unit-testable. Adding a shortcut = add an action here, a
// binding in every preset, and a handler in the provider — nothing else to touch.

// Display order + headings for the cheatsheet and the Settings editor.
export const SECTIONS: { id: HotkeySection; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'navigation', label: 'Go to' },
  { id: 'note', label: 'Note' },
  { id: 'editing', label: 'While editing' },
  { id: 'editor', label: 'Editor' },
]

export const ACTIONS: HotkeyAction[] = [
  // ── General: overlays, search and chrome toggles ───────────────────────────
  {
    id: 'palette.notes',
    section: 'general',
    context: 'global',
    label: 'Quick switcher',
    hint: 'Jump to a note by name (Spotlight).',
  },
  {
    id: 'search.focus',
    section: 'general',
    context: 'global',
    label: 'Search notes',
    hint: 'Open the rail Search view and focus it.',
  },
  {
    id: 'help.keys',
    section: 'general',
    context: 'global',
    label: 'Keyboard shortcuts',
    hint: 'Show this cheat sheet.',
  },
  {
    id: 'view.theme',
    section: 'general',
    context: 'global',
    label: 'Toggle theme',
    hint: 'Switch between light and dark.',
  },
  {
    id: 'view.leftPanel',
    section: 'general',
    context: 'global',
    label: 'Toggle left panel',
    hint: 'Show/hide the file tree panel.',
  },
  {
    id: 'view.rightPanel',
    section: 'general',
    context: 'global',
    label: 'Toggle right panel',
    hint: 'Show/hide the note inspector aside.',
  },

  // ── Go to: scope navigation ────────────────────────────────────────────────
  { id: 'go.home', section: 'navigation', context: 'global', label: 'Home' },
  { id: 'go.feed', section: 'navigation', context: 'global', label: 'Feed' },
  { id: 'go.graph', section: 'navigation', context: 'global', label: 'Graph' },
  { id: 'go.files', section: 'navigation', context: 'global', label: 'Files' },
  { id: 'go.agents', section: 'navigation', context: 'global', label: 'Agents' },
  { id: 'go.trash', section: 'navigation', context: 'global', label: 'Trash' },
  { id: 'go.settings', section: 'navigation', context: 'global', label: 'Settings' },

  // ── Note actions ───────────────────────────────────────────────────────────
  { id: 'note.new', section: 'note', context: 'global', label: 'New note' },
  {
    id: 'note.edit',
    section: 'note',
    context: 'global',
    label: 'Edit note',
    hint: 'Enter the editor for the open note.',
  },

  // ── While editing a draft ──────────────────────────────────────────────────
  { id: 'editing.save', section: 'editing', context: 'editing', label: 'Save draft' },
  {
    id: 'editing.cancel',
    section: 'editing',
    context: 'editing',
    label: 'Cancel editing',
    hint: 'Leave the editor (asks first if there are unsaved changes).',
  },

  // ── Editor (executed by CodeMirror when focused, bound from the same map) ────
  { id: 'format.bold', section: 'editor', context: 'editor', label: 'Bold' },
  { id: 'format.italic', section: 'editor', context: 'editor', label: 'Italic' },
  { id: 'format.code', section: 'editor', context: 'editor', label: 'Inline code' },
  { id: 'format.link', section: 'editor', context: 'editor', label: 'Link' },
  { id: 'format.strike', section: 'editor', context: 'editor', label: 'Strikethrough' },
  {
    id: 'editor.multicursor',
    section: 'editor',
    context: 'editor',
    label: 'Select next occurrence',
    hint: 'Add a cursor at the next match (multi-cursor).',
  },
  // Writing aids (#118) — toggles that flip global focus/typewriter state; in-editor.
  {
    id: 'editor.focusMode',
    section: 'editor',
    context: 'editor',
    label: 'Toggle focus mode',
    hint: 'Dim everything but the active sentence/line/paragraph.',
  },
  {
    id: 'editor.typewriter',
    section: 'editor',
    context: 'editor',
    label: 'Toggle typewriter',
    hint: 'Keep the caret line vertically centered.',
  },
]

export const ACTION_BY_ID: Record<string, HotkeyAction> = Object.fromEntries(
  ACTIONS.map((a) => [a.id, a]),
)

/** Action ids whose bindings drive CodeMirror's keymap (the editor builds itself
 *  from these). Kept here so the editor integration and the resolver agree on the set. */
export const EDITOR_ACTION_IDS = ACTIONS.filter((a) => a.context === 'editor').map((a) => a.id)
