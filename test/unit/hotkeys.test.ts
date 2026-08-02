import { describe, expect, it } from 'vitest'
import {
  bindingKey,
  chordFromEvent,
  chordKey,
  editorBindings,
  formatBinding,
  formatChord,
  isBrowserReserved,
  matchEditing,
  matchGlobal,
  parseBinding,
  resolveKeymap,
} from '../../packages/web/src/libs/hotkeys'
import { ACTIONS } from '../../packages/web/src/libs/hotkeys/actions'
import { PRESETS } from '../../packages/web/src/libs/hotkeys/presets'

// The hotkey core (#30): notation parsing, layout-agnostic event→chord, resolution of
// preset+overrides, conflict detection, and the global/editing matchers (incl. the
// `g`-sequence state). All pure — no React, no DOM — so the whole matching story is
// pinned here before the dispatcher wires it to live keys.

const ev = (code: string, mods: Partial<KeyboardEvent> = {}) =>
  ({
    code,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  }) as KeyboardEvent

describe('parseBinding / chord notation', () => {
  it('parses a modifier chord', () => {
    expect(parseBinding('Mod+Shift+X')).toEqual([{ code: 'KeyX', mod: true, shift: true }])
  })
  it('parses a multi-step sequence', () => {
    expect(parseBinding('g h')).toEqual([{ code: 'KeyG' }, { code: 'KeyH' }])
  })
  it("treats '?' as Shift+Slash", () => {
    expect(parseBinding('?')).toEqual([{ code: 'Slash', shift: true }])
  })
  it('maps symbols and named keys to physical codes', () => {
    expect(parseBinding('[')[0].code).toBe('BracketLeft')
    expect(parseBinding('Mod+Enter')[0]).toEqual({ code: 'Enter', mod: true })
  })
  it('throws on a typo so a bad preset fails loudly', () => {
    expect(() => parseBinding('Mod+Nope')).toThrow()
  })
})

describe('chordFromEvent — layout-agnostic', () => {
  it('reads the physical code + modifiers, treating ctrl/meta as Mod', () => {
    expect(chordFromEvent(ev('KeyP', { ctrlKey: true }))).toEqual({
      code: 'KeyP',
      mod: true,
      shift: false,
      alt: false,
    })
  })
  it('matches by code even when the layout produces another character (RU)', () => {
    // On a RU layout the P key yields 'з' (e.key), but e.code stays 'KeyP'.
    const chord = chordFromEvent(ev('KeyP', { metaKey: true }))!
    expect(chordKey(chord)).toBe(chordKey(parseBinding('Mod+P')[0]))
  })
  it('ignores bare modifier presses', () => {
    expect(chordFromEvent(ev('ShiftLeft', { shiftKey: true }))).toBeNull()
  })
})

describe('formatBinding — display', () => {
  it('renders mac glyphs', () => {
    expect(formatBinding(parseBinding('Mod+Shift+X'), true)).toBe('⌘⇧X')
    expect(formatBinding(parseBinding('?'), true)).toBe('?')
    expect(formatBinding(parseBinding('g h'), true)).toBe('G H')
  })
  it('renders non-mac names', () => {
    expect(formatBinding(parseBinding('Mod+Enter'), false)).toBe('Ctrl+↵')
  })
  it("shows bare Shift+/ as '?' but keeps modifiers explicit (no ambiguous ⌘?)", () => {
    expect(formatChord(parseBinding('?')[0], true)).toBe('?')
    expect(formatChord({ code: 'Slash', mod: true, shift: true }, true)).toBe('⌘⇧/')
  })
})

describe('isBrowserReserved', () => {
  it('flags chords a tab cannot intercept, not ordinary ones', () => {
    expect(isBrowserReserved(parseBinding('Mod+W'))).toBe(true)
    expect(isBrowserReserved(parseBinding('Mod+T'))).toBe(true)
    expect(isBrowserReserved(parseBinding('Mod+P'))).toBe(false)
    expect(isBrowserReserved(parseBinding('Mod+S'))).toBe(false)
  })
})

describe('resolveKeymap', () => {
  it('binds every action in the default preset', () => {
    const km = resolveKeymap('notarium')

    for (const a of ACTIONS) {
      expect(km.byAction[a.id]?.length, a.id).toBeGreaterThan(0)
    }
  })
  it('applies a user override and an unbind ([])', () => {
    const km = resolveKeymap('notarium', {
      'note.new': [parseBinding('Mod+Shift+N')],
      'view.theme': [], // explicitly unbound
    })
    expect(km.byAction['note.new']).toEqual([[{ code: 'KeyN', mod: true, shift: true }]])
    expect(km.byAction['view.theme']).toEqual([])
    expect(km.globalSingles.get(chordKey({ code: 'KeyT' }))).toBeUndefined()
  })
  it('keeps multiple bindings for one action (Save = Cmd+Enter AND Cmd+S)', () => {
    const km = resolveKeymap('notarium')
    expect(km.byAction['editing.save']).toHaveLength(2)
    expect(km.editingSingles.get(chordKey({ code: 'Enter', mod: true }))).toBe('editing.save')
    expect(km.editingSingles.get(chordKey({ code: 'KeyS', mod: true }))).toBe('editing.save')
  })
  it('dedups identical bindings within one action — no "conflicts with itself"', () => {
    const dup = parseBinding('Mod+Shift+N')
    const km = resolveKeymap('notarium', { 'note.new': [dup, dup] })
    expect(km.byAction['note.new']).toHaveLength(1)
    const selfClash = km.conflicts.find(
      (c) => c.actionIds.filter((id) => id === 'note.new').length > 1,
    )
    expect(selfClash).toBeUndefined()
  })
  it('flags a same-context conflict but not a cross-context one', () => {
    // VS Code binds Cmd+B to the panel (global) while the editor keeps it for bold —
    // same chord, different context, intentionally NOT a conflict.
    const vscode = resolveKeymap('vscode')
    const crossCtx = vscode.conflicts.find(
      (c) => c.actionIds.includes('view.leftPanel') && c.actionIds.includes('format.bold'),
    )
    expect(crossCtx).toBeUndefined()
    // Force a real same-context clash.
    const km = resolveKeymap('notarium', { 'note.new': [parseBinding('e')] }) // 'e' already = note.edit
    const clash = km.conflicts.find(
      (c) => c.actionIds.includes('note.new') && c.actionIds.includes('note.edit'),
    )
    expect(clash).toBeTruthy()
  })
})

describe('matchGlobal', () => {
  const km = resolveKeymap('notarium')
  const base = { pending: null, editable: false, modalOpen: false }

  it('fires a single key outside inputs', () => {
    const r = matchGlobal(km, parseBinding('c')[0], base)
    expect(r.actionId).toBe('note.new')
    expect(r.preventDefault).toBe(true)
  })
  it('does NOT fire a plain key while typing in a field', () => {
    const r = matchGlobal(km, parseBinding('c')[0], { ...base, editable: true })
    expect(r.actionId).toBeNull()
    expect(r.preventDefault).toBe(false)
  })
  it('fires a modifier chord even while typing (Cmd+P)', () => {
    const r = matchGlobal(km, chordFromEvent(ev('KeyP', { metaKey: true }))!, {
      ...base,
      editable: true,
    })
    expect(r.actionId).toBe('palette.notes')
  })
  it('arms a prefix on `g`, then completes `g h` → Home', () => {
    const g = matchGlobal(km, parseBinding('g')[0], base)
    expect(g.actionId).toBeNull()
    expect(g.pending).toEqual({ code: 'KeyG' })
    const h = matchGlobal(km, parseBinding('h')[0], { ...base, pending: g.pending })
    expect(h.actionId).toBe('go.home')
  })
  it('drops a dangling prefix and re-evaluates the next key', () => {
    const g = matchGlobal(km, parseBinding('g')[0], base)
    const slash = matchGlobal(km, parseBinding('/')[0], { ...base, pending: g.pending })
    expect(slash.actionId).toBe('search.focus') // 'g /' is no sequence → '/' fires fresh
  })
  it('suppresses sequences and plain keys over an open modal', () => {
    expect(matchGlobal(km, parseBinding('g')[0], { ...base, modalOpen: true }).pending).toBeNull()
    expect(matchGlobal(km, parseBinding('c')[0], { ...base, modalOpen: true }).actionId).toBeNull()
  })
  it('lets a modifier-led sequence (VS Code Mod+K Mod+T) arm + complete while typing', () => {
    const vscode = resolveKeymap('vscode') // view.theme = 'Mod+K Mod+T'
    const k = matchGlobal(vscode, parseBinding('Mod+K')[0], { ...base, editable: true })
    expect(k.pending).toEqual(parseBinding('Mod+K')[0]) // armed even inside an input
    const t = matchGlobal(vscode, parseBinding('Mod+T')[0], {
      ...base,
      editable: true,
      pending: k.pending,
    })
    expect(t.actionId).toBe('view.theme')
  })
})

describe('matchEditing', () => {
  const km = resolveKeymap('notarium')
  it('maps both Save chords and the Cancel chord', () => {
    expect(matchEditing(km, chordFromEvent(ev('Enter', { metaKey: true }))!)).toBe('editing.save')
    expect(matchEditing(km, chordFromEvent(ev('KeyS', { metaKey: true }))!)).toBe('editing.save')
    expect(matchEditing(km, chordFromEvent(ev('Escape'))!)).toBe('editing.cancel')
  })
})

describe('editorBindings — feeds CodeMirror', () => {
  it('exposes the format chords from the resolved map', () => {
    const km = resolveKeymap('notarium')
    const map = Object.fromEntries(
      editorBindings(km).map((b) => [b.actionId, bindingKey([b.chord])]),
    )
    expect(map['format.bold']).toBe(chordKey(parseBinding('Mod+B')[0]))
  })
})

describe('every preset is internally complete', () => {
  it('binds all actions and parses cleanly', () => {
    for (const p of PRESETS) {
      const km = resolveKeymap(p.id)

      for (const a of ACTIONS) {
        expect(km.byAction[a.id]?.length, `${p.id}:${a.id}`).toBeGreaterThan(0)
      }
    }
  })
})
