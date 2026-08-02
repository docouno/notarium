import { ACTIONS } from './actions'
import { bindingKey, chordKey, firesInInput, parseBindings } from './chord'
import { DEFAULT_PRESET_ID, PRESET_BY_ID } from './presets'
import type { Binding, Chord, HotkeyConflict, HotkeyContext, HotkeyOverrides } from './types'

// Resolve a (preset + overrides) pair into the one structure everything reads: the
// effective binding per action, the reverse indices the dispatcher matches against,
// and any same-context conflicts for the Settings editor to surface. Pure — no React,
// no DOM — so the whole matching story is unit-testable (test/unit/hotkeys.test.ts).

export type ResolvedKeymap = {
  /** actionId → effective binding(s) ([] when explicitly unbound). An action can
   *  carry several (Save = Cmd+Enter AND Cmd+S). */
  byAction: Record<string, Binding[]>
  conflicts: HotkeyConflict[]
  // Dispatch indices, split by context (a chord can mean different things in the
  // editor vs. globally — that's intentional, not a clash).
  globalSingles: Map<string, string> // chordKey → actionId
  globalSequences: { key: string; steps: Binding; actionId: string }[]
  sequencePrefixes: Set<string> // chordKey of every sequence's FIRST step
  editingSingles: Map<string, string> // chordKey → actionId (Save / Cancel)
  editorKeys: Set<string> // chordKey of editor chords (CM owns them when focused)
  /** Every modifier-bearing chord bound to ANY action — the app "owns" these, so their
   *  browser default (save-page, bookmark, print…) is suppressed app-wide, in or out of
   *  the surface that uses them (e.g. Cmd+S never saves the page, even when not editing). */
  modifierBoundKeys: Set<string>
}

const effectiveBindings = (
  actionId: string,
  presetBindings: Record<string, string | string[]>,
  overrides: HotkeyOverrides,
): Binding[] => {
  const raw = Object.prototype.hasOwnProperty.call(overrides, actionId)
    ? overrides[actionId] // the full replacement set ([] = unbound)
    : presetBindings[actionId] != null
      ? parseBindings(presetBindings[actionId])
      : []
  // Drop duplicate bindings within one action so it never "conflicts with itself" and
  // never double-indexes (a stored/hand-edited override could repeat one).
  const seen = new Set<string>()
  return raw.filter((b) => {
    const k = bindingKey(b)

    if (seen.has(k)) {
      return false
    }
    seen.add(k)
    return true
  })
}

export const resolveKeymap = (
  presetId: string,
  overrides: HotkeyOverrides = {},
): ResolvedKeymap => {
  const preset = PRESET_BY_ID[presetId] ?? PRESET_BY_ID[DEFAULT_PRESET_ID]
  const byAction: Record<string, Binding[]> = {}
  const globalSingles = new Map<string, string>()
  const globalSequences: ResolvedKeymap['globalSequences'] = []
  const sequencePrefixes = new Set<string>()
  const editingSingles = new Map<string, string>()
  const editorKeys = new Set<string>()
  const modifierBoundKeys = new Set<string>()

  // Group bindings by (context, bindingKey) to flag exact duplicates.
  const seen = new Map<string, string[]>()

  const note = (ctx: HotkeyContext, key: string, actionId: string) => {
    const k = `${ctx}|${key}`
    const arr = seen.get(k)

    if (arr) {
      arr.push(actionId)
    } else {
      seen.set(k, [actionId])
    }
  }

  for (const action of ACTIONS) {
    const bindings = effectiveBindings(action.id, preset.bindings, overrides)
    byAction[action.id] = bindings
    for (const binding of bindings) {
      if (binding.length === 0) {
        continue
      }
      const key = bindingKey(binding)
      note(action.context, key, action.id)

      // A modifier-bearing lead chord the app owns — suppress its browser default
      // everywhere (covers both single chords and the lead of a modifier-led sequence).
      if (firesInInput(binding[0])) {
        modifierBoundKeys.add(chordKey(binding[0]))
      }

      if (action.context === 'editor') {
        // Editor chords are single AND modifier-bearing. A sequence can't run in CM, and a
        // modifier-less chord would block typing — index neither (the resolver, not just
        // the recorder, enforces the invariant; a hand-edited override can't slip through).
        if (binding.length === 1 && firesInInput(binding[0])) {
          editorKeys.add(chordKey(binding[0]))
        }
      } else if (action.context === 'editing') {
        // Save/Cancel are single chords; never register a (hand-edited) sequence under its
        // lead chord, which would fire the action on that lead key alone.
        if (binding.length === 1) {
          editingSingles.set(chordKey(binding[0]), action.id)
        }
      } else if (binding.length === 1) {
        globalSingles.set(chordKey(binding[0]), action.id)
      } else {
        globalSequences.push({ key, steps: binding, actionId: action.id })
        sequencePrefixes.add(chordKey(binding[0]))
      }
    }
  }

  // Exact same chord/sequence in the same context = a real conflict.
  const conflicts: HotkeyConflict[] = []

  for (const [k, actionIds] of seen) {
    if (actionIds.length > 1) {
      const [ctx, key] = k.split('|') as [HotkeyContext, string]
      conflicts.push({ key, context: ctx, actionIds })
    }
  }
  // A single global key that also opens a sequence shadows it — flag that too.
  for (const single of globalSingles.keys()) {
    if (sequencePrefixes.has(single)) {
      const seq = globalSequences.find((s) => chordKey(s.steps[0]) === single)
      const singleAction = globalSingles.get(single)!

      if (seq) {
        conflicts.push({ key: single, context: 'global', actionIds: [singleAction, seq.actionId] })
      }
    }
  }

  return {
    byAction,
    conflicts,
    globalSingles,
    globalSequences,
    sequencePrefixes,
    editingSingles,
    editorKeys,
    modifierBoundKeys,
  }
}

// --- matching (pure; the provider owns the pending-prefix state + timer) ----- //

export type GlobalMatch = {
  actionId: string | null
  /** The new pending prefix (a chord) or null. Caller stores it and arms a timeout. */
  pending: Chord | null
  preventDefault: boolean
}

/** Resolve one keypress against the GLOBAL map, honouring a possibly-active sequence
 *  prefix and the focus/modal context. Plain keys are inert inside text fields and
 *  over modals; modifier chords (Cmd+P) fire through both so they work mid-edit. */
export const matchGlobal = (
  km: ResolvedKeymap,
  chord: Chord,
  ctx: { pending: Chord | null; editable: boolean; modalOpen: boolean },
): GlobalMatch => {
  const blockedPlain = ctx.editable || ctx.modalOpen
  // A chord is "live in a field" if it carries a modifier (safe to type through). Both a
  // single chord and a sequence STEP obey this: a plain `g` is inert in an input, but a
  // modifier-led sequence (VS Code's `Mod+K Mod+T`) must still work there.
  const live = (c: Chord) => firesInInput(c) || !blockedPlain

  // 1) Completing an in-flight sequence (`g` already pressed; or `Mod+K` then `Mod+T`).
  if (ctx.pending) {
    const combined = bindingKey([ctx.pending, chord])
    const seq = km.globalSequences.find((s) => s.key === combined)

    if (seq && live(chord)) {
      return { actionId: seq.actionId, pending: null, preventDefault: true }
    }
    // No completion — drop the prefix and re-evaluate this chord as a fresh press.
  }

  // 2) A fresh single chord.
  const single = km.globalSingles.get(chordKey(chord))

  if (single) {
    if (live(chord)) {
      return { actionId: single, pending: null, preventDefault: true }
    }

    return { actionId: null, pending: null, preventDefault: false } // let it type
  }

  // 3) A fresh sequence prefix (`g`, or a modifier lead like `Mod+K`).
  if (km.sequencePrefixes.has(chordKey(chord)) && live(chord)) {
    return { actionId: null, pending: chord, preventDefault: true }
  }

  return { actionId: null, pending: null, preventDefault: false }
}

/** Resolve one keypress against the EDITING map (Save / Cancel). Returns the action
 *  id; the provider applies the editing-specific guards (a dialog owns Enter, the
 *  slash menu owns Escape) before running it. */
export const matchEditing = (km: ResolvedKeymap, chord: Chord): string | null =>
  km.editingSingles.get(chordKey(chord)) ?? null

/** One editor-context action and its (single) resolved chord. */
export type EditorBinding = { actionId: string; chord: Chord }

/** Editor-context chords, for building CodeMirror's keymap from the same resolved
 *  source (no parallel hardcoded list). One entry per binding, so an editor action
 *  with several chords contributes them all. */
export const editorBindings = (km: ResolvedKeymap): EditorBinding[] => {
  const out: EditorBinding[] = []

  for (const a of ACTIONS) {
    if (a.context !== 'editor') {
      continue
    }
    for (const binding of km.byAction[a.id] ?? []) {
      // Single, modifier-bearing only — a sequence can't run in CM and a modifier-less
      // chord would shadow typing that key in the editor (preventDefault: true).
      if (binding.length === 1 && firesInInput(binding[0])) {
        out.push({ actionId: a.id, chord: binding[0] })
      }
    }
  }

  return out
}
