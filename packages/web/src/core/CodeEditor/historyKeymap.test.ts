import { history, redo, undo } from '@codemirror/commands'
import { EditorState, type StateCommand } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { crossPlatformHistoryKeymap } from './historyKeymap'

// Run a StateCommand against a state and return the resulting state (undo/redo are
// DOM-free StateCommands, so the wiring is testable without an EditorView).
const run = (cmd: StateCommand, state: EditorState): EditorState => {
  let next = state
  cmd({
    state,
    dispatch: (tr) => {
      next = tr.state
    },
  })
  return next
}

describe('cross-platform history keymap (#187)', () => {
  it('maps the redo reflex (Mod-Shift-z and Mod-y) to redo, and Mod-z to undo', () => {
    const byKey = new Map(crossPlatformHistoryKeymap.map((b) => [b.key, b.run]))
    expect(byKey.get('Mod-z')).toBe(undo)
    expect(byKey.get('Mod-Shift-z')).toBe(redo) // the combo that did nothing on Windows
    expect(byKey.get('Mod-y')).toBe(redo)
  })

  it('uses platform-agnostic specs only (no mac/win/linux field) so it resolves the same everywhere', () => {
    // The whole point of #187: do NOT lean on CM6's per-platform table, which left a
    // Windows gap. Every binding must be a plain `key:` spec.
    for (const b of crossPlatformHistoryKeymap) {
      expect(b.key).toBeTruthy()
      expect('mac' in b).toBe(false)
      expect('win' in b).toBe(false)
      expect('linux' in b).toBe(false)
      expect(b.preventDefault).toBe(true) // never let the browser's native default leak through
    }
  })

  it('redo restores a change that undo reverted (the commands really drive the history field)', () => {
    let state = EditorState.create({ doc: 'A', extensions: [history()] })
    state = state.update({ changes: { from: 1, insert: 'B' }, userEvent: 'input.type' }).state
    expect(state.doc.toString()).toBe('AB')

    state = run(undo, state)
    expect(state.doc.toString()).toBe('A') // undo reverted the insert

    state = run(redo, state)
    // Guards the command the keymap points at: `redo` really replays the change (so the
    // keymap entry isn't wired to a no-op / wrong command). The chord→command resolution
    // itself is CM6's and is exercised by the live editor, not here (env=node has no DOM).
    expect(state.doc.toString()).toBe('AB')
  })
})
