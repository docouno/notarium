import { type KeyBinding } from '@codemirror/view'
import {
  chordToCodeMirror,
  type EditorBinding,
  editorBindings,
  resolveKeymap,
} from '../../../../../libs/hotkeys'
import { EDITOR_COMMANDS } from '../../consts'
import { type ToggleRef } from '../../types'

/** Build the formatting/selection keymap from resolved editor bindings. CM matches by
 *  character with a QWERTY base-layer fallback, so a letter chord stays layout-robust. */
export const buildFormatKeymap = (bindings: EditorBinding[]): KeyBinding[] =>
  bindings
    .filter((b) => EDITOR_COMMANDS[b.actionId])
    .map((b) => ({
      key: chordToCodeMirror(b.chord),
      run: EDITOR_COMMANDS[b.actionId],
      preventDefault: true,
    }))

// The writing-aid toggles (#118) flip GLOBAL ChromeProvider state, so their CM command
// just calls the host handler (the prop change then reconfigures the compartment below).
// Bound from the SAME resolved keymap (#30) so they appear in the cheat sheet + Settings
// and are rebindable — no parallel hardcoded chord.
export const buildToggleKeymap = (
  bindings: EditorBinding[],
  toggleRef: ToggleRef,
): KeyBinding[] => {
  // Read the handler off the ref at call time — it's reassigned each render.
  const run: Record<string, () => boolean> = {
    'editor.focusMode': () => {
      toggleRef.current.onToggleFocus?.()
      return true
    },
    'editor.typewriter': () => {
      toggleRef.current.onToggleTypewriter?.()
      return true
    },
  }
  return bindings
    .filter((b) => run[b.actionId])
    .map((b) => ({ key: chordToCodeMirror(b.chord), run: run[b.actionId], preventDefault: true }))
}

// Default editor keymap from the web-native preset — the fallback when the editor is
// used outside HotkeysProvider (standalone / tests) so its formatting still works.
export const DEFAULT_FORMAT_KEYMAP = buildFormatKeymap(editorBindings(resolveKeymap('notarium')))
