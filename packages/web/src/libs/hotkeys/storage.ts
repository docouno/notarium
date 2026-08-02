import { STORAGE_KEYS } from '../storageKeys'
import { DEFAULT_PRESET_ID, PRESET_BY_ID } from './presets'
import type { Binding, HotkeyOverrides } from './types'

// Persistence for the chosen preset + per-action overrides. localStorage now — the
// before-paint cache; the user_preferences server sync lands with the rest of the
// Settings prefs (#28 step 2), same as theme / editor mode. Best-effort: a blocked or
// garbage store falls back to the default preset and no overrides, never a crash.

const PRESET_KEY = STORAGE_KEYS.hotkeyPreset
const OVERRIDES_KEY = STORAGE_KEYS.hotkeyOverrides

export const loadPreset = (): string => {
  try {
    const saved = localStorage.getItem(PRESET_KEY)
    return saved && PRESET_BY_ID[saved] ? saved : DEFAULT_PRESET_ID
  } catch {
    return DEFAULT_PRESET_ID
  }
}

export const savePreset = (id: string): void => {
  try {
    localStorage.setItem(PRESET_KEY, id)
  } catch {
    /* ignore — preferences are best-effort */
  }
}

// A stored override value is the full replacement set: a list of bindings, each a
// Chord[]. (`[]` = explicitly unbound.) Older single-binding shapes (a flat Chord[]
// or null) are tolerated and lifted so a saved override from before never crashes.
const isChord = (c: unknown): boolean =>
  !!c && typeof c === 'object' && typeof (c as { code?: unknown }).code === 'string'

const coerceBindingList = (v: unknown): Binding[] | undefined => {
  if (v === null) {
    return []
  } // legacy "unbound"
  if (!Array.isArray(v)) {
    return undefined
  }
  if (v.length === 0) {
    return []
  }
  if (v.every(isChord)) {
    return [v as Binding]
  } // legacy single binding (flat Chord[])
  if (v.every((b) => Array.isArray(b) && (b as unknown[]).every(isChord))) {
    return v as Binding[]
  }

  return undefined
}

export const loadOverrides = (): HotkeyOverrides => {
  try {
    const raw = localStorage.getItem(OVERRIDES_KEY)

    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: HotkeyOverrides = {}

    for (const [id, v] of Object.entries(parsed)) {
      const coerced = coerceBindingList(v)

      if (coerced) {
        out[id] = coerced
      }
    }

    return out
  } catch {
    return {}
  }
}

export const saveOverrides = (overrides: HotkeyOverrides): void => {
  try {
    if (Object.keys(overrides).length === 0) {
      localStorage.removeItem(OVERRIDES_KEY)
    } else {
      localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides))
    }
  } catch {
    /* ignore */
  }
}
