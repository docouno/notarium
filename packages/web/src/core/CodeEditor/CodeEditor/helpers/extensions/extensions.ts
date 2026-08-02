import { syntaxHighlighting } from '@codemirror/language'
import { focusModeExtension } from '../../../focusMode'
import { typewriterExtension } from '../../../typewriter'
import { wysiwymSourceExtension } from '../../../wysiwymSource'
import { mdHighlight } from '../../consts'
import { type Focus } from '../../types'

// The mode-specific styling lives in a Compartment (#116) so switching
// Source↔WYSIWYM reconfigures it in place — the EditorView is never torn down,
// so undo history, cursor and selection survive the switch. Each mode supplies
// exactly ONE syntax highlight (so they never fight over a tag's colour):
//   'source'  — mdHighlight: full themed syntax highlighting of the raw markdown,
//               VS Code-style (markup + code on the `--hl-*` preset) (the Source mode).
//   'wysiwym' — wysiwymSourceExtension: richer highlight + block backdrops; the
//               markers stay visible, just dimmed — no caret-jump (the WYSIWYM mode).
// The body the editor holds is the SAME raw md string in both — decorations only
// change how it LOOKS, never the bytes, so round-trip stays clean by construction.
export const modeExtension = (mode: 'source' | 'wysiwym') =>
  mode === 'wysiwym' ? wysiwymSourceExtension : syntaxHighlighting(mdHighlight)

// Focus/typewriter (#118) are writing aids ORTHOGONAL to the mode — each lives in its
// own Compartment so a toggle reconfigures it live (no remount). 'off' / false → an
// empty extension (the aid simply isn't installed).
export const focusExtension = (focus: Focus) => (focus === 'off' ? [] : focusModeExtension(focus))
export const typewriterExt = (on: boolean) => (on ? typewriterExtension : [])
